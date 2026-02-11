# Mobile Responsive Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Claude Console usable on mobile phones with a single-column chat-focused layout, hamburger sidebar, and proper touch support.

**Architecture:** CSS media query at 768px switches from 3-column desktop to single-column mobile. Sidebar becomes a fixed overlay toggled via hamburger. Right panel (file tree + shell) hidden entirely. New 44px topbar shows session info. All changes are frontend-only.

**Tech Stack:** Vanilla CSS (media queries, safe area insets, dvh), vanilla JS (classList toggle, matchMedia listener)

**Design doc:** `docs/plans/2026-02-10-mobile-responsive-design.md`

---

### Task 1: Update viewport meta tag

**Files:**
- Modify: `public/index.html:5`

**Step 1: Update the viewport meta tag to enable safe area insets**

In `public/index.html`, line 5, change:
```html
<meta name="viewport" content="width=device-width, initial-scale=1.0">
```
to:
```html
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
```

**Step 2: Commit**

```bash
git add public/index.html
git commit -m "feat(mobile): add viewport-fit=cover for safe area insets"
```

---

### Task 2: Add mobile HTML elements

**Files:**
- Modify: `public/index.html:18` (after `</aside>` closing sidebar)
- Modify: `public/index.html:19-22` (inside `#terminal-container`, before `#tab-bar`)

**Step 1: Add sidebar backdrop element**

In `public/index.html`, after the closing `</aside>` of sidebar (line 18) and before `<main id="terminal-container">` (line 19), insert:

```html
    <div id="sidebar-backdrop"></div>
```

**Step 2: Add mobile topbar element**

Inside `<main id="terminal-container">`, before the `<div id="tab-bar">` (line 20), insert:

```html
      <div id="mobile-topbar">
        <button id="mobile-hamburger" aria-label="Open menu">&#9776;</button>
        <div id="mobile-session-info">
          <span id="mobile-status-dot" class="status-dot"></span>
          <span id="mobile-session-name">Claude Console</span>
        </div>
        <button id="mobile-new-session" aria-label="New session">+</button>
      </div>
```

**Step 3: Commit**

```bash
git add public/index.html
git commit -m "feat(mobile): add mobile topbar and sidebar backdrop HTML"
```

---

### Task 3: Add base CSS for new elements + dvh fix

**Files:**
- Modify: `public/style.css:7` (body height)
- Modify: `public/style.css:13` (app height)
- Modify: `public/style.css` (append after line 892, end of file)

**Step 1: Fix 100vh for mobile Safari**

In `public/style.css`, change body height (line 7):
```css
  height: 100vh;
```
to:
```css
  height: 100vh;
  height: 100dvh;
```

Similarly, change `#app` height (line 13):
```css
  height: 100vh;
```
to:
```css
  height: 100vh;
  height: 100dvh;
```

**Step 2: Add base styles for new elements (hidden on desktop)**

Append to end of `public/style.css`:

```css

/* --- Mobile responsive: base styles (hidden on desktop) --- */

#mobile-topbar {
  display: none;
}

#sidebar-backdrop {
  display: none;
}
```

**Step 3: Commit**

```bash
git add public/style.css
git commit -m "feat(mobile): add dvh fallback and base styles for mobile elements"
```

---

### Task 4: Add mobile media query — core layout

**Files:**
- Modify: `public/style.css` (append to end of file)

**Step 1: Add the mobile media query with sidebar overlay, hidden panels, and topbar**

Append to end of `public/style.css`:

```css

/* --- Mobile responsive: layout (max-width: 768px) --- */

@media (max-width: 768px) {
  /* Sidebar: off-screen fixed overlay */
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

  /* Backdrop behind sidebar */
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

  /* Main area: fill width via flex (not 100vw) */
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
    background: #16213e;
    border-bottom: 1px solid #0f3460;
    flex-shrink: 0;
    z-index: 2;
    position: relative;
  }

  #mobile-hamburger {
    background: none;
    border: none;
    color: #e0e0e0;
    font-size: 20px;
    width: 44px;
    height: 44px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  #mobile-session-info {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 8px;
    cursor: pointer;
  }

  #mobile-session-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 14px;
    font-weight: 600;
  }

  #mobile-topbar .status-dot {
    width: 10px;
    height: 10px;
    flex-shrink: 0;
  }

  #mobile-new-session {
    background: #0f3460;
    border: none;
    color: #e0e0e0;
    font-size: 18px;
    width: 44px;
    height: 44px;
    border-radius: 6px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  /* Terminal wrapper: offset below topbar.
     !important overrides inline style.inset set by switchTab() and state reconciliation.
     This is safe because tab-bar is hidden on mobile, so the JS inset values (32px for
     tab bar offset, 0 for no tabs) are irrelevant — mobile always needs topbar offset. */
  #terminal-wrapper {
    inset: calc(44px + env(safe-area-inset-top)) 0 0 0 !important;
  }

  /* No-session placeholder: offset below topbar */
  #no-session {
    inset: calc(44px + env(safe-area-inset-top)) 0 0 0;
  }

  /* File viewer: offset below topbar (hidden on mobile but just in case) */
  #file-viewer {
    inset: calc(44px + env(safe-area-inset-top)) 0 0 0;
  }
}
```

**Step 2: Commit**

```bash
git add public/style.css
git commit -m "feat(mobile): add core mobile media query with sidebar overlay and topbar"
```

---

### Task 5: Touch targets, hover fixes, and responsive modals

**Files:**
- Modify: `public/style.css:79` (remove hover rule)
- Modify: `public/style.css:106` (remove hover rule)
- Modify: `public/style.css:123` (remove hover rule)
- Modify: `public/style.css:556` (remove hover rule)
- Modify: `public/style.css` (append inside Task 4 media query + new hover capability query)

**Step 1: Move hover rules to capability query**

Remove these 4 existing hover rules from their current locations in `public/style.css`:

- Line 79: `.project-header:hover { background: #0f3460; }`
- Line 106: `.project-header:hover .project-delete { display: block; }`
- Line 123: `.project-sessions li:hover { background: #0f3460; }`
- Line 556: `.project-sessions li:hover .session-actions { display: flex; }`

These will be re-added inside a `@media (hover: hover)` capability query in Step 3.

**Step 2: Add mobile touch/UI rules inside the existing media query from Task 4**

Inside the `@media (max-width: 768px)` block from Task 4, before the closing `}`, append:

```css

  /* --- Touch targets & mobile polish --- */

  /* Touch targets: 44px minimum */
  .project-sessions li {
    min-height: 44px;
    padding-top: 10px;
    padding-bottom: 10px;
    font-size: 14px;
  }
  .project-header {
    min-height: 44px;
    font-size: 14px;
  }
  .btn-new-session {
    min-height: 44px;
    font-size: 14px;
  }
  #btn-add-project {
    min-height: 44px;
    min-width: 44px;
  }

  /* Session actions: always visible on touch (no hover on mobile) */
  .session-actions {
    display: flex !important;
  }

  /* Project delete: always visible on mobile */
  .project-delete {
    display: block !important;
  }

  /* Toast: full-width centered on mobile with safe area */
  .toast {
    left: 16px;
    right: 16px;
    bottom: calc(20px + env(safe-area-inset-bottom));
    max-width: none;
    transform: translateY(10px);
  }
  .toast.show {
    transform: translateY(0);
  }

  /* Modal: responsive width */
  #modal {
    width: calc(100vw - 32px);
    max-width: 480px;
  }

  /* Bump modal/confirm z-index above sidebar backdrop */
  #modal-overlay {
    z-index: 1100;
  }
  .confirm-overlay {
    z-index: 1100;
  }
```

**Step 3: Add hover capability query at end of file**

Append to end of `public/style.css`, after the media query block:

