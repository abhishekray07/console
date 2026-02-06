// test/pty-manager.test.js
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { PtyManager } from '../pty-manager.js';

describe('PtyManager', () => {
  let manager;

  before(() => {
    manager = new PtyManager();
  });

  after(() => {
    // Kill any lingering processes
    for (const id of manager.getAll()) {
      manager.kill(id);
    }
  });

  it('should spawn a process and receive output', async () => {
    // Use 'echo' instead of 'claude' for testing
    const sessionId = 'test-1';

    manager.spawn(sessionId, {
      cwd: process.cwd(),
      shell: '/bin/bash',
      args: ['-c', 'echo hello-from-pty && sleep 0.1'],
    });

    const proc = manager.getProcess(sessionId);
    assert.ok(proc, 'process should exist');

    // Wait for output to land in buffer
    await new Promise((resolve) => setTimeout(resolve, 500));

    const buffer = manager.getBuffer(sessionId);
    const combined = buffer.join('');
    assert.ok(combined.includes('hello-from-pty'), `expected output to contain hello-from-pty, got: ${combined}`);
  });

  it('should store output in ring buffer', async () => {
    const sessionId = 'test-buf';
    manager.spawn(sessionId, {
      cwd: process.cwd(),
      shell: '/bin/bash',
      args: ['-c', 'echo buffered-output && sleep 0.1'],
    });

    await new Promise((resolve) => setTimeout(resolve, 500));

    const buffer = manager.getBuffer(sessionId);
    assert.ok(buffer.length > 0, 'buffer should have data');
    const text = buffer.join('');
    assert.ok(text.includes('buffered-output'), `buffer should contain output, got: ${text}`);
  });

  it('should trim buffer at max size', () => {
    const sessionId = 'test-trim';
    manager.spawn(sessionId, {
      cwd: process.cwd(),
      shell: '/bin/bash',
      args: ['-c', 'sleep 5'],
    });

    const proc = manager.getProcess(sessionId);
    // Manually push data exceeding max buffer
    const bigChunk = 'x'.repeat(512 * 1024); // 512KB
    proc._pushToBuffer(bigChunk);
    proc._pushToBuffer(bigChunk);
    proc._pushToBuffer(bigChunk); // 1.5MB total

    assert.ok(proc.bufferSize <= 1024 * 1024, `buffer should be trimmed to max 1MB, got ${proc.bufferSize}`);
    manager.kill(sessionId);
  });

  it('should list active processes', () => {
    const before = manager.getAll().length;
    manager.spawn('test-list', {
      cwd: process.cwd(),
      shell: '/bin/bash',
      args: ['-c', 'sleep 5'],
    });
    assert.strictEqual(manager.getAll().length, before + 1);
    manager.kill('test-list');
    assert.strictEqual(manager.getAll().length, before);
  });

  it('should resize a process', () => {
    manager.spawn('test-resize', {
      cwd: process.cwd(),
      shell: '/bin/bash',
      args: ['-c', 'sleep 5'],
    });
    // Should not throw
    manager.resize('test-resize', 120, 40);
    manager.kill('test-resize');
  });

  it('should emit exit event', async () => {
    const sessionId = 'test-exit';
    let exitCalled = false;

    manager.spawn(sessionId, {
      cwd: process.cwd(),
      shell: '/bin/bash',
      args: ['-c', 'echo done && exit 0'],
    });

    manager.onExit(sessionId, () => {
      exitCalled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 1000));
    assert.ok(exitCalled, 'exit callback should have been called');
  });
});

describe('PtyManager shell processes', () => {
  let manager;

  before(() => {
    manager = new PtyManager();
  });

  after(() => {
    for (const id of manager.getAll()) {
      manager.kill(id);
    }
    manager.destroyAllShells();
  });

  it('should spawn a shell process and receive output', async () => {
    const sessionId = 'shell-test-1';
    manager.spawnShell(sessionId, {
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    });

    const proc = manager.getShellProcess(sessionId);
    assert.ok(proc, 'shell process should exist');
    assert.ok(manager.isShellAlive(sessionId), 'shell should be alive');

    // Send a command and wait for output
    manager.writeShell(sessionId, 'echo hello-from-shell\r');
    await new Promise((resolve) => setTimeout(resolve, 500));

    const buffer = manager.getShellBuffer(sessionId);
    const combined = buffer.join('');
    assert.ok(combined.includes('hello-from-shell'), `expected shell output, got: ${combined}`);
  });

  it('should resize a shell process', () => {
    const sessionId = 'shell-resize-test';
    manager.spawnShell(sessionId, {
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    });
    // Should not throw
    manager.resizeShell(sessionId, 120, 40);
    manager.killShell(sessionId);
  });

  it('should kill a shell process', () => {
    const sessionId = 'shell-kill-test';
    manager.spawnShell(sessionId, {
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    });
    assert.ok(manager.isShellAlive(sessionId));
    manager.killShell(sessionId);
    assert.ok(!manager.isShellAlive(sessionId));
  });

  it('should not spawn duplicate shell for same session', () => {
    const sessionId = 'shell-dup-test';
    manager.spawnShell(sessionId, {
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    });
    assert.throws(() => {
      manager.spawnShell(sessionId, {
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
      });
    }, /already exists/);
    manager.killShell(sessionId);
  });

  it('destroyAllShells kills all shell processes', () => {
    manager.spawnShell('shell-destroy-1', { cwd: process.cwd(), cols: 80, rows: 24 });
    manager.spawnShell('shell-destroy-2', { cwd: process.cwd(), cols: 80, rows: 24 });
    manager.destroyAllShells();
    assert.ok(!manager.isShellAlive('shell-destroy-1'));
    assert.ok(!manager.isShellAlive('shell-destroy-2'));
  });
});
