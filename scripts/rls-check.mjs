// Integration test of the cloud schema against the REAL Neon project.
// Creates two throwaway users, exercises RLS / guards / sharing, then cleans up.
// Needs DATABASE_URL (owner connection string, used for cleanup only) in the environment.
import { randomBytes, randomUUID } from 'node:crypto';
import { neon } from '@neondatabase/serverless';

const AUTH = 'https://ep-summer-breeze-bdgam8p2.neonauth.c-8.us-east-2.aws.neon.tech/neondb/auth';
const DATA = 'https://ep-summer-breeze-bdgam8p2.apirest.c-8.us-east-2.aws.neon.tech/neondb/rest/v1';
const ORIGIN = 'http://127.0.0.1:5173';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `  [${detail}]` : ''}`);
}

async function auth(path, { method = 'GET', body, cookie } = {}) {
  const headers = { Origin: ORIGIN };
  if (body) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(`${AUTH}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  const cookies = res.headers.getSetCookie().map((c) => c.split(';')[0]);
  return { status: res.status, json, cookies };
}

async function rest(path, jwt, { method = 'GET', body, prefer } = {}) {
  const headers = {};
  if (jwt) headers.Authorization = `Bearer ${jwt}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${DATA}/${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, json, text };
}

const ok2xx = (r) => r.status >= 200 && r.status < 300;
const rowsOf = (r) => (ok2xx(r) && Array.isArray(r.json) ? r.json : null);

async function makeUser(label, ts) {
  const email = `rls+${ts}-${label}@example.com`;
  const password = `Pw-${randomBytes(9).toString('base64url')}`;
  const up = await auth('/sign-up/email', { method: 'POST', body: { email, password, name: `RLS ${label}` } });
  if (up.status !== 200) throw new Error(`sign-up ${label} failed: ${up.status} ${JSON.stringify(up.json)}`);
  const cookie = up.cookies.join('; ');
  const tok = await auth('/token', { cookie });
  if (tok.status !== 200 || !tok.json?.token) throw new Error(`token ${label} failed: ${tok.status}`);
  return { email, id: up.json?.user?.id, jwt: tok.json.token };
}

const ts = Date.now();
const owner = neon(process.env.DATABASE_URL);
const users = [];
try {
  const A = await makeUser('a', ts);
  users.push(A);
  const B = await makeUser('b', ts);
  users.push(B);
  check('sign-up and JWT for two users', !!A.jwt && !!B.jwt && A.jwt !== B.jwt);

  const gameId = randomUUID();
  const t0 = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const gameData = { id: gameId, name: 'RLS game', v: 1 };
  const upsert = 'resolution=merge-duplicates,return=minimal';

  // --- Owner A writes and reads back
  const rg = await rest('games?on_conflict=id', A.jwt, { method: 'POST', prefer: upsert, body: { id: gameId, data: gameData, updated_at: iso(t0), deleted_at: null, share_token: null } });
  check('A upserts game', ok2xx(rg), `${rg.status} ${rg.text}`);
  const rp = await rest('players?on_conflict=user_id,key', A.jwt, { method: 'POST', prefer: upsert, body: { key: 'alice', name: 'Alice', color: 3, updated_at: iso(t0), deleted_at: null } });
  check('A upserts player', ok2xx(rp), `${rp.status} ${rp.text}`);
  const rs = await rest('user_settings?on_conflict=user_id', A.jwt, { method: 'POST', prefer: upsert, body: { data: { theme: 'dark' }, updated_at: iso(t0) } });
  check('A upserts settings', ok2xx(rs), `${rs.status} ${rs.text}`);

  const ag = rowsOf(await rest('games?select=*', A.jwt));
  check('A reads own game, user_id defaulted from JWT', ag?.length === 1 && ag[0].id === gameId && ag[0].user_id === A.id, JSON.stringify(ag));
  const ap = rowsOf(await rest('players?select=*', A.jwt));
  check('A reads own player', ap?.length === 1 && ap[0].key === 'alice' && ap[0].user_id === A.id);
  const as = rowsOf(await rest('user_settings?select=*', A.jwt));
  check('A reads own settings', as?.length === 1 && as[0].data?.theme === 'dark' && as[0].user_id === A.id);

  // --- Isolation: B sees nothing
  for (const t of ['games', 'players', 'user_settings']) {
    const r = await rest(`${t}?select=*`, B.jwt);
    check(`B sees 0 rows in ${t}`, rowsOf(r)?.length === 0, `${r.status} ${r.text}`);
  }
  const bp = await rest(`games?id=eq.${gameId}`, B.jwt, { method: 'PATCH', prefer: 'return=representation', body: { data: { hacked: true } } });
  check('B PATCH of A game changes 0 rows', (ok2xx(bp) ? (bp.json ?? []).length === 0 : true), `${bp.status} ${bp.text}`);
  const bd = await rest(`games?id=eq.${gameId}`, B.jwt, { method: 'DELETE', prefer: 'return=representation' });
  check('B DELETE of A game removes 0 rows', (ok2xx(bd) ? (bd.json ?? []).length === 0 : true), `${bd.status} ${bd.text}`);
  const bu = await rest('games?on_conflict=id', B.jwt, { method: 'POST', prefer: upsert, body: { id: gameId, data: { hacked: true }, updated_at: iso(t0 + 60000), deleted_at: null, share_token: null } });
  const bs = await rest('players?on_conflict=user_id,key', B.jwt, { method: 'POST', prefer: upsert, body: { key: 'alice', name: 'Alice', color: 7, updated_at: iso(t0 + 60000), deleted_at: null } });
  const bo = await rest('games?on_conflict=id', B.jwt, { method: 'POST', prefer: upsert, body: { id: randomUUID(), user_id: A.id, data: { x: 1 }, updated_at: iso(t0), deleted_at: null, share_token: null } });
  check('B cannot insert a row owned by A', !ok2xx(bo), `${bo.status}`);
  const a2 = rowsOf(await rest('games?select=*', A.jwt));
  check('A game untouched after B attacks', a2?.length === 1 && a2[0].data?.hacked === undefined && a2[0].data?.v === 1 && a2[0].user_id === A.id, `upsert=${bu.status} ${JSON.stringify(a2)}`);
  check('B upsert with A game id rejected or no-op', !ok2xx(bu) || a2?.[0]?.data?.hacked === undefined, `${bu.status}`);
  const ap2 = rowsOf(await rest('players?select=*', A.jwt));
  check('A player untouched after B attacks', ap2?.length === 1 && ap2[0].color === 3, `bs=${bs.status}`);

  // --- Stale-write guard
  const st = await rest('games?on_conflict=id', A.jwt, { method: 'POST', prefer: upsert, body: { id: gameId, data: { ...gameData, v: 'STALE' }, updated_at: iso(t0 - 3600000), deleted_at: null, share_token: null } });
  const a3 = rowsOf(await rest('games?select=*', A.jwt));
  check('stale upsert (older updated_at) leaves data unchanged', a3?.[0]?.data?.v === 1, `${st.status} ${JSON.stringify(a3?.[0]?.data)}`);
  const fr = await rest('games?on_conflict=id', A.jwt, { method: 'POST', prefer: upsert, body: { id: gameId, data: { ...gameData, v: 2 }, updated_at: iso(t0 + 1000), deleted_at: null, share_token: null } });
  const a4 = rowsOf(await rest('games?select=*', A.jwt));
  check('newer upsert applies', ok2xx(fr) && a4?.[0]?.data?.v === 2, `${fr.status}`);

  // --- Sharing
  const token = randomBytes(16).toString('base64url');
  const sh = await rest(`games?id=eq.${gameId}`, A.jwt, { method: 'PATCH', prefer: 'return=minimal', body: { share_token: token, updated_at: iso(t0 + 2000) } });
  check('A sets share_token', ok2xx(sh) && token.length === 22, `${sh.status} ${sh.text}`);
  const badTok = await rest(`games?id=eq.${gameId}`, A.jwt, { method: 'PATCH', prefer: 'return=minimal', body: { share_token: 'short', updated_at: iso(t0 + 3000) } });
  check('invalid share_token format rejected by constraint', !ok2xx(badTok), `${badTok.status}`);

  const anon = await auth('/token/anonymous');
  const anonJwt = anon.json?.token;
  check('anonymous JWT issued', anon.status === 200 && !!anonJwt, `${anon.status}`);
  const shared = await rest('rpc/get_shared_game', anonJwt, { method: 'POST', body: { p_token: token } });
  check('anonymous get_shared_game returns the game', ok2xx(shared) && shared.json?.game?.id === gameId && !!shared.json?.updatedAt, `${shared.status} ${shared.text}`);
  const unknown = await rest('rpc/get_shared_game', anonJwt, { method: 'POST', body: { p_token: randomBytes(16).toString('base64url') } });
  check('unknown valid-format token returns null', ok2xx(unknown) && unknown.json === null, `${unknown.status} ${unknown.text}`);
  const invalid = await rest('rpc/get_shared_game', anonJwt, { method: 'POST', body: { p_token: "x' or 1=1 --" } });
  check('invalid token returns null', ok2xx(invalid) && invalid.json === null, `${invalid.status} ${invalid.text}`);
  for (const t of ['games', 'players', 'user_settings']) {
    const r = await rest(`${t}?select=*`, anonJwt);
    check(`anonymous GET ${t} denied`, !ok2xx(r) || (Array.isArray(r.json) && r.json.length === 0 && false), `${r.status} ${r.text}`);
  }
  const anonW = await rest('games?on_conflict=id', anonJwt, { method: 'POST', prefer: upsert, body: { id: randomUUID(), data: { x: 1 }, updated_at: iso(t0), user_id: A.id } });
  check('anonymous write denied', !ok2xx(anonW), `${anonW.status}`);

  // --- Soft delete hides the share
  const del = await rest(`games?id=eq.${gameId}`, A.jwt, { method: 'PATCH', prefer: 'return=minimal', body: { deleted_at: iso(t0 + 4000), updated_at: iso(t0 + 4000) } });
  const gone = await rest('rpc/get_shared_game', anonJwt, { method: 'POST', body: { p_token: token } });
  check('deleted game: RPC returns null', ok2xx(del) && ok2xx(gone) && gone.json === null, `${del.status} ${gone.status} ${gone.text}`);

  // --- No Authorization
  const noAuth = await rest('games?select=*', null);
  check('no Authorization header gives 400', noAuth.status === 400, `${noAuth.status}`);
} catch (err) {
  failures++;
  console.log(`FAIL  unexpected error: ${err.message}`);
} finally {
  try {
    const ids = users.map((u) => u.id).filter(Boolean);
    if (ids.length) {
      for (const t of ['games', 'players', 'user_settings']) {
        await owner.query(`delete from public.${t} where user_id = any($1)`, [ids]);
      }
      const cols = await owner.query(
        `select table_name, column_name from information_schema.columns
         where table_schema = 'neon_auth' and column_name in ('userId', 'user_id') order by 1`
      );
      for (const { table_name, column_name } of cols) {
        await owner.query(`delete from neon_auth."${table_name}" where "${column_name}" = any($1)`, [ids]);
      }
      await owner.query('delete from neon_auth."user" where id = any($1)', [ids]);
      const left = await owner.query('select count(*)::int as n from neon_auth."user" where id = any($1)', [ids]);
      check('cleanup removed test users', left[0].n === 0);
    }
  } catch (err) {
    failures++;
    console.log(`FAIL  cleanup error: ${err.message}`);
  }
}
console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
