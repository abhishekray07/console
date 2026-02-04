// test/server.test.js
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { createServer } from '../server.js';

describe('Server REST API', () => {
  let server;
  let baseUrl;

  before(async () => {
    server = createServer({ testMode: true });
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    baseUrl = `http://localhost:${port}`;
  });

  after(async () => {
    await server.destroy();
  });

  it('GET /api/sessions returns empty array initially', async () => {
    const res = await fetch(`${baseUrl}/api/sessions`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data));
  });

  it('POST /api/sessions with invalid cwd returns 400', async () => {
    const res = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'test', cwd: '/nonexistent/path/xyz' }),
    });
    assert.strictEqual(res.status, 400);
  });

  it('POST /api/sessions with valid cwd creates session', async () => {
    const res = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'test-session', cwd: process.cwd() }),
    });
    assert.strictEqual(res.status, 201);
    const data = await res.json();
    assert.ok(data.id);
    assert.strictEqual(data.name, 'test-session');
    assert.strictEqual(data.status, 'running');
  });

  it('DELETE /api/sessions/:id removes session', async () => {
    // Create first
    const createRes = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'to-delete', cwd: process.cwd() }),
    });
    const { id } = await createRes.json();

    // Delete
    const res = await fetch(`${baseUrl}/api/sessions/${id}`, { method: 'DELETE' });
    assert.strictEqual(res.status, 200);

    // Verify gone
    const listRes = await fetch(`${baseUrl}/api/sessions`);
    const sessions = await listRes.json();
    assert.ok(!sessions.find((s) => s.id === id));
  });
});