```css

/* Hover-reveal styles scoped to pointer devices only.
   These rules were moved here from the main cascade so that touch devices
   (which report hover: none) never get sticky hover backgrounds or
   hover-gated action buttons. */
@media (hover: hover) and (pointer: fine) {
  .project-header:hover { background: #0f3460; }
  .project-sessions li:hover { background: #0f3460; }
  .project-header:hover .project-delete { display: block; }
  .project-sessions li:hover .session-actions { display: flex; }
}
```

**Step 4: Commit**

```bash
git add public/style.css
git commit -m "feat(mobile): add touch targets, move hover rules to capability query"
```

---

### Task 6: Add JS — sidebar toggle and backdrop

**Files:**
- Modify: `public/app.js:70` (after DOM refs)
- Modify: `public/app.js:706-711` (session click handler in renderSidebar)
- Modify: `public/app.js` (before init section at end of file)

**Step 1: Add DOM refs for new mobile elements**

In `public/app.js`, after line 70 (`const fileTreeSection = ...`), add:

```javascript

  // --- Mobile responsive DOM refs ---
  const sidebarEl = document.getElementById('sidebar');
  const sidebarBackdrop = document.getElementById('sidebar-backdrop');
  const mobileHamburger = document.getElementById('mobile-hamburger');
  const mobileSessionInfo = document.getElementById('mobile-session-info');
  const mobileSessionName = document.getElementById('mobile-session-name');
  const mobileStatusDot = document.getElementById('mobile-status-dot');
  const mobileNewSession = document.getElementById('mobile-new-session');
```

**Step 2: Add mobile sidebar toggle functions**

After the new DOM refs, add:

```javascript

  // --- Mobile sidebar ---
  function isMobile() {
    return window.matchMedia('(max-width: 768px)').matches;
  }

  function openMobileSidebar() {
    sidebarEl.classList.add('open');
    sidebarBackdrop.classList.add('visible');
  }

  function closeMobileSidebar() {
    sidebarEl.classList.remove('open');
    sidebarBackdrop.classList.remove('visible');
  }
```

**Step 3: Add mobile event listeners**

In the init section (before `initTerminal();` near end of file), add:

```javascript

  // --- Mobile event listeners ---
  mobileHamburger.addEventListener('click', () => {
    if (sidebarEl.classList.contains('open')) {
      closeMobileSidebar();
    } else {
      openMobileSidebar();
    }
  });

  mobileSessionInfo.addEventListener('click', () => {
    openMobileSidebar();
  });

  sidebarBackdrop.addEventListener('click', () => {
    closeMobileSidebar();
  });

  // Reset sidebar state when crossing breakpoint (e.g. rotating tablet)
  window.matchMedia('(max-width: 768px)').addEventListener('change', (e) => {
    if (!e.matches) {
      closeMobileSidebar();
    }
  });
```

**Step 4: Close sidebar on session click**

In `renderSidebar()`, find the session `li.onclick` handler (around line 706-711). Add `closeMobileSidebar();` after `attachSession(s.id);`:

Change:
```javascript
        li.onclick = () => {
          if (!s.alive && s.claudeSessionId) {
            restartSession(s.id);
          }
          attachSession(s.id);
        };
```
to:
```javascript
        li.onclick = () => {
          if (!s.alive && s.claudeSessionId) {
            restartSession(s.id);
          }
          attachSession(s.id);
          closeMobileSidebar();
        };
```

**Step 5: Verify syntax**

Run: `node --check public/app.js`
Expected: no output (success)

**Step 6: Commit**

```bash
git add public/app.js
git commit -m "feat(mobile): add sidebar toggle, backdrop, and breakpoint listener"
```

---

### Task 7: Add JS — mobile topbar updates

**Files:**
- Modify: `public/app.js` (add helper function + call sites)

**Step 1: Add updateMobileTopbar helper**

After the `closeMobileSidebar()` function, add:

