# Worktree Orphan Cleanup Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Automatically detect and remove orphaned git worktrees that accumulate when sessions are lost due to DB corruption, crashes, or test leftovers.

**Architecture:** A `cleanupOrphanedWorktrees()` function in `git-worktree.js` compares `git worktree list` output against DB sessions per project. Orphaned worktrees (registered with git but no matching session) that are clean and older than 10 minutes get removed. The server runs this on startup and every 6 hours, with an overlap guard.

**Tech Stack:** Node.js (ESM), `child_process.execFile`, `better-sqlite3`, `node:test` for tests

---

## Background

Worktrees live at `<project.cwd>/.worktrees/<branchName>`. Each session in the DB has `worktree_path` (e.g., `.worktrees/fix-bug-a1b2c3d`) and `branch_name` (e.g., `fix-bug-a1b2c3d`). The full git branch is `claude/<branchName>`.

When sessions are lost (DB corruption, crash), their worktrees become orphans — registered with git but no DB record. Currently 73 such orphans exist.

Key safety constraints from the design doc:
- Never delete branches during cleanup (only worktree directories)
- Never remove dirty worktrees (uncommitted changes)
- 10-minute grace period for newly created worktrees
- Per-project mutex acquired per individual orphan removal (not full sweep)
- Best-effort: errors on individual orphans don't abort the sweep
- Cleanup disabled in test mode

---

### Task 1: Add `getSessionWorktreePaths(projectId)` to store

We need a way to query all worktree paths for a given project so the cleanup function can compare against git's list.

**Files:**
- Modify: `store.js:72-86` (prepared statements section)
- Modify: `store.js:88-156` (store methods section)
- Test: `test/store.test.js` (new file)

**Step 1: Write the failing test**

Create `test/store.test.js`:

```javascript
// test/store.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createStore } from '../store.js';

describe('store.getSessionWorktreePaths', () => {
  it('returns worktree paths for sessions with worktreePath set', () => {
    const store = createStore(':memory:');

    store.createProject({
      id: 'p1',
      name: 'test-project',
      cwd: '/tmp/repo',
      createdAt: new Date().toISOString(),
    });

    store.createSession({
      id: 's1',
      projectId: 'p1',
      name: 'session-1',
      branchName: 'fix-bug-abc1234',
      worktreePath: '.worktrees/fix-bug-abc1234',
      claudeSessionId: null,
      status: 'running',
      createdAt: new Date().toISOString(),
    });

    store.createSession({
      id: 's2',
      projectId: 'p1',
      name: 'session-2',
      branchName: null,
      worktreePath: null,
      claudeSessionId: null,
      status: 'running',
      createdAt: new Date().toISOString(),
    });

    const paths = store.getSessionWorktreePaths('p1');
    assert.deepStrictEqual(paths, ['.worktrees/fix-bug-abc1234']);

    store.close();
  });

  it('returns empty array when no sessions have worktree paths', () => {
    const store = createStore(':memory:');

    store.createProject({
      id: 'p1',
      name: 'test-project',
      cwd: '/tmp/repo',
      createdAt: new Date().toISOString(),
    });

    const paths = store.getSessionWorktreePaths('p1');
    assert.deepStrictEqual(paths, []);

    store.close();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `node --test test/store.test.js`
Expected: FAIL with "store.getSessionWorktreePaths is not a function"

**Step 3: Write minimal implementation**

In `store.js`, add a prepared statement after line 85 (`deleteSession`):

```javascript
getSessionWorktreePaths: db.prepare(
  'SELECT worktree_path FROM sessions WHERE project_id = ? AND worktree_path IS NOT NULL'
),
```

Then add the method to the returned store object (after `deleteSession` method, around line 144):

```javascript
getSessionWorktreePaths(projectId) {
  return stmts.getSessionWorktreePaths.all(projectId).map(row => row.worktree_path);
},
```

**Step 4: Run test to verify it passes**

Run: `node --test test/store.test.js`
Expected: PASS

**Step 5: Run full test suite**

Run: `npm test`
Expected: All existing tests still pass

**Step 6: Commit**

```bash
git add store.js test/store.test.js
git commit -m "feat: add getSessionWorktreePaths to store for orphan cleanup"
```

---

### Task 2: Add `listProjectWorktrees(projectDir)` to git-worktree.js

Parse `git worktree list --porcelain` to get all registered worktrees under `.worktrees/` with their creation times.

**Files:**
- Modify: `git-worktree.js` (add new exported function after `worktreeExists` at line 415)
- Test: `test/git-worktree.test.js` (add new describe block)

**Step 1: Write the failing test**

Add to `test/git-worktree.test.js`, importing the new function at line 8:

```javascript
// Add to imports at line 8:
// import { ..., listProjectWorktrees } from '../git-worktree.js';

