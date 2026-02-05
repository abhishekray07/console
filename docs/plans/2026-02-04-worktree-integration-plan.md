# Git Worktree Integration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add git worktree support so each Claude session runs in an isolated worktree for parallel experimentation.

**Architecture:** New `git-worktree.js` module handles all git operations. Server validates repos at project creation, creates worktrees at session creation. Frontend shows branch info and handles archive/delete flows.

**Tech Stack:** Node.js, child_process.execFile, Express REST API, vanilla JS frontend

**Design:** `docs/plans/2026-02-04-worktree-integration-design.md`

**Dex Epic:** `y91ookr7`

---

## Task 1: Create git-worktree.js Helper Module

**Files:**
- Create: `git-worktree.js`
- Test: `test/git-worktree.test.js`

### Step 1: Write failing tests for sanitizeBranchName

```javascript
// test/git-worktree.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { sanitizeBranchName } from '../git-worktree.js';

describe('sanitizeBranchName', () => {
  it('lowercases and replaces spaces with hyphens', () => {
    assert.strictEqual(sanitizeBranchName('Fix Auth Bug'), 'fix-auth-bug');
  });

  it('removes special characters', () => {
    assert.strictEqual(sanitizeBranchName('Fix Auth Bug!'), 'fix-auth-bug');
  });

  it('collapses multiple hyphens', () => {
    assert.strictEqual(sanitizeBranchName('Add   spaces'), 'add-spaces');
  });

  it('handles slashes', () => {
    assert.strictEqual(sanitizeBranchName('foo/bar'), 'foo-bar');
  });

  it('converts underscores to hyphens', () => {
    assert.strictEqual(sanitizeBranchName('hello_world'), 'hello-world');
  });

  it('trims whitespace', () => {
    assert.strictEqual(sanitizeBranchName('  trimmed  '), 'trimmed');
  });

  it('removes emoji and non-ASCII', () => {
    assert.strictEqual(sanitizeBranchName('emojis 🚀'), 'emojis');
  });

  it('falls back to session for empty result', () => {
    assert.strictEqual(sanitizeBranchName(''), 'session');
    assert.strictEqual(sanitizeBranchName('🚀🚀🚀'), 'session');
  });

  it('truncates to 50 chars', () => {
    const long = 'a'.repeat(60);
    assert.strictEqual(sanitizeBranchName(long).length, 50);
  });

  it('trims leading/trailing hyphens', () => {
    assert.strictEqual(sanitizeBranchName('---test---'), 'test');
  });
});
```

### Step 2: Run test to verify it fails

Run: `node --test test/git-worktree.test.js`
Expected: FAIL with "Cannot find module '../git-worktree.js'"

### Step 3: Implement sanitizeBranchName

```javascript
// git-worktree.js
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const execFileAsync = promisify(execFile);

/**
 * Convert session name to branch-safe format (deterministic)
 * @param {string} sessionName - Display name of session
 * @returns {string} - Sanitized branch name
 */
export function sanitizeBranchName(sessionName) {
  let result = sessionName
    .toLowerCase()
    // Remove non-ASCII characters (emoji, accents, etc)
    .replace(/[^\x00-\x7F]/g, '')
    // Replace non-alphanumeric with hyphens
    .replace(/[^a-z0-9]+/g, '-')
    // Collapse multiple hyphens
    .replace(/-+/g, '-')
    // Trim leading/trailing hyphens
    .replace(/^-+|-+$/g, '')
    // Truncate to 50 chars
    .slice(0, 50)
    // Trim again after truncation (might end with hyphen)
    .replace(/-+$/g, '');

  return result || 'session';
}
```

### Step 4: Run test to verify it passes

Run: `node --test test/git-worktree.test.js`
Expected: PASS

### Step 5: Write failing tests for validateGitRepo

Add to `test/git-worktree.test.js`:

```javascript
import { validateGitRepo } from '../git-worktree.js';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

describe('validateGitRepo', () => {
  let tempDir;

  function createTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-test-'));
  }

  it('returns valid for normal git repo with commits', async () => {
    tempDir = createTempDir();
    execSync('git init && git commit --allow-empty -m "init"', { cwd: tempDir });
    const result = await validateGitRepo(tempDir);
    assert.strictEqual(result.valid, true);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns NOT_GIT_REPO for non-git directory', async () => {
    tempDir = createTempDir();
    const result = await validateGitRepo(tempDir);
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.code, 'NOT_GIT_REPO');
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns BARE_REPO for bare repository', async () => {
    tempDir = createTempDir();
    execSync('git init --bare', { cwd: tempDir });
    const result = await validateGitRepo(tempDir);
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.code, 'BARE_REPO');
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns EMPTY_REPO for repo with no commits', async () => {
    tempDir = createTempDir();
    execSync('git init', { cwd: tempDir });
    const result = await validateGitRepo(tempDir);
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.code, 'EMPTY_REPO');
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
```

### Step 6: Run test to verify it fails

Run: `node --test test/git-worktree.test.js`
Expected: FAIL with "validateGitRepo is not a function"

### Step 7: Implement validateGitRepo

Add to `git-worktree.js`:

