// End-to-end test of the same-origin auth proxy (worker/index.js) under `wrangler dev`, against the REAL Neon project.
// The owner connection string is fetched via neonctl into process memory ONLY (never printed or written)
// and is used to delete the throwaway e2e users in a finally block.
//
// config.js only selects the same-origin proxy on www.eight1fivedesign.com and has no test hook, so this script
// patches the BUILT COPY (dist/tabletop-scorecard/js/config.js, a generated artifact) to also select the proxy on
// localhost. App source is never modified. A real hook (e.g. honouring localStorage['tabletop-scorecard:auth-url']
// on localhost) would remove the need for this patch.
import { execSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { neon } from '@neondatabase/serverless';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8787;
const ORIGIN = `http://localhost:${PORT}`;
const APP = `${ORIGIN}/tabletop-scorecard/`;
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

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' });
    else child.kill('SIGTERM');
  } catch { /* already gone */ }
}

async function waitForUrl(url, timeoutMs, child) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (child.exitCode !== null) throw new Error(`wrangler exited early (code ${child.exitCode})`);
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 750));
  }
  throw new Error(`timed out waiting for ${url}`);
}

const waitSynced = (page, timeout = 30000) => page.waitForFunction(
  () => document.getElementById('sync-status')?.textContent === 'Synced', null, { timeout });

const ts = Date.now();
const email = `e2e+w${ts}@example.com`;
const password = `E2e-${randomBytes(9).toString('base64url')}`;
const errors = [];

