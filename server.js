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
import { load, save } from './store.js';
import {
  validateGitRepo,
  validateWorktreesDir,
  resolveWorktreePath,
  sanitizeBranchName,
  createWorktree,
  removeWorktree,
  worktreeExists,
  isWorktreeDirty,
  isWorktreesIgnored,
  WorktreeDirtyCheckError,
} from './git-worktree.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MAX_NAME_LENGTH = 100;
const MAX_CWD_LENGTH = 1024;

export function createServer({ testMode = false } = {}) {
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  const manager = new PtyManager();

  // In test mode, use bash instead of claude; don't persist
  let data = testMode ? { projects: [], sessions: [] } : load();
  const clients = new Set();

  app.use(express.json({ limit: '16kb' }));
  app.use(express.static(path.join(__dirname, 'public')));

  // --- Directory Browser ---

  app.get('/api/browse', async (req, res) => {
    const homedir = os.homedir();
    const requestedPath = req.query.path || homedir;

    let resolved;
    try {
      resolved = await fs.promises.realpath(requestedPath);
    } catch {
      return res.status(400).json({ error: 'Path does not exist' });
    }

    // Security: must be under homedir (use path.sep to prevent prefix bypass e.g. /Users/abh vs /Users/abh2)
    if (resolved !== homedir && !resolved.startsWith(homedir + path.sep)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    let stat;
    try {
      stat = await fs.promises.stat(resolved);
    } catch {
      return res.status(400).json({ error: 'Path does not exist' });
    }

    if (!stat.isDirectory()) {
      return res.status(400).json({ error: 'Path is not a directory' });
    }

    let entries;
    try {
      entries = await fs.promises.readdir(resolved, { withFileTypes: true });
    } catch {
      return res.status(400).json({ error: 'Cannot read directory' });
    }

    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
      .slice(0, 500);

    const parent = resolved === '/' ? null : path.dirname(resolved);

    res.json({ path: resolved, parent, dirs });
  });

  // --- Helpers ---

  function persist() {
    if (!testMode) save(data);
  }

  function safeSend(ws, msg) {
    if (ws.readyState === 1) {
      try {
        ws.send(msg);
      } catch {
        // Client disconnected mid-send; ignore
      }
    }
  }

  function broadcastState() {
    const msg = JSON.stringify({
      type: 'state',
      projects: data.projects,
      sessions: data.sessions.map((s) => ({
        ...s,
        alive: manager.isAlive(s.id),
      })),
    });
    for (const ws of clients) {
      safeSend(ws, msg);
    }
  }

  async function spawnSession(session) {
    const project = data.projects.find((p) => p.id === session.projectId);
    if (!project) throw new Error('Project not found for session');

    // Use worktree path if available (new sessions), otherwise project cwd (backward compat)
    let cwd = project.cwd;
    if (session.worktreePath) {
      try {
        cwd = await resolveWorktreePath(project.cwd, session.worktreePath);
      } catch (e) {
        const err = new Error(`Invalid worktree path for session: ${e.message}`);
        err.code = e.code || 'INVALID_WORKTREE_PATH';
        throw err;
      }
    }

    const spawnOpts = {
      cwd,
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
      broadcastState();
      throw e;
    }

    manager.onExit(session.id, () => {
      session.status = 'exited';
      persist();
      broadcastState();
      const msg = JSON.stringify({ type: 'exited', sessionId: session.id });
      for (const ws of clients) {
        safeSend(ws, msg);
      }
    });

    // Session ID capture (only for real claude).
    if (!testMode) {
      const uuidRegex = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
      const captureListener = (d) => {
        const match = d.match(uuidRegex);
        if (match) {
          session.claudeSessionId = match[0];
          manager.offData(session.id, captureListener);
          persist();
          broadcastState();
        }
      };
      manager.onData(session.id, captureListener);

      // Clean up captureListener if process exits before UUID is found
      manager.onExit(session.id, () => {
        manager.offData(session.id, captureListener);
      });
    }
  }

  // --- Projects REST API ---

  app.get('/api/projects', (req, res) => {
    res.json({
      projects: data.projects,
      sessions: data.sessions.map((s) => ({
        ...s,
        alive: manager.isAlive(s.id),
      })),
    });
  });

  app.post('/api/projects', async (req, res) => {
    const { name, cwd } = req.body;
    if (!name || typeof name !== 'string' || name.length > MAX_NAME_LENGTH) {
      return res.status(400).json({ error: `name is required (string, max ${MAX_NAME_LENGTH} chars)` });
    }
    if (!cwd || typeof cwd !== 'string' || cwd.length > MAX_CWD_LENGTH) {
      return res.status(400).json({ error: `cwd is required (string, max ${MAX_CWD_LENGTH} chars)` });
    }

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

    // Validate git repository
    const gitValidation = await validateGitRepo(resolvedCwd);
    if (!gitValidation.valid) {
      return res.status(400).json({
        error: gitValidation.message,
        code: gitValidation.code,
      });
    }

    const project = {
      id: crypto.randomUUID(),
      name,
      cwd: resolvedCwd,
      createdAt: new Date().toISOString(),
    };

    data.projects.push(project);
    persist();
    broadcastState();
    res.status(201).json(project);
  });

  app.delete('/api/projects/:id', async (req, res) => {
    const idx = data.projects.findIndex((p) => p.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'not found' });

    const project = data.projects[idx];

    // Kill all sessions for this project
    const projectSessions = data.sessions.filter((s) => s.projectId === req.params.id);
    for (const s of projectSessions) {
      manager.kill(s.id);
      manager.killShell(s.id);
      // Notify attached clients
      const msg = JSON.stringify({ type: 'session-deleted', sessionId: s.id });
      for (const ws of clients) {
        safeSend(ws, msg);
      }
    }

    // Clean up worktrees and branches for all sessions (best-effort)
    for (const s of projectSessions) {
      if (!s.branchName) continue;
      try {
        await removeWorktree(project.cwd, s.branchName, project.id, { deleteBranch: true });
      } catch {
        // Best-effort cleanup - ignore errors
      }
    }

    // Remove sessions and project
    data.sessions = data.sessions.filter((s) => s.projectId !== req.params.id);
    data.projects.splice(idx, 1);
    persist();
    broadcastState();
    res.json({ ok: true });
  });

  // --- Sessions REST API ---

  app.post('/api/projects/:id/sessions', async (req, res) => {
    const project = data.projects.find((p) => p.id === req.params.id);
    if (!project) return res.status(404).json({ error: 'project not found' });

    const { name } = req.body;
    if (!name || typeof name !== 'string' || name.length > MAX_NAME_LENGTH) {
      return res.status(400).json({ error: `name is required (string, max ${MAX_NAME_LENGTH} chars)` });
    }

    // Validate project cwd still exists
    try {
      const stat = fs.statSync(project.cwd);
      if (!stat.isDirectory()) throw new Error();
    } catch {
      return res.status(400).json({ error: 'Project directory no longer exists' });
    }

    // Generate session ID and branch name first
    const sessionId = crypto.randomUUID();
    const branchName = `${sanitizeBranchName(name)}-${sessionId.slice(0, 7)}`;
    const worktreePath = `.worktrees/${branchName}`;

    // Create worktree
    try {
      await createWorktree(project.cwd, branchName, project.id);
    } catch (e) {
      return res.status(400).json({
        error: e.message,
        code: e.code || 'WORKTREE_FAILED',
      });
    }

    // Check if .worktrees is in .gitignore
    let worktreeWarning = null;
    try {
      const isIgnored = await isWorktreesIgnored(project.cwd);
      if (!isIgnored) {
        worktreeWarning = 'Warning: .worktrees/ is not in .gitignore. Add it to avoid committing worktree files.';
      }
    } catch {
      // Ignore check errors
    }

    const session = {
      id: sessionId,
      projectId: project.id,
      name,
      branchName,
      worktreePath,
      claudeSessionId: null,
      status: 'running',
      createdAt: new Date().toISOString(),
    };

    data.sessions.push(session);
    persist();

    try {
      await spawnSession(session);
    } catch (e) {
      // Clean up worktree on spawn failure
      try {
        await removeWorktree(project.cwd, branchName, project.id, { deleteBranch: true });
      } catch {
        // Ignore cleanup errors
      }
      // Remove session from data
      const idx = data.sessions.findIndex((s) => s.id === session.id);
      if (idx !== -1) data.sessions.splice(idx, 1);
      persist();
      if (e.code === 'INVALID_WORKTREE_PATH' || e.code === 'PATH_SAFETY_VIOLATION') {
        return res.status(400).json({ error: e.message, code: e.code });
      }
      return res.status(500).json({ error: `Failed to spawn: ${e.message}` });
    }

    broadcastState();
    const response = { ...session, alive: true };
    if (worktreeWarning) {
      response.warning = worktreeWarning;
    }
    res.status(201).json(response);
  });

  app.delete('/api/sessions/:id', async (req, res) => {
    const idx = data.sessions.findIndex((s) => s.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'not found' });

    const session = data.sessions[idx];
    const project = data.projects.find((p) => p.id === session.projectId);
    const force = req.query.force === 'true';

    // Check for dirty worktree (if session has one and not forcing)
    if (!force && session.branchName && project) {
      try {
        const dirty = await isWorktreeDirty(project.cwd, session.branchName);
        if (dirty) {
          return res.status(400).json({
            error: 'Worktree has uncommitted changes. Use force=true to delete anyway.',
            code: 'DIRTY_WORKTREE',
          });
        }
      } catch (e) {
        if (e instanceof WorktreeDirtyCheckError) {
          // Only proceed silently if worktree is missing - other errors should block
          if (e.code !== 'WORKTREE_MISSING') {
            return res.status(400).json({
              error: 'Cannot verify worktree status. Use force=true to delete anyway.',
              code: e.code || 'DIRTY_CHECK_FAILED',
            });
          }
        } else {
          throw e;
        }
      }
    }

    manager.kill(session.id);
    manager.killShell(session.id);

    // Remove worktree and branch
    if (session.branchName && project) {
      try {
        await removeWorktree(project.cwd, session.branchName, project.id, { deleteBranch: true });
      } catch {
        // Ignore removal errors - worktree might already be gone
      }
    }

    const msg = JSON.stringify({ type: 'session-deleted', sessionId: session.id });
    for (const ws of clients) {
      safeSend(ws, msg);
    }

    data.sessions.splice(idx, 1);
    persist();
    broadcastState();
    res.json({ ok: true });
  });

  // Archive session: remove worktree but keep branch (can recover later)
  app.post('/api/sessions/:id/archive', async (req, res) => {
    const idx = data.sessions.findIndex((s) => s.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'not found' });

    const session = data.sessions[idx];
    const project = data.projects.find((p) => p.id === session.projectId);
    const force = req.query.force === 'true';

    // Check for dirty worktree (same as delete - archive also removes worktree)
    if (!force && session.branchName && project) {
      try {
        const dirty = await isWorktreeDirty(project.cwd, session.branchName);
        if (dirty) {
          return res.status(400).json({
            error: 'Worktree has uncommitted changes. Use force=true to archive anyway.',
            code: 'DIRTY_WORKTREE',
          });
        }
      } catch (e) {
        if (e instanceof WorktreeDirtyCheckError) {
          if (e.code !== 'WORKTREE_MISSING') {
            return res.status(400).json({
              error: 'Cannot verify worktree status. Use force=true to archive anyway.',
              code: e.code || 'DIRTY_CHECK_FAILED',
            });
          }
        } else {
          throw e;
        }
      }
    }

    manager.kill(session.id);
    manager.killShell(session.id);

    const fullBranchName = session.branchName ? `claude/${session.branchName}` : null;

    // Remove worktree but keep branch
    if (session.branchName && project) {
      try {
        await removeWorktree(project.cwd, session.branchName, project.id, { deleteBranch: false });
      } catch {
        // Ignore removal errors - worktree might already be gone
      }
    }

    const msg = JSON.stringify({ type: 'session-deleted', sessionId: session.id });
    for (const ws of clients) {
      safeSend(ws, msg);
    }

    data.sessions.splice(idx, 1);
    persist();
    broadcastState();

    res.json({
      ok: true,
      branch: fullBranchName,
      message: fullBranchName
        ? `Session archived. Branch '${fullBranchName}' preserved for recovery.`
        : 'Session archived.',
    });
  });

  app.post('/api/sessions/:id/restart', async (req, res) => {
    const session = data.sessions.find((s) => s.id === req.params.id);
    if (!session) return res.status(404).json({ error: 'not found' });

    const project = data.projects.find((p) => p.id === session.projectId);
    if (!project) return res.status(400).json({ error: 'Parent project not found' });

    // Validate cwd
    try {
      const stat = fs.statSync(project.cwd);
      if (!stat.isDirectory()) throw new Error();
    } catch {
      return res.status(400).json({ error: 'Project directory no longer exists' });
    }

    // Check worktree exists (if session has one)
    if (session.branchName) {
      const exists = await worktreeExists(project.cwd, session.branchName);
      if (!exists) {
        return res.status(400).json({
          error: 'Worktree no longer exists. Session cannot be restarted.',
          code: 'WORKTREE_MISSING',
        });
      }
    }

    // Always kill — even exited processes remain in PtyManager's map and
    // would cause spawn() to throw "Session already exists"
    manager.kill(session.id);

    session.status = 'running';
    persist();

    try {
      await spawnSession(session);
    } catch (e) {
      if (e.code === 'INVALID_WORKTREE_PATH' || e.code === 'PATH_SAFETY_VIOLATION') {
        return res.status(400).json({ error: e.message, code: e.code });
      }
      return res.status(500).json({ error: `Failed to spawn: ${e.message}` });
    }

    broadcastState();
    res.json({ ...session, alive: true });
  });

  // --- WebSocket ---

  wss.on('connection', (ws) => {
    clients.add(ws);
    let attachedSessionId = null;

    // Send initial state
    safeSend(
      ws,
      JSON.stringify({
        type: 'state',
        projects: data.projects,
        sessions: data.sessions.map((s) => ({
          ...s,
          alive: manager.isAlive(s.id),
        })),
      })
    );

    // Track the current data listener so we can remove it on detach
    let dataListener = null;
    let shellDataListener = null;

    ws.on('message', async (raw) => {
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

          dataListener = (d) => {
            if (replaying) {
              pendingData.push(d);
            } else {
              safeSend(ws, JSON.stringify({ type: 'output', sessionId, data: d }));
            }
          };
          manager.onData(sessionId, dataListener);

          // Replay buffer in a single message to reduce write-queue churn
          const buffer = manager.getBuffer(sessionId);
          if (buffer.length > 0) {
            const combined = buffer.join('');
            safeSend(ws, JSON.stringify({ type: 'output', sessionId, data: combined }));
          }

          // Flush any data that arrived during replay, then switch to live
          replaying = false;
          for (const d of pendingData) {
            safeSend(ws, JSON.stringify({ type: 'output', sessionId, data: d }));
          }

          // Send replay-done AFTER all data (buffer + pending) is sent
          safeSend(ws, JSON.stringify({ type: 'replay-done', sessionId }));

          // Nudge Claude CLI to re-render by triggering a SIGWINCH via
          // a tiny resize bounce. Ink (Claude's TUI) listens for this and
          // repaints, restoring correct cursor position and visibility.
          if (cols && rows && manager.isAlive(sessionId)) {
            const nudgeCols = Math.max(cols - 1, 1);
            manager.resize(sessionId, nudgeCols, rows);
            setTimeout(() => {
              manager.resize(sessionId, cols, rows);
            }, 50);
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

        case 'shell-attach': {
          const { sessionId, cols, rows } = msg;
          const session = data.sessions.find((s) => s.id === sessionId);
          if (!session) break;

          const project = data.projects.find((p) => p.id === session.projectId);
          if (!project) break;

          // Detach previous shell listener
          if (attachedSessionId && shellDataListener) {
            manager.offShellData(attachedSessionId, shellDataListener);
            shellDataListener = null;
          }

          // Spawn shell if not already running
          if (!manager.isShellAlive(sessionId)) {
            let cwd = project.cwd;
            if (session.worktreePath) {
              try {
                cwd = await resolveWorktreePath(project.cwd, session.worktreePath);
              } catch {
                break;
              }
            }
            manager.spawnShell(sessionId, { cwd, cols, rows });
          } else if (cols && rows) {
            manager.resizeShell(sessionId, cols, rows);
          }

          // Install live listener with replay buffering (same pattern as attach)
          const shellPending = [];
          let shellReplaying = true;

          shellDataListener = (d) => {
            if (shellReplaying) {
              shellPending.push(d);
            } else {
              safeSend(ws, JSON.stringify({ type: 'shell-output', sessionId, data: d }));
            }
          };
          manager.onShellData(sessionId, shellDataListener);

          // Replay buffer
          const shellBuffer = manager.getShellBuffer(sessionId);
          if (shellBuffer.length > 0) {
            const combined = shellBuffer.join('');
            safeSend(ws, JSON.stringify({ type: 'shell-output', sessionId, data: combined }));
          }

          // Flush pending and switch to live
          shellReplaying = false;
          for (const d of shellPending) {
            safeSend(ws, JSON.stringify({ type: 'shell-output', sessionId, data: d }));
          }

          safeSend(ws, JSON.stringify({ type: 'shell-replay-done', sessionId }));
          break;
        }

        case 'shell-input': {
          if (msg.sessionId) {
            manager.writeShell(msg.sessionId, msg.data);
          }
          break;
        }

        case 'shell-resize': {
          if (msg.sessionId && msg.cols && msg.rows) {
            manager.resizeShell(msg.sessionId, msg.cols, msg.rows);
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
      if (attachedSessionId && shellDataListener) {
        manager.offShellData(attachedSessionId, shellDataListener);
      }
    });
  });

  // --- Startup: resume running sessions ---

  if (!testMode) {
    for (const session of data.sessions) {
      if (session.status === 'running' && session.claudeSessionId) {
        const project = data.projects.find((p) => p.id === session.projectId);
        if (!project) {
          session.status = 'exited';
          continue;
        }
        try {
          const stat = fs.statSync(project.cwd);
          if (!stat.isDirectory()) throw new Error();
        } catch {
          console.error(`Project cwd missing for ${session.name}, marking exited`);
          session.status = 'exited';
          continue;
        }
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
      manager.destroyAllShells();
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
