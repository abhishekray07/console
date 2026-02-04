# Home Screen & Projects Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the flat session-based UI with a project-grouped model: sidebar shows projects with nested sessions, home screen has "Add Project" button, directory browser modal for picking project paths.

**Architecture:** New `projects.json` store (clean slate, replaces `sessions.json`). Projects own sessions; sessions inherit cwd from parent project. Server-side `/api/browse` endpoint for filesystem navigation restricted to homedir. WebSocket broadcasts unified `type: "state"` messages.

**Tech Stack:** Node.js, Express, node-pty, ws, vanilla JS, xterm.js

**Dex Epic:** drue3k9h

---

### Task 1: Rewrite store.js for new data shape

**Files:**
- Modify: `store.js` (entire file, 33 lines)
- Create: `test/store.test.js`

**Step 1: Write the failing test**

Create `test/store.test.js`:

```js
// test/store.test.js
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE_PATH = path.join(__dirname, '..', 'projects.json');

// We must import after setting up, since the module reads the path at import time
let load, save;

describe('Store', () => {
  beforeEach(async () => {
    // Clean up before each test
    try { fs.unlinkSync(STORE_PATH); } catch { /* ignore */ }
    // Re-import to get fresh module state
    const mod = await import('../store.js?t=' + Date.now());
    load = mod.load;
    save = mod.save;
  });

  afterEach(() => {
    try { fs.unlinkSync(STORE_PATH); } catch { /* ignore */ }
  });

  it('load returns empty projects and sessions when file missing', () => {
    const data = load();
    assert.deepStrictEqual(data, { projects: [], sessions: [] });
  });

  it('save writes and load reads back', () => {
    const data = {
      projects: [{ id: 'p1', name: 'test', cwd: '/tmp', createdAt: '2026-01-01T00:00:00Z' }],
      sessions: [{ id: 's1', projectId: 'p1', name: 'sess', claudeSessionId: null, status: 'running', createdAt: '2026-01-01T00:00:00Z' }],
    };
    save(data);
    const loaded = load();
    assert.deepStrictEqual(loaded, data);
  });

  it('save is atomic (file exists after save)', () => {
    save({ projects: [], sessions: [] });
    assert.ok(fs.existsSync(STORE_PATH));
  });
});
```

**Step 2: Run test to verify it fails**

Run: `node --test test/store.test.js`
Expected: FAIL — `load` and `save` are not exported from store.js (it exports `loadSessions` and `saveSessions`)

**Step 3: Rewrite store.js**

Replace entire `store.js` with:

```js
// store.js
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE_PATH = path.join(__dirname, 'projects.json');

export function load() {
  try {
    const data = fs.readFileSync(STORE_PATH, 'utf-8');
    return JSON.parse(data);
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.warn('Failed to load projects.json (starting fresh):', e.message);
    }
    return { projects: [], sessions: [] };
  }
}

export function save(data) {
  const tmp = STORE_PATH + '.tmp.' + crypto.randomUUID().slice(0, 8);
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, STORE_PATH);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    console.error('Failed to save projects:', e.message);
  }
}
```

**Step 4: Run test to verify it passes**

Run: `node --test test/store.test.js`
Expected: PASS (3 tests)

**Step 5: Commit**

```bash
git add store.js test/store.test.js
git commit -m "refactor: rewrite store.js for projects.json data shape"
```

---

### Task 2: Add /api/browse endpoint

**Files:**
- Modify: `server.js` (add endpoint after line 29, the `express.static` line)
- Create: `test/browse.test.js`

**Step 1: Write the failing test**

Create `test/browse.test.js`:

```js
// test/browse.test.js
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server.js';

describe('/api/browse', () => {
  let server;
  let baseUrl;

  before(async () => {
    server = createServer({ testMode: true });
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://localhost:${server.address().port}`;
  });

  after(async () => {
    await server.destroy();
  });

  it('returns homedir contents when no path given', async () => {
    const res = await fetch(`${baseUrl}/api/browse`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.path, os.homedir());
    assert.ok(Array.isArray(data.dirs));
    assert.ok(data.parent !== undefined);
  });

  it('returns subdirectories for a valid path', async () => {
    const res = await fetch(`${baseUrl}/api/browse?path=${encodeURIComponent(os.homedir())}`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.path, os.homedir());
    assert.ok(Array.isArray(data.dirs));
    // Should not contain hidden dirs
    for (const d of data.dirs) {
      assert.ok(!d.startsWith('.'), `hidden dir found: ${d}`);
    }
  });

  it('returns 400 for non-existent path', async () => {
    const res = await fetch(`${baseUrl}/api/browse?path=${encodeURIComponent('/nonexistent/xyz/abc')}`);
    assert.strictEqual(res.status, 400);
  });

  it('returns 403 for path outside homedir', async () => {
    const res = await fetch(`${baseUrl}/api/browse?path=${encodeURIComponent('/etc')}`);
    assert.strictEqual(res.status, 403);
  });

  it('returns sorted directories', async () => {
    const res = await fetch(`${baseUrl}/api/browse?path=${encodeURIComponent(os.homedir())}`);
    const data = await res.json();
    const sorted = [...data.dirs].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    assert.deepStrictEqual(data.dirs, sorted);
  });

  it('parent is null at filesystem root (homedir parent chain)', async () => {
    const res = await fetch(`${baseUrl}/api/browse?path=${encodeURIComponent(os.homedir())}`);
    const data = await res.json();
    // Parent of homedir should exist and be a string
    assert.ok(typeof data.parent === 'string' || data.parent === null);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `node --test test/browse.test.js`
Expected: FAIL — 404 on `/api/browse` since the endpoint doesn't exist yet

**Step 3: Add browse endpoint to server.js**

In `server.js`, add after line 29 (`app.use(express.static(...))`):

```js
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

    // Security: must be under homedir
    if (!resolved.startsWith(homedir)) {
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
```

Note: `fs` is already imported in server.js (line 5). The `os` module is also already imported (line 8).

**Step 4: Run test to verify it passes**

Run: `node --test test/browse.test.js`
Expected: PASS (6 tests)

**Step 5: Commit**

```bash
git add server.js test/browse.test.js
git commit -m "feat: add /api/browse endpoint for directory navigation"
```

---

### Task 3: Rewrite server.js data layer (projects + sessions)

This is the largest backend task. Replace the flat sessions array with `{ projects, sessions }` from the new store, and add project CRUD + session CRUD scoped to projects.

**Files:**
- Modify: `server.js` (lines 11, 24-25, 33-35, 47-58, 60-108, 112-200, 204-218, 303-318)
- Modify: `test/server.test.js` (entire file)

**Step 1: Write the failing tests**

Replace `test/server.test.js` entirely:

```js
// test/server.test.js
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { createServer } from '../server.js';

describe('Projects API', () => {
  let server;
  let baseUrl;

  before(async () => {
    server = createServer({ testMode: true });
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://localhost:${server.address().port}`;
  });

  after(async () => {
    await server.destroy();
  });

  it('GET /api/projects returns empty array initially', async () => {
    const res = await fetch(`${baseUrl}/api/projects`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data));
    assert.strictEqual(data.length, 0);
  });

  it('POST /api/projects creates a project', async () => {
    const res = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'test-proj', cwd: process.cwd() }),
    });
    assert.strictEqual(res.status, 201);
    const proj = await res.json();
    assert.ok(proj.id);
    assert.strictEqual(proj.name, 'test-proj');
    assert.ok(proj.cwd);
    assert.ok(proj.createdAt);
  });

  it('POST /api/projects rejects invalid cwd', async () => {
    const res = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'bad', cwd: '/nonexistent/xyz' }),
    });
    assert.strictEqual(res.status, 400);
  });

  it('POST /api/projects rejects missing name', async () => {
    const res = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: process.cwd() }),
    });
    assert.strictEqual(res.status, 400);
  });

  it('DELETE /api/projects/:id removes project', async () => {
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'to-delete', cwd: process.cwd() }),
    });
    const { id } = await createRes.json();

    const res = await fetch(`${baseUrl}/api/projects/${id}`, { method: 'DELETE' });
    assert.strictEqual(res.status, 200);

    const listRes = await fetch(`${baseUrl}/api/projects`);
    const projects = await listRes.json();
    assert.ok(!projects.find((p) => p.id === id));
  });

  it('DELETE /api/projects/:id returns 404 for unknown id', async () => {
    const res = await fetch(`${baseUrl}/api/projects/nonexistent`, { method: 'DELETE' });
    assert.strictEqual(res.status, 404);
  });
});

