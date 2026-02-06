# File Viewer Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an integrated file viewer to Claude Console so users can browse worktree files in a tree panel and view them (with markdown rendering) in tabs alongside the Claude terminal.

**Architecture:** The right panel splits vertically — file tree on top (40%), shell terminal on bottom (60%), with a draggable divider. The center area gains a tab bar: a permanent "Claude" tab plus closeable file tabs. A new `GET /api/file` endpoint serves file contents scoped to session worktrees with path traversal and symlink protection. `/api/browse` gains a `sessionId` mode for server-side scoped browsing with file listing. Markdown is rendered client-side via vendored `marked.js` + `DOMPurify`.

**Tech Stack:** Express (existing), vanilla JS + xterm.js (existing), marked.js (vendor, ~40KB), DOMPurify (vendor, ~20KB).

**Design spec:** `docs/plans/2026-02-06-file-viewer-design.md`

---

### Task 1: Extend `/api/browse` with session-scoped mode and file listing

The existing `/api/browse` only returns directories and is scoped to the user's home directory. The file tree needs:
- Files in addition to directories
- Server-side scoping to the session's worktree root (not client-side path construction)
- A 200-entry soft limit per the design spec

**Files:**
- Modify: `test/browse.test.js`
- Modify: `server.js`

**Step 1: Write failing tests for session-scoped browse with files**

Add a new `describe` block at the end of `test/browse.test.js`:

