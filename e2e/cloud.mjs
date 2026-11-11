// End-to-end test of accounts, sync and sharing against the REAL Neon project.
// Needs: Edge (playwright channel msedge), network access, and neonctl login.
// The owner connection string is fetched via neonctl into process memory ONLY (never printed or written)
// and is used to delete the throwaway e2e users in a finally block.
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright-core';
import { neon } from '@neondatabase/serverless';
import { startServer } from '../scripts/serve.mjs';

const PORT = 5173; // this origin is trusted by Neon Auth
const BASE = `http://127.0.0.1:${PORT}/`;
const channel = process.env.E2E_CHANNEL || 'msedge';
const EMAIL_LIKE = 'e2e+%@example.com';

const failures = [];
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? `  [${detail}]` : ''}`);
  if (!ok) failures.push(label);
};

function ownerSql() {
  let url = process.env.DATABASE_URL;
  if (!url) {
    url = execSync(
      'npx -y neonctl@latest connection-string --project-id late-haze-23135872 --branch br-old-mountain-bdcbtobt --database-name neondb --role-name neondb_owner',
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    process.env.DATABASE_URL = url; // memory only
  }
  if (!url.startsWith('postgres')) throw new Error('could not obtain owner connection string');
  return neon(url);
}

async function cleanupUsers(sql) {
  const users = await sql.query('select id from neon_auth."user" where email like $1', [EMAIL_LIKE]);
  const ids = users.map((u) => u.id);
  if (ids.length) {
    for (const t of ['games', 'players', 'user_settings']) {
      await sql.query(`delete from public.${t} where user_id = any($1)`, [ids]);
    }
    const cols = await sql.query(
      `select table_name, column_name from information_schema.columns
       where table_schema = 'neon_auth' and column_name in ('userId', 'user_id') order by 1`,
    );
    for (const { table_name, column_name } of cols) {
      await sql.query(`delete from neon_auth."${table_name}" where "${column_name}" = any($1)`, [ids]);
    }
    await sql.query('delete from neon_auth."user" where id = any($1)', [ids]);
  }
  const left = await sql.query('select count(*)::int as n from neon_auth."user" where email like $1', [EMAIL_LIKE]);
  return { removed: ids.length, remaining: left[0].n };
}

const ts = Date.now();
const email = `e2e+${ts}@example.com`;
const password = `E2e-${randomBytes(9).toString('base64url')}`;

const errors = [];
const dialogs = [];

async function newDevice(browser, label, options = {}) {
  const context = await browser.newContext({ viewport: { width: 420, height: 800 }, ...options });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`[${label}] ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const url = m.location()?.url ?? '';
    // 401 on /token is expected when there is no session (e.g. during sign-out).
    if (url.includes('/token') && m.text().includes('401')) return;
    errors.push(`[${label}] ${m.text()} ${url}`);
  });
  if (process.env.E2E_DEBUG) {
    page.on('response', (r) => { if (/neon.tech/.test(r.url())) console.log('  [net]', label, r.request().method(), r.status(), new URL(r.url()).pathname); });
    page.on('console', (m) => console.log('  [console]', label, m.type(), m.text()));
  }
  page.on('dialog', (d) => {
    dialogs.push({ label, message: d.message() });
    d.accept();
  });
  return { context, page, label };
}

async function until(fn, { timeout = 20000, interval = 500 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    let value;
    try { value = await fn(); } catch { value = false; }
    if (value) return value;
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, interval));
  }
}

const totalsOf = async (page) => (await page.locator('.total-cell').allTextContents()).map((t) => t.trim()).join(',');
const waitSynced = (page, timeout = 30000) => page.waitForFunction(
  () => document.getElementById('sync-status')?.textContent === 'Synced', null, { timeout });
const gameIdOf = (page) => /#\/game\/([^/?]+)/.exec(page.url())?.[1];

async function createGame(page, name) {
  await page.goto(`${BASE}#/new`);
  await page.waitForSelector('.view-setup');
  await page.fill('#game-name', name);
  const inputs = page.locator('.player-row input');
  await inputs.nth(0).fill('Alice');
  await inputs.nth(1).fill('Bob');
  await page.click('button[type="submit"]');
  await page.waitForSelector('.view-game');
}