describe('Sessions API (scoped to projects)', () => {
  let server;
  let baseUrl;
  let projectId;

  before(async () => {
    server = createServer({ testMode: true });
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://localhost:${server.address().port}`;

    // Create a project to use
    const res = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'session-test-proj', cwd: process.cwd() }),
    });
    const proj = await res.json();
    projectId = proj.id;
  });

  after(async () => {
    await server.destroy();
  });

  it('POST /api/projects/:id/sessions creates a session', async () => {
    const res = await fetch(`${baseUrl}/api/projects/${projectId}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'test-session' }),
    });
    assert.strictEqual(res.status, 201);
    const session = await res.json();
    assert.ok(session.id);
    assert.strictEqual(session.projectId, projectId);
    assert.strictEqual(session.name, 'test-session');
    assert.strictEqual(session.status, 'running');
    assert.strictEqual(session.alive, true);
  });

  it('POST /api/projects/:id/sessions returns 404 for unknown project', async () => {
    const res = await fetch(`${baseUrl}/api/projects/nonexistent/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'orphan' }),
    });
    assert.strictEqual(res.status, 404);
  });

  it('POST /api/projects/:id/sessions rejects missing name', async () => {
    const res = await fetch(`${baseUrl}/api/projects/${projectId}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.strictEqual(res.status, 400);
  });

  it('DELETE /api/sessions/:id removes session', async () => {
    // Create a session first
    const createRes = await fetch(`${baseUrl}/api/projects/${projectId}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'to-delete' }),
    });
    const { id } = await createRes.json();

    const res = await fetch(`${baseUrl}/api/sessions/${id}`, { method: 'DELETE' });
    assert.strictEqual(res.status, 200);
  });

  it('POST /api/sessions/:id/restart restarts session', async () => {
    const createRes = await fetch(`${baseUrl}/api/projects/${projectId}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'to-restart' }),
    });
    const { id } = await createRes.json();

    const res = await fetch(`${baseUrl}/api/sessions/${id}/restart`, { method: 'POST' });
    assert.strictEqual(res.status, 200);
    const session = await res.json();
    assert.strictEqual(session.alive, true);
  });

  it('DELETE /api/projects/:id also removes its sessions', async () => {
    // Create a fresh project with a session
    const projRes = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'cascade-test', cwd: process.cwd() }),
    });
    const proj = await projRes.json();

    await fetch(`${baseUrl}/api/projects/${proj.id}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'child-session' }),
    });

    // Delete project
    const delRes = await fetch(`${baseUrl}/api/projects/${proj.id}`, { method: 'DELETE' });
    assert.strictEqual(delRes.status, 200);

    // Verify project and its sessions are gone from GET /api/projects
    const listRes = await fetch(`${baseUrl}/api/projects`);
    const projects = await listRes.json();
    assert.ok(!projects.find((p) => p.id === proj.id));
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `node --test test/server.test.js`
Expected: FAIL — `/api/projects` returns 404, old `/api/sessions` is still the main route

**Step 3: Rewrite server.js data layer**

Key changes to `server.js`:

1. **Line 11** — Change import:
   ```js
   import { load, save } from './store.js';
   ```

2. **Line 25** — Change data initialization:
   ```js
   let data = testMode ? { projects: [], sessions: [] } : load();
   ```

3. **Line 33-35** — Change persist:
   ```js
   function persist() {
     if (!testMode) save(data);
   }
   ```

4. **Lines 47-58** — Replace `broadcastSessions` with `broadcastState`:
   ```js
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
   ```

5. **Lines 60-108** — Update `spawnSession` to look up project cwd:
   ```js
   function spawnSession(session) {
     const project = data.projects.find((p) => p.id === session.projectId);
     if (!project) throw new Error('Project not found for session');

     const spawnOpts = {
       cwd: project.cwd,
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
       manager.onExit(session.id, () => {
         manager.offData(session.id, captureListener);
       });
     }
   }
   ```

6. **Lines 112-200** — Replace old session REST endpoints with project + session endpoints:
   ```js
   // --- Projects REST API ---

   app.get('/api/projects', (req, res) => {
     res.json(data.projects);
   });

   app.post('/api/projects', (req, res) => {
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

   app.delete('/api/projects/:id', (req, res) => {
     const idx = data.projects.findIndex((p) => p.id === req.params.id);
     if (idx === -1) return res.status(404).json({ error: 'not found' });

     // Kill all sessions for this project
     const projectSessions = data.sessions.filter((s) => s.projectId === req.params.id);
     for (const s of projectSessions) {
       manager.kill(s.id);
       // Notify attached clients
       const msg = JSON.stringify({ type: 'session-deleted', sessionId: s.id });
       for (const ws of clients) {
         safeSend(ws, msg);
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

   app.post('/api/projects/:id/sessions', (req, res) => {
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

     const session = {
       id: crypto.randomUUID(),
       projectId: project.id,
       name,
       claudeSessionId: null,
       status: 'running',
       createdAt: new Date().toISOString(),
     };

     data.sessions.push(session);
     persist();

     try {
       spawnSession(session);
     } catch (e) {
       return res.status(500).json({ error: `Failed to spawn: ${e.message}` });
     }

     broadcastState();
     res.status(201).json({ ...session, alive: true });
   });

   app.delete('/api/sessions/:id', (req, res) => {
     const idx = data.sessions.findIndex((s) => s.id === req.params.id);
     if (idx === -1) return res.status(404).json({ error: 'not found' });

     const session = data.sessions[idx];
     manager.kill(session.id);

     const msg = JSON.stringify({ type: 'session-deleted', sessionId: session.id });
     for (const ws of clients) {
       safeSend(ws, msg);
     }

     data.sessions.splice(idx, 1);
     persist();
     broadcastState();
     res.json({ ok: true });
   });

   app.post('/api/sessions/:id/restart', (req, res) => {
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

     broadcastState();
     res.json({ ...session, alive: true });
   });
   ```

