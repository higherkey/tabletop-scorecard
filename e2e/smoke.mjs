import { mkdirSync, readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { startServer } from '../scripts/serve.mjs';

const PORT = Number(process.env.E2E_PORT) || 5199;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const BASE = `${ORIGIN}/`;
const channel = process.env.E2E_CHANNEL || 'msedge';
const SHOTS = 'e2e/screenshots';
const MIN_TARGET = 48;

const failures = [];
const check = (ok, label) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures.push(label);
};

mkdirSync(SHOTS, { recursive: true });
const server = await startServer({ port: PORT });
const browser = await chromium.launch({ channel });

try {
  const context = await browser.newContext({
    viewport: { width: 360, height: 740 },
    deviceScaleFactor: 1,
    acceptDownloads: true,
  });
  // Local only: never reach real cloud endpoints.
  await context.route((url) => url.origin !== ORIGIN, (route) => route.abort());

  const page = await context.newPage();
  const errors = [];
  const dialogs = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const url = m.location()?.url || '';
    if (url && !url.startsWith(ORIGIN)) return; // blocked external request
    errors.push(m.text());
  });
  page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss(); });

  const go = async (hash, selector) => {
    await page.evaluate((hsh) => { location.hash = hsh; }, hash);
    await page.waitForSelector(selector);
  };
  const clean = (arr) => arr.map((t) => t.trim()).join(',');
  const current = (sel) => page.locator(`${sel}[aria-current="page"]`).evaluateAll((els) => els.map((e) => e.dataset.route || e.id).join(','));

  // 1. Home empty state and navigation aria-current
  await page.goto(BASE);
  await page.waitForSelector('.view-home');
  check(await page.locator('.empty-state').isVisible(), 'home shows empty state');
  check(await page.locator('.empty-title').textContent() === 'No games yet', 'empty state title');
  check(await current('.tab') === 'home' && await current('.nav-link') === 'home', 'home route: tab + nav-link aria-current=home');
  await go('#/stats', '.view-stats');
  check(await current('.tab') === 'stats' && await current('.nav-link') === 'stats', 'stats route: aria-current=stats');
  check(await page.locator('.view-stats .empty-state').isVisible(), 'stats shows empty state with no finished games');
  await go('#/settings', '.view-settings');
  check(await current('.tab') === 'settings' && await current('.nav-link') === 'settings', 'settings route: aria-current=settings');
  await go('#/account', '.view-account');
  check(await current('.tab') === '' && await current('.nav-link') === '', 'account route: no tab/nav-link current');
  check(await page.locator('#account-link[aria-current="page"]').count() === 1, 'account route: account link aria-current');
  await go('#/new', '.view-setup');
  check(await current('.tab') === 'home', 'setup route keeps Games tab current');
  check(await page.locator('#roster-label').count() === 0, 'no saved-player chips before any game finished');

  // 2. Setup + keypad
  await page.fill('#game-name', 'Test night');
  const inputs = page.locator('.player-row input');
  await inputs.nth(0).fill('Alice');
  await inputs.nth(1).fill('Bob');
  await inputs.nth(1).press('Enter');
  check(await page.locator('.player-row').count() === 3, 'Enter on last player adds a row');
  await page.locator('.player-row input').nth(2).fill('<img src=x onerror=alert(1)>');
  check(await page.locator('.player-row .avatar').first().textContent() === 'Al', 'setup avatar shows initials');
  await page.click('button[type="submit"]');
  await page.waitForSelector('.view-game');
  check(await page.locator('.player-col').nth(2).textContent().then((t) => t.includes('<img')), 'player names are rendered as text');
  check(await page.locator('.view-game img').count() === 0 && dialogs.length === 0, 'no injected <img> element or alert dialog');
  check(await page.locator('.game-mode').textContent() === 'Highest score wins', 'game mode label: highest wins');

  const cell = (r, p) => page.locator('tbody tr').nth(r).locator('.score-cell').nth(p);
  await cell(0, 0).click();
  await page.waitForSelector('#keypad[open]');
  await page.click('.key[data-key="1"]');
  await page.click('.key[data-key="2"]');
  check(await page.locator('#keypad-display').textContent() === '12', 'keypad digits show 12');
  await page.click('[data-key="next"]');
  check(await page.locator('#keypad-title').textContent().then((t) => t.includes('Bob')), 'Next advances to the next player');
  await page.keyboard.type('5');
  await page.keyboard.press('-');
  check(await page.locator('#keypad-display').textContent() === '-5', 'keyboard "-" toggles negative');
  await page.click('[data-key="next"]');
  check(await page.locator('#keypad-title').textContent().then((t) => t.includes('<img')), 'Next advances to third player');
  await page.click('[data-key="done"]');
  check(!(await page.locator('#keypad[open]').count()), 'Done closes keypad');
  check((await cell(0, 0).textContent()).trim() === '12', 'round 1 Alice = 12');
  check((await cell(0, 1).textContent()).trim() === '-5', 'round 1 Bob = -5');
  check(await page.waitForFunction(() => document.activeElement?.classList.contains('score-cell'), null, { timeout: 2000 })
    .then(() => true, () => false), 'focus returns to a score cell');

  await page.click('.game-actions .btn-primary');
  check(await page.locator('tbody tr').count() === 2, 'Add round appends a row');
  await cell(1, 1).click();
  await page.keyboard.type('20');
  await page.keyboard.press('Enter');
  check(clean(await page.locator('.total-cell').allTextContents()) === '12,15,0', 'totals 12,15,0');
  check(await page.locator('.standing.is-leader .standing-name').textContent() === 'Bob', 'Bob leads');

  // 3. Delete round without confirm, Undo restores
  await page.click('button[aria-label="Delete round 2"]');
  check(dialogs.length === 0, 'delete round shows no confirm dialog');
  check(await page.locator('tbody tr').count() === 1, 'round removed');
  check(clean(await page.locator('.total-cell').allTextContents()) === '12,-5,0', 'totals after delete 12,-5,0');
  check(await page.locator('.standing.is-leader .standing-name').textContent() === 'Alice', 'Alice leads after delete');
  check(await page.locator('#toast .toast-action').textContent() === 'Undo', 'Undo toast offered');
  await page.click('#toast .toast-action');
  check(await page.locator('tbody tr').count() === 2, 'Undo restores the round');
  check(clean(await page.locator('.total-cell').allTextContents()) === '12,15,0', 'totals restored 12,15,0');
  check(await page.locator('.standing.is-leader .standing-name').textContent() === 'Bob', 'Bob leads again after Undo');
  check(await page.locator('#toast').isHidden(), 'toast hides after Undo');

  // 4. Finish, stats
  await page.click('.game-actions .btn:not(.btn-primary)');
  check(await page.locator('.winner-banner').isVisible(), 'winner banner appears');
  check(await page.locator('.winner-title').textContent() === 'Bob wins!', 'banner names Bob');
  check(await page.locator('.winner-banner .muted').textContent() === 'Final · 15 points', 'banner subtitle Final · 15 points');
  check(await page.locator('button.score-cell').count() === 0 && await page.locator('.score-cell').count() === 0, 'score cells are not buttons when finished');
  check(await page.locator('.score-value').count() === 6, 'six .score-value cells');
  check(await page.locator('button[aria-label^="Delete round"]').count() === 0, 'round-delete buttons omitted when finished');
  check(await page.getByRole('button', { name: 'Reopen' }).isVisible() && await page.getByRole('button', { name: 'Rematch' }).isVisible(), 'Reopen and Rematch shown');
  check(await page.getByRole('button', { name: 'Finish' }).count() === 0, 'Finish hidden when finished');

  await go('#/stats', '.stat-tiles');
  const tile = async (label) => page.locator('.stat-tile', { hasText: label }).locator('.stat-value').textContent().then((t) => t.trim());
  check(await tile('Games played') === '1', 'Stats: Games played = 1');
  check(await tile('Top winner') === 'Bob', 'Stats: Top winner = Bob');
  const wins = async (name) => page.locator('.stats-table tbody tr', { hasText: name }).locator('td').nth(1).textContent();
  check(await wins('Bob') === '1' && await wins('Alice') === '0', 'Stats: Bob 1 win, Alice 0 wins');
  check(await page.locator('.stats-table tbody tr', { hasText: 'Bob' }).locator('td').nth(2).textContent() === '100%', 'Stats: Bob win % 100%');

  // 5. Saved players chips
  await go('#/new', '.view-setup');
  check(await page.locator('.chip-player').count() === 3, 'setup shows 3 roster chips');
  const alice = page.locator('.chip-player', { hasText: 'Alice' });
  check(await alice.getAttribute('aria-pressed') === 'false', 'chip starts unpressed');
  await alice.click();
  check(await alice.getAttribute('aria-pressed') === 'true', 'tapping chip sets aria-pressed=true');
  check(await page.locator('.player-row input').nth(0).inputValue() === 'Alice', 'chip fills first empty row');
  await alice.click();
  check(await alice.getAttribute('aria-pressed') === 'false', 'tapping again sets aria-pressed=false');
  check(await page.locator('.player-row').count() === 1, 'tapping again removes the row');
  const rowCountBefore = await page.locator('.player-row').count();
  await page.locator('.chip-player', { hasText: 'Bob' }).click();
  await page.locator('.chip-player', { hasText: 'Alice' }).click();
  check(await page.locator('.player-row').count() === rowCountBefore + 1, 'chip appends a row when none empty');
  await page.locator('.chip-player', { hasText: 'Bob' }).click();
  await page.locator('.chip-player', { hasText: 'Alice' }).click();
  check(await page.locator('.player-row').count() === 1 && await page.locator('.player-row input').inputValue() === '', 'removing last remaining row clears input instead');

  // 6. Settings
  await go('#/settings', '.view-settings');
  const theme = () => page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  await page.locator('.segmented-option', { hasText: 'Dark' }).click();
  check(await theme() === 'dark', 'Theme Dark sets html[data-theme=dark]');
  await page.reload();
  await page.waitForSelector('.view-settings');
  check(await theme() === 'dark', 'Dark theme persists across reload');
  check(await page.locator('input[name="theme"][value="dark"]').isChecked(), 'Dark radio checked after reload');
  await page.locator('.segmented-option', { hasText: 'System' }).click();
  check(await theme() === null, 'Theme System removes data-theme');

  await page.locator('.segmented-option', { hasText: 'Lowest wins' }).click();
  await go('#/new', '.view-setup');
  check(await page.locator('input[name="lowWins"][value="1"]').isChecked(), 'Default scoring Lowest wins pre-selects in setup');
  await go('#/settings', '.view-settings');
  await page.locator('.segmented-option', { hasText: 'Highest wins' }).click();
  await go('#/new', '.view-setup');
  check(await page.locator('input[name="lowWins"][value="0"]').isChecked(), 'Highest wins restored in setup');
  await go('#/settings', '.view-settings');

  const rosterInput = page.locator('input[aria-label="Add player name"]');
  await rosterInput.fill('Zed');
  await rosterInput.press('Enter');
  check(await page.locator('.roster-item', { hasText: 'Zed' }).count() === 1, 'roster add shows Zed');
  check(await rosterInput.inputValue() === '', 'roster input cleared after add');
  check(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')) === 'Add player name', 'focus stays on roster input');
  await rosterInput.fill('   ');
  await rosterInput.press('Enter');
  check(await page.locator('.roster-item').count() === 4, 'blank roster name ignored');
  await page.click('button[aria-label="Remove Zed"]');
  check(await page.locator('.roster-item', { hasText: 'Zed' }).count() === 0, 'roster remove deletes Zed');

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export games (JSON)' }).click(),
  ]);
  check(/^tabletop-scorecard-.+\.json$/.test(download.suggestedFilename()), `export filename (${download.suggestedFilename()})`);
  let exported = null;
  try { exported = JSON.parse(readFileSync(await download.path(), 'utf8')); } catch { /* checked below */ }
  check(Array.isArray(exported?.games) && exported.games.length === 1, 'export is valid JSON with games');

  // 7. Home: delete game with no confirm, Undo
  await go('#/', '.game-card');
  check(await page.locator('.group-title').textContent() === 'Finished', 'finished game is in Finished group');
  check(await page.locator('.game-card .chip-success').textContent() === 'Finished', 'game card has Finished chip');
  check(await page.locator('.game-card-leader').textContent().then((t) => t.includes('Winner: Bob (15)')), 'home card shows winner');
  const dialogsBefore = dialogs.length;
  await page.click('button[aria-label="Delete Test night"]');
  await page.waitForSelector('.empty-state');
  check(dialogs.length === dialogsBefore, 'delete game shows no confirm dialog');
  check(await page.locator('#toast .toast-action').textContent() === 'Undo', 'Undo toast after game delete');
  await page.click('#toast .toast-action');
  await page.waitForSelector('.game-card');
  check(await page.locator('.game-card').count() === 1, 'Undo restores the game');

  // 8. Persistence, service worker, offline
  await page.reload();
  await page.waitForSelector('.game-card');
  check(await page.locator('.game-card-name').textContent() === 'Test night', 'game persists across reload');
  const gameHref = await page.locator('.game-card-link').getAttribute('href');
  check(await page.evaluate(async () => Boolean((await navigator.serviceWorker.ready).active)), 'service worker is active');
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await context.setOffline(true);
  await page.reload();
  await page.waitForSelector('.view-home', { timeout: 5000 });
  check(await page.locator('.game-card').count() === 1, 'app shell loads offline with data');
  await context.setOffline(false);
  const manifest = await page.evaluate(async () => (await fetch('./manifest.webmanifest')).json());
  check(manifest.icons?.some((i) => i.sizes === '512x512' && i.purpose === 'maskable'), 'manifest has maskable 512 icon');

  // Shared route may hit the network (blocked here); it must still render without throwing.
  await go('#/s/e2e-token', '.view-shared');
  check(true, 'shared route renders');
  await go('#/', '.game-card');

  // 10. Keypad is a bottom sheet at 360 (reopen game so cells are editable)
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await go(gameHref, '.view-game');
  await page.getByRole('button', { name: 'Reopen' }).click();
  await page.waitForSelector('.score-cell');
  check(await page.locator('.winner-banner').count() === 0, 'Reopen removes winner banner');
  await page.setViewportSize({ width: 360, height: 740 });
  await cell(0, 0).click();
  await page.waitForSelector('#keypad[open]');
  const sheet = await page.evaluate(() => {
    const r = document.getElementById('keypad').getBoundingClientRect();
    return { bottom: r.bottom, vh: window.innerHeight, width: r.width };
  });
  check(Math.abs(sheet.bottom - sheet.vh) <= 2, `keypad bottom within 2px of viewport bottom (${sheet.bottom} vs ${sheet.vh})`);
  await page.screenshot({ path: `${SHOTS}/keypad-360-light.png` });
  await page.click('[data-key="done"]');
  await page.waitForSelector('#keypad:not([open])', { state: 'attached' });
  await page.getByRole('button', { name: 'Finish' }).click();
  await page.waitForSelector('.winner-banner');

  // 9. Layout matrix
  const ROUTES = [
    ['home', '#/', '.view-home'],
    ['new', '#/new', '.view-setup'],
    ['game', gameHref, '.view-game'],
    ['stats', '#/stats', '.stat-tiles'],
    ['settings', '#/settings', '.view-settings'],
    ['account', '#/account', '.view-account'],
  ];
  const measure = () => page.evaluate((min) => {
    const sel = 'button, a.btn, .tab, .nav-link, .chip, .segmented-option, .icon-btn';
    const small = [...document.querySelectorAll(sel)]
      .filter((el) => !el.classList.contains('chip-success')) // non-interactive status pill
      .filter((el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden')
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height), t: (el.getAttribute('aria-label') || el.textContent.trim()).slice(0, 24), c: el.className };
      })
      .filter((r) => r.w < min || r.h < min);
    return {
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      small,
      styled: document.querySelectorAll('[style]').length,
    };
  }, MIN_TARGET);
  const fmt = (list) => JSON.stringify(list);
  for (const [width, height] of [[360, 740], [768, 1024], [1024, 768]]) {
    await page.setViewportSize({ width, height });
    const overflow = [];
    const small = [];
    const styled = [];
    for (const [name, hash, sel] of ROUTES) {
      await go(hash, sel);
      const m = await measure();
      if (m.overflow) overflow.push(name);
      if (m.small.length) small.push({ route: name, offenders: m.small });
      if (m.styled) styled.push(name);
    }
    check(overflow.length === 0, `${width}px: no horizontal overflow (${overflow.join(',')})`);
    check(small.length === 0, `${width}px: targets >= ${MIN_TARGET}px (${fmt(small)})`);
    check(styled.length === 0, `${width}px: no [style] attributes (${styled.join(',')})`);
  }

  // 12. Screenshots
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    for (const [width, height] of [[360, 740], [1024, 768]]) {
      await page.setViewportSize({ width, height });
      for (const [name, hash, sel] of ROUTES.filter(([n]) => ['home', 'game', 'stats', 'settings', 'account'].includes(n))) {
        await go(hash, sel);
        await page.screenshot({ path: `${SHOTS}/${name}-${width}-${scheme}.png`, fullPage: true });
      }
    }
  }
  await page.emulateMedia({ colorScheme: null, reducedMotion: null });

  // 11. Errors
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