async function setScore(page, r, p, value) {
  await page.locator('tbody tr').nth(r).locator('.score-cell').nth(p).click();
  await page.waitForSelector('#keypad[open]');
  // The keypad opens pre-filled with the current score: erase it first.
  for (let i = 0; i < 8; i++) await page.keyboard.press('Backspace');
  await page.keyboard.type(String(value));
  await page.keyboard.press('Enter');
  await page.waitForSelector('#keypad[open]', { state: 'detached' });
}

const pushed = (page) => page.waitForResponse(
  (r) => r.url().includes('/rest/v1/games') && r.request().method() === 'POST', { timeout: 30000 });

let server;
let browser;
let sql;
try {
  sql = ownerSql();
  await cleanupUsers(sql); // stale users from interrupted runs
  server = await startServer({ port: PORT });
  browser = await chromium.launch({ channel });

  // ---------- 1. Device A: local game, then account
  const A = await newDevice(browser, 'A', { permissions: ['clipboard-read', 'clipboard-write'] });
  await A.context.addInitScript(() => {
    if (navigator.share) navigator.share = async (data) => { window.__shared = data; };
  });
  await A.page.goto(BASE);
  await A.page.waitForSelector('.view-home');
  await createGame(A.page, 'Cloud night');
  const gameId = gameIdOf(A.page);
  await setScore(A.page, 0, 0, 12);
  await setScore(A.page, 0, 1, 7);
  check(await totalsOf(A.page) === '12,7', 'A: signed-out game scored 12,7');

  await A.page.goto(`${BASE}#/account`);
  await A.page.waitForSelector('#auth-email');
  await A.page.locator('label:has(input[name="auth-mode"][value="create"])').click();
  await A.page.fill('#auth-name', 'E2E User');
  await A.page.fill('#auth-email', email);
  await A.page.fill('#auth-password', password);
  await A.page.click('button[type="submit"]');
  await waitSynced(A.page).then(() => check(true, 'A: header status reaches "Synced"'),
    () => check(false, 'A: header status reaches "Synced"', `status=${A.page.url()}`));
  check(dialogs.some((d) => d.label === 'A' && /^Add 1 game on this device to /.test(d.message)),
    'A: ownership confirm "Add 1 game on this device to <email>?"', JSON.stringify(dialogs));
  check((await A.page.locator('.view-account .auth-card .muted').first().textContent()).trim() === email,
    'A: account view shows the email');

  // ---------- 2. Device B signs in
  const B = await newDevice(browser, 'B');
  await B.page.goto(`${BASE}#/account`);
  await B.page.waitForSelector('#auth-email');
  await B.page.fill('#auth-email', email);
  await B.page.fill('#auth-password', password);
  await B.page.click('button[type="submit"]');
  await B.page.waitForSelector('.view-account .auth-card .auth-sync');
  await B.page.goto(`${BASE}#/`);
  const seen = await until(async () => (await B.page.locator('.game-card').count()) === 1, { timeout: 30000 });
  check(seen, 'B: game appears on home after sign-in');
  await B.page.goto(`${BASE}#/game/${gameId}`);
  await B.page.waitForSelector('.view-game');
  check(await totalsOf(B.page) === '12,7', 'B: same totals as A (12,7)', await totalsOf(B.page));

  // ---------- 3. B edits, A syncs
  const bPush = pushed(B.page);
  await setScore(B.page, 0, 0, 20);
  await bPush.then(() => check(true, 'B: edit pushed to cloud'), () => check(false, 'B: edit pushed to cloud'));
  await A.page.goto(`${BASE}#/account`);
  await A.page.waitForSelector('.view-account .auth-sync');
  const aSees = await until(async () => {
    await A.page.goto(`${BASE}#/account`);
    await A.page.getByRole('button', { name: 'Sync now' }).click();
    await A.page.waitForTimeout(1500);
    await A.page.goto(`${BASE}#/game/${gameId}`);
    await A.page.waitForSelector('.view-game');
    return (await totalsOf(A.page)) === '20,7';
  }, { timeout: 30000, interval: 200 });
  check(aSees, 'A: sees B\'s edit (20,7) after Sync now', await totalsOf(A.page));

  // ---------- 4. A deletes, B syncs -> tombstone
  await A.page.goto(`${BASE}#/`);
  await A.page.waitForSelector('.game-card');
  const aDelPush = pushed(A.page);
  await A.page.click('.game-card .icon-btn[aria-label^="Delete"]');
  await A.page.waitForSelector('.view-home .empty-state');
  await aDelPush.then(() => check(true, 'A: delete pushed to cloud'), () => check(false, 'A: delete pushed to cloud'));
  const bGone = await until(async () => {
    await B.page.goto(`${BASE}#/account`);
    await B.page.getByRole('button', { name: 'Sync now' }).click();
    await B.page.waitForTimeout(1500);
    await B.page.goto(`${BASE}#/`);
    await B.page.waitForSelector('.view-home');
    return (await B.page.locator('.game-card').count()) === 0;
  }, { timeout: 30000, interval: 200 });
  check(bGone, 'B: deleted game disappears after sync (tombstone propagated)');

  // ---------- 5. A creates a game and shares it
  await createGame(A.page, 'Shared night');
  await setScore(A.page, 0, 0, 5);
  await A.page.click('button[aria-label="Share game"]');
  let link = await until(async () => {
    const shared = await A.page.evaluate(() => window.__shared?.url ?? null);
    if (shared) return shared;
    const clip = await A.page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
    return /#\/s\//.test(clip) ? clip : null;
  }, { timeout: 30000, interval: 300 });
  const tokenMatch = typeof link === 'string' ? /#\/s\/([A-Za-z0-9_-]{22})$/.exec(link) : null;
  check(Boolean(tokenMatch), 'A: share link has a 22-char token', String(link));
  if (!tokenMatch) throw new Error('no share link; cannot continue');
  const token = tokenMatch[1];

  // ---------- 6. Device C (signed out) opens the link
  const C = await newDevice(browser, 'C');
  await C.page.goto(link);
  await C.page.waitForSelector('.view-shared .readonly-badge', { timeout: 20000 });
  check((await C.page.locator('.readonly-badge').textContent()).trim() === 'Read-only', 'C: "Read-only" badge shows');
  check(await C.page.locator('.view-shared .score-cell, .view-shared button').count() === 0, 'C: no score buttons or actions');
  check(await totalsOf(C.page) === '5,0', 'C: shows current totals (5,0)', await totalsOf(C.page));

  // ---------- 7. A scores more, C sees it via the poll
  const aPush = pushed(A.page);
  await setScore(A.page, 0, 1, 9);
  await aPush.catch(() => null);
  const cUpdated = await until(async () => (await totalsOf(C.page)) === '5,9', { timeout: 20000, interval: 500 });
  check(cUpdated, 'C: sees update within 20 s (poll)', await totalsOf(C.page));

  // ---------- 8. A stops sharing
  await A.page.goto(`${BASE}#/s/${token}`);
  await A.page.getByRole('button', { name: 'Stop sharing' }).click();
  await A.page.waitForSelector('.view-game');
  const missing = await until(async () => {
    await C.page.reload();
    return C.page.getByText('This game is no longer shared').waitFor({ timeout: 4000 }).then(() => true, () => false);
  }, { timeout: 20000, interval: 500 });
  check(missing, 'C: reload shows "This game is no longer shared"');

  // ---------- 9. A signs out
  await A.page.goto(`${BASE}#/account`);
  await A.page.getByRole('button', { name: 'Sign out' }).click();
  await A.page.waitForSelector('#auth-email');
  check(dialogs.some((d) => d.label === 'A' && d.message === 'Remove games from this device too?'),
    'A: sign-out asks "Remove games from this device too?"');
  await A.page.goto(`${BASE}#/`);
  await A.page.waitForSelector('.view-home .empty-state');
  check(true, 'A: home is empty after sign-out');
  await A.page.reload();
  await A.page.waitForSelector('.view-home .empty-state');
  await A.page.goto(`${BASE}#/account`);
  await A.page.waitForSelector('#auth-email', { timeout: 10000 });
  check(await A.page.locator('#sync-status').isHidden(), 'A: still signed out after reload');

  // ---------- 10. No errors
  check(errors.length === 0, `no console/page errors (${errors.join(' | ')})`);
} catch (err) {
  failures.push(`exception: ${err.message}`);
  console.error(err);
} finally {
  await browser?.close();
  server?.close();
  try {
    const res = await cleanupUsers(sql ?? ownerSql());
    check(res.remaining === 0, `cleanup: removed ${res.removed} e2e user(s), remaining e2e users = ${res.remaining}`);
  } catch (err) {
    failures.push(`cleanup: ${err.message}`);
    console.error('FAIL  cleanup error:', err.message);
  }
}

console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASSED');
process.exit(failures.length ? 1 : 0);
