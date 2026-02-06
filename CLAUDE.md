# Claude Console

Web-based multi-session manager for the Claude CLI. Express + WebSocket backend spawns Claude processes via node-pty; vanilla JS + xterm.js frontend.

## Stack

- Node.js, Express, WebSocket (ws)
- node-pty for terminal emulation
- better-sqlite3 for persistence
- Vanilla JS + xterm.js frontend
- Vendored: marked.js (markdown), DOMPurify (sanitization)

## Structure

- server.js — REST API (`/api/browse`, `/api/file`, `/api/projects`), WebSocket handler, session lifecycle
- pty-manager.js — PTY process management, ring buffer
- store.js — Atomic JSON persistence
- public/app.js — Frontend logic (file tree, tabs, file viewer, terminal management)
- public/ — Frontend (vanilla JS + xterm.js)
- public/vendor/ — Vendored libs (xterm.js, marked.js, DOMPurify — do not modify)
- test/ — Unit tests (`*.test.js`) and smoke test (`smoke-test.mjs`)

## Commands

```
npm start              # Run server (port 3000)
npm test               # Run unit tests
npm run test:smoke     # Run Playwright UI smoke test (requires server not running)
node --check server.js # Syntax check
```

## Verification

Run before committing:
1. `npm test` — fix failing tests
2. `node --check server.js && node --check pty-manager.js && node --check store.js` — fix syntax errors
3. `npm run test:smoke` — fix UI regressions (tests layout, file tree, tabs, markdown rendering)

## Don't

- Don't modify session UUID regex in server.js — it enables `claude --resume`. Read the regex and surrounding comments before touching session capture logic.
- Don't expose server publicly — `/api/browse` and `/api/file` serve filesystem contents. Server MUST remain bound to 127.0.0.1.
- Don't edit files in public/vendor/ — these are vendored third-party libs. Update by re-downloading from CDN.
- Don't commit `.worktrees/` — sessions run in isolated worktrees. Branch naming: `claude/{name}-{uuid}`. See `docs/worktree-guide.md` for details.
- Don't bypass path traversal checks — `/api/file` and session-scoped `/api/browse` validate paths server-side with symlink-safe realpath checks. All file access goes through worktree root resolution.

## References

- For file viewer architecture and design: see `docs/plans/2026-02-06-file-viewer-design.md`
- For file viewer implementation plan: see `docs/plans/2026-02-06-file-viewer-plan.md`
- For worktree setup: see `docs/worktree-guide.md`
