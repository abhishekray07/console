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
