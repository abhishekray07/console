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
