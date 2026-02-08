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
import { createStore } from './store.js';
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
  cleanupOrphanedWorktrees,
} from './git-worktree.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MAX_NAME_LENGTH = 100;
const MAX_CWD_LENGTH = 1024;

export function createServer({ testMode = false } = {}) {
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  const manager = new PtyManager();

  // In test mode, use bash instead of claude; in-memory SQLite
  const store = testMode ? createStore(':memory:') : createStore();
  const clients = new Set();

  app.use(express.json({ limit: '16kb' }));
  app.use(express.static(path.join(__dirname, 'public')));

  // --- Session-scoped file browser (for file tree) ---

  const BROWSE_ENTRY_LIMIT = 200;

  app.get('/api/browse', async (req, res, next) => {
    const { sessionId } = req.query;
    if (!sessionId) return next(); // fall through to original /api/browse handler

    const session = store.getSession(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const project = store.getProject(session.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    // Resolve worktree root
    let worktreeRoot;
    if (session.worktreePath) {
      try {
        worktreeRoot = await resolveWorktreePath(project.cwd, session.worktreePath);
      } catch {
        return res.status(400).json({ error: 'Invalid worktree path' });
      }
    } else {
      worktreeRoot = project.cwd;
    }

    const relativePath = req.query.path || '';

    // Reject absolute paths
    if (path.isAbsolute(relativePath)) {
      return res.status(403).json({ error: 'Absolute paths not allowed' });
    }

    // Reject path traversal
    const normalized = path.normalize(relativePath || '.');
    if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
      return res.status(403).json({ error: 'Path traversal not allowed' });
    }

    const resolved = relativePath ? path.resolve(worktreeRoot, normalized) : worktreeRoot;

    // Symlink-safe validation
    let realResolved, realRoot;
    try {
      realResolved = await fs.promises.realpath(resolved);
      realRoot = await fs.promises.realpath(worktreeRoot);
    } catch {
      return res.status(400).json({ error: 'Path does not exist' });
    }

    if (realResolved !== realRoot && !realResolved.startsWith(realRoot + path.sep)) {
      return res.status(403).json({ error: 'Path escapes worktree' });
    }

    let stat;
    try {
      stat = await fs.promises.stat(realResolved);
    } catch {
      return res.status(400).json({ error: 'Path does not exist' });
    }

    if (!stat.isDirectory()) {
      return res.status(400).json({ error: 'Path is not a directory' });
    }

    let entries;
    try {
      entries = await fs.promises.readdir(realResolved, { withFileTypes: true });
    } catch {
      return res.status(400).json({ error: 'Cannot read directory' });
    }

    const allDirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

    const allFiles = entries
      .filter((e) => e.isFile() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

    const totalEntries = allDirs.length + allFiles.length;
    const dirs = allDirs.slice(0, BROWSE_ENTRY_LIMIT);
    const remaining = BROWSE_ENTRY_LIMIT - dirs.length;
    const files = allFiles.slice(0, Math.max(remaining, 0));
    const hasMore = totalEntries > BROWSE_ENTRY_LIMIT;

    const result = { dirs, files };
    if (hasMore) result.hasMore = true;
    res.json(result);
  });

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

  // --- File Viewer ---

  const MAX_FILE_SIZE = 1024 * 1024; // 1MB

  app.get('/api/file', async (req, res) => {
    const { sessionId, path: filePath } = req.query;

    if (!sessionId || typeof sessionId !== 'string') {
      return res.status(400).json({ error: 'sessionId is required' });
    }
    if (!filePath || typeof filePath !== 'string') {
      return res.status(400).json({ error: 'path is required' });
    }

    // Reject absolute paths
    if (path.isAbsolute(filePath)) {
      return res.status(403).json({ error: 'Absolute paths not allowed' });
    }

    // Reject path traversal
    const normalized = path.normalize(filePath);
    if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
      return res.status(403).json({ error: 'Path traversal not allowed' });
    }

    const session = store.getSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const project = store.getProject(session.projectId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Resolve worktree root
    let worktreeRoot;
    if (session.worktreePath) {
      try {
        worktreeRoot = await resolveWorktreePath(project.cwd, session.worktreePath);
      } catch {
        return res.status(400).json({ error: 'Invalid worktree path' });
      }
    } else {
      worktreeRoot = project.cwd;
    }

    const resolved = path.resolve(worktreeRoot, normalized);

    // Symlink-safe: realpath and verify still under worktree root
    let realResolved;
    try {
      realResolved = await fs.promises.realpath(resolved);
    } catch {
      return res.status(404).json({ error: 'File not found' });
    }

    let realRoot;
    try {
      realRoot = await fs.promises.realpath(worktreeRoot);
    } catch {
      return res.status(400).json({ error: 'Worktree root not found' });
    }

    if (!realResolved.startsWith(realRoot + path.sep) && realResolved !== realRoot) {
      return res.status(403).json({ error: 'Path escapes worktree' });
    }

    // Stat the file
    let stat;
    try {
      stat = await fs.promises.stat(realResolved);
    } catch {
      return res.status(404).json({ error: 'File not found' });
    }

    if (!stat.isFile()) {
      return res.status(400).json({ error: 'Not a file' });
    }

    if (stat.size > MAX_FILE_SIZE) {
      return res.status(413).json({ error: 'File too large (max 1MB)' });
    }

    // Read file and check for binary (null bytes in first 8KB)
    const content = await fs.promises.readFile(realResolved);
    const checkBytes = content.subarray(0, 8192);
    if (checkBytes.includes(0)) {
      return res.json({ isBinary: true });
    }

    res.type('text/plain').send(content.toString('utf-8'));
  });

  // --- Helpers ---

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
    const { projects, sessions } = store.getAll();
    const msg = JSON.stringify({
      type: 'state',
      projects,
      sessions: sessions.map((s) => ({
        ...s,
        alive: manager.isAlive(s.id),
      })),
    });
    for (const ws of clients) {
      safeSend(ws, msg);
    }
  }

  /** Derive the ~/.claude/projects/ directory for a given cwd. */
  function getClaudeProjectDir(cwd) {
    return path.join(
      os.homedir(), '.claude', 'projects',
      fs.realpathSync(cwd).replace(/\//g, '-').replace(/\./g, '-'),
    );
  }

  async function spawnSession(session) {
    const project = store.getProject(session.projectId);
    if (!project) throw new Error('Project not found for session');

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

    // Capture the Claude session ID by watching ~/.claude/projects/ for new .jsonl files.
    // Claude CLI stores conversations as {sessionId}.jsonl in a directory derived from
    // the realpath of the cwd: replace '/' and '.' with '-'.
    // Snapshot BEFORE spawn to avoid race where Claude creates the file instantly.
    let existingJsonlFiles;
    if (!testMode && !session.claudeSessionId) {
      const claudeProjectDir = getClaudeProjectDir(cwd);

      existingJsonlFiles = new Set();
      try {
        existingJsonlFiles = new Set(
          fs.readdirSync(claudeProjectDir).filter(f => f.endsWith('.jsonl')),
        );
      } catch {
        // Directory may not exist yet — Claude will create it
      }
    }

    const spawnOpts = {
      cwd,
      ...(testMode
        ? { shell: '/bin/bash', args: ['-c', 'sleep 5'] }
        : session.claudeSessionId
          ? { resumeId: session.claudeSessionId }
          : {}),
    };

    try {
      manager.spawn(session.id, spawnOpts);
    } catch (e) {
      store.updateSession(session.id, { status: 'exited' });
      broadcastState();
      throw e;
    }

    manager.onExit(session.id, () => {
      store.updateSession(session.id, { status: 'exited' });
      broadcastState();
      const msg = JSON.stringify({ type: 'exited', sessionId: session.id });
      for (const ws of clients) {
        safeSend(ws, msg);
      }
    });

    if (existingJsonlFiles) {
      const claudeProjectDir = getClaudeProjectDir(cwd);
      const MAX_POLL_MS = 60_000; // give up after 60s
      const startTime = Date.now();

      const pollInterval = setInterval(() => {
        if (Date.now() - startTime > MAX_POLL_MS) {
          clearInterval(pollInterval);
          return;
        }
        try {
          const current = fs.readdirSync(claudeProjectDir).filter(f => f.endsWith('.jsonl'));
          const newFile = current.find(f => !existingJsonlFiles.has(f));
          if (newFile) {
            const claudeSessionId = newFile.replace('.jsonl', '');
            store.updateSession(session.id, { claudeSessionId });
            broadcastState();
            clearInterval(pollInterval);
          }
        } catch {
          // Directory not yet created — keep polling
        }
      }, 500);

      // Stop polling when the process exits
      manager.onExit(session.id, () => clearInterval(pollInterval));
    }
  }

  // --- Projects REST API ---

  app.get('/api/projects', (req, res) => {
    const { projects, sessions } = store.getAll();
    res.json({
      projects,
      sessions: sessions.map((s) => ({
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

    const project = store.createProject({
      id: crypto.randomUUID(),
      name,
      cwd: resolvedCwd,
      createdAt: new Date().toISOString(),
    });

    broadcastState();
    res.status(201).json(project);
  });

  app.delete('/api/projects/:id', async (req, res) => {
    const project = store.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'not found' });

    const projectSessions = store.getSessions(req.params.id);
    for (const s of projectSessions) {
      manager.kill(s.id);
      manager.killShell(s.id);
      const msg = JSON.stringify({ type: 'session-deleted', sessionId: s.id });
      for (const ws of clients) {
        safeSend(ws, msg);
      }
    }

    for (const s of projectSessions) {
      if (!s.branchName) continue;
      try {
        await removeWorktree(project.cwd, s.branchName, project.id, { deleteBranch: true });
      } catch {
        // Best-effort cleanup
      }
    }

    store.deleteProject(req.params.id);
    broadcastState();
    res.json({ ok: true });
  });

  // --- Sessions REST API ---

  app.post('/api/projects/:id/sessions', async (req, res) => {
    const project = store.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'project not found' });

    const { name } = req.body;
    if (!name || typeof name !== 'string' || name.length > MAX_NAME_LENGTH) {
      return res.status(400).json({ error: `name is required (string, max ${MAX_NAME_LENGTH} chars)` });
    }

    try {
      const stat = fs.statSync(project.cwd);
      if (!stat.isDirectory()) throw new Error();
    } catch {
      return res.status(400).json({ error: 'Project directory no longer exists' });
    }

    const sessionId = crypto.randomUUID();
    const branchName = `${sanitizeBranchName(name)}-${sessionId.slice(0, 7)}`;
    const worktreePath = `.worktrees/${branchName}`;

    try {
      await createWorktree(project.cwd, branchName, project.id);
    } catch (e) {
      return res.status(400).json({
        error: e.message,
        code: e.code || 'WORKTREE_FAILED',
      });
    }

    let worktreeWarning = null;
    try {
      const isIgnored = await isWorktreesIgnored(project.cwd);
      if (!isIgnored) {
        worktreeWarning = 'Warning: .worktrees/ is not in .gitignore. Add it to avoid committing worktree files.';
      }
    } catch {
      // Ignore check errors
    }

    const session = store.createSession({
      id: sessionId,
      projectId: project.id,
      name,
      branchName,
      worktreePath,
      claudeSessionId: null,
      status: 'running',
      createdAt: new Date().toISOString(),
    });

    try {
      await spawnSession(session);
    } catch (e) {
      try {
        await removeWorktree(project.cwd, branchName, project.id, { deleteBranch: true });
      } catch {
        // Ignore cleanup errors
      }
      store.deleteSession(session.id);
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
    const session = store.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'not found' });

    const project = store.getProject(session.projectId);
    const force = req.query.force === 'true';

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

    if (session.branchName && project) {
      try {
        await removeWorktree(project.cwd, session.branchName, project.id, { deleteBranch: true });
      } catch {
        // Ignore removal errors
      }
    }

    const msg = JSON.stringify({ type: 'session-deleted', sessionId: session.id });
    for (const ws of clients) {
      safeSend(ws, msg);
    }

    store.deleteSession(session.id);
    broadcastState();
    res.json({ ok: true });
  });

  app.post('/api/sessions/:id/archive', async (req, res) => {
    const session = store.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'not found' });

    const project = store.getProject(session.projectId);
    const force = req.query.force === 'true';

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

    if (session.branchName && project) {
      try {
        await removeWorktree(project.cwd, session.branchName, project.id, { deleteBranch: false });
      } catch {
        // Ignore removal errors
      }
    }

    const msg = JSON.stringify({ type: 'session-deleted', sessionId: session.id });
    for (const ws of clients) {
      safeSend(ws, msg);
    }

    store.deleteSession(session.id);
    broadcastState();

    res.json({
      ok: true,
      branch: fullBranchName,
      message: fullBranchName
        ? `Session archived. Branch '${fullBranchName}' preserved for recovery.`
        : 'Session archived.',
    });
  });

  // --- Orphan Cleanup ---

  let cleanupTimer = null;
  let isCleanupRunning = false;

  app.post('/api/cleanup', async (req, res) => {
    if (isCleanupRunning) {
      return res.status(429).json({ error: 'Cleanup already in progress' });
    }
    isCleanupRunning = true;
    try {
      const result = await cleanupOrphanedWorktrees(store, {
        gracePeriodMs: testMode ? 0 : undefined,
      });
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: `Cleanup failed: ${e.message}` });
    } finally {
      isCleanupRunning = false;
    }
  });

  app.post('/api/sessions/:id/restart', async (req, res) => {
    const session = store.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'not found' });

    const project = store.getProject(session.projectId);
    if (!project) return res.status(400).json({ error: 'Parent project not found' });

    try {
      const stat = fs.statSync(project.cwd);
      if (!stat.isDirectory()) throw new Error();
    } catch {
      return res.status(400).json({ error: 'Project directory no longer exists' });
    }

    if (session.branchName) {
      const exists = await worktreeExists(project.cwd, session.branchName);
      if (!exists) {
        return res.status(400).json({
          error: 'Worktree no longer exists. Session cannot be restarted.',
          code: 'WORKTREE_MISSING',
        });
      }
    }

    manager.kill(session.id);

    store.updateSession(session.id, { status: 'running' });
    const updatedSession = store.getSession(session.id);

    try {
      await spawnSession(updatedSession);
    } catch (e) {
      if (e.code === 'INVALID_WORKTREE_PATH' || e.code === 'PATH_SAFETY_VIOLATION') {
        return res.status(400).json({ error: e.message, code: e.code });
      }
      return res.status(500).json({ error: `Failed to spawn: ${e.message}` });
    }

    broadcastState();
    res.json({ ...store.getSession(session.id), alive: true });
  });

  // --- WebSocket ---

  wss.on('connection', (ws) => {
    clients.add(ws);
    let attachedSessionId = null;

    // Send initial state
    const { projects, sessions } = store.getAll();
    safeSend(
      ws,
      JSON.stringify({
        type: 'state',
        projects,
        sessions: sessions.map((s) => ({
          ...s,
          alive: manager.isAlive(s.id),
        })),
      })
    );

    // Track the current data listener so we can remove it on detach
    let dataListener = null;
    let shellDataListener = null;
    let attachedShellSessionId = null;

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
          console.log('[shell-attach] sessionId:', sessionId, 'cols:', cols, 'rows:', rows);
          const session = store.getSession(sessionId);
          if (!session) { console.log('[shell-attach] session not found'); break; }

          const project = store.getProject(session.projectId);
          if (!project) { console.log('[shell-attach] project not found'); break; }

          // Detach previous shell listener (use dedicated tracking variable
          // since attachedSessionId may already point to the new session)
          if (attachedShellSessionId && shellDataListener) {
            manager.offShellData(attachedShellSessionId, shellDataListener);
            shellDataListener = null;
          }
          attachedShellSessionId = sessionId;

          // Spawn shell if not already running
          if (!manager.isShellAlive(sessionId)) {
            let cwd = project.cwd;
            if (session.worktreePath) {
              try {
                cwd = await resolveWorktreePath(project.cwd, session.worktreePath);
                console.log('[shell-attach] resolved cwd:', cwd);
              } catch (e) {
                console.log('[shell-attach] resolveWorktreePath FAILED:', e.message);
                break;
              }
            }
            console.log('[shell-attach] spawning shell in:', cwd);
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
      if (attachedShellSessionId && shellDataListener) {
        manager.offShellData(attachedShellSessionId, shellDataListener);
      }
    });
  });

  // --- Startup: recover missing Claude session IDs, then resume ---

  if (!testMode) {
    const sessions = store.getAll().sessions;

    // First pass: resolve the latest Claude session ID for every resumable session.
    // This handles: null IDs (polling failed), stale IDs (/clear created new JSONL),
    // deleted JSONL files, and exited sessions that can be revived.
    for (const session of sessions) {
      if (session.status !== 'running' && session.status !== 'exited') continue;

      const project = store.getProject(session.projectId);
      if (!project) continue;

      try {
        let cwd = project.cwd;
        if (session.worktreePath) {
          // Apply the same safety checks as resolveWorktreePath (sync version)
          const normalized = path.normalize(session.worktreePath);
          if (path.isAbsolute(session.worktreePath)
            || normalized === '..' || normalized.startsWith(`..${path.sep}`)
            || (!normalized.startsWith(`.worktrees${path.sep}`) && normalized !== '.worktrees')) {
            console.warn(`[startup] Invalid worktree path for ${session.name}, marking exited`);
            store.updateSession(session.id, { status: 'exited' });
            continue;
          }
          const resolved = fs.realpathSync(path.resolve(project.cwd, normalized));
          const resolvedProject = fs.realpathSync(project.cwd);
          if (!resolved.startsWith(resolvedProject + path.sep)) {
            console.warn(`[startup] Worktree path escapes project for ${session.name}, marking exited`);
            store.updateSession(session.id, { status: 'exited' });
            continue;
          }
          cwd = resolved;
        }
        const claudeProjectDir = getClaudeProjectDir(cwd);
        // Find the most recently modified JSONL that contains an actual conversation.
        // Claude CLI creates stub files (only file-history-snapshot entries) on every
        // launch including failed --resume attempts. Skip those.
        const jsonlFiles = fs.readdirSync(claudeProjectDir)
          .filter(f => {
            if (!f.endsWith('.jsonl')) return false;
            // Check if file has conversation data (not just snapshots)
            const content = fs.readFileSync(path.join(claudeProjectDir, f), 'utf8');
            const lines = content.split('\n').filter(Boolean);
            return lines.some(line => {
              try {
                const t = JSON.parse(line).type;
                return t && t !== 'file-history-snapshot';
              } catch { return false; }
            });
          })
          .map(f => ({
            name: f,
            mtime: fs.statSync(path.join(claudeProjectDir, f)).mtimeMs,
          }))
          .sort((a, b) => b.mtime - a.mtime); // most recently modified conversation first

        if (jsonlFiles.length > 0) {
          const latestId = jsonlFiles[0].name.replace('.jsonl', '');
          if (latestId !== session.claudeSessionId || session.status === 'exited') {
            store.updateSession(session.id, { claudeSessionId: latestId, status: 'running' });
            console.log(`[startup] Updated claude session ID for ${session.name}: ${latestId}${session.claudeSessionId ? ` (was ${session.claudeSessionId})` : ' (was null)'}${session.status === 'exited' ? ' (revived)' : ''}`);
          }
        } else {
          console.warn(`[startup] No JSONL files found for ${session.name}, marking exited`);
          store.updateSession(session.id, { status: 'exited' });
        }
      } catch (err) {
        console.warn(`[startup] Could not resolve session ID for ${session.name}: ${err.message}`);
        store.updateSession(session.id, { status: 'exited' });
      }
    }

    // Second pass: resume sessions that have a claudeSessionId
    const updatedSessions = store.getAll().sessions;
    for (const session of updatedSessions) {
      if (session.status === 'running' && session.claudeSessionId) {
        const project = store.getProject(session.projectId);
        if (!project) {
          store.updateSession(session.id, { status: 'exited' });
          continue;
        }
        try {
          const stat = fs.statSync(project.cwd);
          if (!stat.isDirectory()) throw new Error();
        } catch {
          console.error(`Project cwd missing for ${session.name}, marking exited`);
          store.updateSession(session.id, { status: 'exited' });
          continue;
        }
        try {
          spawnSession(session);
          console.log(`Resumed session: ${session.name}`);
        } catch (e) {
          console.error(`Failed to resume ${session.name}: ${e.message}`);
          store.updateSession(session.id, { status: 'exited' });
        }
      }
    }
  }

  // --- Periodic Orphan Cleanup ---

  const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

  async function runCleanup() {
    if (isCleanupRunning) {
      console.log('[cleanup] Skipping — previous cleanup still running');
      return;
    }
    isCleanupRunning = true;
    try {
      await cleanupOrphanedWorktrees(store);
    } catch (e) {
      console.error(`[cleanup] Cleanup failed: ${e.message}`);
    } finally {
      isCleanupRunning = false;
    }
  }

  if (!testMode) {
    // Run cleanup on startup (async, don't block server start)
    runCleanup();

    // Schedule periodic cleanup
    cleanupTimer = setInterval(runCleanup, CLEANUP_INTERVAL_MS);
  }

  server.destroy = () => {
    return new Promise((resolve) => {
      if (cleanupTimer) clearInterval(cleanupTimer);
      manager.destroyAll();
      manager.destroyAllShells();
      store.close();
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
