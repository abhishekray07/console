# Mobile Responsive Design — Claude Console

## Summary

Make Claude Console usable on mobile phones by adding CSS media queries and minimal JS to collapse the 3-column desktop layout into a single-column chat-focused view.

## Decisions

- **Breakpoint:** 768px (tablet portrait and below)
- **Navigation:** Hamburger slide-out sidebar overlay
- **Top bar:** Hamburger + session name + status dot + new session button
- **Terminal input:** Leave xterm.js as-is, iterate if needed
- **Voice input:** Deferred to follow-up
- **Scope:** Frontend-only (CSS + JS). No backend changes.

## Layout Strategy

### What changes on mobile (`@media (max-width: 768px)`):

- **Sidebar** — hidden off-screen to the left (`transform: translateX(-100%)`), slides in as an overlay when hamburger is tapped. Semi-transparent backdrop behind it to dismiss on tap.
- **Right panel** — completely hidden (`display: none`). File tree and shell terminal are desktop-only for now.
- **Main area** — fills full width (`width: 100%`, not `100vw` to avoid scrollbar issues). The Claude terminal gets the full screen minus the top bar.
- **Tab bar** — hidden. No file tabs on mobile, just the Claude chat.

### What's added on mobile:

- **Top bar** (~44px + safe area) — hamburger icon (left), session name + status dot (center), "+" new session button (right). Respects `env(safe-area-inset-top)` for notched devices.
- **Backdrop overlay** — dark semi-transparent div behind the sidebar when it's open, click/tap to dismiss.
- **Recent sessions section** — flat list of last 5 sessions at the top of the mobile sidebar for fast switching (2 taps instead of 3).

### What stays the same:

- Desktop layout is completely untouched above 768px. Zero changes to existing behavior.
- Sidebar HTML structure is reused — we just change how it's positioned.

## HTML Changes

Add two elements directly in `index.html` (not created dynamically):

```html
<!-- After #sidebar, before #terminal-container -->
<div id="sidebar-backdrop"></div>

<!-- Inside #terminal-container, before #tab-bar -->
<div id="mobile-topbar">
  <button id="mobile-hamburger" aria-label="Open menu">☰</button>
  <div id="mobile-session-info">
    <span id="mobile-status-dot" class="status-dot"></span>
    <span id="mobile-session-name">Claude Console</span>
  </div>
  <button id="mobile-new-session" aria-label="New session">+</button>
</div>
```

Both hidden by default via CSS (`display: none`), shown only inside the 768px media query. Static HTML means no layout shift, testable at any viewport, and no conditional DOM creation in JS.

## CSS Approach

### Base styles (outside media query):

```css
/* Hidden on desktop by default */
#mobile-topbar { display: none; }
#sidebar-backdrop { display: none; }
```

### Viewport fix:

```css
/* Fix 100vh on mobile Safari — 100dvh excludes URL bar */
body, #app {
  height: 100vh;
  height: 100dvh;
}
```

### Viewport meta tag update:

```html
<!-- Add viewport-fit=cover to enable safe area insets -->
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
```

### Media query structure:

```css
@media (max-width: 768px) {
  /* Sidebar: off-screen overlay */
  #sidebar {
    position: fixed;
    left: 0;
    top: 0;
    bottom: 0;
    z-index: 1000;
    transform: translateX(-100%);
    transition: transform 0.2s ease;
    will-change: transform;
    padding-top: env(safe-area-inset-top);
    padding-bottom: env(safe-area-inset-bottom);
  }
  #sidebar.open {
    transform: translateX(0);
  }

  /* Backdrop */
  #sidebar-backdrop {
    display: block;
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    z-index: 999;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.2s ease;
  }
  #sidebar-backdrop.visible {
    opacity: 1;
    pointer-events: auto;
  }

  /* Hide right panel entirely */
  #right-panel {
    display: none !important;
  }

  /* Hide tab bar */
  #tab-bar {
    display: none !important;
  }

  /* Main area fills screen via flex, not 100vw */
  #terminal-container {
    width: 100%;
  }

  /* Mobile top bar */
  #mobile-topbar {
    display: flex;
    align-items: center;
    height: calc(44px + env(safe-area-inset-top));
    padding-top: env(safe-area-inset-top);
    padding-left: 8px;
    padding-right: 8px;
    flex-shrink: 0;
  }

  /* Terminal wrapper: offset below topbar */
  #terminal-wrapper {
    inset: calc(44px + env(safe-area-inset-top)) 0 0 0 !important;
  }

  /* Touch targets: 44px minimum */
  .project-sessions li {
    min-height: 44px;
    display: flex;
    align-items: center;
  }
  .project-header {
    min-height: 44px;
  }
  .btn-new-session {
    min-height: 44px;
  }
  #btn-add-project {
    min-height: 44px;
    min-width: 44px;
  }

  /* Session actions: always visible on touch (no hover) */
  .session-actions {
    display: flex !important;
  }

  /* Disable sticky hover states on touch devices */
  .project-header:hover {
    background: inherit;
  }
  .project-sessions li:hover {
    background: inherit;
  }

  /* Toast positioning for mobile */
  .toast {
    left: 50%;
    right: auto;
    transform: translateX(-50%);
    bottom: calc(20px + env(safe-area-inset-bottom));
  }

  /* Modal: responsive width */
  #modal .modal-content,
  #confirm-dialog {
    width: calc(100vw - 32px);
    max-width: 480px;
  }

  /* Bump modal z-index above sidebar backdrop */
  #modal-overlay {
    z-index: 1100;
  }
  #modal {
    z-index: 1101;
  }
}

/* Scope hover styles to pointer devices only */
@media (hover: hover) {
  .project-header:hover { /* existing hover styles */ }
  .project-sessions li:hover { /* existing hover styles */ }
}
```