```javascript
/**
 * Check if directory is a valid git repository (not bare, has commits)
 * @param {string} dir - Directory to check
 * @returns {Promise<{valid: boolean, code?: string, message?: string}>}
 */
export async function validateGitRepo(dir) {
  // Check if it's a git repo
  try {
    await execFileAsync('git', ['rev-parse', '--git-dir'], { cwd: dir });
  } catch {
    return {
      valid: false,
      code: 'NOT_GIT_REPO',
      message: 'Directory is not a git repository',
    };
  }

  // Check if it's bare
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['rev-parse', '--is-bare-repository'],
      { cwd: dir }
    );
    if (stdout.trim() === 'true') {
      return {
        valid: false,
        code: 'BARE_REPO',
        message: 'Bare repositories are not supported',
      };
    }
  } catch {
    return {
      valid: false,
      code: 'NOT_GIT_REPO',
      message: 'Directory is not a git repository',
    };
  }

  // Check if HEAD exists (has commits)
  try {
    await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: dir });
  } catch {
    return {
      valid: false,
      code: 'EMPTY_REPO',
      message: 'Repository has no commits. Make an initial commit first.',
    };
  }

  return { valid: true };
}
```

### Step 8: Run test to verify it passes

Run: `node --test test/git-worktree.test.js`
Expected: PASS

### Step 9: Write failing tests for createWorktree

Add to `test/git-worktree.test.js`:

```javascript
import { createWorktree } from '../git-worktree.js';

describe('createWorktree', () => {
  let tempDir;

  function createTempRepo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-test-'));
    execSync('git init && git commit --allow-empty -m "init"', { cwd: dir });
    return dir;
  }

  it('creates worktree and branch', async () => {
    tempDir = createTempRepo();
    await createWorktree(tempDir, 'test-branch');

    // Verify worktree exists
    const worktreePath = path.join(tempDir, '.worktrees', 'test-branch');
    assert.ok(fs.existsSync(worktreePath));

    // Verify branch exists
    const branches = execSync('git branch', { cwd: tempDir, encoding: 'utf-8' });
    assert.ok(branches.includes('claude/test-branch'));

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('rejects path traversal attempts', async () => {
    tempDir = createTempRepo();
    await assert.rejects(
      () => createWorktree(tempDir, '../escape'),
      /Invalid branch name/
    );
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
```

### Step 10: Run test to verify it fails

Run: `node --test test/git-worktree.test.js`
Expected: FAIL with "createWorktree is not a function"

### Step 11: Implement createWorktree

Add to `git-worktree.js`:

```javascript
/**
 * Validate branch name for safety (no path traversal, valid ref format)
 * @param {string} branchName - Branch name to validate
 * @returns {Promise<boolean>}
 */
async function validateBranchName(branchName) {
  // Reject path traversal
  if (branchName.includes('..') || branchName.includes('/')) {
    return false;
  }

  // Validate with git check-ref-format
  try {
    await execFileAsync('git', [
      'check-ref-format',
      '--branch',
      `claude/${branchName}`,
    ]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create worktree and branch (with path/ref safety checks)
 * @param {string} projectDir - Project root directory
 * @param {string} branchName - Sanitized branch name (without claude/ prefix)
 * @returns {Promise<void>}
 */
export async function createWorktree(projectDir, branchName) {
  // Validate branch name
  if (!(await validateBranchName(branchName))) {
    throw new Error(`Invalid branch name: ${branchName}`);
  }

  const worktreePath = path.join(projectDir, '.worktrees', branchName);
  const fullBranchName = `claude/${branchName}`;

  // Ensure .worktrees directory exists
  const worktreesDir = path.join(projectDir, '.worktrees');
  await fs.promises.mkdir(worktreesDir, { recursive: true });

  // Create worktree with new branch
  try {
    await execFileAsync(
      'git',
      ['worktree', 'add', '-b', fullBranchName, '--', worktreePath],
      { cwd: projectDir }
    );
  } catch (err) {
    throw new Error(`Failed to create worktree: ${err.stderr || err.message}`);
  }
}
```

### Step 12: Run test to verify it passes

Run: `node --test test/git-worktree.test.js`
Expected: PASS

### Step 13: Write failing tests for removeWorktree

Add to `test/git-worktree.test.js`:

```javascript
import { removeWorktree } from '../git-worktree.js';

describe('removeWorktree', () => {
  let tempDir;

  function createTempRepoWithWorktree() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-test-'));
    execSync('git init && git commit --allow-empty -m "init"', { cwd: dir });
    execSync('mkdir -p .worktrees && git worktree add -b claude/test-branch .worktrees/test-branch', { cwd: dir });
    return dir;
  }

  it('removes worktree but keeps branch when deleteBranch=false', async () => {
    tempDir = createTempRepoWithWorktree();
    await removeWorktree(tempDir, 'test-branch', { deleteBranch: false });

    // Verify worktree is gone
    const worktreePath = path.join(tempDir, '.worktrees', 'test-branch');
    assert.ok(!fs.existsSync(worktreePath));

    // Verify branch still exists
    const branches = execSync('git branch', { cwd: tempDir, encoding: 'utf-8' });
    assert.ok(branches.includes('claude/test-branch'));

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('removes worktree and branch when deleteBranch=true', async () => {
    tempDir = createTempRepoWithWorktree();
    await removeWorktree(tempDir, 'test-branch', { deleteBranch: true });

    // Verify worktree is gone
    const worktreePath = path.join(tempDir, '.worktrees', 'test-branch');
    assert.ok(!fs.existsSync(worktreePath));

    // Verify branch is gone
    const branches = execSync('git branch', { cwd: tempDir, encoding: 'utf-8' });
    assert.ok(!branches.includes('claude/test-branch'));

    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
```

### Step 14: Run test to verify it fails

Run: `node --test test/git-worktree.test.js`
Expected: FAIL with "removeWorktree is not a function"

### Step 15: Implement removeWorktree

Add to `git-worktree.js`:

```javascript
/**
 * Remove worktree, optionally delete branch (with safety checks)
 * @param {string} projectDir - Project root directory
 * @param {string} branchName - Sanitized branch name (without claude/ prefix)
 * @param {Object} options
 * @param {boolean} options.deleteBranch - Whether to delete the branch too
 * @returns {Promise<void>}
 */
export async function removeWorktree(projectDir, branchName, { deleteBranch = false } = {}) {
  // Validate branch name
  if (!(await validateBranchName(branchName))) {
    throw new Error(`Invalid branch name: ${branchName}`);
  }

  const worktreePath = path.join(projectDir, '.worktrees', branchName);
  const fullBranchName = `claude/${branchName}`;

  // Verify worktree path is inside .worktrees (path safety)
  const resolvedWorktree = await fs.promises.realpath(worktreePath).catch(() => worktreePath);
  const worktreesDir = path.join(projectDir, '.worktrees');
  if (!resolvedWorktree.startsWith(worktreesDir)) {
    throw new Error('Path safety violation: worktree path escapes .worktrees/');
  }

  // Remove worktree
  try {
    await execFileAsync(
      'git',
      ['worktree', 'remove', '--force', '--', worktreePath],
      { cwd: projectDir }
    );
  } catch (err) {
    // Worktree might already be removed manually
    if (!err.stderr?.includes('is not a working tree')) {
      throw new Error(`Failed to remove worktree: ${err.stderr || err.message}`);
    }
  }

  // Delete branch if requested
  if (deleteBranch) {
    try {
      await execFileAsync(
        'git',
        ['branch', '-D', '--', fullBranchName],
        { cwd: projectDir }
      );
    } catch (err) {
      // Branch might already be deleted
      if (!err.stderr?.includes('not found')) {
        throw new Error(`Failed to delete branch: ${err.stderr || err.message}`);
      }
    }
  }
}
```

### Step 16: Run test to verify it passes

Run: `node --test test/git-worktree.test.js`
Expected: PASS

### Step 17: Write failing tests for remaining functions

Add to `test/git-worktree.test.js`:

```javascript
import { worktreeExists, isWorktreeDirty, isWorktreesIgnored } from '../git-worktree.js';

describe('worktreeExists', () => {
  it('returns true when worktree exists', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-test-'));
    execSync('git init && git commit --allow-empty -m "init"', { cwd: tempDir });
    execSync('mkdir -p .worktrees && git worktree add -b claude/exists .worktrees/exists', { cwd: tempDir });

    assert.strictEqual(await worktreeExists(tempDir, 'exists'), true);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns false when worktree does not exist', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-test-'));
    execSync('git init && git commit --allow-empty -m "init"', { cwd: tempDir });

    assert.strictEqual(await worktreeExists(tempDir, 'missing'), false);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});

describe('isWorktreeDirty', () => {
  it('returns false for clean worktree', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-test-'));
    execSync('git init && git commit --allow-empty -m "init"', { cwd: tempDir });
    execSync('mkdir -p .worktrees && git worktree add -b claude/clean .worktrees/clean', { cwd: tempDir });

    assert.strictEqual(await isWorktreeDirty(tempDir, 'clean'), false);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns true for dirty worktree', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-test-'));
    execSync('git init && git commit --allow-empty -m "init"', { cwd: tempDir });
    execSync('mkdir -p .worktrees && git worktree add -b claude/dirty .worktrees/dirty', { cwd: tempDir });
    fs.writeFileSync(path.join(tempDir, '.worktrees', 'dirty', 'newfile.txt'), 'content');

    assert.strictEqual(await isWorktreeDirty(tempDir, 'dirty'), true);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});

describe('isWorktreesIgnored', () => {
  it('returns true when .worktrees/ is in .gitignore', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-test-'));
    execSync('git init && git commit --allow-empty -m "init"', { cwd: tempDir });
    fs.writeFileSync(path.join(tempDir, '.gitignore'), '.worktrees/\n');

    assert.strictEqual(await isWorktreesIgnored(tempDir), true);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns false when .worktrees/ is not in .gitignore', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-test-'));
    execSync('git init && git commit --allow-empty -m "init"', { cwd: tempDir });

    assert.strictEqual(await isWorktreesIgnored(tempDir), false);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
```

### Step 18: Run test to verify it fails

Run: `node --test test/git-worktree.test.js`
Expected: FAIL with functions not defined

### Step 19: Implement remaining functions

Add to `git-worktree.js`:

```javascript
/**
 * Check if worktree directory exists
 * @param {string} projectDir - Project root directory
 * @param {string} branchName - Sanitized branch name
 * @returns {Promise<boolean>}
 */
export async function worktreeExists(projectDir, branchName) {
  const worktreePath = path.join(projectDir, '.worktrees', branchName);
  try {
    await fs.promises.access(worktreePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if worktree has uncommitted changes
 * @param {string} projectDir - Project root directory
 * @param {string} branchName - Sanitized branch name
 * @returns {Promise<boolean>}
 */
export async function isWorktreeDirty(projectDir, branchName) {
  const worktreePath = path.join(projectDir, '.worktrees', branchName);
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['status', '--porcelain'],
      { cwd: worktreePath }
    );
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Check if .worktrees/ is in .gitignore
 * @param {string} projectDir - Project root directory
 * @returns {Promise<boolean>}
 */
export async function isWorktreesIgnored(projectDir) {
  try {
    // Use git check-ignore to see if .worktrees would be ignored
    await execFileAsync(
      'git',
      ['check-ignore', '-q', '.worktrees'],
      { cwd: projectDir }
    );
    return true;
  } catch {
    return false;
  }
}
```

