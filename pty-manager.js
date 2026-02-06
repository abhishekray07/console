// pty-manager.js
import * as pty from 'node-pty';
import { EventEmitter } from 'node:events';

const MAX_BUFFER = 1024 * 1024; // 1MB

class PtyProcess extends EventEmitter {
  constructor(ptyProcess) {
    super();
    this.pty = ptyProcess;
    this.buffer = [];
    this.bufferSize = 0;
    this.alive = true;

    this._onPtyData = (data) => {
      this._pushToBuffer(data);
      this.emit('data', data);
    };

    this._onPtyExit = ({ exitCode }) => {
      this.alive = false;
      this.emit('exit', exitCode);
    };

    this.pty.onData(this._onPtyData);
    this.pty.onExit(this._onPtyExit);
  }

  _pushToBuffer(data) {
    this.buffer.push(data);
    this.bufferSize += data.length;
    while (this.bufferSize > MAX_BUFFER) {
      const removed = this.buffer.shift();
      this.bufferSize -= removed.length;
    }
  }

  write(data) {
    if (this.alive) {
      this.pty.write(data);
    }
  }

  resize(cols, rows) {
    if (this.alive) {
      this.pty.resize(cols, rows);
    }
  }

  kill() {
    if (this.alive) {
      this.pty.kill();
      this.alive = false;
    }
    this._cleanup();
  }

  _cleanup() {
    this.buffer.length = 0;
    this.bufferSize = 0;
    this.removeAllListeners();
  }
}

export class PtyManager {
  constructor() {
    this.processes = new Map();
    this.shellProcesses = new Map();
  }

  spawn(sessionId, { cwd, resumeId, cols = 80, rows = 24, shell, args }) {
    if (this.processes.has(sessionId)) {
      throw new Error(`Session ${sessionId} already exists`);
    }

    let command, cmdArgs;
    if (shell) {
      command = shell;
      cmdArgs = args || [];
    } else if (resumeId) {
      command = 'claude';
      cmdArgs = ['--resume', resumeId];
    } else {
      command = 'claude';
      cmdArgs = [];
    }

    const ptyProcess = pty.spawn(command, cmdArgs, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: { ...process.env, TERM: 'xterm-256color' },
    });

    const proc = new PtyProcess(ptyProcess);
    this.processes.set(sessionId, proc);
    return proc;
  }

  getProcess(sessionId) {
    return this.processes.get(sessionId) || null;
  }

  getBuffer(sessionId) {
    const proc = this.processes.get(sessionId);
    return proc ? proc.buffer : [];
  }

  write(sessionId, data) {
    const proc = this.processes.get(sessionId);
    if (proc) proc.write(data);
  }

  resize(sessionId, cols, rows) {
    const proc = this.processes.get(sessionId);
    if (proc) proc.resize(cols, rows);
  }

  kill(sessionId) {
    const proc = this.processes.get(sessionId);
    if (proc) {
      proc.kill();
      this.processes.delete(sessionId);
    }
  }

  onExit(sessionId, callback) {
    const proc = this.processes.get(sessionId);
    if (proc) {
      // If already dead, fire immediately
      if (!proc.alive) {
        callback();
      } else {
        proc.on('exit', callback);
      }
    }
  }

  onData(sessionId, callback) {
    const proc = this.processes.get(sessionId);
    if (proc) proc.on('data', callback);
  }

  offData(sessionId, callback) {
    const proc = this.processes.get(sessionId);
    if (proc) proc.off('data', callback);
  }

  getAll() {
    return [...this.processes.keys()];
  }

  isAlive(sessionId) {
    const proc = this.processes.get(sessionId);
    return proc ? proc.alive : false;
  }

  destroyAll() {
    for (const id of this.getAll()) {
      this.kill(id);
    }
  }

  spawnShell(sessionId, { cwd, cols = 80, rows = 24 }) {
    if (this.shellProcesses.has(sessionId)) {
      throw new Error(`Shell for session ${sessionId} already exists`);
    }

    const shell = process.env.SHELL || '/bin/bash';
    const ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: { ...process.env, TERM: 'xterm-256color' },
    });

    const proc = new PtyProcess(ptyProcess);
    this.shellProcesses.set(sessionId, proc);
    return proc;
  }

  getShellProcess(sessionId) {
    return this.shellProcesses.get(sessionId) || null;
  }

  getShellBuffer(sessionId) {
    const proc = this.shellProcesses.get(sessionId);
    return proc ? proc.buffer : [];
  }

  writeShell(sessionId, data) {
    const proc = this.shellProcesses.get(sessionId);
    if (proc) proc.write(data);
  }

  resizeShell(sessionId, cols, rows) {
    const proc = this.shellProcesses.get(sessionId);
    if (proc) proc.resize(cols, rows);
  }

  killShell(sessionId) {
    const proc = this.shellProcesses.get(sessionId);
    if (proc) {
      proc.kill();
      this.shellProcesses.delete(sessionId);
    }
  }

  isShellAlive(sessionId) {
    const proc = this.shellProcesses.get(sessionId);
    return proc ? proc.alive : false;
  }

  onShellData(sessionId, callback) {
    const proc = this.shellProcesses.get(sessionId);
    if (proc) proc.on('data', callback);
  }

  offShellData(sessionId, callback) {
    const proc = this.shellProcesses.get(sessionId);
    if (proc) proc.off('data', callback);
  }

  destroyAllShells() {
    for (const [id] of this.shellProcesses) {
      this.killShell(id);
    }
  }
}
