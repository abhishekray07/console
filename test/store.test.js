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
    // Re-import to get fresh module state (use crypto.randomUUID for unique cache key)
    const mod = await import(`../store.js?t=${crypto.randomUUID()}`);
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
