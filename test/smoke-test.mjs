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