```javascript

  function updateMobileTopbar() {
    if (!activeSessionId) {
      mobileSessionName.textContent = 'Claude Console';
      mobileStatusDot.className = 'status-dot';
      mobileStatusDot.style.display = 'none';
      mobileNewSession.style.display = 'none';
      return;
    }
    const session = sessions.find(s => s.id === activeSessionId);
    if (session) {
      mobileSessionName.textContent = session.name;
      mobileStatusDot.className = 'status-dot ' + (session.alive ? 'alive' : 'exited');
      mobileStatusDot.style.display = '';
      mobileNewSession.style.display = '';
    }
  }
```

**Step 2: Call updateMobileTopbar from attachSession**

In `attachSession()`, after `renderSidebar();` (the last line before closing brace), add:

```javascript
    updateMobileTopbar();
```

**Step 3: Call updateMobileTopbar from WebSocket state handlers**

In `case 'state':` handler, after `renderSidebar();`, add:
```javascript
          updateMobileTopbar();
```

In the `case 'state':` reconciliation block (the `if (activeSessionId && !sessions.find...)` block), after the home-state resets and before closing brace, add:
```javascript
            updateMobileTopbar();
```

In `case 'exited':` handler, after `renderSidebar();`, add:
```javascript
          updateMobileTopbar();
```

In `case 'session-deleted':` handler, after the home-state reset block, add:
```javascript
            updateMobileTopbar();
```

In `deleteSession()` function, inside the `if (activeSessionId === id)` block, after `rightPanel.classList.add('hidden');`, add:
```javascript
      updateMobileTopbar();
```

**Step 4: Verify syntax**

Run: `node --check public/app.js`
Expected: no output (success)

**Step 5: Commit**

```bash
git add public/app.js
git commit -m "feat(mobile): sync mobile topbar with active session state"
```

---

### Task 8: Add JS — new session button + WebGL skip

**Files:**
- Modify: `public/app.js` (mobile new session handler, WebGL conditional)

**Step 1: Add mobile new session button handler**

In the mobile event listeners section (added in Task 6), add:

```javascript

  mobileNewSession.addEventListener('click', () => {
    if (!activeSessionId) return;
    const session = sessions.find(s => s.id === activeSessionId);
    if (!session) return;
    // Open sidebar and trigger inline input on the active project
    openMobileSidebar();
    expandedProjects.add(session.projectId);
    renderSidebar();
    requestAnimationFrame(() => {
      const projGroup = projectListEl.querySelector(`[data-project-id="${session.projectId}"]`);
      if (projGroup) {
        const ul = projGroup.querySelector('.project-sessions');
        if (ul) showInlineSessionInput(ul, session.projectId);
      }
    });
  });
```

**Step 2: Skip WebGL addon on mobile in initTerminal()**

In `initTerminal()`, find lines 224-235 (WebGL section). Replace:

```javascript
    const webglAddon = new WebglAddon.WebglAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.open(terminalEl);

    // WebGL addon for sharper rendering on high-DPI displays
    try {
      term.loadAddon(webglAddon);
    } catch (e) {
      console.warn('WebGL addon failed, using canvas renderer');
    }
```

with:

```javascript
    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.open(terminalEl);

    // WebGL addon for sharper rendering — skip on mobile (GPU issues on low-end devices).
    // This check runs once at init. Addons can't be unloaded, so viewport changes after
    // init won't toggle WebGL. Desktop users always get WebGL; mobile always gets canvas.
    if (!isMobile()) {
      try {
        const webglAddon = new WebglAddon.WebglAddon();
        term.loadAddon(webglAddon);
      } catch (e) {
        console.warn('WebGL addon failed, using canvas renderer');
      }
    }
```

**Step 3: Skip WebGL addon on mobile in initShellTerminal()**

In `initShellTerminal()`, find lines 335-340. Replace:

```javascript
    try {
      const webglAddon = new WebglAddon.WebglAddon();
      shellTerm.loadAddon(webglAddon);
    } catch (e) {
      console.warn('Shell WebGL addon failed, using canvas renderer');
    }
```

with:

