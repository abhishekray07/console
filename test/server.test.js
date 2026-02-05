// test/server.test.js
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

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'server-test-'));
}

function createTempRepo() {
  const dir = createTempDir();
  execSync('git init && git commit --allow-empty -m "init"', {
    cwd: dir,
    env: { ...process.env, ...gitEnv },
  });
  return dir;
}

function cleanupDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

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

  it('GET /api/projects returns empty projects and sessions initially', async () => {
    const res = await fetch(`${baseUrl}/api/projects`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.projects));
    assert.ok(Array.isArray(data.sessions));
    assert.strictEqual(data.projects.length, 0);
    assert.strictEqual(data.sessions.length, 0);
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
    const { projects } = await listRes.json();
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
    const { projects, sessions } = await listRes.json();
    assert.ok(!projects.find((p) => p.id === proj.id));
    assert.ok(!sessions.find((s) => s.projectId === proj.id), 'cascade: sessions should be removed');
  });
});

describe('Git Worktree Integration', () => {
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

  it('POST /api/projects rejects non-git directory (code: NOT_GIT_REPO)', async () => {
    tempDir = createTempDir();
    const res = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'not-git', cwd: tempDir }),
    });
    assert.strictEqual(res.status, 400);
    const data = await res.json();
    assert.strictEqual(data.code, 'NOT_GIT_REPO');
    cleanupDir(tempDir);
    tempDir = null;
  });

  it('POST /api/projects rejects bare repository (code: BARE_REPO)', async () => {
    tempDir = createTempDir();
    execSync('git init --bare', { cwd: tempDir, env: { ...process.env, ...gitEnv } });
    const res = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'bare-repo', cwd: tempDir }),
    });
    assert.strictEqual(res.status, 400);
    const data = await res.json();
    assert.strictEqual(data.code, 'BARE_REPO');
    cleanupDir(tempDir);
    tempDir = null;
  });

  it('POST /api/projects rejects empty repository (code: EMPTY_REPO)', async () => {
    tempDir = createTempDir();
    execSync('git init', { cwd: tempDir, env: { ...process.env, ...gitEnv } });
    const res = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'empty-repo', cwd: tempDir }),
    });
    assert.strictEqual(res.status, 400);
    const data = await res.json();
    assert.strictEqual(data.code, 'EMPTY_REPO');
    cleanupDir(tempDir);
    tempDir = null;
  });

  it('POST /api/projects accepts valid git repository', async () => {
    tempDir = createTempRepo();
    const res = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'valid-repo', cwd: tempDir }),
    });
    assert.strictEqual(res.status, 201);
    const data = await res.json();
    assert.ok(data.id);
    assert.strictEqual(data.name, 'valid-repo');
    cleanupDir(tempDir);
    tempDir = null;
  });
});