let wrangler;
let browser;
let sql;
try {
  sql = ownerSql();
  await cleanupUsers(sql); // stale users from interrupted runs

  execSync('node scripts/build-site.mjs', { cwd: ROOT, stdio: 'ignore' });
  const configPath = resolve(ROOT, 'dist', 'tabletop-scorecard', 'js', 'config.js');
  const src = readFileSync(configPath, 'utf8');
  const patched = src.replace("location.hostname === 'www.eight1fivedesign.com'", "location.hostname === 'localhost'");
  if (patched === src) throw new Error('config.js no longer has the www.eight1fivedesign.com check; update this test');
  writeFileSync(configPath, patched);

  wrangler = spawn('npx --no-install wrangler dev -c wrangler.dev.toml --port 8787', {
    cwd: ROOT, shell: true, stdio: 'ignore',
  });
  await waitForUrl(APP, 120000, wrangler);

  browser = await chromium.launch({ channel });
  const context = await browser.newContext({ viewport: { width: 420, height: 800 } });
  // The Neon Data API CORS allowlist does not include http://localhost:8787 (only github.io, 127.0.0.1:5173 and the
  // production host). Emulate that allowance at the network boundary so sync can be exercised; auth is NOT touched.
  const cors = {
    'access-control-allow-origin': ORIGIN,
    'access-control-allow-headers': 'authorization,content-type,prefer,accept,accept-profile,content-profile',
    'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'access-control-expose-headers': '*',
  };
  await context.route('https://*.apirest.*.neon.tech/**', async (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const res = await route.fetch();
    return route.fulfill({ response: res, headers: { ...res.headers(), ...cors } });
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if ((m.location()?.url ?? '').includes('/auth/') && m.text().includes('401')) return;
    errors.push(`${m.text()} ${m.location()?.url ?? ''}`);
  });
  if (process.env.E2E_DEBUG) {
    page.on('console', (m) => console.log('  [console]', m.type(), m.text()));
    page.on('requestfailed', (r) => console.log('  [reqfailed]', r.url(), r.failure()?.errorText));
    page.on('response', (r) => { if (!r.url().includes('/css/') && !r.url().includes('/js/') && !r.url().includes('/icons/')) console.log('  [net]', r.request().method(), r.status(), r.url()); });
  }
  page.on('dialog', (d) => d.accept());
  const authRequests = [];
  page.on('request', (r) => { if (/\/auth\//.test(r.url())) authRequests.push(r.url()); });

  // ---- app loads, SW takes control
  await page.goto(APP);
  await page.waitForSelector('.view-home');
  check(true, 'app loads at /tabletop-scorecard/');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 15000 });
  check(true, 'service worker controls the page before sign-up');
  const configJs = await page.evaluate(() => fetch('./js/config.js').then((r) => r.text()));
  check(configJs.includes("location.hostname === 'localhost'"), 'served config.js selects the same-origin proxy (test patch applied)');

  // ---- create an account via the account view
  await page.goto(`${APP}#/account`);
  await page.waitForSelector('#auth-email');
  await page.locator('label:has(input[name="auth-mode"][value="create"])').click();
  await page.fill('#auth-name', 'E2E Worker');
  await page.fill('#auth-email', email);
  await page.fill('#auth-password', password);
  await page.click('button[type="submit"]');
  const signedUp = await page.waitForSelector('.view-account .auth-sync', { timeout: 30000 }).then(() => true, () => false);
  check(signedUp, 'account created via the account view', (await page.locator('.form-error').textContent().catch(() => '')) ?? '');
  if (!signedUp) throw new Error('sign-up failed; cannot continue');

  // ---- auth traffic is same-origin
  const sameOrigin = authRequests.length > 0 && authRequests.every((u) => u.startsWith(`${ORIGIN}/tabletop-scorecard/auth/`));
  check(sameOrigin, 'all auth requests go to same-origin /tabletop-scorecard/auth/...', authRequests.join(' | '));
  check(!authRequests.some((u) => u.includes('neon.tech')), 'no auth request goes directly to neon.tech');
  check(authRequests.some((u) => u.endsWith('/auth/sign-up/email')) && authRequests.some((u) => u.includes('/auth/token')),
    'sign-up and token requests were proxied', authRequests.join(' | '));

  // ---- first-party cookie
  const cookies = await context.cookies(`${ORIGIN}/tabletop-scorecard/auth/`);
  const session = cookies.find((c) => c.name === '__Secure-neon-auth.session_token');
  check(Boolean(session), '__Secure-neon-auth.session_token cookie is set for localhost', cookies.map((c) => c.name).join(','));
  check(session?.path === '/tabletop-scorecard/auth', 'session cookie path is /tabletop-scorecard/auth', session?.path);
  check(session?.httpOnly === true && session?.domain === 'localhost', 'session cookie is HttpOnly and host-only on localhost', `${session?.domain}`);
  const stray = (await context.cookies()).filter((c) => c.domain.includes('neon.tech'));
  check(stray.length === 0, 'no cookie stored for the neon.tech host');

  // ---- sync works
  await waitSynced(page).then(() => check(true, 'header status reaches "Synced" after sign-up'),
    () => check(false, 'header status reaches "Synced" after sign-up'));
  await page.goto(`${APP}#/new`);
  await page.waitForSelector('.view-setup');
  await page.fill('#game-name', 'Worker night');
  const inputs = page.locator('.player-row input');
  await inputs.nth(0).fill('Alice');
  await inputs.nth(1).fill('Bob');
  const pushed = page.waitForResponse((r) => r.url().includes('/rest/v1/games') && r.request().method() === 'POST', { timeout: 30000 });
  await page.click('button[type="submit"]');
  await page.waitForSelector('.view-game');
  const pushRes = await pushed.catch(() => null);
  check(pushRes?.status() === 201, 'game created and pushed to the Data API (201)', String(pushRes?.status()));
  await waitSynced(page).then(() => check(true, 'header status reaches "Synced" after creating a game'),
    () => check(false, 'header status reaches "Synced" after creating a game'));

  // ---- the SW never cached /auth/
  const cached = await page.evaluate(async () => {
    const urls = [];
    for (const name of await caches.keys()) {
      for (const req of await (await caches.open(name)).keys()) urls.push(req.url);
    }
    return urls;
  });
  check(cached.length > 0, 'SW cache is populated (sanity)', String(cached.length));
  check(!cached.some((u) => u.includes('/auth/')), 'no /auth/ response was cached by the service worker',
    cached.filter((u) => u.includes('/auth/')).join(' | '));

  // ---- reload with the SW in control must work (precached index.html must not be a redirected response)
  const state = await context.storageState();
  const reloaded = await page.reload().then(() => true, (e) => e.message.split('\n')[0]);
  check(reloaded === true, 'reload succeeds with the service worker in control', String(reloaded));

  // ---- the session survives a reload (when the SW bug blocks reload, verify with a fresh SW-less page using the same cookies)
  let check_page = page;
  if (reloaded !== true) {
    const fresh = await browser.newContext({ storageState: state, serviceWorkers: 'block', viewport: { width: 420, height: 800 } });
    await fresh.route('https://*.apirest.*.neon.tech/**', async (route) => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      const res = await route.fetch();
      return route.fulfill({ response: res, headers: { ...res.headers(), ...cors } });
    });
    check_page = await fresh.newPage();
    check_page.on('pageerror', (e) => errors.push(e.message));
    await check_page.goto(APP);
  }
  await check_page.waitForSelector('#app > .view');
  await waitSynced(check_page).then(() => check(true, 'after reload: still signed in (header shows Synced)'),
    () => check(false, 'after reload: still signed in (header shows Synced)'));
  await check_page.goto(`${APP}#/account`);
  const emailShown = await check_page.locator('.view-account .auth-card .muted').first().textContent({ timeout: 15000 }).catch(() => '');
  check(emailShown?.trim() === email, 'after reload: account view shows the email', emailShown);

  check(errors.length === 0, `no console/page errors (${errors.join(' | ')})`);
} catch (err) {
  failures.push(`exception: ${err.message}`);
  console.error(err);
} finally {
  await browser?.close().catch(() => {});
  killTree(wrangler);
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
