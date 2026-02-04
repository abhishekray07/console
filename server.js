// server.js
import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PtyManager } from './pty-manager.js';
import { loadSessions, saveSessions } from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MAX_NAME_LENGTH = 100;
const MAX_CWD_LENGTH = 1024;

export function createServer({ testMode = false } = {}) {
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  const manager = new PtyManager();

  // In test mode, use bash instead of claude; don't persist
  let sessions = testMode ? [] : loadSessions();
  const clients = new Set();

  app.use(express.json({ limit: '16kb' }));
  app.use(express.static(path.join(__dirname, 'public')));

  // --- Helpers ---

  function persist() {
    if (!testMode) saveSessions(sessions);
  }

  function safeSend(ws, data) {
    if (ws.readyState === 1) {
      try {
        ws.send(data);
      } catch {
        // Client disconnected mid-send; ignore
      }
    }
  }

  function broadcastSessions() {
    const msg = JSON.stringify({
      type: 'sessions',
      sessions: sessions.map((s) => ({
        ...s,
        alive: manager.isAlive(s.id),
      })),
    });
    for (const ws of clients) {
      safeSend(ws, msg);
    }
  }

  function spawnSession(session) {
    const spawnOpts = {
      cwd: session.cwd,
      ...(testMode
        ? { shell: '/bin/bash', args: ['-c', 'sleep 3600'] }
        : session.claudeSessionId
          ? { resumeId: session.claudeSessionId }
          : {}),
    };

    try {
      manager.spawn(session.id, spawnOpts);
    } catch (e) {
      session.status = 'exited';
      persist();
      broadcastSessions();
      throw e;
    }

    manager.onExit(session.id, () => {
      session.status = 'exited';
      persist();
      broadcastSessions();
      const msg = JSON.stringify({ type: 'exited', sessionId: session.id });
      for (const ws of clients) {
        safeSend(ws, msg);
      }
    });

    // Session ID capture (only for real claude).
    if (!testMode) {
      const uuidRegex = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
      const captureListener = (data) => {
        const match = data.match(uuidRegex);
        if (match) {
          session.claudeSessionId = match[0];
          manager.offData(session.id, captureListener);
          persist();
          broadcastSessions();
        }
      };
      manager.onData(session.id, captureListener);

      // Clean up captureListener if process exits before UUID is found
      manager.onExit(session.id, () => {
        manager.offData(session.id, captureListener);
      });
    }
  }

  // --- REST API ---

  app.get('/api/sessions', (req, res) => {
    res.json(
      sessions.map((s) => ({
        ...s,
        alive: manager.isAlive(s.id),
      }))
    );
  });

  app.post('/api/sessions', (req, res) => {
    const { name, cwd } = req.body;
    if (!name || !cwd) {
      return res.status(400).json({ error: 'name and cwd are required' });
    }

    if (typeof name !== 'string' || name.length > MAX_NAME_LENGTH) {
      return res.status(400).json({ error: `name must be a string of at most ${MAX_NAME_LENGTH} characters` });
    }
    if (typeof cwd !== 'string' || cwd.length > MAX_CWD_LENGTH) {
      return res.status(400).json({ error: `cwd must be a string of at most ${MAX_CWD_LENGTH} characters` });
    }

    // Expand ~ and canonicalize cwd
    const expanded = cwd.startsWith('~') ? cwd.replace(/^~/, os.homedir()) : cwd;
    const resolvedCwd = path.resolve(expanded);
    try {
      const stat = fs.statSync(resolvedCwd);
      if (!stat.isDirectory()) {
        return res.status(400).json({ error: 'cwd is not a directory' });
      }
    } catch {
      return res.status(400).json({ error: 'cwd does not exist' });
    }

    const session = {
      id: crypto.randomUUID(),
      name,
      cwd: resolvedCwd,
      claudeSessionId: null,
      status: 'running',
      createdAt: new Date().toISOString(),
    };

    sessions.push(session);
    persist();

    try {
      spawnSession(session);
    } catch (e) {
      return res.status(500).json({ error: `Failed to spawn: ${e.message}` });
    }

    broadcastSessions();
    res.status(201).json({ ...session, alive: true });
  });

  app.post('/api/sessions/:id/restart', (req, res) => {
    const session = sessions.find((s) => s.id === req.params.id);
    if (!session) return res.status(404).json({ error: 'not found' });

    // Kill existing if alive
    if (manager.isAlive(session.id)) {
      manager.kill(session.id);
    }

    session.status = 'running';
    persist();

    try {
      spawnSession(session);
    } catch (e) {
      return res.status(500).json({ error: `Failed to spawn: ${e.message}` });
    }

    broadcastSessions();
    res.json({ ...session, alive: true });
  });

  app.delete('/api/sessions/:id', (req, res) => {
    const idx = sessions.findIndex((s) => s.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'not found' });

    manager.kill(sessions[idx].id);
    sessions.splice(idx, 1);
    persist();
    broadcastSessions();

    res.json({ ok: true });
  });

  // --- WebSocket ---

  wss.on('connection', (ws) => {
    clients.add(ws);
    let attachedSessionId = null;

    // Send initial session list
    safeSend(
      ws,
      JSON.stringify({
        type: 'sessions',
        sessions: sessions.map((s) => ({
          ...s,
          alive: manager.isAlive(s.id),
        })),
      })
    );

    // Track the current data listener so we can remove it on detach
    let dataListener = null;

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      switch (msg.type) {
        case 'attach': {
          const { sessionId, cols, rows } = msg;
          const proc = manager.getProcess(sessionId);
          if (!proc) break;

          // Detach from previous
          if (attachedSessionId && dataListener) {
            manager.offData(attachedSessionId, dataListener);
            dataListener = null;
          }

          attachedSessionId = sessionId;

          // Resize before replay
          if (cols && rows) {
            manager.resize(sessionId, cols, rows);
          }

          // Install the live listener FIRST to capture everything.
          // Buffer data until replay is done, then switch to direct forwarding.
          const pendingData = [];
          let replaying = true;

          dataListener = (data) => {
            if (replaying) {
              pendingData.push(data);
            } else {
              safeSend(ws, JSON.stringify({ type: 'output', sessionId, data }));
            }
          };
          manager.onData(sessionId, dataListener);

          // Replay buffer
          const buffer = manager.getBuffer(sessionId);
          for (const chunk of buffer) {
            safeSend(ws, JSON.stringify({ type: 'output', sessionId, data: chunk }));
          }
          safeSend(ws, JSON.stringify({ type: 'replay-done', sessionId }));

          // Flush any data that arrived during replay, then switch to live
          replaying = false;
          for (const data of pendingData) {
            safeSend(ws, JSON.stringify({ type: 'output', sessionId, data }));
          }
          break;
        }

        case 'input': {
          if (attachedSessionId) {
            manager.write(attachedSessionId, msg.data);
          }
          break;
        }

        case 'resize': {
          if (attachedSessionId && msg.cols && msg.rows) {
            manager.resize(attachedSessionId, msg.cols, msg.rows);
          }
          break;
        }
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      if (attachedSessionId && dataListener) {
        manager.offData(attachedSessionId, dataListener);
      }
    });
  });

  // --- Startup: resume running sessions ---

  if (!testMode) {
    for (const session of sessions) {
      if (session.status === 'running' && session.claudeSessionId) {
        try {
          spawnSession(session);
          console.log(`Resumed session: ${session.name}`);
        } catch (e) {
          console.error(`Failed to resume ${session.name}: ${e.message}`);
          session.status = 'exited';
        }
      }
    }
    persist();
  }

  // Expose cleanup for testing
  server.destroy = () => {
    return new Promise((resolve) => {
      manager.destroyAll();
      wss.close();
      for (const client of clients) {
        client.terminate();
      }
      clients.clear();
      server.close(resolve);
    });
  };

  // Return server (not app) so WebSocket upgrade works
  return server;
}

// Run if executed directly (ESM-safe check)
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const port = process.env.PORT || 3000;
  const server = createServer();
  server.listen(port, '127.0.0.1', () => {
    console.log(`Claude Console running at http://127.0.0.1:${port}`);
  });
}