### Step 20: Run all tests to verify they pass

Run: `node --test test/git-worktree.test.js`
Expected: All PASS

### Step 21: Commit

```bash
git add git-worktree.js test/git-worktree.test.js
git commit -m "$(cat <<'EOF'
feat: add git-worktree.js helper module

- sanitizeBranchName(): convert session names to branch-safe format
- validateGitRepo(): check for valid git repo (not bare, has commits)
- createWorktree(): create worktree and branch with safety checks
- removeWorktree(): remove worktree, optionally delete branch
- worktreeExists(): check if worktree directory exists
- isWorktreeDirty(): check for uncommitted changes
- isWorktreesIgnored(): check if .worktrees/ is gitignored
EOF
)"
```

---

## Task 2: Update server.js for Worktree Integration

**Files:**
- Modify: `server.js`
- Test: `test/server.test.js`

### Step 1: Write failing test for project git validation

Add to `test/server.test.js`:

```javascript
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('Projects API - Git Validation', () => {
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

  it('POST /api/projects rejects non-git directory', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'not-git-'));
    const res = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'not-git', cwd: tempDir }),
    });
    assert.strictEqual(res.status, 400);
    const data = await res.json();
    assert.strictEqual(data.code, 'NOT_GIT_REPO');
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('POST /api/projects rejects bare repository', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bare-'));
    execSync('git init --bare', { cwd: tempDir });
    const res = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'bare', cwd: tempDir }),
    });
    assert.strictEqual(res.status, 400);
    const data = await res.json();
    assert.strictEqual(data.code, 'BARE_REPO');
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('POST /api/projects rejects empty repository', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-'));
    execSync('git init', { cwd: tempDir });
    const res = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'empty', cwd: tempDir }),
    });
    assert.strictEqual(res.status, 400);
    const data = await res.json();
    assert.strictEqual(data.code, 'EMPTY_REPO');
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('POST /api/projects accepts valid git repository', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'valid-'));
    execSync('git init && git commit --allow-empty -m "init"', { cwd: tempDir });
    const res = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'valid', cwd: tempDir }),
    });
    assert.strictEqual(res.status, 201);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
```

### Step 2: Run test to verify it fails

Run: `node --test test/server.test.js`
Expected: FAIL - non-git directory currently accepted

### Step 3: Add git validation to POST /api/projects

In `server.js`, import and add validation:

```javascript
// At top of server.js, add import
import { validateGitRepo } from './git-worktree.js';

// In POST /api/projects handler, after directory exists check:
// Add git repo validation
const gitResult = await validateGitRepo(resolvedCwd);
if (!gitResult.valid) {
  return res.status(400).json({
    error: gitResult.message,
    code: gitResult.code,
  });
}
```

### Step 4: Run test to verify it passes

Run: `node --test test/server.test.js`
Expected: Git validation tests PASS

### Step 5: Write failing test for session worktree creation

Add to `test/server.test.js`:

```javascript
describe('Sessions API - Worktree Creation', () => {
  let server;
  let baseUrl;
  let tempDir;
  let projectId;

  before(async () => {
    server = createServer({ testMode: true });
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://localhost:${server.address().port}`;

    // Create a valid git repo
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-session-'));
    execSync('git init && git commit --allow-empty -m "init"', { cwd: tempDir });

    // Create a project
    const res = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'worktree-test', cwd: tempDir }),
    });
    const proj = await res.json();
    projectId = proj.id;
  });

  after(async () => {
    await server.destroy();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates worktree and branch on session creation', async () => {
    const res = await fetch(`${baseUrl}/api/projects/${projectId}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Fix Bug' }),
    });
    assert.strictEqual(res.status, 201);
    const session = await res.json();

    // Verify branchName and worktreePath are set
    assert.ok(session.branchName);
    assert.ok(session.branchName.startsWith('fix-bug-'));
    assert.ok(session.worktreePath);

    // Verify worktree exists on disk
    const fullWorktreePath = path.join(tempDir, session.worktreePath);
    assert.ok(fs.existsSync(fullWorktreePath));

    // Verify branch exists
    const branches = execSync('git branch', { cwd: tempDir, encoding: 'utf-8' });
    assert.ok(branches.includes(`claude/${session.branchName}`));
  });
});
```

### Step 6: Run test to verify it fails

Run: `node --test test/server.test.js`
Expected: FAIL - branchName not set

### Step 7: Update session creation to create worktree

In `server.js`, update `POST /api/projects/:id/sessions`:

```javascript
// Import at top
import {
  validateGitRepo,
  sanitizeBranchName,
  createWorktree,
  removeWorktree,
  worktreeExists,
  isWorktreeDirty,
  isWorktreesIgnored,
} from './git-worktree.js';

// In POST /api/projects/:id/sessions handler, before creating session object:
// Generate branch name
const baseName = sanitizeBranchName(name);
const shortId = crypto.randomUUID().slice(0, 7);
const branchName = `${baseName}-${shortId}`;
const worktreePath = `.worktrees/${branchName}`;

// Create worktree
try {
  await createWorktree(project.cwd, branchName);
} catch (err) {
  return res.status(400).json({
    error: err.message,
    code: 'WORKTREE_FAILED',
  });
}

// Check if .worktrees is gitignored (non-blocking warning)
const ignored = await isWorktreesIgnored(project.cwd);

// Update session object creation:
const session = {
  id: crypto.randomUUID(),
  projectId: project.id,
  name,
  claudeSessionId: null,
  status: 'running',
  createdAt: new Date().toISOString(),
  branchName,      // NEW
  worktreePath,    // NEW
};

// Update spawnSession to use worktree path:
// In spawnSession function, change cwd:
const spawnOpts = {
  cwd: path.join(project.cwd, session.worktreePath || ''),  // Use worktree if set
  // ... rest unchanged
};

// Add warning to response if not ignored:
const response = { ...session, alive: true };
if (!ignored) {
  response.warning = 'Consider adding .worktrees/ to your .gitignore';
}
res.status(201).json(response);
```

### Step 8: Run test to verify it passes

Run: `node --test test/server.test.js`
Expected: PASS

### Step 9: Write failing test for archive endpoint

Add to `test/server.test.js`:

```javascript
describe('Sessions API - Archive', () => {
  // ... setup similar to above

  it('POST /api/sessions/:id/archive removes worktree but keeps branch', async () => {
    // Create session
    const createRes = await fetch(`${baseUrl}/api/projects/${projectId}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'to-archive' }),
    });
    const session = await createRes.json();

    // Archive it
    const res = await fetch(`${baseUrl}/api/sessions/${session.id}/archive`, {
      method: 'POST',
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(data.branch);

    // Verify worktree is gone
    const fullWorktreePath = path.join(tempDir, session.worktreePath);
    assert.ok(!fs.existsSync(fullWorktreePath));

    // Verify branch still exists
    const branches = execSync('git branch', { cwd: tempDir, encoding: 'utf-8' });
    assert.ok(branches.includes(`claude/${session.branchName}`));

    // Verify session is removed from list
    const listRes = await fetch(`${baseUrl}/api/projects`);
    const { sessions } = await listRes.json();
    assert.ok(!sessions.find(s => s.id === session.id));
  });
});
```

### Step 10: Run test to verify it fails

Run: `node --test test/server.test.js`
Expected: FAIL - 404 (endpoint doesn't exist)

### Step 11: Implement archive endpoint

Add to `server.js`:

```javascript
app.post('/api/sessions/:id/archive', async (req, res) => {
  const session = data.sessions.find((s) => s.id === req.params.id);
  if (!session) return res.status(404).json({ error: 'not found' });

  const project = data.projects.find((p) => p.id === session.projectId);
  if (!project) return res.status(400).json({ error: 'Parent project not found' });

  // Kill the process
  manager.kill(session.id);

  // Remove worktree (keep branch)
  if (session.branchName) {
    try {
      await removeWorktree(project.cwd, session.branchName, { deleteBranch: false });
    } catch (err) {
      console.error(`Failed to remove worktree: ${err.message}`);
    }
  }

  // Notify clients
  const msg = JSON.stringify({ type: 'session-deleted', sessionId: session.id });
  for (const ws of clients) {
    safeSend(ws, msg);
  }

  // Remove session from data
  const idx = data.sessions.findIndex((s) => s.id === session.id);
  data.sessions.splice(idx, 1);
  persist();
  broadcastState();

  res.json({
    ok: true,
    branch: session.branchName ? `claude/${session.branchName}` : null,
    message: 'Session archived. Branch preserved for manual recovery.',
  });
});
```

### Step 12: Run test to verify it passes

Run: `node --test test/server.test.js`
Expected: PASS

### Step 13: Write failing test for delete with dirty worktree

Add to `test/server.test.js`:

```javascript
it('DELETE /api/sessions/:id returns DIRTY_WORKTREE when dirty', async () => {
  // Create session
  const createRes = await fetch(`${baseUrl}/api/projects/${projectId}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'dirty-session' }),
  });
  const session = await createRes.json();

  // Make it dirty
  const fullWorktreePath = path.join(tempDir, session.worktreePath);
  fs.writeFileSync(path.join(fullWorktreePath, 'dirty.txt'), 'uncommitted');

  // Try to delete
  const res = await fetch(`${baseUrl}/api/sessions/${session.id}`, { method: 'DELETE' });
  assert.strictEqual(res.status, 400);
  const data = await res.json();
  assert.strictEqual(data.code, 'DIRTY_WORKTREE');
});

it('DELETE /api/sessions/:id?force=true deletes dirty worktree', async () => {
  // Create session
  const createRes = await fetch(`${baseUrl}/api/projects/${projectId}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'force-delete' }),
  });
  const session = await createRes.json();

  // Make it dirty
  const fullWorktreePath = path.join(tempDir, session.worktreePath);
  fs.writeFileSync(path.join(fullWorktreePath, 'dirty.txt'), 'uncommitted');

  // Force delete
  const res = await fetch(`${baseUrl}/api/sessions/${session.id}?force=true`, { method: 'DELETE' });
  assert.strictEqual(res.status, 200);

  // Verify worktree and branch are gone
  assert.ok(!fs.existsSync(fullWorktreePath));
  const branches = execSync('git branch', { cwd: tempDir, encoding: 'utf-8' });
  assert.ok(!branches.includes(`claude/${session.branchName}`));
});
```

### Step 14: Run test to verify it fails

Run: `node --test test/server.test.js`
Expected: FAIL - dirty check not implemented

### Step 15: Update DELETE endpoint with dirty check

Update `DELETE /api/sessions/:id` in `server.js`:

```javascript
app.delete('/api/sessions/:id', async (req, res) => {
  const idx = data.sessions.findIndex((s) => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });

  const session = data.sessions[idx];
  const project = data.projects.find((p) => p.id === session.projectId);
  const forceDelete = req.query.force === 'true';

  // Check for dirty worktree (unless force)
  if (session.branchName && project && !forceDelete) {
    try {
      const dirty = await isWorktreeDirty(project.cwd, session.branchName);
      if (dirty) {
        return res.status(400).json({
          error: 'Worktree has uncommitted changes. Use force=true to delete anyway.',
          code: 'DIRTY_WORKTREE',
        });
      }
    } catch {
      // Worktree might not exist, proceed with delete
    }
  }

  // Kill the process
  manager.kill(session.id);

  // Remove worktree and branch
  if (session.branchName && project) {
    try {
      await removeWorktree(project.cwd, session.branchName, { deleteBranch: true });
    } catch (err) {
      console.error(`Failed to remove worktree: ${err.message}`);
    }
  }

  // Notify clients
  const msg = JSON.stringify({ type: 'session-deleted', sessionId: session.id });
  for (const ws of clients) {
    safeSend(ws, msg);
  }

  // Remove session
  data.sessions.splice(idx, 1);
  persist();
  broadcastState();
  res.json({ ok: true });
});
```

### Step 16: Run test to verify it passes

Run: `node --test test/server.test.js`
Expected: PASS

### Step 17: Update restart to check worktree exists

Update `POST /api/sessions/:id/restart`:

```javascript
// At start of handler, after finding session:
if (session.branchName) {
  const exists = await worktreeExists(project.cwd, session.branchName);
  if (!exists) {
    return res.status(400).json({
      error: 'Worktree was removed. Delete this session and create a new one.',
      code: 'WORKTREE_MISSING',
    });
  }
}
```

### Step 18: Run all server tests

Run: `node --test test/server.test.js`
Expected: All PASS

### Step 19: Commit

```bash
git add server.js test/server.test.js
git commit -m "$(cat <<'EOF'
feat: integrate worktree support into server

