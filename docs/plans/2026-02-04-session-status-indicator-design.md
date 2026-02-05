# Session Status Indicator Design

**Date:** 2026-02-04
**Status:** Approved

## Overview

Add visual distinction between "Claude is running" (pulsing green) and "Claude is waiting for input" (solid green) in the sidebar session list.

## Current State

- Binary status: `alive` (green) vs `exited` (gray)
- No indication of whether Claude is actively generating or waiting

## New State Model

```
alive + active  → pulsing green (Claude is generating output)
alive + idle    → solid green (Claude is waiting for input)
exited          → gray (process terminated)
```

## Approach: Hybrid Idle Detection

Use PTY output idle detection (500ms without output = waiting) with room to add JSONL file watching later for more accuracy.

## Implementation

### 1. PtyManager Changes (`pty-manager.js`)

Add idle tracking to `PtyProcess` class:

```javascript
class PtyProcess extends EventEmitter {
  constructor(ptyProcess) {
    // ... existing code
    this.lastOutputTime = Date.now();
    this.idle = false;

    this.idleChecker = setInterval(() => {
      const wasIdle = this.idle;
      this.idle = Date.now() - this.lastOutputTime > 500;
      if (this.idle !== wasIdle) {
        this.emit('idle-change', this.idle);
      }
    }, 300);
  }

  _onPtyData = (data) => {
    this.lastOutputTime = Date.now();
    if (this.idle) {
      this.idle = false;
      this.emit('idle-change', false);
    }
    // ... existing buffer/emit logic
  };

  _cleanup() {
    clearInterval(this.idleChecker);
    // ... existing cleanup
  }
}
```

Add new methods to `PtyManager`:

```javascript
isIdle(sessionId) {
  const proc = this.processes.get(sessionId);
  return proc ? proc.idle : true;
}

onIdleChange(sessionId, callback) {
  const proc = this.processes.get(sessionId);
  if (proc) proc.on('idle-change', callback);
}
```

### 2. Server Changes (`server.js`)

Broadcast idle state changes:

```javascript
// In spawnSession()
manager.onIdleChange(session.id, (idle) => {
  const msg = JSON.stringify({ type: 'session-idle', sessionId: session.id, idle });
  for (const ws of clients) {
    safeSend(ws, msg);
  }
});
```

Include idle in state broadcasts:

```javascript
sessions: data.sessions.map((s) => ({
  ...s,
  alive: manager.isAlive(s.id),
  idle: manager.isIdle(s.id),
})),
```

### 3. CSS Changes (`public/style.css`)

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

### 4. Frontend Changes (`public/app.js`)

Track and update idle state:

```javascript
const sessionIdleState = new Map();

// WebSocket handler
case 'session-idle': {
  const { sessionId, idle } = msg;
  sessionIdleState.set(sessionId, idle);
  updateStatusDot(sessionId, idle);
  break;
}

function updateStatusDot(sessionId, idle) {
  const dot = document.querySelector(`[data-session-id="${sessionId}"] .status-dot`);
  if (dot) {
    dot.classList.toggle('active', !idle);
  }
}
```

Update `renderSidebar()` to include idle state:

```javascript
const dot = document.createElement('span');
dot.className = 'status-dot';
if (s.alive) {
  dot.classList.add('alive');
  if (!s.idle) dot.classList.add('active');
} else {
  dot.classList.add('exited');
}
```

## Edge Cases

1. **New session spawn** - Starts as `active` (pulsing)
2. **Session restart** - Reset idle state, starts pulsing
3. **Process exit** - Clear interval, dot goes gray
4. **Client reconnect** - Gets current idle state via `broadcastState()`

## Future Enhancement

JSONL file watching for ground-truth state detection:
- Watch `~/.claude/projects/<project-path>/<claudeSessionId>.jsonl`
- Look for `type: "system"` with `subtype: "stop_hook_summary"` or `"turn_duration"`
- Not needed for v1

## Files to Modify

1. `pty-manager.js` - Add idle tracking
2. `server.js` - Broadcast idle changes, include in state
3. `public/style.css` - Add pulse animation
4. `public/app.js` - Handle idle messages, update dots