7. **Lines 208-218** — Update WebSocket initial send to use `broadcastState` format:
   ```js
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
   ```

8. **Lines 305-318** — Update startup resume to look up project cwd:
   ```js
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
   ```

**Step 4: Run all tests**

Run: `node --test test/`
Expected: PASS (store tests + browse tests + server tests + pty-manager tests)

**Step 5: Verify syntax**

Run: `node --check server.js && node --check store.js`
Expected: No errors

**Step 6: Commit**

```bash
git add server.js test/server.test.js
git commit -m "feat: replace flat sessions with project-scoped session model"
```

---

### Task 4: Rewrite frontend HTML structure

**Files:**
- Modify: `public/index.html` (entire file, 40 lines)

**Step 1: Rewrite index.html**

Replace entire `public/index.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Claude Console</title>
  <link rel="stylesheet" href="/vendor/xterm.css">
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <div id="app">
    <aside id="sidebar">
      <div id="sidebar-header">
        <span class="sidebar-title">Projects</span>
        <button id="btn-add-project" title="Add project">+</button>
      </div>
      <div id="project-list"></div>
    </aside>
    <main id="terminal-container">
      <div id="terminal"></div>
      <div id="no-session">
        <button id="btn-home-add-project" class="home-add-btn">Add Project</button>
      </div>
    </main>
  </div>

  <!-- Add Project Modal -->
  <div id="modal-overlay" class="hidden">
    <div id="modal">
      <h2>Add Project</h2>
      <label for="modal-project-name">Project Name</label>
      <input id="modal-project-name" type="text" placeholder="My Project" autofocus>
      <label for="modal-project-path">Directory</label>
      <div class="path-input-row">
        <input id="modal-project-path" type="text" placeholder="Select a directory..." readonly>
        <button id="btn-browse">Browse</button>
      </div>
      <div id="dir-browser" class="hidden">
        <div id="dir-breadcrumbs"></div>
        <ul id="dir-list"></ul>
        <button id="btn-select-dir">Select This Directory</button>
      </div>
      <div class="modal-buttons">
        <button id="btn-modal-cancel">Cancel</button>
        <button id="btn-modal-create" disabled>Create Project</button>
      </div>
    </div>
  </div>

  <script src="/vendor/xterm.js"></script>
  <script src="/vendor/xterm-addon-fit.js"></script>
  <script src="/vendor/xterm-addon-web-links.js"></script>
  <script src="/app.js"></script>
</body>
</html>
```

**Step 2: Verify no syntax issues**

Open browser at `http://127.0.0.1:3000` — page should load (will look broken until CSS and JS are updated).

**Step 3: Commit**

```bash
git add public/index.html
git commit -m "feat: update HTML structure for projects sidebar and modal"
```

---

### Task 5: Rewrite frontend CSS

**Files:**
- Modify: `public/style.css` (entire file, 151 lines)

**Step 1: Rewrite style.css**

Replace entire `public/style.css`:

```css
* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  background: #1a1a2e;
  color: #e0e0e0;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  height: 100vh;
  overflow: hidden;
}

#app {
  display: flex;
  height: 100vh;
}

/* --- Sidebar --- */

#sidebar {
  width: 240px;
  min-width: 240px;
  background: #16213e;
  border-right: 1px solid #0f3460;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
}

#sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid #0f3460;
}

.sidebar-title {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #6b7280;
}

#btn-add-project {
  background: #0f3460;
  color: #e0e0e0;
  border: none;
  width: 24px;
  height: 24px;
  border-radius: 4px;
  font-size: 16px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}
#btn-add-project:hover { background: #e94560; }

/* --- Project list --- */

#project-list {
  flex: 1;
}

.project-group {
  border-bottom: 1px solid #0f346033;
}

.project-header {
  display: flex;
  align-items: center;
  padding: 10px 12px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
  gap: 6px;
  user-select: none;
}
.project-header:hover { background: #0f3460; }

.project-arrow {
  font-size: 10px;
  color: #6b7280;
  transition: transform 0.15s;
  width: 12px;
  text-align: center;
}
.project-arrow.expanded { transform: rotate(90deg); }

.project-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.project-delete {
  background: none;
  border: none;
  color: #6b7280;
  cursor: pointer;
  font-size: 14px;
  padding: 0 4px;
  display: none;
}
.project-header:hover .project-delete { display: block; }
.project-delete:hover { color: #e94560; }

.project-sessions {
  list-style: none;
  display: none;
}
.project-sessions.expanded { display: block; }

.project-sessions li {
  padding: 6px 16px 6px 30px;
  cursor: pointer;
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.project-sessions li:hover { background: #0f3460; }
.project-sessions li.active { background: #0f3460; border-left: 3px solid #e94560; padding-left: 27px; }

.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}
.status-dot.alive { background: #4ade80; }
.status-dot.exited { background: #6b7280; }

.session-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.session-time {
  color: #6b7280;
  font-size: 11px;
  flex-shrink: 0;
}

.session-delete {
  background: none;
  border: none;
  color: #6b7280;
  cursor: pointer;
  font-size: 12px;
  padding: 0 2px;
  display: none;
}
.project-sessions li:hover .session-delete { display: block; }
.session-delete:hover { color: #e94560; }

.btn-new-session {
  padding: 6px 16px 8px 30px;
  font-size: 12px;
  color: #6b7280;
  cursor: pointer;
  border: none;
  background: none;
  width: 100%;
  text-align: left;
}
.btn-new-session:hover { color: #e94560; }

.inline-session-input {
  width: calc(100% - 30px);
  margin: 4px 0 8px 30px;
  padding: 4px 8px;
  background: #1a1a2e;
  border: 1px solid #0f3460;
  border-radius: 4px;
  color: #e0e0e0;
  font-size: 12px;
  outline: none;
}
.inline-session-input:focus { border-color: #e94560; }

/* --- Main area --- */

#terminal-container {
  flex: 1;
  position: relative;
  background: #000;
}

#terminal {
  position: absolute;
  inset: 0;
}

#no-session {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}
#no-session.hidden { display: none; }

.home-add-btn {
  padding: 16px 32px;
  background: #16213e;
  color: #e0e0e0;
  border: 2px dashed #0f3460;
  border-radius: 8px;
  font-size: 16px;
  cursor: pointer;
}
.home-add-btn:hover { border-color: #e94560; color: #e94560; }

/* --- Modal --- */

#modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
#modal-overlay.hidden { display: none; }

#modal {
  background: #16213e;
  border: 1px solid #0f3460;
  border-radius: 8px;
  padding: 24px;
  width: 480px;
  max-height: 80vh;
  overflow-y: auto;
}

#modal h2 {
  font-size: 16px;
  margin-bottom: 16px;
  color: #e0e0e0;
}

#modal label {
  display: block;
  font-size: 12px;
  color: #6b7280;
  margin-bottom: 4px;
  margin-top: 12px;
}

#modal input[type="text"] {
  width: 100%;
  padding: 8px 10px;
  background: #1a1a2e;
  border: 1px solid #0f3460;
  border-radius: 4px;
  color: #e0e0e0;
  font-size: 13px;
}

.path-input-row {
  display: flex;
  gap: 8px;
}
.path-input-row input { flex: 1; }

#btn-browse {
  padding: 8px 12px;
  background: #0f3460;
  color: #e0e0e0;
  border: none;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}
#btn-browse:hover { background: #e94560; }

/* --- Directory browser --- */

#dir-browser {
  margin-top: 12px;
  border: 1px solid #0f3460;
  border-radius: 4px;
  background: #1a1a2e;
}
#dir-browser.hidden { display: none; }

#dir-breadcrumbs {
  padding: 8px 10px;
  font-size: 12px;
  color: #6b7280;
  border-bottom: 1px solid #0f3460;
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
}

.breadcrumb {
  cursor: pointer;
  color: #e94560;
}
.breadcrumb:hover { text-decoration: underline; }
.breadcrumb-sep { color: #6b7280; margin: 0 2px; }

#dir-list {
  list-style: none;
  max-height: 200px;
  overflow-y: auto;
}

#dir-list li {
  padding: 6px 10px;
  font-size: 13px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 6px;
}
#dir-list li:hover { background: #0f3460; }
#dir-list li::before { content: ''; color: #6b7280; }

#btn-select-dir {
  display: block;
  width: 100%;
  padding: 8px;
  background: none;
  color: #e94560;
  border: none;
  border-top: 1px solid #0f3460;
  font-size: 12px;
  cursor: pointer;
}
#btn-select-dir:hover { background: #0f346033; }

.modal-buttons {
  display: flex;
  gap: 8px;
  margin-top: 20px;
  justify-content: flex-end;
}

.modal-buttons button {
  padding: 8px 16px;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
}

#btn-modal-cancel { background: #0f3460; color: #e0e0e0; }
#btn-modal-create { background: #e94560; color: white; }
#btn-modal-create:disabled { opacity: 0.4; cursor: not-allowed; }
```

