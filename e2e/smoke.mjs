import { chromium } from 'playwright-core';
import { startServer } from '../scripts/serve.mjs';

const PORT = Number(process.env.E2E_PORT) || 5199;
const BASE = `http://127.0.0.1:${PORT}/`;
const channel = process.env.E2E_CHANNEL || 'msedge';

const failures = [];
const check = (ok, label) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures.push(label);
};

const server = await startServer({ port: PORT });
const browser = await chromium.launch({ channel });

try {
  const context = await browser.newContext({ viewport: { width: 360, height: 740 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(BASE);
  await page.waitForSelector('.view-home');
  check(await page.locator('.empty-state').isVisible(), 'home shows empty state');

  await page.click('a[href="#/new"]');
  await page.waitForSelector('.view-setup');
  await page.fill('#game-name', 'Test night');
  const inputs = page.locator('.player-row input');
  await inputs.nth(0).fill('Alice');
  await inputs.nth(1).fill('Bob');
  await inputs.nth(1).press('Enter');
  check(await page.locator('.player-row').count() === 3, 'Enter on last player adds a row');
  await page.locator('.player-row input').nth(2).fill('<img src=x onerror=alert(1)>');
  await page.click('button[type="submit"]');
  await page.waitForSelector('.view-game');
  check(await page.locator('.player-col').nth(2).textContent().then((t) => t.includes('<img')), 'player names are rendered as text');

  const cell = (r, p) => page.locator('tbody tr').nth(r).locator('.score-cell').nth(p);
  await cell(0, 0).click();
  await page.waitForSelector('#keypad[open]');
  await page.click('.key[data-key="1"]');
  await page.click('.key[data-key="2"]');
  await page.click('[data-key="next"]');
  check(await page.locator('#keypad-title').textContent().then((t) => t.includes('Bob')), 'Next advances to the next player');
  await page.keyboard.type('5');
  await page.keyboard.press('-');
  await page.click('[data-key="next"]');
  await page.click('[data-key="done"]');
  check(!(await page.locator('#keypad[open]').count()), 'Done closes keypad');
  check((await cell(0, 0).textContent()).trim() === '12', 'round 1 Alice = 12');
  check((await cell(0, 1).textContent()).trim() === '-5', 'round 1 Bob = -5 (negative via keyboard)');
  const focusBack = await page.waitForFunction(() => document.activeElement?.classList.contains('score-cell'), null, { timeout: 2000 })
    .then(() => true, () => false);
  check(focusBack, 'focus returns to a score cell');

  await page.click('.game-actions .btn-primary');
  check(await page.locator('tbody tr').count() === 2, 'Add round appends a row');
  await cell(1, 1).click();
  await page.keyboard.type('20');
  await page.keyboard.press('Enter');
  const totals = await page.locator('.total-cell').allTextContents();
  check(totals.map((t) => t.trim()).join(',') === '12,15,0', `totals 12,15,0 (got ${totals.join(',')})`);
  check(await page.locator('.standing.is-leader .standing-name').textContent() === 'Bob', 'Bob leads');

  await page.reload();
  await page.waitForSelector('.view-game');
  check((await page.locator('.total-cell').allTextContents()).map((t) => t.trim()).join(',') === '12,15,0', 'scores persist across reload');

  const overflow = async () => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  check(!(await overflow()), 'no horizontal page overflow at 360px (game)');

  const smallTargets = await page.evaluate(() => [...document.querySelectorAll('button, a.btn, .radio-option')]
    .filter((el) => el.offsetParent !== null)
    .map((el) => { const r = el.getBoundingClientRect(); return { w: r.width, h: r.height, t: el.textContent.trim() || el.getAttribute('aria-label') }; })
    .filter((r) => r.w < 44 || r.h < 44));
  check(smallTargets.length === 0, `touch targets >= 44px (${JSON.stringify(smallTargets)})`);
  check(await page.evaluate(() => document.querySelectorAll('[style]').length) === 0, 'no inline style attributes in DOM');

  await page.goto(`${BASE}#/`);
  await page.waitForSelector('.game-card');
  check(await page.locator('.game-card-leader').textContent().then((t) => t.includes('Bob')), 'home card shows leader');
  check(!(await overflow()), 'no horizontal page overflow at 360px (home)');

  const swReady = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return Boolean(reg.active);
  });
  check(swReady, 'service worker is active');
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await context.setOffline(true);
  await page.reload();
  await page.waitForSelector('.view-home', { timeout: 5000 });
  check(true, 'app shell loads offline');
  await context.setOffline(false);

  const manifest = await page.evaluate(async () => (await fetch('./manifest.webmanifest')).json());
  check(manifest.icons?.some((i) => i.sizes === '512x512' && i.purpose === 'maskable'), 'manifest has maskable 512 icon');

  await page.setViewportSize({ width: 1024, height: 768 });
  await page.click('.game-card-link');
  await page.waitForSelector('.view-game');
  check(!(await overflow()), 'no horizontal page overflow at 1024px');
  await page.screenshot({ path: 'e2e/screenshots/game-1024.png', fullPage: true });
  await page.setViewportSize({ width: 360, height: 740 });
  await page.screenshot({ path: 'e2e/screenshots/game-360.png', fullPage: true });

  page.once('dialog', (d) => d.accept());
  await page.goto(`${BASE}#/`);
  await page.click('.game-card .icon-btn-danger');
  await page.waitForSelector('.empty-state');
  check(true, 'delete game returns to empty state');

  check(errors.length === 0, `no console/page errors (${errors.join(' | ')})`);
  await context.close();
} catch (err) {
  failures.push(`exception: ${err.message}`);
  console.error(err);
} finally {
  await browser.close();
  server.close();
}

console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASSED');
process.exit(failures.length ? 1 : 0);