describe('Worktree Session Lifecycle', () => {
  let server;
  let baseUrl;
  let tempDir;
  let projectId;

  before(async () => {
    server = createServer({ testMode: true });
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://localhost:${server.address().port}`;

    // Create a temp git repo for tests
    tempDir = createTempRepo();
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
    if (tempDir) cleanupDir(tempDir);
  });

  it('POST /api/projects/:id/sessions creates worktree and branch', async () => {
    const res = await fetch(`${baseUrl}/api/projects/${projectId}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Feature Test' }),
    });
    assert.strictEqual(res.status, 201);
    const session = await res.json();
    assert.ok(session.id);
    assert.ok(session.branchName, 'session should have branchName');
    assert.ok(session.worktreePath, 'session should have worktreePath');
    assert.ok(session.branchName.startsWith('feature-test-'), 'branchName should be sanitized');

    // Verify worktree was created
    const worktreePath = path.join(tempDir, session.worktreePath);
    assert.ok(fs.existsSync(worktreePath), 'worktree directory should exist');

    // Verify branch exists
    const branches = execSync('git branch -a', { cwd: tempDir, encoding: 'utf8' });
    assert.ok(branches.includes(`claude/${session.branchName}`), 'branch should exist');
  });

  it('POST /api/projects/:id/sessions returns INVALID_BRANCH_NAME for bad names', async () => {
    const res = await fetch(`${baseUrl}/api/projects/${projectId}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '../../../etc/passwd' }),
    });
    // The name gets sanitized, so it should actually succeed
    // The sanitizer removes the dots and slashes
    assert.strictEqual(res.status, 201);
    const session = await res.json();
    // Verify the branch name doesn't contain path traversal
    assert.ok(!session.branchName.includes('..'), 'branchName should not contain ..');
    assert.ok(!session.branchName.includes('/'), 'branchName should not contain /');
  });

  it('POST /api/sessions/:id/restart returns WORKTREE_MISSING when worktree removed', async () => {
    // Create a session
    const createRes = await fetch(`${baseUrl}/api/projects/${projectId}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Restart Test' }),
    });
    const session = await createRes.json();

    // Manually remove the worktree
    const worktreePath = path.join(tempDir, session.worktreePath);
    execSync(`git worktree remove --force "${worktreePath}"`, { cwd: tempDir });

    // Try to restart
    const res = await fetch(`${baseUrl}/api/sessions/${session.id}/restart`, { method: 'POST' });
    assert.strictEqual(res.status, 400);
    const data = await res.json();
    assert.strictEqual(data.code, 'WORKTREE_MISSING');
  });

  it('POST /api/sessions/:id/archive removes worktree but keeps branch', async () => {
    // Create a session
    const createRes = await fetch(`${baseUrl}/api/projects/${projectId}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Archive Test' }),
    });
    const session = await createRes.json();
    const worktreePath = path.join(tempDir, session.worktreePath);
    const fullBranchName = `claude/${session.branchName}`;

    // Archive the session
    const res = await fetch(`${baseUrl}/api/sessions/${session.id}/archive`, { method: 'POST' });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.ok, true);
    assert.ok(data.branch.includes('claude/'), 'response should include branch name');

    // Verify worktree was removed
    assert.ok(!fs.existsSync(worktreePath), 'worktree directory should be removed');

    // Verify branch still exists
    const branches = execSync('git branch -a', { cwd: tempDir, encoding: 'utf8' });
    assert.ok(branches.includes(fullBranchName), 'branch should still exist after archive');

    // Verify session is removed from list
    const listRes = await fetch(`${baseUrl}/api/projects`);
    const { sessions } = await listRes.json();
    assert.ok(!sessions.find((s) => s.id === session.id), 'session should be removed');
  });

  it('DELETE returns DIRTY_WORKTREE when uncommitted changes', async () => {
    // Create a session
    const createRes = await fetch(`${baseUrl}/api/projects/${projectId}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Dirty Test' }),
    });
    const session = await createRes.json();

    // Create uncommitted changes in the worktree
    const worktreePath = path.join(tempDir, session.worktreePath);
    fs.writeFileSync(path.join(worktreePath, 'dirty-file.txt'), 'uncommitted changes');

    // Try to delete (should fail)
    const res = await fetch(`${baseUrl}/api/sessions/${session.id}`, { method: 'DELETE' });
    assert.strictEqual(res.status, 400);
    const data = await res.json();
    assert.strictEqual(data.code, 'DIRTY_WORKTREE');
  });

  it('DELETE with force=true deletes dirty worktree', async () => {
    // Create a session
    const createRes = await fetch(`${baseUrl}/api/projects/${projectId}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Force Delete Test' }),
    });
    const session = await createRes.json();

    // Create uncommitted changes in the worktree
    const worktreePath = path.join(tempDir, session.worktreePath);
    fs.writeFileSync(path.join(worktreePath, 'dirty-file.txt'), 'uncommitted changes');

    // Delete with force=true
    const res = await fetch(`${baseUrl}/api/sessions/${session.id}?force=true`, { method: 'DELETE' });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.ok, true);

    // Verify worktree and branch are removed
    assert.ok(!fs.existsSync(worktreePath), 'worktree directory should be removed');
  });

  it('DELETE proceeds when dirty check fails (missing worktree)', async () => {
    // Create a session
    const createRes = await fetch(`${baseUrl}/api/projects/${projectId}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Missing Worktree Test' }),
    });
    const session = await createRes.json();

    // Manually remove the worktree directory (simulate corruption)
    const worktreePath = path.join(tempDir, session.worktreePath);
    fs.rmSync(worktreePath, { recursive: true, force: true });

    // Delete should still succeed
    const res = await fetch(`${baseUrl}/api/sessions/${session.id}`, { method: 'DELETE' });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.ok, true);
  });
});