```js
describe('/api/browse with sessionId (session-scoped)', () => {
  let server, baseUrl, tempDir, projectId, sessionId;

  before(async () => {
    server = createServer({ testMode: true });
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://localhost:${server.address().port}`;

    // Create temp repo with files
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-session-test-'));
    execSync('git init && git commit --allow-empty -m "init"', {
      cwd: tempDir,
      env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@test.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@test.com' },
    });

    const projRes = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'browse-session-test', cwd: tempDir }),
    });
    const proj = await projRes.json();
    projectId = proj.id;

    const sessRes = await fetch(`${baseUrl}/api/projects/${projectId}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Browse Test' }),
    });
    const session = await sessRes.json();
    sessionId = session.id;

    // Create test files in the worktree
    const wtPath = path.join(tempDir, session.worktreePath);
    fs.writeFileSync(path.join(wtPath, 'readme.md'), '# Hello');
    fs.writeFileSync(path.join(wtPath, 'app.js'), 'console.log("hi");');
    fs.mkdirSync(path.join(wtPath, 'src'));
    fs.writeFileSync(path.join(wtPath, 'src', 'index.js'), 'export default 42;');
    // Hidden file should be excluded
    fs.writeFileSync(path.join(wtPath, '.hidden'), 'secret');
  });

  after(async () => {
    await server.destroy();
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  it('returns dirs and files for session root', async () => {
    const res = await fetch(`${baseUrl}/api/browse?sessionId=${sessionId}`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.dirs), 'should have dirs');
    assert.ok(Array.isArray(data.files), 'should have files');
    assert.ok(data.files.includes('readme.md'), 'should include readme.md');
    assert.ok(data.files.includes('app.js'), 'should include app.js');
    assert.ok(!data.files.includes('.hidden'), 'should exclude hidden files');
    assert.ok(data.dirs.includes('src'), 'should include src dir');
  });

  it('returns nested directory contents', async () => {
    const res = await fetch(`${baseUrl}/api/browse?sessionId=${sessionId}&path=src`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(data.files.includes('index.js'));
  });

  it('returns 404 for unknown session', async () => {
    const res = await fetch(`${baseUrl}/api/browse?sessionId=nonexistent`);
    assert.strictEqual(res.status, 404);
  });

  it('returns 403 for path traversal', async () => {
    const res = await fetch(`${baseUrl}/api/browse?sessionId=${sessionId}&path=../../etc`);
    assert.strictEqual(res.status, 403);
  });

  it('returns 403 for absolute path', async () => {
    const res = await fetch(`${baseUrl}/api/browse?sessionId=${sessionId}&path=/etc`);
    assert.strictEqual(res.status, 403);
  });

  it('enforces 200-entry soft limit', async () => {
    // Create 210 files in worktree
    const wtPath = path.join(tempDir, (await (await fetch(`${baseUrl}/api/projects`)).json()).sessions.find(s => s.id === sessionId).worktreePath);
    fs.mkdirSync(path.join(wtPath, 'many'), { recursive: true });
    for (let i = 0; i < 210; i++) {
      fs.writeFileSync(path.join(wtPath, 'many', `file-${String(i).padStart(3, '0')}.txt`), 'x');
    }
    const res = await fetch(`${baseUrl}/api/browse?sessionId=${sessionId}&path=many`);
    const data = await res.json();
    assert.ok(data.files.length <= 200, `should cap at 200, got ${data.files.length}`);
    assert.strictEqual(data.hasMore, true, 'should indicate more entries exist');
  });
});
```

Also add `import { execSync } from 'node:child_process';` and `import fs from 'node:fs';` and `import path from 'node:path';` to the imports at the top of `test/browse.test.js` (they're not currently imported there).

**Step 2: Run tests to verify they fail**

Run: `node --test test/browse.test.js`
Expected: FAIL — session-scoped browse not implemented.

**Step 3: Add session-scoped browse to server.js**

In `server.js`, add this new handler **before** the existing `/api/browse` handler (before line 45). The existing handler continues to serve the project-creation modal's directory browser:

```js
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
```

Note: We register this as a handler that checks for `sessionId` and calls `next()` if absent, so the original `/api/browse` handler (for the project modal) still works unchanged. Express routes are matched in registration order, so this must be registered first.

**Important:** The original `/api/browse` handler (around line 45) needs to become a named handler or we need to restructure. The simplest approach: convert the original `/api/browse` to an `app.get('/api/browse', ...)` that is registered second. Since Express matches routes in order, the first handler calls `next()` when there's no `sessionId`, and the second handler runs as normal.

Actually, the simpler approach is: just register both as `app.get('/api/browse', ...)`. The first one returns early if `sessionId` is present, or calls `next()` to fall through. The second one is the existing handler. This works because Express allows multiple handlers for the same route.

**Step 4: Run tests to verify they pass**

Run: `node --test test/browse.test.js`
Expected: All tests PASS.

**Step 5: Run full test suite**

Run: `npm test`
Expected: All tests pass.

**Step 6: Commit**

```bash
git add server.js test/browse.test.js
git commit -m "feat: add session-scoped /api/browse with file listing and 200-entry limit"
```

---

### Task 2: Add `GET /api/file` endpoint — tests

**Files:**
- Create: `test/file.test.js`

**Step 1: Write failing tests for /api/file**

```js
// test/file.test.js
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createServer } from '../server.js';

const gitEnv = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@test.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@test.com',
};

function createTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-test-'));
  execSync('git init && git commit --allow-empty -m "init"', {
    cwd: dir,
    env: { ...process.env, ...gitEnv },
  });
  return dir;
}

function cleanupDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

describe('GET /api/file', () => {
  let server, baseUrl, tempDir, projectId, sessionId, worktreePath;

  before(async () => {
    server = createServer({ testMode: true });
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://localhost:${server.address().port}`;

    // Create temp repo, project, and session
    tempDir = createTempRepo();
    const projRes = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'file-test', cwd: tempDir }),
    });
    const proj = await projRes.json();
    projectId = proj.id;

    const sessRes = await fetch(`${baseUrl}/api/projects/${projectId}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'File Session' }),
    });
    const session = await sessRes.json();
    sessionId = session.id;
    worktreePath = path.join(tempDir, session.worktreePath);

    // Create test files in the worktree
    fs.writeFileSync(path.join(worktreePath, 'readme.md'), '# Hello\n\nWorld');
    fs.writeFileSync(path.join(worktreePath, 'app.js'), 'console.log("hi");');
    fs.mkdirSync(path.join(worktreePath, 'src'));
    fs.writeFileSync(path.join(worktreePath, 'src', 'index.js'), 'export default 42;');
    // Create a large file (>1MB)
    fs.writeFileSync(path.join(worktreePath, 'big.txt'), 'x'.repeat(1024 * 1024 + 1));
    // Create a binary file
    const buf = Buffer.alloc(100);
    buf[50] = 0; // null byte
    fs.writeFileSync(path.join(worktreePath, 'image.bin'), buf);
    // Create a symlink that escapes the worktree
    try {
      fs.symlinkSync('/etc/hosts', path.join(worktreePath, 'escape-link'));
    } catch {
      // Symlink creation may fail on some systems; test will be skipped
    }
  });

  after(async () => {
    await server.destroy();
    if (tempDir) cleanupDir(tempDir);
  });

  it('returns file contents for valid path', async () => {
    const res = await fetch(`${baseUrl}/api/file?sessionId=${sessionId}&path=readme.md`);
    assert.strictEqual(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('# Hello'));
  });

  it('returns nested file contents', async () => {
    const res = await fetch(`${baseUrl}/api/file?sessionId=${sessionId}&path=src/index.js`);
    assert.strictEqual(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('export default 42'));
  });

  it('returns 400 for missing sessionId', async () => {
    const res = await fetch(`${baseUrl}/api/file?path=readme.md`);
    assert.strictEqual(res.status, 400);
  });

  it('returns 400 for missing path', async () => {
    const res = await fetch(`${baseUrl}/api/file?sessionId=${sessionId}`);
    assert.strictEqual(res.status, 400);
  });

  it('returns 404 for session not found', async () => {
    const res = await fetch(`${baseUrl}/api/file?sessionId=nonexistent&path=readme.md`);
    assert.strictEqual(res.status, 404);
  });

  it('returns 404 for file not found', async () => {
    const res = await fetch(`${baseUrl}/api/file?sessionId=${sessionId}&path=nope.txt`);
    assert.strictEqual(res.status, 404);
  });

  it('returns 403 for path traversal (..)', async () => {
    const res = await fetch(`${baseUrl}/api/file?sessionId=${sessionId}&path=../../../etc/passwd`);
    assert.strictEqual(res.status, 403);
  });

  it('returns 403 for absolute path', async () => {
    const res = await fetch(`${baseUrl}/api/file?sessionId=${sessionId}&path=/etc/passwd`);
    assert.strictEqual(res.status, 403);
  });

  it('returns 413 for files over 1MB', async () => {
    const res = await fetch(`${baseUrl}/api/file?sessionId=${sessionId}&path=big.txt`);
    assert.strictEqual(res.status, 413);
  });

  it('returns isBinary flag for binary files', async () => {
    const res = await fetch(`${baseUrl}/api/file?sessionId=${sessionId}&path=image.bin`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.isBinary, true);
  });

  it('returns 403 for symlink that escapes worktree', async () => {
    // Only run if the symlink was created successfully
    const linkPath = path.join(worktreePath, 'escape-link');
    let linkExists = false;
    try { linkExists = fs.lstatSync(linkPath).isSymbolicLink(); } catch {}
    if (!linkExists) return; // skip if symlink wasn't created

    const res = await fetch(`${baseUrl}/api/file?sessionId=${sessionId}&path=escape-link`);
    assert.strictEqual(res.status, 403);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `node --test test/file.test.js`
Expected: FAIL — `/api/file` endpoint does not exist, all tests should fail.

---

### Task 3: Add `GET /api/file` endpoint — implementation

**Files:**
- Modify: `server.js` (add endpoint after the `/api/browse` handlers)

**Step 1: Add the /api/file endpoint to server.js**

Add this code after both `/api/browse` handlers and before the `// --- Helpers ---` comment:

```js
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
```

**Note on binary response format:** The design says the endpoint "returns raw file contents as text." For text files, it does exactly that. For binary files, we return JSON `{ isBinary: true }` instead of sending garbage bytes. The client detects the JSON content-type to distinguish the two cases. This is a pragmatic server-side implementation of the design's "show Binary file — not supported placeholder" requirement.

**Step 2: Run tests to verify they pass**

Run: `node --test test/file.test.js`
Expected: All tests PASS.

**Step 3: Run full test suite**

Run: `npm test`
Expected: All existing tests still pass.

**Step 4: Commit**

```bash
git add test/file.test.js server.js
git commit -m "feat: add GET /api/file endpoint with path traversal and symlink protection"
```

---

### Task 4: Vendor `marked.js` and `DOMPurify`

**Files:**
- Create: `public/vendor/marked.min.js`
- Create: `public/vendor/purify.min.js`

**Step 1: Download marked.js**

Run: `curl -L -o public/vendor/marked.min.js https://cdn.jsdelivr.net/npm/marked@15.0.7/marked.min.js`

If curl fails or the URL changes, use the latest version from the npm CDN. The file should be ~40KB.

**Step 2: Download DOMPurify**

Run: `curl -L -o public/vendor/purify.min.js https://cdn.jsdelivr.net/npm/dompurify@3.2.4/dist/purify.min.js`

The file should be ~20KB.

**Step 3: Verify the files exist and are reasonable size**

Run: `ls -la public/vendor/marked.min.js public/vendor/purify.min.js`
Expected: Both files exist, marked ~40KB, purify ~20KB.

**Step 4: Add script tags to index.html**

In `public/index.html`, add these two lines before the `<script src="/app.js"></script>` line (before line 65):

```html
  <script src="/vendor/marked.min.js"></script>
  <script src="/vendor/purify.min.js"></script>
```

**Step 5: Commit**

```bash
git add public/vendor/marked.min.js public/vendor/purify.min.js public/index.html
git commit -m "chore: vendor marked.js and DOMPurify for markdown rendering"
```

---

### Task 5: Restructure right panel — split into file tree + shell terminal

**Files:**
- Modify: `public/index.html` (restructure `#right-panel`)
- Modify: `public/style.css` (add file tree styles, modify right panel layout)

**Step 1: Update index.html right panel structure**

Replace the entire `<aside id="right-panel" ...>` block (lines 27-35) with:

```html
    <aside id="right-panel" class="hidden">
      <div id="file-tree-section">
        <div class="right-panel-header">
          <span class="right-panel-title">Files</span>
          <span id="right-panel-path"></span>
          <button id="btn-toggle-file-tree" class="panel-toggle" title="Collapse file tree">&#x25BC;</button>
        </div>
        <div id="file-tree" class="file-tree-container"></div>
      </div>
      <div id="right-panel-divider"></div>
      <div id="shell-section">
        <div class="right-panel-header">
          <span class="right-panel-title">Terminal</span>
        </div>
        <div id="shell-terminal-wrapper">
          <div id="shell-terminal"></div>
        </div>
      </div>
    </aside>
```

Note: The header includes a collapse/expand toggle button per the design spec ("Files" label + collapse/expand toggle).

**Step 2: Add CSS for the split right panel**

Replace the existing `/* --- Right panel (shell terminal) --- */` section (lines 228-274) in `public/style.css` with:

```css
/* --- Right panel (file tree + shell terminal) --- */

#right-panel {
  width: 400px;
  min-width: 400px;
  background: #1a1a2e;
  border-left: 1px solid #0f3460;
  display: flex;
  flex-direction: column;
}
#right-panel.hidden { display: none; }

#file-tree-section {
  flex: 0 0 40%;
  min-height: 100px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
#file-tree-section.collapsed {
  flex: 0 0 auto;
  min-height: 0;
}
#file-tree-section.collapsed .file-tree-container {
  display: none;
}

.panel-toggle {
  background: none;
  border: none;
  color: #6b7280;
  cursor: pointer;
  font-size: 10px;
  padding: 2px 4px;
  margin-left: auto;
}
.panel-toggle:hover { color: #e94560; }

#right-panel-divider {
  height: 4px;
  background: #0f3460;
  cursor: row-resize;
  flex-shrink: 0;
}
#right-panel-divider:hover {
  background: #e94560;
}

#shell-section {
  flex: 1;
  min-height: 100px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.right-panel-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid #0f3460;
  background: #16213e;
  flex-shrink: 0;
}

.right-panel-title {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #6b7280;
}

#right-panel-path {
  font-size: 11px;
  color: #569cd6;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}

/* File tree */

.file-tree-container {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}

.file-tree-item {
  display: flex;
  align-items: center;
  padding: 3px 8px;
  cursor: pointer;
  font-size: 12px;
  color: #d4d4d4;
  white-space: nowrap;
  user-select: none;
}
.file-tree-item:hover {
  background: #0f3460;
}

.file-tree-arrow {
  width: 16px;
  font-size: 10px;
  color: #6b7280;
  text-align: center;
  flex-shrink: 0;
}

.file-tree-label {
  overflow: hidden;
  text-overflow: ellipsis;
}

.file-tree-folder > .file-tree-label {
  color: #569cd6;
}

.file-tree-children {
  display: none;
}
.file-tree-children.expanded {
  display: block;
}

.file-tree-loading {
  padding: 4px 8px 4px 32px;
  font-size: 11px;
  color: #6b7280;
  font-style: italic;
}

.file-tree-more {
  padding: 3px 8px;
  font-size: 11px;
  color: #e94560;
  cursor: pointer;
  user-select: none;
}
.file-tree-more:hover {
  text-decoration: underline;
}

#shell-terminal-wrapper {
  flex: 1;
  position: relative;
}

#shell-terminal {
  position: absolute;
  inset: 0;
  padding: 8px;
}
```

**Step 3: Commit**

```bash
git add public/index.html public/style.css
git commit -m "feat: split right panel into file tree + shell terminal with collapse toggle"
```

---

### Task 6: Add center area tab bar and file viewer

**Files:**
- Modify: `public/index.html` (add tab bar to main area)
- Modify: `public/style.css` (add tab bar and file viewer styles)

**Step 1: Update index.html center area**

Replace the `<main id="terminal-container">` block (lines 19-26) with:

```html
    <main id="terminal-container">
      <div id="tab-bar">
        <div id="tab-list"></div>
      </div>
      <div id="terminal-wrapper">
        <div id="terminal"></div>
      </div>
      <div id="file-viewer" class="hidden">
        <div id="file-viewer-toolbar">
          <span id="file-viewer-path"></span>
          <button id="file-viewer-refresh" title="Refresh">Refresh</button>
        </div>
        <div id="file-viewer-content"></div>
      </div>
      <div id="no-session">
        <button id="btn-home-add-project" class="home-add-btn">Add Project</button>
      </div>
    </main>
```

**Step 2: Add CSS for tabs and file viewer**

First, update the existing `#terminal-wrapper` rule (around line 197-201). Change it to:

```css
#terminal-wrapper {
  position: absolute;
  inset: 0;
  padding: 12px;
}
```

Note: `#terminal-wrapper` keeps `inset: 0`. The tab bar height is accounted for dynamically — when a session is active, JS sets `inset` to `32px 0 0 0`; when no session, it remains `0`. This avoids the 32px gap bug.

Then append these styles to `public/style.css`:

```css
/* --- Tab bar --- */

#tab-bar {
  height: 32px;
  background: #16213e;
  border-bottom: 1px solid #0f3460;
  display: none;
  align-items: center;
  padding: 0 4px;
  overflow-x: auto;
  flex-shrink: 0;
  position: relative;
  z-index: 2;
}
#tab-bar.visible {
  display: flex;
}

#tab-list {
  display: flex;
  gap: 2px;
  align-items: center;
}

.tab {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  font-size: 12px;
  color: #6b7280;
  cursor: pointer;
  border-radius: 4px 4px 0 0;
  white-space: nowrap;
  max-width: 180px;
  user-select: none;
}
.tab:hover {
  color: #d4d4d4;
  background: #1a1a2e;
}
.tab.active {
  color: #d4d4d4;
  background: #1a1a2e;
  border-bottom: 2px solid #e94560;
}

.tab-label {
  overflow: hidden;
  text-overflow: ellipsis;
}

.tab-close {
  font-size: 14px;
  color: #6b7280;
  cursor: pointer;
  line-height: 1;
  padding: 0 2px;
  border: none;
  background: none;
}
.tab-close:hover {
  color: #e94560;
}

/* --- File viewer --- */

#file-viewer {
  position: absolute;
  inset: 32px 0 0 0; /* below tab bar */
  display: flex;
  flex-direction: column;
  background: #1a1a2e;
}
#file-viewer.hidden {
  display: none;
}

#file-viewer-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  border-bottom: 1px solid #0f3460;
  background: #16213e;
  flex-shrink: 0;
}

#file-viewer-path {
  font-size: 12px;
  color: #569cd6;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

#file-viewer-refresh {
  padding: 2px 8px;
  font-size: 11px;
  background: #0f3460;
  color: #e0e0e0;
  border: none;
  border-radius: 3px;
  cursor: pointer;
}
#file-viewer-refresh:hover {
  background: #e94560;
}

#file-viewer-content {
  flex: 1;
  overflow: auto;
  padding: 16px 20px;
}

/* Markdown rendered content */
#file-viewer-content.markdown-body {
  color: #d4d4d4;
  line-height: 1.6;
}
#file-viewer-content.markdown-body h1,
#file-viewer-content.markdown-body h2,
#file-viewer-content.markdown-body h3 {
  color: #e0e0e0;
  margin: 1.2em 0 0.4em;
  border-bottom: 1px solid #0f3460;
  padding-bottom: 4px;
}
#file-viewer-content.markdown-body h1 { font-size: 1.6em; }
#file-viewer-content.markdown-body h2 { font-size: 1.3em; }
#file-viewer-content.markdown-body h3 { font-size: 1.1em; }
#file-viewer-content.markdown-body p { margin: 0.6em 0; }
#file-viewer-content.markdown-body code {
  background: #0f3460;
  padding: 2px 5px;
  border-radius: 3px;
  font-size: 0.9em;
  font-family: Menlo, Monaco, 'Courier New', monospace;
  color: #ce9178;
}
#file-viewer-content.markdown-body pre {
  background: #0d1117;
  border: 1px solid #0f3460;
  border-radius: 6px;
  padding: 12px 16px;
  overflow-x: auto;
  margin: 0.8em 0;
}
#file-viewer-content.markdown-body pre code {
  background: none;
  padding: 0;
  font-size: 13px;
  line-height: 1.5;
  color: #d4d4d4;
}

/* CSS-only syntax highlighting for fenced code blocks.
   marked.js adds language-* classes to <code> elements inside <pre>.
   We use attribute selectors to style tokens via CSS where possible.
   Full token-level highlighting would require a JS tokenizer (e.g., Prism.js);
   these rules provide visual differentiation for code vs prose. */
#file-viewer-content.markdown-body pre code[class*="language-"] {
  color: #d4d4d4;
}

#file-viewer-content.markdown-body ul,
#file-viewer-content.markdown-body ol {
  padding-left: 1.5em;
  margin: 0.6em 0;
}
#file-viewer-content.markdown-body li {
  margin: 0.2em 0;
}
#file-viewer-content.markdown-body table {
  border-collapse: collapse;
  margin: 0.8em 0;
  width: 100%;
}
#file-viewer-content.markdown-body th,
#file-viewer-content.markdown-body td {
  border: 1px solid #0f3460;
  padding: 6px 10px;
  text-align: left;
}
#file-viewer-content.markdown-body th {
  background: #16213e;
  font-weight: 600;
}
#file-viewer-content.markdown-body blockquote {
  border-left: 3px solid #e94560;
  padding: 4px 12px;
  margin: 0.6em 0;
  color: #9ca3af;
}
#file-viewer-content.markdown-body a {
  color: #569cd6;
}
#file-viewer-content.markdown-body img {
  max-width: 100%;
}

/* Plain text file viewer */
#file-viewer-content.plain-text {
  white-space: pre-wrap;
  font-family: Menlo, Monaco, 'Courier New', monospace;
  font-size: 13px;
  line-height: 1.5;
  color: #d4d4d4;
}

/* Binary file placeholder */
#file-viewer-content.binary-file {
  display: flex;
  align-items: center;
  justify-content: center;
  color: #6b7280;
  font-size: 14px;
}
```

**Step 3: Commit**

```bash
git add public/index.html public/style.css
git commit -m "feat: add tab bar and file viewer container to center area"
```

---

### Task 7: Implement file tree rendering in app.js

**Files:**
- Modify: `public/app.js` (add file tree loading, rendering, expand/collapse, "Show more", collapse toggle)

**Step 1: Add file tree state and DOM refs**

At the top of app.js, after the existing state variables (after line 16 where `shellFitAddon` is declared), add:

```js
  let expandedDirs = new Set(); // tracks expanded directory paths in file tree
  let openTabs = []; // { id, filename, fullPath, content, type }
  let activeTabId = 'claude';
```

After the existing DOM refs (after line 36 where `rightPanelPath` is declared), add:

```js
  const fileTreeEl = document.getElementById('file-tree');
  const tabBar = document.getElementById('tab-bar');
  const tabList = document.getElementById('tab-list');
  const fileViewer = document.getElementById('file-viewer');
  const fileViewerPath = document.getElementById('file-viewer-path');
  const fileViewerRefresh = document.getElementById('file-viewer-refresh');
  const fileViewerContent = document.getElementById('file-viewer-content');
  const btnToggleFileTree = document.getElementById('btn-toggle-file-tree');
  const fileTreeSection = document.getElementById('file-tree-section');
```

**Step 2: Add file tree functions**

Add before the `// --- Init ---` section:

```js
  // --- File Tree ---

  async function fetchDirEntries(relativePath) {
    if (!activeSessionId) return { dirs: [], files: [], hasMore: false };
    const params = new URLSearchParams({ sessionId: activeSessionId });
    if (relativePath) params.set('path', relativePath);
    const res = await fetch(`/api/browse?${params}`);
    if (!res.ok) return { dirs: [], files: [], hasMore: false };
    const data = await res.json();
    return {
      dirs: data.dirs || [],
      files: data.files || [],
      hasMore: data.hasMore || false,
    };
  }

  async function renderFileTreeDir(container, relativePath, depth) {
    container.innerHTML = '';

    const loading = document.createElement('div');
    loading.className = 'file-tree-loading';
    loading.textContent = 'Loading\u2026';
    container.appendChild(loading);

    const { dirs, files, hasMore } = await fetchDirEntries(relativePath);
    container.innerHTML = '';

    const indent = depth * 16;

    // Render directories first
    for (const dir of dirs) {
      const dirPath = relativePath ? relativePath + '/' + dir : dir;
      const item = document.createElement('div');

      const row = document.createElement('div');
      row.className = 'file-tree-item file-tree-folder';
      row.style.paddingLeft = indent + 'px';

      const arrow = document.createElement('span');
      arrow.className = 'file-tree-arrow';
      arrow.textContent = expandedDirs.has(dirPath) ? '\u25BC' : '\u25B6';

      const label = document.createElement('span');
      label.className = 'file-tree-label';
      label.textContent = dir;

      row.appendChild(arrow);
      row.appendChild(label);

      const children = document.createElement('div');
      children.className = 'file-tree-children';
      if (expandedDirs.has(dirPath)) {
        children.classList.add('expanded');
        renderFileTreeDir(children, dirPath, depth + 1);
      }

      row.onclick = () => {
        if (expandedDirs.has(dirPath)) {
          expandedDirs.delete(dirPath);
          arrow.textContent = '\u25B6';
          children.classList.remove('expanded');
          children.innerHTML = '';
        } else {
          expandedDirs.add(dirPath);
          arrow.textContent = '\u25BC';
          children.classList.add('expanded');
          renderFileTreeDir(children, dirPath, depth + 1);
        }
      };

      item.appendChild(row);
      item.appendChild(children);
      container.appendChild(item);
    }

    // Render files
    for (const file of files) {
      const filePath = relativePath ? relativePath + '/' + file : file;

      const row = document.createElement('div');
      row.className = 'file-tree-item';
      row.style.paddingLeft = (indent + 16) + 'px';

      const label = document.createElement('span');
      label.className = 'file-tree-label';
      label.textContent = file;
      label.title = filePath;

      row.appendChild(label);
      row.onclick = () => openFileTab(filePath, file);
      container.appendChild(row);
    }

    // "Show more" indicator when entries were truncated
    if (hasMore) {
      const more = document.createElement('div');
      more.className = 'file-tree-more';
      more.style.paddingLeft = indent + 'px';
      more.textContent = 'More entries not shown\u2026';
      container.appendChild(more);
    }

    // Show message if empty
    if (dirs.length === 0 && files.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'file-tree-loading';
      empty.textContent = 'Empty directory';
      container.appendChild(empty);
    }
  }

  function initFileTree() {
    if (!activeSessionId) {
      fileTreeEl.innerHTML = '';
      return;
    }
    expandedDirs.clear();
    renderFileTreeDir(fileTreeEl, '', 0);
  }

  // File tree collapse/expand toggle
  btnToggleFileTree.onclick = () => {
    const isCollapsed = fileTreeSection.classList.toggle('collapsed');
    btnToggleFileTree.innerHTML = isCollapsed ? '&#x25B6;' : '&#x25BC;';
    btnToggleFileTree.title = isCollapsed ? 'Expand file tree' : 'Collapse file tree';
    // Refit shell terminal after layout change
    requestAnimationFrame(() => {
      if (shellFitAddon) shellFitAddon.fit();
    });
  };
```

**Step 3: Commit**

```bash
git add public/app.js
git commit -m "feat: implement file tree with session-scoped browsing and 200-entry limit"
```

---

### Task 8: Implement tab system and file viewer in app.js

**Files:**
- Modify: `public/app.js` (add tab management, file rendering, keyboard shortcuts)

**Step 1: Add tab rendering and file viewing functions**

Add after the file tree functions (before `// --- Init ---`):

```js
  // --- Tab System ---

  function renderTabs() {
    if (!activeSessionId) {
      tabBar.classList.remove('visible');
      return;
    }
    tabBar.classList.add('visible');
    tabList.innerHTML = '';

    // Claude tab (always first, never closeable)
    const claudeTab = document.createElement('div');
    claudeTab.className = 'tab' + (activeTabId === 'claude' ? ' active' : '');
    const claudeLabel = document.createElement('span');
    claudeLabel.className = 'tab-label';
    claudeLabel.textContent = 'Claude';
    claudeTab.appendChild(claudeLabel);
    claudeTab.onclick = () => switchTab('claude');
    tabList.appendChild(claudeTab);

    // File tabs
    for (const tab of openTabs) {
      const el = document.createElement('div');
      el.className = 'tab' + (activeTabId === tab.id ? ' active' : '');
      el.title = tab.fullPath;

      const label = document.createElement('span');
      label.className = 'tab-label';
      label.textContent = tab.filename;

      const close = document.createElement('button');
      close.className = 'tab-close';
      close.textContent = '\u00D7';
      close.onclick = (e) => {
        e.stopPropagation();
        closeTab(tab.id);
      };

      el.appendChild(label);
      el.appendChild(close);
      el.onclick = () => switchTab(tab.id);
      tabList.appendChild(el);
    }
  }

  function switchTab(tabId) {
    activeTabId = tabId;
    renderTabs();

    const termWrapper = document.getElementById('terminal-wrapper');

    if (tabId === 'claude') {
      // Show terminal, hide file viewer
      termWrapper.style.display = '';
      termWrapper.style.inset = '32px 0 0 0';
      fileViewer.classList.add('hidden');
      term.focus();
      // Refit terminal since we changed inset
      requestAnimationFrame(() => { if (fitAddon) fitAddon.fit(); });
    } else {
      // Show file viewer, hide terminal
      termWrapper.style.display = 'none';
      fileViewer.classList.remove('hidden');

      const tab = openTabs.find(t => t.id === tabId);
      if (tab) {
        renderFileContent(tab);
      }
    }
  }

  function closeTab(tabId) {
    openTabs = openTabs.filter(t => t.id !== tabId);
    if (activeTabId === tabId) {
      activeTabId = openTabs.length > 0 ? openTabs[openTabs.length - 1].id : 'claude';
    }
    switchTab(activeTabId);
  }

  async function openFileTab(filePath, filename) {
    // Check if already open
    const existing = openTabs.find(t => t.id === filePath);
    if (existing) {
      switchTab(existing.id);
      return;
    }

    // Fetch file content
    const res = await fetch(`/api/file?sessionId=${activeSessionId}&path=${encodeURIComponent(filePath)}`);

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Failed to load file' }));
      showToast(err.error || 'Failed to load file', 'error');
      return;
    }

    const contentType = res.headers.get('content-type') || '';
    let tab;

    if (contentType.includes('application/json')) {
      // Binary file response
      const data = await res.json();
      if (data.isBinary) {
        tab = { id: filePath, filename, fullPath: filePath, content: null, type: 'binary' };
      }
    } else {
      const content = await res.text();
      const ext = filename.split('.').pop().toLowerCase();
      const type = (ext === 'md' || ext === 'markdown') ? 'markdown' : 'text';
      tab = { id: filePath, filename, fullPath: filePath, content, type };
    }

    if (tab) {
      openTabs.push(tab);
      switchTab(tab.id);
    }
  }

  function renderFileContent(tab) {
    fileViewerPath.textContent = tab.fullPath;
    fileViewerContent.innerHTML = '';
    fileViewerContent.className = '';

    if (tab.type === 'binary') {
      fileViewerContent.className = 'binary-file';
      fileViewerContent.textContent = 'Binary file \u2014 not supported';
      return;
    }

    if (tab.type === 'markdown') {
      fileViewerContent.className = 'markdown-body';
      const rawHtml = marked.parse(tab.content);
      fileViewerContent.innerHTML = DOMPurify.sanitize(rawHtml);
      return;
    }

    // Plain text
    fileViewerContent.className = 'plain-text';
    fileViewerContent.textContent = tab.content;
  }

  // Refresh button handler
  fileViewerRefresh.onclick = async () => {
    const tab = openTabs.find(t => t.id === activeTabId);
    if (!tab || tab.type === 'binary') return;

    const res = await fetch(`/api/file?sessionId=${activeSessionId}&path=${encodeURIComponent(tab.fullPath)}`);
    if (!res.ok) {
      showToast('Failed to refresh file', 'error');
      return;
    }

    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const data = await res.json();
      if (data.isBinary) {
        tab.type = 'binary';
        tab.content = null;
      }
    } else {
      tab.content = await res.text();
    }

    renderFileContent(tab);
  };

  // Keyboard shortcuts (only when terminal is NOT focused)
  document.addEventListener('keydown', (e) => {
    const inTerminal = terminalEl.contains(document.activeElement) ||
                       shellTerminalEl.contains(document.activeElement);
    if (inTerminal) return;

    if (e.altKey && e.key === 'Tab') {
      e.preventDefault();
      const allIds = ['claude', ...openTabs.map(t => t.id)];
      const idx = allIds.indexOf(activeTabId);
      const nextIdx = (idx + 1) % allIds.length;
      switchTab(allIds[nextIdx]);
    }

    if (e.altKey && e.key === 'w') {
      e.preventDefault();
      if (activeTabId !== 'claude') {
        closeTab(activeTabId);
      }
    }
  });
```

**Step 2: Commit**

```bash
git add public/app.js
git commit -m "feat: implement tab system and file viewer with markdown rendering"
```

---

### Task 9: Wire everything together — session switching and divider drag

**Files:**
- Modify: `public/app.js` (update `attachSession`, session-clear paths, add divider drag)

**Step 1: Update `attachSession` to initialize file tree and tabs**

In the existing `attachSession` function, after `rightPanel.classList.remove('hidden')` and the path display update (around line 401), add:

```js
      // Reset tabs and file tree for new session
      openTabs = [];
      activeTabId = 'claude';
      switchTab('claude');
      renderTabs();
      initFileTree();
```

**Step 2: Update session-cleared paths to reset UI state**

In the `state` message handler (inside `ws.onmessage`, the `case 'state':` block), where `activeSessionId = null` is set, add after `rightPanel.classList.add('hidden')`:

```js
            tabBar.classList.remove('visible');
            fileViewer.classList.add('hidden');
            document.getElementById('terminal-wrapper').style.display = '';
            document.getElementById('terminal-wrapper').style.inset = '0';
```

Add the same four lines in the `session-deleted` handler (after `rightPanel.classList.add('hidden')`).

**Step 3: Add divider drag logic with proper debouncing**

Add before the `// --- Init ---` section:

```js
  // --- Right Panel Divider Drag ---

  const divider = document.getElementById('right-panel-divider');
  const shellSection = document.getElementById('shell-section');

  let isDragging = false;
  let rafPending = false;

  divider.addEventListener('mousedown', (e) => {
    isDragging = true;
    e.preventDefault();
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    if (rafPending) return; // true single-frame debounce

    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      const panelRect = rightPanel.getBoundingClientRect();
      const offset = e.clientY - panelRect.top;
      const total = panelRect.height;
      const minHeight = 100;

      if (offset < minHeight || total - offset < minHeight) return;

      const pct = (offset / total) * 100;
      fileTreeSection.style.flex = `0 0 ${pct}%`;

      if (shellFitAddon) shellFitAddon.fit();
    });
  });

  document.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      if (shellFitAddon) shellFitAddon.fit();
    }
  });
```

Note: Uses `rafPending` flag to ensure only one `requestAnimationFrame` callback is queued at a time, preventing multiple frames from stacking during rapid `mousemove` events.

**Step 4: Commit**

```bash
git add public/app.js
git commit -m "feat: wire file tree, tabs, and divider drag to session lifecycle"
```

---

### Task 10: Verify everything works — syntax check + test suite + UI smoke test

**Files:**
- None modified (verification only)

**Step 1: Run syntax check on all modified files**

Run: `node --check server.js && node --check pty-manager.js && node --check store.js`
Expected: All pass with no output.

**Step 2: Run the full test suite**

Run: `npm test`
Expected: All tests pass (existing + new file.test.js + updated browse.test.js).

**Step 3: UI smoke test**

Run: Start server with `npm start`, then use Playwright MCP to:
1. Navigate to `http://127.0.0.1:3000`
2. Verify sidebar shows "Projects" header with "+" button
3. Create a project and session
4. Verify the right panel shows two sections: "Files" header (with collapse toggle) on top and "Terminal" header on bottom
5. Verify the file tree loads entries (dirs and files)
6. Click a `.md` file → verify it opens in a new tab with rendered markdown (headings, code blocks styled)
7. Click a `.js` file → verify it opens as plain text in monospace
8. Verify the "Claude" tab is always present and clicking it returns to the terminal
9. Verify the close button (x) removes file tabs
10. Verify `Alt+Tab` cycles tabs and `Alt+W` closes the active file tab
11. Verify the divider between file tree and shell is draggable
12. Click the collapse toggle in the "Files" header → verify file tree collapses and shell expands
13. Verify no 32px gap appears above the terminal when returning to Claude tab
14. If a directory has >200 entries, verify "More entries not shown..." message appears

**Step 4: Final commit (if any smoke test fixes needed)**

```bash
git add -A
git commit -m "fix: address smoke test issues"
```

---

## Summary of Tasks

| Task | Description | Files |
|------|-------------|-------|
| 1 | Session-scoped `/api/browse` with files + 200-entry limit | `server.js`, `test/browse.test.js` |
| 2 | Write tests for `/api/file` (incl. symlink escape) | `test/file.test.js` |
| 3 | Implement `/api/file` endpoint | `server.js` |
| 4 | Vendor `marked.js` and `DOMPurify` | `public/vendor/`, `public/index.html` |
| 5 | Split right panel into file tree + shell (with collapse toggle) | `public/index.html`, `public/style.css` |
| 6 | Add tab bar and file viewer to center area | `public/index.html`, `public/style.css` |
| 7 | Implement file tree rendering (with "Show more") | `public/app.js` |
| 8 | Implement tab system and file viewer | `public/app.js` |
| 9 | Wire together: session switching, divider drag (debounced) | `public/app.js` |
| 10 | Verify: syntax check, test suite, UI smoke test | (none) |

## Implementation Progress

All tasks executed via subagent-driven development on branch `claude/create-file-viewer-69584a8`.

| Task | Status | Commit | Notes |
|------|--------|--------|-------|
| 1 | ✅ Done | `f6f6e19` | Session-scoped `/api/browse` with 200-entry limit, path traversal/symlink protection |
| 2 | ✅ Done | `56d1875` | 11 tests for `/api/file` (TDD red phase) |
| 3 | ✅ Done | `0654d9b` | `/api/file` endpoint — all 11 tests pass |
| 4 | ✅ Done | `76df029` | Vendored marked.js v15.0.7 (~40KB) + DOMPurify v3.2.4 (~22KB) |
| 5 | ✅ Done | `08fb6a3` | Right panel split: file tree (40%) + shell (60%) + divider + collapse toggle |
| 6 | ✅ Done | (bundled in `08fb6a3`) | Tab bar + file viewer HTML/CSS appended to center area |
| 7 | ✅ Done | `d700a62` | File tree rendering with expand/collapse, "Show more" indicator |
| 8 | ✅ Done | `e67a71c` | Tab system, markdown/text/binary rendering, keyboard shortcuts |
| 9 | ✅ Done | `ed6ec02` | Session lifecycle wiring, divider drag with RAF debounce |
| 10 | ✅ Done | — | Syntax checks pass, 113/113 unit tests pass, 33/33 smoke test checks pass |

### Verification Results

- **Syntax check**: `node --check server.js && node --check pty-manager.js && node --check store.js && node --check public/app.js` — all pass
- **Unit tests**: `npm test` — 113 tests, 23 suites, 0 failures
- **UI smoke test**: `npm run test:smoke` — 33 Playwright checks, 0 failures
  - Initial layout, project/session creation, right panel structure
  - File tree loading, directory expand, "Show more" truncation
  - Markdown rendering (headings, HTML), plain text rendering
  - Tab switching, Claude tab, file tab close
  - File tree collapse/expand toggle
  - No 32px gap bug

### Remaining

- [ ] Commit smoke test + package.json changes
- [ ] Finish branch (merge/PR)

## Review Findings Addressed

| Finding | Resolution |
|---------|------------|
| Missing file tree collapse/expand toggle | Task 5: added `#btn-toggle-file-tree` button + `.collapsed` CSS state |
| Missing 200-entry soft limit + "Show more" | Task 1: server returns `hasMore` flag at 200 entries; Task 7: renders "More entries not shown..." |
| CSS-only syntax highlighting | Task 6: styled code blocks with language-aware classes; noted limitation that full token highlighting needs a JS tokenizer |
| Binary file response format | Task 3: documented as pragmatic implementation — JSON for binary, text/plain for text |
| Directory entry limit 500 vs 200 | Task 1: changed to `BROWSE_ENTRY_LIMIT = 200` |
| No server-side scoping for /api/browse | Task 1: new session-scoped handler resolves worktree root server-side, validates all paths |
| Client-side path construction | Task 7: client sends only `sessionId` + relative path; server does all path resolution |
| Divider drag queueing | Task 9: `rafPending` flag ensures single-frame debounce |
| 32px gap when tab bar hidden | Task 8/9: `#terminal-wrapper` inset managed dynamically via JS; defaults to `inset: 0` |
| Task ordering (browse extension before UI) | Task 1 is now the session-scoped browse, before any UI tasks |
| False start block in old Task 6 | Removed entirely; clean plan from scratch |
| Missing symlink-escape test | Task 2: added `escape-link` symlink test |
| Missing 200-entry limit tests | Task 1: added `enforces 200-entry soft limit` test with `hasMore` assertion |
| Missing /api/browse scoping tests | Task 1: path traversal, absolute path, and session-not-found tests |
| Keyboard shortcut coverage | Task 10: added to smoke test checklist (items 10, 13) |