**Step 2: Verify visually**

Open browser — sidebar and main area should render with correct layout (content will be empty until JS is updated).

**Step 3: Commit**

```bash
git add public/style.css
git commit -m "feat: restyle CSS for project sidebar, modal, and directory browser"
```

---

### Task 6: Rewrite frontend JavaScript

**Files:**
- Modify: `public/app.js` (entire file, 272 lines)

**Step 1: Rewrite app.js**

Replace entire `public/app.js`:

```js
// app.js
(function () {
  'use strict';

  // --- State ---
  let ws = null;
  let term = null;
  let fitAddon = null;
  let activeSessionId = null;
  let projects = [];
  let sessions = [];
  let expandedProjects = new Set();
  let reconnectDelay = 1000;

  // --- DOM refs ---
  const projectListEl = document.getElementById('project-list');
  const terminalEl = document.getElementById('terminal');
  const noSession = document.getElementById('no-session');
  const btnAddProject = document.getElementById('btn-add-project');
  const btnHomeAddProject = document.getElementById('btn-home-add-project');
  const modalOverlay = document.getElementById('modal-overlay');
  const modalProjectName = document.getElementById('modal-project-name');
  const modalProjectPath = document.getElementById('modal-project-path');
  const btnBrowse = document.getElementById('btn-browse');
  const dirBrowser = document.getElementById('dir-browser');
  const dirBreadcrumbs = document.getElementById('dir-breadcrumbs');
  const dirList = document.getElementById('dir-list');
  const btnSelectDir = document.getElementById('btn-select-dir');
  const btnModalCancel = document.getElementById('btn-modal-cancel');
  const btnModalCreate = document.getElementById('btn-modal-create');

  // --- Helpers ---
  function wsSend(data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }

  function debounce(fn, ms) {
    let timer;
    return function () {
      clearTimeout(timer);
      timer = setTimeout(fn, ms);
    };
  }

  function relativeTime(isoString) {
    const diff = Date.now() - new Date(isoString).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 30) return `${days}d ago`;
    const months = Math.floor(days / 30);
    return `${months}mo ago`;
  }

  // --- Terminal setup ---
  function initTerminal() {
    term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
      theme: {
        background: '#000000',
        foreground: '#e0e0e0',
        cursor: '#e94560',
      },
    });

    fitAddon = new FitAddon.FitAddon();
    const webLinksAddon = new WebLinksAddon.WebLinksAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.open(terminalEl);
    fitAddon.fit();

    term.onData((data) => {
      if (activeSessionId) {
        wsSend(JSON.stringify({ type: 'input', data }));
      }
    });

    const handleResize = debounce(() => {
      if (fitAddon) {
        fitAddon.fit();
        if (activeSessionId) {
          wsSend(JSON.stringify({
            type: 'resize',
            cols: term.cols,
            rows: term.rows,
          }));
        }
      }
    }, 100);

    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(terminalEl);
  }

  // --- WebSocket ---
  function connect() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${location.host}/ws`);

    ws.onopen = () => {
      reconnectDelay = 1000;
      if (activeSessionId) {
        attachSession(activeSessionId);
      }
    };

    ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }

      switch (msg.type) {
        case 'output':
          if (msg.sessionId === activeSessionId && msg.data) {
            term.write(msg.data);
          }
          break;

        case 'replay-done':
          break;

        case 'state':
          projects = msg.projects;
          sessions = msg.sessions;
          renderSidebar();
          break;

        case 'session-deleted':
          if (msg.sessionId === activeSessionId) {
            activeSessionId = null;
            term.reset();
            noSession.classList.remove('hidden');
          }
          break;

        case 'exited':
          // Session still exists, just re-render sidebar to update status dot
          renderSidebar();
          break;
      }
    };

    ws.onclose = () => {
      const jitter = reconnectDelay * (0.5 + Math.random());
      setTimeout(connect, jitter);
      reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    };

    ws.onerror = () => { ws.close(); };
  }

  function attachSession(sessionId) {
    activeSessionId = sessionId;
    term.reset();
    noSession.classList.add('hidden');

    wsSend(JSON.stringify({
      type: 'attach',
      sessionId,
      cols: term.cols,
      rows: term.rows,
    }));

    term.focus();
    renderSidebar();
  }

  // --- Sidebar ---
  function renderSidebar() {
    projectListEl.innerHTML = '';

    for (const proj of projects) {
      const group = document.createElement('div');
      group.className = 'project-group';

      // Project header
      const header = document.createElement('div');
      header.className = 'project-header';

      const arrow = document.createElement('span');
      arrow.className = 'project-arrow';
      if (expandedProjects.has(proj.id)) arrow.classList.add('expanded');
      arrow.textContent = '\u25B6';

      const name = document.createElement('span');
      name.className = 'project-name';
      name.textContent = proj.name;

      const del = document.createElement('button');
      del.className = 'project-delete';
      del.textContent = '\u00D7';
      del.title = 'Delete project';
      del.onclick = (e) => {
        e.stopPropagation();
        if (confirm(`Delete project "${proj.name}" and all its sessions?`)) {
          deleteProject(proj.id);
        }
      };

      header.appendChild(arrow);
      header.appendChild(name);
      header.appendChild(del);

      header.onclick = () => {
        if (expandedProjects.has(proj.id)) {
          expandedProjects.delete(proj.id);
        } else {
          expandedProjects.add(proj.id);
        }
        renderSidebar();
      };

      group.appendChild(header);

      // Sessions list
      const projSessions = sessions
        .filter((s) => s.projectId === proj.id)
        .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

      const ul = document.createElement('ul');
      ul.className = 'project-sessions';
      if (expandedProjects.has(proj.id)) ul.classList.add('expanded');

      for (const s of projSessions) {
        const li = document.createElement('li');
        if (s.id === activeSessionId) li.classList.add('active');

        const dot = document.createElement('span');
        dot.className = 'status-dot';
        dot.classList.add(s.alive ? 'alive' : 'exited');

        const sName = document.createElement('span');
        sName.className = 'session-name';
        sName.textContent = s.name;

        const time = document.createElement('span');
        time.className = 'session-time';
        time.textContent = relativeTime(s.createdAt);

        const sDel = document.createElement('button');
        sDel.className = 'session-delete';
        sDel.textContent = '\u00D7';
        sDel.title = 'Delete session';
        sDel.onclick = (e) => {
          e.stopPropagation();
          deleteSession(s.id);
        };

        li.appendChild(dot);
        li.appendChild(sName);
        li.appendChild(time);
        li.appendChild(sDel);

        li.onclick = () => {
          if (!s.alive && s.claudeSessionId) {
            restartSession(s.id);
          }
          attachSession(s.id);
        };

        ul.appendChild(li);
      }

      // New session button
      const newBtn = document.createElement('button');
      newBtn.className = 'btn-new-session';
      newBtn.textContent = '+ New Session';
      newBtn.onclick = (e) => {
        e.stopPropagation();
        showInlineSessionInput(ul, proj.id);
      };

      if (expandedProjects.has(proj.id)) {
        ul.appendChild(document.createElement('li')).appendChild(newBtn);
      }

      group.appendChild(ul);
      projectListEl.appendChild(group);
    }
  }

  function showInlineSessionInput(ul, projectId) {
    // Remove any existing inline input
    const existing = ul.querySelector('.inline-session-input');
    if (existing) { existing.remove(); return; }

    const input = document.createElement('input');
    input.className = 'inline-session-input';
    input.type = 'text';
    input.placeholder = 'Session name...';
    ul.insertBefore(input, ul.lastElementChild);
    input.focus();

    input.onkeydown = async (e) => {
      if (e.key === 'Enter') {
        const name = input.value.trim();
        if (!name) return;
        input.disabled = true;
        await createSession(projectId, name);
        input.remove();
      } else if (e.key === 'Escape') {
        input.remove();
      }
    };

    input.onblur = () => {
      setTimeout(() => input.remove(), 150);
    };
  }

  // --- API calls ---
  async function createProject(name, cwd) {
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, cwd }),
    });
    if (!res.ok) {
      const err = await res.json();
      alert(err.error || 'Failed to create project');
      return null;
    }
    return await res.json();
  }

  async function deleteProject(id) {
    await fetch(`/api/projects/${id}`, { method: 'DELETE' });
  }

  async function createSession(projectId, name) {
    const res = await fetch(`/api/projects/${projectId}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      const err = await res.json();
      alert(err.error || 'Failed to create session');
      return null;
    }
    const session = await res.json();
    attachSession(session.id);
    return session;
  }

  async function deleteSession(id) {
    await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
    if (activeSessionId === id) {
      activeSessionId = null;
      term.reset();
      noSession.classList.remove('hidden');
    }
  }

  async function restartSession(id) {
    await fetch(`/api/sessions/${id}/restart`, { method: 'POST' });
  }

  // --- Directory Browser ---
  let browsePath = '';

  async function loadDir(dirPath) {
    const url = dirPath
      ? `/api/browse?path=${encodeURIComponent(dirPath)}`
      : '/api/browse';
    const res = await fetch(url);
    if (!res.ok) return;
    const data = await res.json();
    browsePath = data.path;

    // Render breadcrumbs
    dirBreadcrumbs.innerHTML = '';
    const homedir = data.path.split('/').slice(0, 3).join('/'); // approximate homedir
    const segments = data.path.split('/').filter(Boolean);

    // Add ~ for home
    const homeSpan = document.createElement('span');
    homeSpan.className = 'breadcrumb';
    homeSpan.textContent = '~';
    homeSpan.onclick = () => loadDir('');
    dirBreadcrumbs.appendChild(homeSpan);

    // Build path segments relative to display
    let accumulated = '';
    for (const seg of segments) {
      accumulated += '/' + seg;
      const sep = document.createElement('span');
      sep.className = 'breadcrumb-sep';
      sep.textContent = '/';
      dirBreadcrumbs.appendChild(sep);

      const crumb = document.createElement('span');
      crumb.className = 'breadcrumb';
      crumb.textContent = seg;
      const pathForClick = accumulated;
      crumb.onclick = () => loadDir(pathForClick);
      dirBreadcrumbs.appendChild(crumb);
    }

    // Render directory list
    dirList.innerHTML = '';

    // Parent directory entry
    if (data.parent) {
      const parentLi = document.createElement('li');
      parentLi.textContent = '..';
      parentLi.onclick = () => loadDir(data.parent);
      dirList.appendChild(parentLi);
    }

    for (const d of data.dirs) {
      const li = document.createElement('li');
      li.textContent = d;
      li.onclick = () => loadDir(data.path + '/' + d);
      dirList.appendChild(li);
    }
  }

  // --- Modal ---
  function openModal() {
    modalProjectName.value = '';
    modalProjectPath.value = '';
    dirBrowser.classList.add('hidden');
    btnModalCreate.disabled = true;
    modalOverlay.classList.remove('hidden');
    modalProjectName.focus();
  }

  function closeModal() {
    modalOverlay.classList.add('hidden');
  }

  function updateCreateButton() {
    btnModalCreate.disabled = !(modalProjectName.value.trim() && modalProjectPath.value.trim());
  }

  btnAddProject.onclick = openModal;
  btnHomeAddProject.onclick = openModal;

  btnBrowse.onclick = () => {
    if (dirBrowser.classList.contains('hidden')) {
      dirBrowser.classList.remove('hidden');
      loadDir('');
    } else {
      dirBrowser.classList.add('hidden');
    }
  };

  btnSelectDir.onclick = () => {
    modalProjectPath.value = browsePath;
    dirBrowser.classList.add('hidden');
    updateCreateButton();
  };

  btnModalCancel.onclick = closeModal;

  btnModalCreate.onclick = async () => {
    const name = modalProjectName.value.trim();
    const cwd = modalProjectPath.value.trim();
    if (!name || !cwd) return;
    btnModalCreate.disabled = true;
    const proj = await createProject(name, cwd);
    if (proj) {
      expandedProjects.add(proj.id);
      closeModal();
    }
    updateCreateButton();
  };

  modalProjectName.oninput = updateCreateButton;

  modalOverlay.onclick = (e) => {
    if (e.target === modalOverlay) closeModal();
  };

  document.onkeydown = (e) => {
    if (e.key === 'Escape' && !modalOverlay.classList.contains('hidden')) {
      closeModal();
    }
  };

  // --- Init ---
  initTerminal();
  connect();
})();
```

**Step 2: Manual test**

Run: `npm start`
Open browser at `http://127.0.0.1:3000`. Verify:
- Sidebar shows "Projects" header with "+" button
- Main area shows "Add Project" button
- Clicking "Add Project" opens modal
- Browse button opens directory browser
- Can navigate directories, select one, create project
- Project appears in sidebar
- Can expand project, create session via "+ New Session"
- Terminal attaches and works
- Can delete sessions and projects

**Step 3: Commit**

```bash
git add public/app.js
git commit -m "feat: rewrite frontend JS for project-grouped sessions and directory browser"
```

---

### Task 7: Run full test suite and verify

**Files:**
- No new files

**Step 1: Run all tests**

Run: `node --test test/`
Expected: All tests pass

**Step 2: Run syntax checks**

Run: `node --check server.js && node --check pty-manager.js && node --check store.js`
Expected: No errors

**Step 3: Manual smoke test**

Run: `npm start`
Verify end-to-end: create project, create session, terminal works, delete session, delete project.

**Step 4: Commit any fixes if needed**

If tests revealed issues, fix and commit with descriptive message.

---

### Task 8: Update CLAUDE.md with browse endpoint security note

**Files:**
- Modify: `CLAUDE.md`

**Step 1: Add security note**

Add to the Gotchas section in `CLAUDE.md`:

```markdown
- /api/browse endpoint: Serves directory listings restricted to user's home directory. Server MUST remain bound to 127.0.0.1 — never expose this endpoint publicly.
```

**Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add security note about /api/browse endpoint"
```