## JS Changes

### Sidebar toggle:
- Toggle `sidebar.classList.toggle('open')` on hamburger tap
- Toggle `backdrop.classList.toggle('visible')` in sync
- Close sidebar on backdrop tap
- Close sidebar on session selection (auto-dismiss to chat)

### Mobile topbar updates:
- `updateMobileTopbar(session)` — extracted helper function, called from `attachSession()` and `renderSidebar()`. Updates session name and status dot.
- On no active session: shows "Claude Console" text, hides status dot

### New session button:
- "+" button in topbar triggers new session creation for the active project (same as sidebar's "+ New Session")

### Orientation / breakpoint handling:
- Listen for `matchMedia('(max-width: 768px)')` changes
- On transition above 768px: remove `open` class from sidebar, remove `visible` from backdrop (prevents state mismatch when rotating tablet past breakpoint)

### WebGL renderer:
- Skip `WebglAddon` when `matchMedia('(max-width: 768px)').matches` — use canvas renderer on mobile to avoid GPU issues on low-end devices

### Recent sessions in sidebar:
- Render a "Recent" section at the top of the sidebar on mobile showing the last 5 sessions (sorted by last activity) as a flat list, regardless of project. Reduces session switching from 3 taps to 2.

## Interaction Details

### Sidebar behavior:
- Opens with slide animation (0.2s ease), sits on top of content (not pushing it)
- `will-change: transform` hints browser to pre-composite for smooth animation
- Backdrop prevents accidental taps on the terminal behind
- Closes on: backdrop tap, session selection, or hamburger tap again
- Sidebar keeps its full 240px width (fits on 375px+ viewports)

### Session name in top bar:
- Truncated with ellipsis (`text-overflow: ellipsis`, `flex: 1`, `min-width: 0`)
- Status dot: 10px on mobile (up from 7px) for visibility
- Tapping the session name also opens the sidebar (larger tap target)

### Touch interactions:
- All interactive elements have 44px minimum touch targets
- Session delete/archive buttons always visible on mobile (no hover gate)
- Hover styles scoped to `@media (hover: hover)` to prevent sticky highlights on touch

### Terminal sizing:
- xterm.js `fit()` addon recalculates columns/rows for the single-column view
- Existing `ResizeObserver` / `window resize` listener handles this automatically
- Terminal wrapper `inset` adjusted to account for topbar height + safe area

### Edge cases:
- No active session: show existing no-session placeholder, top bar shows hamburger + "Claude Console"
- Orientation change: resize event fires, xterm refits. If rotating past 768px breakpoint, `matchMedia` listener resets sidebar state
- Keyboard open on mobile: `ResizeObserver` fires, terminal refits. Verify on iOS Safari with `visualViewport` API if needed.
- Modal from sidebar: modal z-index (1100+) sits above sidebar backdrop (999), so "Add Project" modal works even during sidebar close animation

## Deferred to Follow-up

- Voice input via Web Speech API
- Swipe-from-left-edge gesture to open sidebar
- Swipe-to-reveal session actions (currently always-visible on mobile)
- Landscape orientation hint for better terminal column count
- Haptic feedback on session switch
- Better empty states with onboarding copy
- File tree access on tablets via bottom sheet
