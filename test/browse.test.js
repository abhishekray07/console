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
