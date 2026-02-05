# Session Status Indicator Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add pulsing green status indicator when Claude is actively running, solid green when waiting for input.

**Architecture:** PTY idle detection with 1.5s setTimeout threshold and hysteresis (immediate active on output, delayed idle). Server broadcasts idle state changes via WebSocket; frontend tracks state in Map for persistence across re-renders.

**Tech Stack:** Node.js, node-pty, WebSocket, vanilla JS, CSS animations

**Design Doc:** `docs/plans/2026-02-04-session-status-indicator-design.md`

**Dex Epic:** `7a106ab5`

---

### Task 1: Add idle tracking to PtyProcess class

**Files:**
- Modify: `pty-manager.js:7-63` (PtyProcess class)

**Step 1: Add idle state properties to constructor**

After line 13 (`this.alive = true;`), add:

```javascript
this.idle = false;
this.idleTimer = null;

this._scheduleIdleCheck();
```

**Step 2: Add idle timer methods**

After the constructor, add these methods:

```javascript
_scheduleIdleCheck() {
  this._clearIdleTimer();
  this.idleTimer = setTimeout(() => {
    if (!this.idle && this.alive) {
      this.idle = true;
      this.emit('idle-change', true);
    }
  }, 1500);
}

_clearIdleTimer() {
  if (this.idleTimer) {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}
```

**Step 3: Update _onPtyData to reset idle**

Replace the `_onPtyData` assignment (lines 15-18) with:

```javascript
this._onPtyData = (data) => {
  if (this.idle) {
    this.idle = false;
    this.emit('idle-change', false);
  }
  this._scheduleIdleCheck();
  this._pushToBuffer(data);
  this.emit('data', data);
};
```

**Step 4: Update _onPtyExit to clear timer**

Replace the `_onPtyExit` assignment (lines 20-23) with:

```javascript
this._onPtyExit = ({ exitCode }) => {
  this._clearIdleTimer();
  this.alive = false;
  this.emit('exit', exitCode);
};
```

**Step 5: Update _cleanup to clear timer**

Replace `_cleanup()` method (lines 58-62) with:

```javascript
_cleanup() {
  this._clearIdleTimer();
  this.buffer.length = 0;
  this.bufferSize = 0;
  this.removeAllListeners();
}
```

**Step 6: Run syntax check**

Run: `node --check pty-manager.js`
Expected: No output (success)

**Step 7: Commit**

```bash
git add pty-manager.js
git commit -m "feat(pty): add idle tracking with setTimeout hysteresis"
```

---

### Task 2: Add idle methods to PtyManager class

**Files:**
- Modify: `pty-manager.js:65-163` (PtyManager class)

**Step 1: Add isIdle method**

After `isAlive()` method (lines 153-156), add:

```javascript
isIdle(sessionId) {
  const proc = this.processes.get(sessionId);
  return proc ? proc.idle : true;
}

onIdleChange(sessionId, callback) {
  const proc = this.processes.get(sessionId);
  if (proc) proc.on('idle-change', callback);
}

offIdleChange(sessionId, callback) {
  const proc = this.processes.get(sessionId);
  if (proc) proc.off('idle-change', callback);
}
```

**Step 2: Run syntax check**

Run: `node --check pty-manager.js`
Expected: No output (success)

**Step 3: Commit**

```bash
git add pty-manager.js
git commit -m "feat(pty): add isIdle and onIdleChange methods to PtyManager"
```

---

### Task 3: Add idle to server state broadcasts

**Files:**
- Modify: `server.js:94-106` (broadcastState function)
- Modify: `server.js:163-171` (GET /api/projects)
- Modify: `server.js:322-337` (WebSocket initial state)

**Step 1: Update broadcastState to include idle**

In `broadcastState()`, change line 100 from:
```javascript
alive: manager.isAlive(s.id),
```
to:
```javascript
alive: manager.isAlive(s.id),
idle: manager.isIdle(s.id),
```

**Step 2: Update GET /api/projects to include idle**

In the `/api/projects` handler, change line 168 from:
```javascript
alive: manager.isAlive(s.id),
```
to:
```javascript
alive: manager.isAlive(s.id),
idle: manager.isIdle(s.id),
```

**Step 3: Update WebSocket initial state to include idle**

In the WebSocket connection handler, change line 334 from:
```javascript
alive: manager.isAlive(s.id),
```
to:
```javascript
alive: manager.isAlive(s.id),
idle: manager.isIdle(s.id),
```

**Step 4: Run syntax check**

Run: `node --check server.js`
Expected: No output (success)

**Step 5: Commit**

```bash
git add server.js
git commit -m "feat(server): include idle state in all state broadcasts"
```

---

### Task 4: Add idle change broadcast to spawnSession

**Files:**
- Modify: `server.js:108-159` (spawnSession function)

**Step 1: Add idle change listener after onExit**

After the `manager.onExit()` block (around line 138), add:

```javascript
manager.onIdleChange(session.id, (idle) => {
  const msg = JSON.stringify({ type: 'session-idle', sessionId: session.id, idle });
  for (const ws of clients) {
    safeSend(ws, msg);
  }
});
```