describe('listProjectWorktrees', () => {
  let tempDir;

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('returns worktree paths under .worktrees/', async () => {
    tempDir = createTempRepo();
    fs.mkdirSync(path.join(tempDir, '.worktrees'));
    execSync('git worktree add -b claude/branch-1 .worktrees/branch-1', {
      cwd: tempDir,
      env: { ...process.env, ...gitEnv },
    });
    execSync('git worktree add -b claude/branch-2 .worktrees/branch-2', {
      cwd: tempDir,
      env: { ...process.env, ...gitEnv },
    });

    const worktrees = await listProjectWorktrees(tempDir);
    const relativePaths = worktrees.map(w => w.relativePath).sort();
    assert.deepStrictEqual(relativePaths, [
      '.worktrees/branch-1',
      '.worktrees/branch-2',
    ]);
  });

  it('excludes main worktree (repo root)', async () => {
    tempDir = createTempRepo();
    const worktrees = await listProjectWorktrees(tempDir);
    assert.strictEqual(worktrees.length, 0);
  });

  it('excludes worktrees outside .worktrees/', async () => {
    tempDir = createTempRepo();
    // Create a worktree in a different location
    const otherPath = path.join(tempDir, 'other-worktree');
    execSync(`git worktree add -b claude/other "${otherPath}"`, {
      cwd: tempDir,
      env: { ...process.env, ...gitEnv },
    });

    const worktrees = await listProjectWorktrees(tempDir);
    assert.strictEqual(worktrees.length, 0);
  });

  it('returns empty array when .worktrees dir validation fails', async () => {
    tempDir = createTempRepo();
    // Make .worktrees a file (not a directory)
    fs.writeFileSync(path.join(tempDir, '.worktrees'), 'not a directory');
    const worktrees = await listProjectWorktrees(tempDir);
    assert.strictEqual(worktrees.length, 0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `node --test test/git-worktree.test.js`
Expected: FAIL with "listProjectWorktrees is not a function" or import error

**Step 3: Write minimal implementation**

Add to `git-worktree.js` after line 415 (after `worktreeExists`):

```javascript
/**
 * List all registered git worktrees under .worktrees/ for a project
 * @param {string} projectDir - Project root directory
 * @returns {Promise<Array<{absolutePath: string, relativePath: string}>>}
 */
export async function listProjectWorktrees(projectDir) {
  // Validate .worktrees directory safety
  const dirValidation = await validateWorktreesDir(projectDir);
  if (!dirValidation.valid) {
    return [];
  }

  let stdout;
  try {
    const result = await execFileAsync(
      'git',
      ['worktree', 'list', '--porcelain'],
      { cwd: projectDir }
    );
    stdout = result.stdout;
  } catch {
    return [];
  }

  const resolvedProject = await fs.promises.realpath(projectDir).catch(() => path.resolve(projectDir));
  const worktreesDir = path.join(resolvedProject, '.worktrees');

  const worktrees = [];
  const lines = stdout.split('\n');
  for (const line of lines) {
    if (!line.startsWith('worktree ')) continue;
    const absPath = line.slice('worktree '.length);
    const resolved = await fs.promises.realpath(absPath).catch(() => path.resolve(absPath));

    // Only include worktrees under .worktrees/
    if (!resolved.startsWith(worktreesDir + path.sep)) continue;

    const relativePath = path.relative(resolvedProject, resolved);
    worktrees.push({ absolutePath: resolved, relativePath });
  }

  return worktrees;
}
```

**Step 4: Run test to verify it passes**

Run: `node --test test/git-worktree.test.js`
Expected: All tests PASS (new + existing)

**Step 5: Commit**

```bash
git add git-worktree.js test/git-worktree.test.js
git commit -m "feat: add listProjectWorktrees for orphan detection"
```

---

### Task 3: Implement `cleanupOrphanedWorktrees(store)` in git-worktree.js

The core cleanup function. Iterates all projects, finds orphans, removes clean ones older than 10 minutes.

**Files:**
- Modify: `git-worktree.js` (add new exported function after `listProjectWorktrees`)
- Test: `test/git-worktree.test.js` (add new describe block)

**Step 1: Write the failing test**

Add to `test/git-worktree.test.js`, importing `cleanupOrphanedWorktrees` and `createStore`:

```javascript
// Add to imports:
// import { ..., cleanupOrphanedWorktrees } from '../git-worktree.js';
// import { createStore } from '../store.js';

describe('cleanupOrphanedWorktrees', () => {
  let tempDir;
  let store;

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
    if (store) {
      store.close();
      store = null;
    }
  });

  it('removes clean orphaned worktree with no matching session', async () => {
    tempDir = createTempRepo();
    store = createStore(':memory:');

    // Register project in DB
    store.createProject({
      id: 'p1',
      name: 'test',
      cwd: tempDir,
      createdAt: new Date().toISOString(),
    });

    // Create a worktree via git (simulating orphan - no session in DB)
    fs.mkdirSync(path.join(tempDir, '.worktrees'));
    execSync('git worktree add -b claude/orphan-branch .worktrees/orphan-branch', {
      cwd: tempDir,
      env: { ...process.env, ...gitEnv },
    });

    // Run cleanup with gracePeriodMs=0 to skip time check
    const result = await cleanupOrphanedWorktrees(store, { gracePeriodMs: 0 });

    assert.strictEqual(result.removed, 1);
    assert.strictEqual(result.skippedDirty, 0);

    // Verify worktree directory is gone
    assert.ok(!fs.existsSync(path.join(tempDir, '.worktrees', 'orphan-branch')));

    // Verify branch is still there (cleanup never deletes branches)
    const branches = execSync('git branch', { cwd: tempDir, encoding: 'utf-8' });
    assert.ok(branches.includes('claude/orphan-branch'));
  });

  it('skips dirty orphaned worktree', async () => {
    tempDir = createTempRepo();
    store = createStore(':memory:');

    store.createProject({
      id: 'p1',
      name: 'test',
      cwd: tempDir,
      createdAt: new Date().toISOString(),
    });

    fs.mkdirSync(path.join(tempDir, '.worktrees'));
    execSync('git worktree add -b claude/dirty-branch .worktrees/dirty-branch', {
      cwd: tempDir,
      env: { ...process.env, ...gitEnv },
    });

    // Make it dirty
    fs.writeFileSync(
      path.join(tempDir, '.worktrees', 'dirty-branch', 'dirty.txt'),
      'uncommitted'
    );

    const result = await cleanupOrphanedWorktrees(store, { gracePeriodMs: 0 });

    assert.strictEqual(result.removed, 0);
    assert.strictEqual(result.skippedDirty, 1);

    // Verify worktree still exists
    assert.ok(fs.existsSync(path.join(tempDir, '.worktrees', 'dirty-branch')));
  });

  it('does not remove worktree that has a matching session', async () => {
    tempDir = createTempRepo();
    store = createStore(':memory:');

    store.createProject({
      id: 'p1',
      name: 'test',
      cwd: tempDir,
      createdAt: new Date().toISOString(),
    });

    // Create worktree AND matching session
    fs.mkdirSync(path.join(tempDir, '.worktrees'));
    execSync('git worktree add -b claude/active-branch .worktrees/active-branch', {
      cwd: tempDir,
      env: { ...process.env, ...gitEnv },
    });

    store.createSession({
      id: 's1',
      projectId: 'p1',
      name: 'active',
      branchName: 'active-branch',
      worktreePath: '.worktrees/active-branch',
      claudeSessionId: null,
      status: 'running',
      createdAt: new Date().toISOString(),
    });

    const result = await cleanupOrphanedWorktrees(store, { gracePeriodMs: 0 });

    assert.strictEqual(result.removed, 0);
    assert.strictEqual(result.skippedDirty, 0);

    // Verify worktree still exists
    assert.ok(fs.existsSync(path.join(tempDir, '.worktrees', 'active-branch')));
  });

  it('skips worktrees within grace period (default 10 min)', async () => {
    tempDir = createTempRepo();
    store = createStore(':memory:');

    store.createProject({
      id: 'p1',
      name: 'test',
      cwd: tempDir,
      createdAt: new Date().toISOString(),
    });

    fs.mkdirSync(path.join(tempDir, '.worktrees'));
    execSync('git worktree add -b claude/new-branch .worktrees/new-branch', {
      cwd: tempDir,
      env: { ...process.env, ...gitEnv },
    });

    // Run with default grace period (10 min) — worktree just created, should be skipped
    const result = await cleanupOrphanedWorktrees(store, { gracePeriodMs: 10 * 60 * 1000 });

    assert.strictEqual(result.removed, 0);
    assert.strictEqual(result.skippedGrace, 1);

    // Verify worktree still exists
    assert.ok(fs.existsSync(path.join(tempDir, '.worktrees', 'new-branch')));
  });

  it('runs git worktree prune after cleanup', async () => {
    tempDir = createTempRepo();
    store = createStore(':memory:');

    store.createProject({
      id: 'p1',
      name: 'test',
      cwd: tempDir,
      createdAt: new Date().toISOString(),
    });

    const result = await cleanupOrphanedWorktrees(store, { gracePeriodMs: 0 });

    // Should succeed even with nothing to clean
    assert.strictEqual(result.removed, 0);
    assert.strictEqual(result.errors, 0);
  });

  it('continues cleanup when individual orphan removal fails', async () => {
    tempDir = createTempRepo();
    store = createStore(':memory:');

    store.createProject({
      id: 'p1',
      name: 'test',
      cwd: tempDir,
      createdAt: new Date().toISOString(),
    });

    // Create two orphan worktrees
    fs.mkdirSync(path.join(tempDir, '.worktrees'));
    execSync('git worktree add -b claude/orphan-1 .worktrees/orphan-1', {
      cwd: tempDir,
      env: { ...process.env, ...gitEnv },
    });
    execSync('git worktree add -b claude/orphan-2 .worktrees/orphan-2', {
      cwd: tempDir,
      env: { ...process.env, ...gitEnv },
    });

    // Break orphan-1: make its .git file point nowhere so git worktree remove fails
    // The .git file in a worktree is a pointer back to the main repo's worktree metadata
    fs.writeFileSync(
      path.join(tempDir, '.worktrees', 'orphan-1', '.git'),
      'gitdir: /nonexistent/path'
    );

    const result = await cleanupOrphanedWorktrees(store, { gracePeriodMs: 0 });

    // orphan-1 should error, orphan-2 should succeed
    assert.strictEqual(result.errors >= 1, true, 'should have at least 1 error');
    assert.strictEqual(result.removed >= 1, true, 'should have removed at least 1 orphan');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `node --test test/git-worktree.test.js`
Expected: FAIL with "cleanupOrphanedWorktrees is not a function"

**Step 3: Write minimal implementation**

Add to `git-worktree.js` after `listProjectWorktrees`:

```javascript
const GRACE_PERIOD_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Remove orphaned worktrees across all projects.
 * An orphan is a git-registered worktree under .worktrees/ with no matching session.
 *
 * @param {object} store - Store instance with getProjects() and getSessionWorktreePaths()
 * @param {object} [options]
 * @param {number} [options.gracePeriodMs=600000] - Skip worktrees younger than this (ms)
 * @returns {Promise<{removed: number, skippedDirty: number, skippedGrace: number, errors: number}>}
 */
export async function cleanupOrphanedWorktrees(store, { gracePeriodMs = GRACE_PERIOD_MS } = {}) {
  const result = { removed: 0, skippedDirty: 0, skippedGrace: 0, errors: 0 };

  const projects = store.getProjects();

  for (const project of projects) {
    // Verify project directory still exists
    try {
      const stat = await fs.promises.stat(project.cwd);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }

    // Get all registered worktrees under .worktrees/
    const worktrees = await listProjectWorktrees(project.cwd);
    if (worktrees.length === 0) continue;

    // Get all session worktree paths for this project
    const sessionPaths = new Set(store.getSessionWorktreePaths(project.id));

    for (const worktree of worktrees) {
      // Check if this worktree has a matching session
      if (sessionPaths.has(worktree.relativePath)) continue;

      // Grace period: skip if worktree directory is too new
      if (gracePeriodMs > 0) {
        try {
          const stat = await fs.promises.stat(worktree.absolutePath);
          const ageMs = Date.now() - stat.birthtimeMs;
          if (ageMs < gracePeriodMs) {
            result.skippedGrace++;
            console.log(`[cleanup] Skipping young orphan (${Math.round(ageMs / 1000)}s old): ${worktree.relativePath}`);
            continue;
          }
        } catch {
          // If we can't stat it, proceed with removal attempt
        }
      }

      // Check if dirty
      // Extract branchName from relativePath: ".worktrees/branch-name" -> "branch-name"
      const branchName = path.basename(worktree.relativePath);
      try {
        const dirty = await isWorktreeDirty(project.cwd, branchName);
        if (dirty) {
          result.skippedDirty++;
          console.log(`[cleanup] Skipping dirty orphan: ${worktree.relativePath}`);
          continue;
        }
      } catch (e) {
        if (e instanceof WorktreeDirtyCheckError && e.code === 'WORKTREE_MISSING') {
          // Worktree directory gone but still registered — proceed to prune
          // removeWorktree will handle this
        } else {
          result.errors++;
          console.error(`[cleanup] Error checking dirty status for ${worktree.relativePath}: ${e.message}`);
          continue;
        }
      }

      // Remove the orphan worktree (never delete branch)
      try {
        await removeWorktree(project.cwd, branchName, project.id, { deleteBranch: false });
        result.removed++;
        console.log(`[cleanup] Removed orphan worktree: ${worktree.relativePath}`);
      } catch (e) {
        result.errors++;
        console.error(`[cleanup] Failed to remove ${worktree.relativePath}: ${e.message}`);
      }
    }

    // Prune stale git worktree refs
    try {
      await execFileAsync('git', ['worktree', 'prune'], { cwd: project.cwd });
    } catch {
      // Best-effort
    }
  }

  console.log(`[cleanup] Complete: removed=${result.removed}, skippedDirty=${result.skippedDirty}, skippedGrace=${result.skippedGrace}, errors=${result.errors}`);
  return result;
}
```

**Step 4: Run test to verify it passes**

Run: `node --test test/git-worktree.test.js`
Expected: All tests PASS

**Step 5: Run full test suite**

Run: `npm test`
Expected: All tests PASS

**Step 6: Commit**

```bash
git add git-worktree.js test/git-worktree.test.js
git commit -m "feat: implement cleanupOrphanedWorktrees for orphan detection and removal"
```

---

### Task 4: Wire cleanup into server startup and periodic schedule

The server should run cleanup on startup (non-test mode) and every 6 hours, with an overlap guard and shutdown cleanup.

**Files:**
- Modify: `server.js:12-23` (imports — add `cleanupOrphanedWorktrees`)
- Modify: `server.js:683-711` (startup section — add cleanup call)
- Modify: `server.js:713-725` (server.destroy — clear interval)
- Test: `test/server.test.js` (add new describe block)

**Step 1: Write the failing test**

Add to `test/server.test.js`:

```javascript
describe('Worktree Orphan Cleanup Integration', () => {
  let server;
  let baseUrl;
  let tempDir;

  before(async () => {
    server = createServer({ testMode: true });
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://localhost:${server.address().port}`;
  });

  after(async () => {
    await server.destroy();
    if (tempDir) cleanupDir(tempDir);
  });

  it('POST /api/cleanup triggers orphan cleanup and returns result', async () => {
    // Create a project with a temp repo
    tempDir = createTempRepo();
    const projRes = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'cleanup-test', cwd: tempDir }),
    });
    assert.strictEqual(projRes.status, 201);
    const project = await projRes.json();

    // Create an orphan worktree (no session in DB)
    fs.mkdirSync(path.join(tempDir, '.worktrees'), { recursive: true });
    execSync('git worktree add -b claude/orphan-test .worktrees/orphan-test', {
      cwd: tempDir,
      env: { ...process.env, ...gitEnv },
    });

    // Trigger cleanup (gracePeriodMs=0 in test mode for immediate cleanup)
    const res = await fetch(`${baseUrl}/api/cleanup`, { method: 'POST' });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(typeof data.removed, 'number');
    assert.ok(data.removed >= 1, `expected at least 1 removed, got ${data.removed}`);

    // Verify orphan worktree is gone
    assert.ok(!fs.existsSync(path.join(tempDir, '.worktrees', 'orphan-test')));

    // Verify branch still exists (cleanup preserves branches)
    const branches = execSync('git branch', { cwd: tempDir, encoding: 'utf-8' });
    assert.ok(branches.includes('claude/orphan-test'));
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — 404 on POST /api/cleanup

**Step 3: Write implementation**

In `server.js`, add import at line 23 (with existing git-worktree imports):

```javascript
// Add cleanupOrphanedWorktrees to the import from './git-worktree.js'
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
```

Add the cleanup endpoint after the archive endpoint (after line 441), before the restart endpoint:

```javascript
  // --- Orphan Cleanup ---

  app.post('/api/cleanup', async (req, res) => {
    try {
      const result = await cleanupOrphanedWorktrees(store, {
        gracePeriodMs: testMode ? 0 : undefined,
      });
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: `Cleanup failed: ${e.message}` });
    }
  });
```

Add the periodic cleanup and overlap guard. Inside `createServer`, after the startup session resume block (after line 711, before `server.destroy`):

```javascript
  // --- Periodic Orphan Cleanup ---

  let cleanupTimer = null;
  let isCleanupRunning = false;
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
```

Update `server.destroy` (around line 713) to clear the timer:

```javascript
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
```

**Step 4: Run test to verify it passes**

Run: `npm test`
Expected: All tests PASS

**Step 5: Syntax check**

Run: `node --check server.js && node --check git-worktree.js && node --check store.js`
Expected: No errors

**Step 6: Commit**

```bash
git add server.js
git commit -m "feat: wire up orphan cleanup on startup, periodic schedule, and API endpoint"
```

---

### Task 5: Add store.test.js to the test glob and verify full suite

Make sure the new test file is picked up by `npm test`.

**Files:**
- Verify: `package.json:8` (test script already uses `'test/*.test.js'` glob — `test/store.test.js` should be included automatically)

**Step 1: Run full test suite**

Run: `npm test`
Expected: All tests pass, including new `test/store.test.js`

**Step 2: Run syntax checks**

Run: `node --check server.js && node --check pty-manager.js && node --check store.js && node --check git-worktree.js`
Expected: No errors

**Step 3: Verify no regressions by running tests twice**

Run: `npm test`
Expected: Consistent pass (no test pollution between runs)

**Step 4: Commit (only if any fix was needed)**

If any fixes were needed:
```bash
git add -A
git commit -m "fix: test suite adjustments for orphan cleanup"
```

---

## Summary of Changes

| File | Change |
|------|--------|
| `store.js` | Add `getSessionWorktreePaths(projectId)` method + prepared statement |
| `git-worktree.js` | Add `listProjectWorktrees()` and `cleanupOrphanedWorktrees()` |
| `server.js` | Import cleanup, add POST `/api/cleanup`, startup/periodic cleanup, clear timer on destroy |
| `test/store.test.js` | New: tests for `getSessionWorktreePaths` |
| `test/git-worktree.test.js` | New tests for `listProjectWorktrees` and `cleanupOrphanedWorktrees` |
| `test/server.test.js` | New test for POST `/api/cleanup` integration |

## Key Safety Properties

1. **Branches never deleted** — `removeWorktree` called with `deleteBranch: false`
2. **Dirty worktrees never removed** — checked via `isWorktreeDirty`
3. **10-minute grace period** — prevents race with session creation
4. **Per-project mutex** — `removeWorktree` acquires lock internally
5. **Best-effort** — individual failures don't abort sweep
6. **Overlap guard** — `isCleanupRunning` flag prevents stacking
7. **Test mode** — cleanup disabled (no timer), but API endpoint works with `gracePeriodMs: 0`
