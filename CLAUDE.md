# Claude Console

Web-based multi-session manager for the Claude CLI. Express + WebSocket backend spawns Claude processes via node-pty; vanilla JS + xterm.js frontend.

## Structure

- server.js — REST API, WebSocket handler, session lifecycle
- pty-manager.js — PTY process management, ring buffer
- store.js — Atomic JSON persistence
- public/ — Frontend (vanilla JS + xterm.js)
- public/vendor/ — Vendored xterm.js (do not modify)

## Commands

npm start          # Run server (port 3000)
npm test           # Run all tests

## Verification

Run before committing:
1. npm test
2. node --check server.js && node --check pty-manager.js && node --check store.js
3. UI smoke test: Start server (`npm start`), use Playwright MCP to navigate to http://127.0.0.1:3000 and verify:
   - Sidebar shows "Projects" header with "+" button
   - Main area shows "Add Project" button when no sessions active
   - Clicking "+" opens modal with directory browser
   - Fetch /app.js and confirm `term.scrollToBottom()` exists in replay-done handler
   - For terminal changes: create sessions, switch between them, verify scroll position

## Gotchas

- Session UUID capture: server.js regex-matches the first UUID from Claude CLI output to enable `claude --resume`. Changes to this logic break session resumption.
- node-pty postinstall: macOS ARM needs chmod on spawn-helper (handled by postinstall script in package.json)
- /api/browse endpoint: Serves directory listings restricted to user's home directory. Server MUST remain bound to 127.0.0.1 — never expose this endpoint publicly.
- Worktrees: Sessions run in isolated worktrees under `.worktrees/`. Add `.worktrees/` to your project's `.gitignore` to avoid committing session directories. Branch naming: `claude/{name}-{uuid}`. See `docs/worktree-guide.md` for details.