- Validate git repo at project creation (reject bare/empty)
- Create worktree and branch on session creation
- Add POST /api/sessions/:id/archive endpoint
- Check for dirty worktree on delete (require force=true)
- Check worktree exists on restart
EOF
)"
```

---

## Task 3: Update Frontend for Worktree UI

**Files:**
- Modify: `public/app.js`
- Modify: `public/style.css`
- Modify: `public/index.html`

### Step 1: Add tooltip styles

Add to `public/style.css`:

```css
/* --- Session tooltip --- */
.session-item {
  position: relative;
}

.session-tooltip {
  display: none;
  position: absolute;
  left: 100%;
  top: 0;
  margin-left: 8px;
  background: #0f3460;
  border: 1px solid #1a1a2e;
  border-radius: 4px;
  padding: 8px 12px;
  font-size: 11px;
  white-space: nowrap;
  z-index: 100;
  box-shadow: 0 2px 8px rgba(0,0,0,0.3);
}

.session-item:hover .session-tooltip {
  display: block;
}

.tooltip-label {
  color: #6b7280;
  margin-right: 4px;
}

.tooltip-value {
  color: #e0e0e0;
  font-family: monospace;
}

.tooltip-row {
  margin-bottom: 4px;
}

.tooltip-row:last-child {
  margin-bottom: 0;
}
```

### Step 2: Add archive button styles

Add to `public/style.css`:

```css
/* --- Session actions --- */
.session-actions {
  display: flex;
  gap: 4px;
  opacity: 0;
  transition: opacity 0.15s;
}

.session-item:hover .session-actions {
  opacity: 1;
}

.session-archive {
  background: none;
  border: none;
  color: #6b7280;
  cursor: pointer;
  font-size: 11px;
  padding: 2px 4px;
}

.session-archive:hover {
  color: #dcdcaa;
}
```

### Step 3: Add toast styles

Add to `public/style.css`:

```css
/* --- Toast notifications --- */
#toast-container {
  position: fixed;
  bottom: 20px;
  right: 20px;
  z-index: 1000;
}

.toast {
  background: #0f3460;
  color: #e0e0e0;
  padding: 12px 16px;
  border-radius: 4px;
  margin-top: 8px;
  font-size: 13px;
  box-shadow: 0 2px 8px rgba(0,0,0,0.3);
  animation: toast-in 0.3s ease;
}

.toast.warning {
  border-left: 3px solid #dcdcaa;
}

@keyframes toast-in {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: translateY(0); }
}
```

### Step 4: Add delete confirmation modal

Add to `public/index.html` (before closing `</body>`):

```html
<!-- Delete Confirmation Modal -->
<div id="delete-modal" class="hidden">
  <div id="delete-modal-content">
    <p>This session has uncommitted changes that will be lost. Delete anyway?</p>
    <div class="modal-buttons">
      <button id="btn-delete-cancel">Cancel</button>
      <button id="btn-delete-confirm" class="danger">Delete</button>
    </div>
  </div>
</div>

<!-- Toast Container -->
<div id="toast-container"></div>
```

### Step 5: Add delete modal styles

Add to `public/style.css`:

```css
/* --- Delete confirmation modal --- */
#delete-modal {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
}

#delete-modal.hidden {
  display: none;
}

#delete-modal-content {
  background: #16213e;
  border: 1px solid #0f3460;
  border-radius: 8px;
  padding: 20px;
  max-width: 400px;
}

#delete-modal-content p {
  margin-bottom: 16px;
}

.danger {
  background: #f44747 !important;
}