```javascript
    if (!isMobile()) {
      try {
        const webglAddon = new WebglAddon.WebglAddon();
        shellTerm.loadAddon(webglAddon);
      } catch (e) {
        console.warn('Shell WebGL addon failed, using canvas renderer');
      }
    }
```

**Step 4: Verify syntax**

Run: `node --check public/app.js`
Expected: no output (success)

**Step 5: Commit**

```bash
git add public/app.js
git commit -m "feat(mobile): add new session button handler, skip WebGL on mobile"
```

---

### Task 9: Add JS — recent sessions in mobile sidebar

**Files:**
- Modify: `public/app.js` (renderSidebar function)

**Step 1: Add recent sessions section to renderSidebar**

At the top of `renderSidebar()`, after `projectListEl.innerHTML = '';` (around line 585), add:

```javascript
    // Mobile: show flat "Recent" section for quick session switching
    if (isMobile() && sessions.length > 0) {
      const recentSessions = [...sessions]
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, 5);

      const recentGroup = document.createElement('div');
      recentGroup.className = 'project-group';

      const recentHeader = document.createElement('div');
      recentHeader.className = 'project-header';
      recentHeader.style.pointerEvents = 'none';

      const recentName = document.createElement('span');
      recentName.className = 'project-name';
      recentName.textContent = 'Recent';
      recentName.style.color = '#6b7280';
      recentName.style.fontSize = '12px';
      recentName.style.textTransform = 'uppercase';
      recentName.style.letterSpacing = '0.05em';
      recentHeader.appendChild(recentName);
      recentGroup.appendChild(recentHeader);

      const recentUl = document.createElement('ul');
      recentUl.className = 'project-sessions expanded';

      for (const s of recentSessions) {
        const li = document.createElement('li');
        if (s.id === activeSessionId) li.classList.add('active');

        const dot = document.createElement('span');
        dot.className = 'status-dot ' + (s.alive ? 'alive' : 'exited');

        const sName = document.createElement('span');
        sName.className = 'session-name';
        sName.textContent = s.name;

        li.appendChild(dot);
        li.appendChild(sName);
        li.onclick = () => {
          if (!s.alive && s.claudeSessionId) {
            restartSession(s.id);
          }
          attachSession(s.id);
          closeMobileSidebar();
        };
        recentUl.appendChild(li);
      }

      recentGroup.appendChild(recentUl);
      projectListEl.appendChild(recentGroup);
    }
```

**Step 2: Verify syntax**

Run: `node --check public/app.js`
Expected: no output (success)

**Step 3: Commit**

```bash
git add public/app.js
git commit -m "feat(mobile): add recent sessions section to mobile sidebar"
```

---

### Task 10: Add mobile smoke test

**Files:**
- Modify: `test/smoke-test.mjs`

**Step 1: Add mobile layout test section**

In `test/smoke-test.mjs`, after the "File Tree Collapse" section (after line 235, the expand second toggle check) and before the "Directory Expand" section (line 238, `console.log('\nSection: Directory Expand')`), add:

```javascript

  // --- Mobile Layout ---
  console.log('\nSection: Mobile Layout');

  // Resize to mobile viewport
  await page.setViewportSize({ width: 375, height: 667 });
  await page.waitForTimeout(1000);

  // Core layout checks
  check('Mobile topbar visible',
    await page.$eval('#mobile-topbar', el => getComputedStyle(el).display) === 'flex');
  check('Right panel hidden on mobile',
    await page.$eval('#right-panel', el => getComputedStyle(el).display) === 'none');
  check('Tab bar hidden on mobile',
    await page.$eval('#tab-bar', el => getComputedStyle(el).display) === 'none');
  check('Sidebar is fixed-position on mobile',
    await page.$eval('#sidebar', el => getComputedStyle(el).position) === 'fixed');

  // Test session name in topbar
  check('Session name shown in topbar',
    (await page.$eval('#mobile-session-name', el => el.textContent)).includes('Smoke Session'));

  // Test mobile new session button visible
  check('Mobile new session button visible',
    await page.$eval('#mobile-new-session', el => getComputedStyle(el).display) !== 'none');

  // Test hamburger opens sidebar
  await page.click('#mobile-hamburger');
  await page.waitForTimeout(500);
  check('Sidebar opens on hamburger click',
    await page.$eval('#sidebar', el => el.classList.contains('open')));
  check('Backdrop visible when sidebar open',
    await page.$eval('#sidebar-backdrop', el => el.classList.contains('visible')));

  // Test touch targets (44px minimum height)
  const sessionItems = await page.$$('.project-sessions li');
  check('Session list items found', sessionItems.length > 0, `found ${sessionItems.length}`);
  if (sessionItems.length > 0) {
    const itemHeight = await sessionItems[0].evaluate(el => el.getBoundingClientRect().height);
    check('Session touch target >= 44px', itemHeight >= 44, `got ${Math.round(itemHeight)}px`);
  }

  // Test backdrop closes sidebar
  await page.click('#sidebar-backdrop', { force: true });
  await page.waitForTimeout(500);
  check('Sidebar closes on backdrop click',
    await page.$eval('#sidebar', el => !el.classList.contains('open')));

  // Test session click closes sidebar
  await page.click('#mobile-hamburger');
  await page.waitForTimeout(500);
  const sessionLi = await page.$('.project-sessions li');
  if (sessionLi) {
    await sessionLi.click();
    await page.waitForTimeout(500);
    check('Session click closes sidebar',
      await page.$eval('#sidebar', el => !el.classList.contains('open')));
  }

  // Test new session button opens sidebar
  await page.click('#mobile-new-session');
  await page.waitForTimeout(500);
  check('New session button opens sidebar',
    await page.$eval('#sidebar', el => el.classList.contains('open')));
  await page.click('#sidebar-backdrop', { force: true });
  await page.waitForTimeout(500);

  // Test modal z-index above sidebar backdrop
  await page.click('#mobile-hamburger');
  await page.waitForTimeout(500);
  await page.click('#btn-add-project');
  await page.waitForTimeout(500);
  const modalZ = await page.$eval('#modal-overlay', el => parseInt(getComputedStyle(el).zIndex));
  const backdropZ = await page.$eval('#sidebar-backdrop', el => parseInt(getComputedStyle(el).zIndex));
  check('Modal z-index above sidebar backdrop', modalZ > backdropZ,
    `modal=${modalZ}, backdrop=${backdropZ}`);
  await page.click('#btn-modal-cancel');
  await page.waitForTimeout(300);
  await page.click('#sidebar-backdrop', { force: true });
  await page.waitForTimeout(500);

  // Restore desktop viewport and verify layout restoration
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.waitForTimeout(1000);
  check('Right panel visible after restore',
    await page.$eval('#right-panel', el => getComputedStyle(el).display) !== 'none');
  check('Tab bar visible after restore',
    await page.$eval('#tab-bar', el => getComputedStyle(el).display) !== 'none');
  check('Mobile topbar hidden after restore',
    await page.$eval('#mobile-topbar', el => getComputedStyle(el).display) === 'none');
  check('Sidebar not fixed after restore',
    await page.$eval('#sidebar', el => getComputedStyle(el).position) !== 'fixed');
```

**Step 2: Run the smoke test**

Run: `npm run test:smoke`
Expected: All checks pass including the new mobile layout checks.

**Step 3: Commit**

```bash
git add test/smoke-test.mjs
git commit -m "test: add mobile viewport smoke tests"
```

---

### Task 11: Final verification

**Files:** None (verification only)

**Step 1: Run syntax checks**

Run: `node --check server.js && node --check pty-manager.js && node --check store.js && node --check public/app.js`
Expected: no output (all pass)

**Step 2: Run unit tests**

Run: `npm test`
Expected: all tests pass

**Step 3: Run smoke test**

Run: `npm run test:smoke`
Expected: all checks pass including mobile viewport tests

**Step 4: If all pass, done. If any fail, fix and re-run.**
