# File Viewer Design

## Summary

Add an integrated file viewer to Claude Console for reading specs, plans, and other files during sessions. Files are browsed via a file tree in the right panel and rendered (with markdown support) in tabs in the main center area.

## Layout

```
┌──────────┬─────────────────────────────┬──────────────┐
│          │                             │  File Tree   │
│ Projects │  [Claude Terminal] [spec.md]│  (browse)    │
│ Sessions │                             │──────────────│
│          │   Main content area         │  Shell       │
│          │   (terminal or file view)   │  Terminal    │
└──────────┴─────────────────────────────┴──────────────┘
```

- **Left sidebar**: unchanged
- **Right panel top**: file tree navigator (browse worktree files)
- **Right panel bottom**: shell terminal (existing)
- **Center area**: tabbed — Claude terminal + opened file tabs

## Right Panel Split

The existing right panel (400px) is split vertically into two regions using flexbox:

### File Tree (top, default 40%)
- Header bar: "Files" label + collapse/expand toggle
- Scrollable file tree showing active session's worktree directory
- Folders expandable/collapsible, files clickable
- Clicking a file opens it as a tab in the center area
- Lazy loading: fetch directory contents on folder expand
- Reuses `/api/browse` endpoint scoped to session's worktree path
- Text-based icons: folder arrows (▶/▼), no icon library
- Soft limit of 200 entries per directory; "Show more" action for larger directories

### Shell Terminal (bottom, default 60%)
- Unchanged behavior, just in bottom portion
- `fitAddon.fit()` called when split ratio changes, debounced via `requestAnimationFrame`

### Draggable Divider
- 4px horizontal bar between sections
- Mouse drag to resize (JS mousedown/mousemove handler)
- Resize calls `fitAddon.fit()` debounced via `requestAnimationFrame` to avoid jank
- Min heights on both sections (100px) to prevent collapse

## Center Area Tab System

### Tab Bar
- Thin horizontal strip (~32px) above terminal content
- First tab: "Claude" (always present, cannot be closed)
- File tabs: show filename, full path on hover tooltip
- Close button (×) on each file tab
- Keyboard shortcuts (only active when terminal is NOT focused):
  - `Alt+Tab` cycles through open tabs
  - `Alt+W` closes the active file tab (never closes Claude tab)
  - Avoids Ctrl+W/Ctrl+Tab/Ctrl+R which conflict with browser-native shortcuts

### Tab Content
- Claude tab active: xterm.js terminal as today
- File tab active: rendered file content
- Terminal stays alive in background when viewing files
- Switching back to Claude shows terminal where you left it

### File Rendering
- Markdown files (.md): rendered via marked.js (vendored, ~40KB, zero deps)
- **HTML sanitization**: all rendered markdown is sanitized with DOMPurify (vendored, ~20KB) to prevent XSS from malicious HTML in markdown files
- Other text files (.js, .json, .txt, etc.): preformatted plain text, monospace font
- **Binary file detection**: check for null bytes in first 8KB; show "Binary file — not supported" placeholder instead of rendering garbage
- Styled markdown: headings, code blocks, lists, tables
- CSS-only syntax highlighting for code blocks
- No live-reload — refresh button on file tabs re-fetches content

## API

### New Endpoint: GET /api/file
- `GET /api/file?sessionId=<id>&path=<relative-path>` — returns raw file contents as text
- **Path is relative to the session's worktree root** (not absolute) to reduce traversal risk
- Server resolves: `path.resolve(worktreeRoot, relativePath)`
- **Symlink-safe validation**: uses `fs.realpath()` on the resolved path and verifies it still starts with the worktree root
- 403 if resolved path escapes worktree root (after realpath check)
- 404 for missing files
- 413 for files over 1MB

### Existing Endpoint: /api/browse
- Reused for file tree, scoped to worktree path

## State Management

All in-memory, no persistence:
- `openTabs[]` — array of `{ id, filename, fullPath, content, type }`
- `activeTabId` — `'claude'` or a file path
- Switching sessions closes all file tabs

## No WebSocket Changes

File viewing is purely REST. Existing WebSocket handles terminal I/O only.

## Security Checklist
- [ ] Path traversal: relative paths only, resolved server-side, realpath validation
- [ ] Symlink escape: fs.realpath check after resolution
- [ ] XSS: DOMPurify sanitizes all rendered markdown HTML
- [ ] Binary files: detected and blocked from rendering
- [ ] File size: 1MB limit enforced server-side
- [ ] Directory size: soft limit of 200 entries per directory listing