.danger:hover {
  background: #d43d3d !important;
}
```

### Step 6: Update renderSidebar to show tooltip and archive button

In `public/app.js`, update the session rendering in `renderSidebar()`:

```javascript
for (const s of projSessions) {
  const li = document.createElement('li');
  li.className = 'session-item';
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

  // Session actions (archive + delete)
  const actions = document.createElement('div');
  actions.className = 'session-actions';

  const sArchive = document.createElement('button');
  sArchive.className = 'session-archive';
  sArchive.textContent = 'Archive';
  sArchive.title = 'Archive session (keep branch)';
  sArchive.onclick = (e) => {
    e.stopPropagation();
    archiveSession(s.id);
  };

  const sDel = document.createElement('button');
  sDel.className = 'session-delete';
  sDel.textContent = '\u00D7';
  sDel.title = 'Delete session';
  sDel.onclick = (e) => {
    e.stopPropagation();
    deleteSession(s.id);
  };

  actions.appendChild(sArchive);
  actions.appendChild(sDel);

  // Tooltip (only if branchName exists)
  if (s.branchName) {
    const tooltip = document.createElement('div');
    tooltip.className = 'session-tooltip';
    tooltip.innerHTML = `
      <div class="tooltip-row">
        <span class="tooltip-label">Branch:</span>
        <span class="tooltip-value">claude/${s.branchName}</span>
      </div>
      <div class="tooltip-row">
        <span class="tooltip-label">Path:</span>
        <span class="tooltip-value">${s.worktreePath}</span>
      </div>
    `;
    li.appendChild(tooltip);
  }

  li.appendChild(dot);
  li.appendChild(sName);
  li.appendChild(time);
  li.appendChild(actions);

  li.onclick = () => {
    if (!s.alive && s.claudeSessionId) {
      restartSession(s.id);
    }
    attachSession(s.id);
  };

  ul.appendChild(li);
}
```

### Step 7: Add archiveSession function

Add to `public/app.js`:

```javascript
async function archiveSession(id) {
  const res = await fetch(`/api/sessions/${id}/archive`, { method: 'POST' });
  if (!res.ok) {
    const err = await res.json();
    showToast(err.error || 'Failed to archive session', 'error');
    return;
  }
  const data = await res.json();
  if (data.branch) {
    showToast(`Archived. Branch ${data.branch} preserved.`, 'info');
  }
  if (activeSessionId === id) {
    activeSessionId = null;
    term.reset();
    noSession.classList.remove('hidden');
  }
}
```

### Step 8: Update deleteSession with dirty confirmation

Update `deleteSession` in `public/app.js`:

```javascript
async function deleteSession(id, force = false) {
  const url = force ? `/api/sessions/${id}?force=true` : `/api/sessions/${id}`;
  const res = await fetch(url, { method: 'DELETE' });

  if (!res.ok) {
    const err = await res.json();
    if (err.code === 'DIRTY_WORKTREE') {
      // Show confirmation modal
      showDeleteConfirmation(id);
      return;
    }
    showToast(err.error || 'Failed to delete session', 'error');
    return;
  }

  if (activeSessionId === id) {
    activeSessionId = null;
    term.reset();
    noSession.classList.remove('hidden');
  }
}

let pendingDeleteId = null;

function showDeleteConfirmation(id) {
  pendingDeleteId = id;
  document.getElementById('delete-modal').classList.remove('hidden');
}

// Add event listeners for delete modal
document.getElementById('btn-delete-cancel').onclick = () => {
  pendingDeleteId = null;
  document.getElementById('delete-modal').classList.add('hidden');
};