**Step 2: Run syntax check**

Run: `node --check server.js`
Expected: No output (success)

**Step 3: Commit**

```bash
git add server.js
git commit -m "feat(server): broadcast session-idle WebSocket messages"
```

---

### Task 5: Add CSS pulse animation

**Files:**
- Modify: `public/style.css:126-133` (status-dot styles)

**Step 1: Add active class and keyframes**

After the existing `.status-dot.exited` rule (line 133), add:

```css
.status-dot.alive.active {
  animation: pulse 1.5s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.5;
    transform: scale(1.2);
  }
}
```

**Step 2: Commit**

```bash
git add public/style.css
git commit -m "feat(css): add pulse animation for active session status"
```

---

### Task 6: Add frontend idle state tracking

**Files:**
- Modify: `public/app.js`

**Step 1: Add sessionIdleState Map**

After line 12 (`let expandedProjects = new Set();`), add:

```javascript
const sessionIdleState = new Map();
```

**Step 2: Add updateStatusDot function**

After the `attachSession` function (around line 213), add:

```javascript
function updateStatusDot(sessionId, idle) {
  const dot = document.querySelector(`[data-session-id="${sessionId}"] .status-dot`);
  if (dot) {
    dot.classList.toggle('active', !idle);
  }
}
```

**Step 3: Add session-idle WebSocket handler**

In the WebSocket message switch statement, add a new case after `case 'exited'` (around line 186):

```javascript
case 'session-idle': {
  const { sessionId, idle } = msg;
  sessionIdleState.set(sessionId, idle);
  updateStatusDot(sessionId, idle);
  break;
}
```

**Step 4: Sync idle state on 'state' message (with full reconciliation)**

In the `case 'state'` handler, after `sessions = msg.sessions;` (line 165), add:

```javascript
// Reconcile idle state: overwrite with server state and prune stale entries
const currentSessionIds = new Set(sessions.map(s => s.id));
for (const [id] of sessionIdleState) {
  if (!currentSessionIds.has(id)) {
    sessionIdleState.delete(id);
  }
}
for (const s of sessions) {
  if (s.idle !== undefined) {
    sessionIdleState.set(s.id, s.idle);
  }
}
```

**Step 5: Clean up idle state on session-deleted**

In the `case 'session-deleted'` handler (around line 175), add after the existing code:

```javascript
sessionIdleState.delete(msg.sessionId);
```

**Step 6: Commit**

```bash
git add public/app.js
git commit -m "feat(frontend): add idle state tracking with full reconciliation"
```

---

### Task 7: Update renderSidebar with data-session-id and idle class

**Files:**
- Modify: `public/app.js` (renderSidebar function, lines 276-282)

**Step 1: Add data-session-id to session list item**

Find the session `<li>` creation (line 277):
```javascript
const li = document.createElement('li');
```

Add immediately after:
```javascript
li.dataset.sessionId = s.id;
```

**Step 2: Update status dot logic**

Replace the existing dot creation and class logic (lines 280-282):
```javascript
const dot = document.createElement('span');
dot.className = 'status-dot';
dot.classList.add(s.alive ? 'alive' : 'exited');
```

With:
```javascript
const dot = document.createElement('span');
dot.className = 'status-dot';
if (s.alive) {
  dot.classList.add('alive');
  const idle = sessionIdleState.has(s.id) ? sessionIdleState.get(s.id) : s.idle;
  if (!idle) dot.classList.add('active');
} else {
  dot.classList.add('exited');
  sessionIdleState.delete(s.id);
}
```

**Step 3: Commit**

```bash
git add public/app.js
git commit -m "feat(frontend): add data-session-id and idle-aware status dots"
```

---

### Task 8: Run tests and verify

**Files:**
- None (verification only)

**Step 1: Run syntax checks**

Run: `node --check server.js && node --check pty-manager.js && node --check store.js`
Expected: No output (success)

**Step 2: Run test suite**

Run: `npm test`
Expected: All tests pass

**Step 3: Manual smoke test**

1. Start server: `npm start`
2. Open http://127.0.0.1:3000
3. Create a project and session
4. Verify: Status dot pulses green while Claude outputs
5. Verify: Status dot becomes solid green after ~1.5s of no output
6. Verify: Typing in terminal briefly pulses (echo)
7. Verify: Exited session shows gray dot

**Step 4: Final commit (if any fixes needed)**

```bash
git add -A
git commit -m "fix: address issues found in smoke test"
```

---

## Summary

| Task | Component | Files |
|------|-----------|-------|
| 1 | PtyProcess idle tracking | pty-manager.js |
| 2 | PtyManager idle methods | pty-manager.js |
| 3 | State broadcast with idle | server.js |
| 4 | Idle change WebSocket | server.js |
| 5 | CSS pulse animation | public/style.css |
| 6 | Frontend idle tracking | public/app.js |
| 7 | Sidebar idle-aware rendering | public/app.js |
| 8 | Testing & verification | - |
