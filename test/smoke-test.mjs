// UI Smoke test for file viewer feature
// Run: npm run test:smoke
// Requires: playwright (devDependency)
//
// Uses testMode server (in-memory DB, bash shell) with a temp git repo.
// Creates its own fixtures and cleans up after.

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';
import { createServer } from '../server.js';

const gitEnv = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@test.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@test.com',
};

let tempDir, server, browser, page;
let passed = 0;
let failed = 0;

function check(name, ok, detail) {
  if (ok) {
    console.log(`  \u2705 ${name}`);
    passed++;
  } else {
    console.log(`  \u274c ${name}${detail ? ': ' + detail : ''}`);
    failed++;
  }
}

function createTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-test-'));
  execSync('git init && git commit --allow-empty -m "init"', {
    cwd: dir,
    env: { ...process.env, ...gitEnv },
  });
  fs.writeFileSync(path.join(dir, 'README.md'), '# Smoke Test\n\nThis is a test file.');
  fs.writeFileSync(path.join(dir, 'app.js'), 'console.log("hello");');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'index.js'), 'export default 42;');
  execSync('git add -A && git commit -m "add test files"', {
    cwd: dir,
    env: { ...process.env, ...gitEnv },
  });
  return dir;
}

try {
  // Setup
  tempDir = createTempRepo();
  server = createServer({ testMode: true });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const BASE = `http://127.0.0.1:${port}`;

  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();

  console.log('\nUI Smoke Test: File Viewer Feature\n');
  await page.goto(BASE);
  await page.waitForTimeout(1000);

  // --- Initial Layout ---
  console.log('Section: Initial Layout');
  check('Sidebar shows "Projects" header',
    await page.textContent('.sidebar-title') === 'Projects');
  check('"+" button exists', !!(await page.$('#btn-add-project')));
  check('"Add Project" button visible', !!(await page.$('#btn-home-add-project')));
  check('Tab bar hidden when no session',
    await page.$eval('#tab-bar', el => getComputedStyle(el).display) === 'none');
  check('Right panel hidden when no session',
    await page.$eval('#right-panel', el => el.classList.contains('hidden')));

  // --- Project + Session Creation ---
  console.log('\nSection: Project + Session Creation');
  const projRes = await page.evaluate(async (cwd) => {
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Smoke Test', cwd }),
    });
    return res.json();
  }, tempDir);
  check('Project created', !!projRes.id, projRes.error);

  const sessRes = await page.evaluate(async (projectId) => {
    const res = await fetch(`/api/projects/${projectId}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Smoke Session' }),
    });
    return res.json();
  }, projRes.id);
  check('Session created', !!sessRes.id, sessRes.error);

  // Expand project and click session to attach
  await page.waitForTimeout(1500);
  const projectHeaders = await page.$$('.project-header');
  for (const header of projectHeaders) {
    const nameText = await header.$eval('.project-name', el => el.textContent).catch(() => '');
    if (nameText === 'Smoke Test') {
      await header.click();
      await page.waitForTimeout(500);
      break;
    }
  }
  await page.locator('.project-sessions.expanded li:has-text("Smoke Session")').first()
    .click({ timeout: 5000 });
  await page.waitForTimeout(1000);

  // --- Right Panel Structure ---
  console.log('\nSection: Right Panel Structure');
  check('Right panel visible',
    await page.$eval('#right-panel', el => !el.classList.contains('hidden')));
  check('Files header present',
    await page.$eval('#file-tree-section .right-panel-title', el => el.textContent) === 'Files');
  check('Collapse toggle exists', !!(await page.$('#btn-toggle-file-tree')));
  check('Terminal header present',
    await page.$eval('#shell-section .right-panel-title', el => el.textContent) === 'Terminal');
  check('Divider exists', !!(await page.$('#right-panel-divider')));

  // --- File Tree ---
  console.log('\nSection: File Tree');
  await page.waitForTimeout(1500);
  const treeItems = await page.$$('.file-tree-item');
  check('File tree has entries', treeItems.length > 0, `found ${treeItems.length}`);
  const treeText = await page.$eval('#file-tree', el => el.textContent);
  check('Shows README.md', treeText.includes('README.md'));
  check('Shows app.js', treeText.includes('app.js'));
  check('Shows src directory', treeText.includes('src'));

  // --- Tab Bar ---
  console.log('\nSection: Tab Bar');
  check('Tab bar visible',
    await page.$eval('#tab-bar', el => getComputedStyle(el).display) !== 'none');
  check('Claude tab present',
    (await page.$eval('#tab-list', el => el.textContent)).includes('Claude'));

  // --- Markdown Viewer ---
  console.log('\nSection: Markdown Viewer');
  await page.locator('.file-tree-item:has-text("README.md")').first().click();
  await page.waitForTimeout(1000);
  check('File viewer visible',
    await page.$eval('#file-viewer', el => !el.classList.contains('hidden')));
  check('Markdown class applied',
    (await page.$eval('#file-viewer-content', el => el.className)).includes('markdown-body'));
  const fvHtml = await page.$eval('#file-viewer-content', el => el.innerHTML);
  check('Rendered as HTML', fvHtml.includes('<h1') || fvHtml.includes('<p'));
  check('Tab created', (await page.$$('.tab')).length >= 2);
  check('Path shown in toolbar',
    (await page.$eval('#file-viewer-path', el => el.textContent)).includes('README.md'));

  // --- Plain Text Viewer ---
  console.log('\nSection: Plain Text Viewer');
  await page.locator('.file-tree-item:has-text("app.js")').first().click();
  await page.waitForTimeout(1000);
  check('Plain text class',
    (await page.$eval('#file-viewer-content', el => el.className)).includes('plain-text'));
  check('JS content displayed',
    (await page.$eval('#file-viewer-content', el => el.textContent)).includes('console.log'));

  // --- Tab Switching ---
  console.log('\nSection: Tab Switching');
  await page.locator('.tab:has-text("Claude")').first().click();
  await page.waitForTimeout(500);
  check('Terminal visible after Claude tab',
    await page.$eval('#terminal-wrapper', el => getComputedStyle(el).display) !== 'none');
  check('File viewer hidden after Claude tab',
    await page.$eval('#file-viewer', el => el.classList.contains('hidden')));
  const termInset = await page.$eval('#terminal-wrapper', el => el.style.inset);
  check('No 32px gap (inset correct)', termInset.startsWith('32px'), termInset);

  // --- Shift+Enter sends CSI u sequence ---
  console.log('\nSection: Shift+Enter Key Handling');
  // Spy on WebSocket.send to capture outgoing messages
  await page.evaluate(() => {
    window.__wsSent = [];
    const origSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function(data) {
      window.__wsSent.push(data);
      return origSend.call(this, data);
    };
  });
  // Focus the terminal textarea (offscreen element, use JS focus)
  await page.evaluate(() => document.querySelector('#terminal-wrapper .xterm-helper-textarea').focus());
  await page.waitForTimeout(200);
  await page.evaluate(() => { window.__wsSent = []; }); // clear any focus-related messages
  await page.keyboard.press('Shift+Enter');
  await page.waitForTimeout(300);
  const shiftEnterMessages = await page.evaluate(() => window.__wsSent);
  const inputMsgs = shiftEnterMessages
    .map(m => { try { return JSON.parse(m); } catch { return null; } })
    .filter(m => m && m.type === 'input');
  check('Shift+Enter sends exactly one input message', inputMsgs.length === 1,
    `got ${inputMsgs.length}: ${JSON.stringify(inputMsgs)}`);
  if (inputMsgs.length > 0) {
    check('Shift+Enter sends CSI u sequence (\\x1b[13;2u)', inputMsgs[0].data === '\x1b[13;2u',
      `got: ${JSON.stringify(inputMsgs[0].data)}`);
  }
  // Verify plain Enter still sends \r
  await page.evaluate(() => { window.__wsSent = []; });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  const enterMessages = await page.evaluate(() => window.__wsSent);
  const enterInputMsgs = enterMessages
    .map(m => { try { return JSON.parse(m); } catch { return null; } })
    .filter(m => m && m.type === 'input');
  check('Plain Enter sends \\r', enterInputMsgs.length === 1 && enterInputMsgs[0].data === '\r',
    `got: ${JSON.stringify(enterInputMsgs)}`);

  // --- Tab Close ---
  console.log('\nSection: Tab Close');
  const tabsBefore = (await page.$$('.tab')).length;
  const closeBtn = await page.$('.tab-close');
  if (closeBtn) {
    await closeBtn.click();
    await page.waitForTimeout(300);
    check('Close button removes tab', (await page.$$('.tab')).length < tabsBefore);
  }

  // --- File Tree Collapse ---
  console.log('\nSection: File Tree Collapse');
  await page.$('#btn-toggle-file-tree').then(btn => btn.click());
  await page.waitForTimeout(300);
  check('Collapses on toggle',
    await page.$eval('#file-tree-section', el => el.classList.contains('collapsed')));
  await page.$('#btn-toggle-file-tree').then(btn => btn.click());
  await page.waitForTimeout(300);
  check('Expands on second toggle',
    await page.$eval('#file-tree-section', el => !el.classList.contains('collapsed')));

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

  // Test backdrop closes sidebar — click at x=350 (right of 240px sidebar)
  await page.mouse.click(350, 400);
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
  await page.mouse.click(350, 400);
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
  await page.mouse.click(350, 400);
  await page.waitForTimeout(500);

  // Test Recent sessions section visible on mobile
  await page.click('#mobile-hamburger');
  await page.waitForTimeout(500);
  const recentText = await page.$eval('.mobile-recent-label', el => el.textContent).catch(() => '');
  check('Recent sessions section visible', recentText === 'Recent');

  // Test session actions always visible on mobile
  const sessionActionsDisplay = await page.$eval('.session-actions',
    el => getComputedStyle(el).display).catch(() => 'none');
  check('Session actions visible on mobile', sessionActionsDisplay === 'flex');

  // Test project delete always visible on mobile
  const projDeleteDisplay = await page.$eval('.project-delete',
    el => getComputedStyle(el).display).catch(() => 'none');
  check('Project delete visible on mobile', projDeleteDisplay !== 'none');

  // Test project header touch target (skip the non-interactive Recent header)
  const projHeaderHeight = await page.$eval('.project-header:not(.mobile-recent-header)',
    el => el.getBoundingClientRect().height);
  check('Project header touch target >= 44px', projHeaderHeight >= 44,
    `got ${Math.round(projHeaderHeight)}px`);

  // Test mobileSessionInfo click opens sidebar
  await page.mouse.click(350, 400);
  await page.waitForTimeout(500);
  await page.click('#mobile-session-info');
  await page.waitForTimeout(500);
  check('Session info click opens sidebar',
    await page.$eval('#sidebar', el => el.classList.contains('open')));

  // Test breakpoint crossing closes sidebar (sidebar is currently open)
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.waitForTimeout(1000);
  check('Breakpoint crossing closes sidebar',
    await page.$eval('#sidebar', el => !el.classList.contains('open')));

  // Return to mobile viewport for remaining checks
  await page.setViewportSize({ width: 375, height: 667 });
  await page.waitForTimeout(1000);

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
  check('Sidebar aria-hidden after restore',
    await page.$eval('#sidebar', el => el.getAttribute('aria-hidden')) === 'true');

  // --- Directory Expand ---
  console.log('\nSection: Directory Expand');
  await page.locator('.file-tree-folder:has-text("src")').first().click();
  await page.waitForTimeout(1000);
  check('src expands', !!(await page.$('.file-tree-children.expanded')));
  const childText = await page.$eval('.file-tree-children.expanded', el => el.textContent).catch(() => '');
  check('Shows index.js', childText.includes('index.js'));

  // Summary
  console.log(`\n${'='.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed} checks`);
  console.log(`${'='.repeat(40)}\n`);
  process.exit(failed > 0 ? 1 : 0);

} catch (err) {
  console.error('\nSmoke test error:', err.message);
  process.exit(1);
} finally {
  if (browser) await browser.close();
  if (server) await server.destroy();
  if (tempDir) try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
}