document.getElementById('btn-delete-confirm').onclick = () => {
  if (pendingDeleteId) {
    deleteSession(pendingDeleteId, true);
  }
  pendingDeleteId = null;
  document.getElementById('delete-modal').classList.add('hidden');
};
```

### Step 9: Add toast function

Add to `public/app.js`:

```javascript
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 5000);
}
```

### Step 10: Handle gitignore warning from session creation

Update `createSession` in `public/app.js`:

```javascript
async function createSession(projectId, name) {
  const res = await fetch(`/api/projects/${projectId}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const err = await res.json();
    // Show error inline...
    return null;
  }
  const session = await res.json();

  // Show gitignore warning if present
  if (session.warning) {
    showToast(session.warning, 'warning');
  }

  attachSession(session.id);
  return session;
}
```

### Step 11: Update project creation error handling

Update `createProject` in `public/app.js`:

```javascript
async function createProject(name, cwd) {
  const res = await fetch('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, cwd }),
  });
  if (!res.ok) {
    const err = await res.json();
    // Show specific messages for git errors
    let message = err.error || 'Failed to create project';
    if (err.code === 'NOT_GIT_REPO') {
      message = 'Not a git repository. Run `git init` first.';
    } else if (err.code === 'BARE_REPO') {
      message = 'Bare repositories are not supported.';
    } else if (err.code === 'EMPTY_REPO') {
      message = 'Repository has no commits. Make an initial commit first.';
    }
    alert(message);
    return null;
  }
  return await res.json();
}
```

### Step 12: Test UI manually

Run: `npm start`
- Create project with non-git dir → error shown
- Create session → worktree created, tooltip shows branch
- Hover session → tooltip visible
- Archive session → worktree removed, branch kept, toast shown
- Delete dirty session → confirmation modal
- Force delete → session removed

### Step 13: Commit

```bash
git add public/app.js public/style.css public/index.html
git commit -m "$(cat <<'EOF'
feat: add worktree UI to frontend

- Show branch name and worktree path in session tooltip
- Add Archive button to session actions
- Add delete confirmation modal for dirty worktrees
- Add toast notifications for warnings
- Show specific error messages for git validation failures
EOF
)"
```

---

## Task 4: Add Integration Tests

**Files:**
- Modify: `test/server.test.js`

### Step 1: Add full lifecycle integration test

Add to `test/server.test.js`:

```javascript
describe('Worktree Integration - Full Lifecycle', () => {
  let server;
  let baseUrl;
  let tempDir;

  before(async () => {
    server = createServer({ testMode: true });
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://localhost:${server.address().port}`;

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-'));
    execSync('git init && git commit --allow-empty -m "init"', { cwd: tempDir });
  });

  after(async () => {
    await server.destroy();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('complete session lifecycle: create → restart → archive → verify', async () => {
    // Create project
    const projRes = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'lifecycle-test', cwd: tempDir }),
    });
    const project = await projRes.json();

    // Create session
    const sessRes = await fetch(`${baseUrl}/api/projects/${project.id}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Lifecycle Test' }),
    });
    const session = await sessRes.json();
    assert.ok(session.branchName);
    assert.ok(session.worktreePath);

    // Verify worktree exists
    const worktreePath = path.join(tempDir, session.worktreePath);
    assert.ok(fs.existsSync(worktreePath));

    // Create a file in worktree
    fs.writeFileSync(path.join(worktreePath, 'test.txt'), 'test content');

    // Restart session (should work)
    const restartRes = await fetch(`${baseUrl}/api/sessions/${session.id}/restart`, {
      method: 'POST',
    });
    assert.strictEqual(restartRes.status, 200);

    // Archive session
    const archiveRes = await fetch(`${baseUrl}/api/sessions/${session.id}/archive`, {
      method: 'POST',
    });
    assert.strictEqual(archiveRes.status, 200);
    const archiveData = await archiveRes.json();
    assert.ok(archiveData.branch);

    // Verify worktree is gone
    assert.ok(!fs.existsSync(worktreePath));

    // Verify branch still exists
    const branches = execSync('git branch', { cwd: tempDir, encoding: 'utf-8' });
    assert.ok(branches.includes(`claude/${session.branchName}`));

    // Verify session is removed from API
    const listRes = await fetch(`${baseUrl}/api/projects`);
    const { sessions } = await listRes.json();
    assert.ok(!sessions.find(s => s.id === session.id));
  });
});
```

### Step 2: Run all tests

Run: `npm test`
Expected: All PASS

### Step 3: Commit

```bash
git add test/server.test.js
git commit -m "test: add worktree integration lifecycle test"
```

---

## Task 5: Create Documentation

**Files:**
- Modify: `CLAUDE.md`
- Create: `docs/worktrees.md`

### Step 1: Update CLAUDE.md

Add to CLAUDE.md under "## Gotchas":

```markdown
- Git worktrees: Projects must be git repositories (not bare, with at least one commit). Each session creates a worktree at `.worktrees/<branch-name>`. Add `.worktrees/` to your `.gitignore`.
```

### Step 2: Create docs/worktrees.md

```markdown
# Git Worktree Integration

Claude Console uses git worktrees to isolate sessions. Each session runs in its own worktree with its own branch.

## How It Works

When you create a session:
1. A new branch `claude/<session-name>-<id>` is created from current HEAD
2. A worktree is checked out at `.worktrees/<session-name>-<id>`
3. Claude runs in the worktree directory

This means multiple sessions can work on the same codebase without conflicts.

## Requirements

- Project directory must be a git repository
- Repository must have at least one commit
- Bare repositories are not supported

## Recommendations

Add `.worktrees/` to your `.gitignore`:

```
echo ".worktrees/" >> .gitignore
```

## Session Lifecycle

| Action | Worktree | Branch | Data |
|--------|----------|--------|------|
| Create | Created | Created | Stored |
| Restart | Reused | Unchanged | Unchanged |
| Archive | Removed | **Kept** | Removed |
| Delete | Removed | Removed | Removed |

### Archive vs Delete

- **Archive**: Removes the worktree but keeps the branch. Use this when you might want to recover the code later.
- **Delete**: Removes both worktree and branch. Use this for complete cleanup.

If a session has uncommitted changes, delete will prompt for confirmation.

## Recovering Archived Branches

After archiving, the branch remains in git:

```bash
# List Claude branches
git branch | grep claude/

# Checkout an archived branch
git checkout claude/fix-auth-bug-a1b2c3d

# Or create a new worktree from it
git worktree add ../recovered-work claude/fix-auth-bug-a1b2c3d
```

## Cleaning Up Old Branches

```bash
# Delete all claude branches
git branch | grep claude/ | xargs git branch -D
```

## Troubleshooting

### "Worktree was removed" error on restart

The worktree directory was deleted manually. Delete the session and create a new one.

### "Directory is not a git repository"

Initialize git in the project directory:

```bash
cd /path/to/project
git init
git commit --allow-empty -m "Initial commit"
```

### Session creation fails

Check git status in the project directory. Common issues:
- Corrupted git state
- Disk full
- Permission issues
```

### Step 3: Commit

```bash
git add CLAUDE.md docs/worktrees.md
git commit -m "docs: add worktree documentation"
```

---

## Summary

| Task | Files | Status |
|------|-------|--------|
| 1. git-worktree.js module | `git-worktree.js`, `test/git-worktree.test.js` | Ready |
| 2. Server integration | `server.js`, `test/server.test.js` | Ready |
| 3. Frontend UI | `public/app.js`, `public/style.css`, `public/index.html` | Ready |
| 4. Integration tests | `test/server.test.js` | Ready |
| 5. Documentation | `CLAUDE.md`, `docs/worktrees.md` | Ready |

**Total commits:** 6
