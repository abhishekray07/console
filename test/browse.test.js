// test/browse.test.js
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
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
    // Get worktree path from session data
    const allRes = await fetch(`${baseUrl}/api/projects`);
    const allData = await allRes.json();
    const session = allData.sessions.find(s => s.id === sessionId);
    const wtPath = path.join(tempDir, session.worktreePath);

    // Create 210 files in worktree
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
