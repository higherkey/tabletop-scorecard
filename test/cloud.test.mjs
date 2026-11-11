import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createCloud, CloudError } from '../js/cloud.js';
import { createGame } from '../js/model.js';

const AUTH = 'https://auth.example/neondb/auth';
const DATA = 'https://data.example/neondb/rest/v1';
const APP = 'https://user.github.io/tabletop-scorecard/';
const FLAG = 'tabletop-scorecard:had-session';
const USER = { id: 'u1', email: 'a@b.co', name: 'Ann' };

const json = (body, status = 200, headers = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

function makeJwt(expSec, extra = {}) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'EdDSA' })}.${enc({ exp: expSec, ...extra })}.sig`;
}

// Records every call and delegates to handler({url, path, method, credentials, headers, body}).
function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const call = {
      url,
      path: url.replace(AUTH, '').replace(DATA, ''),
      method: init.method ?? 'GET',
      credentials: init.credentials,
      headers: init.headers ?? {},
      body: init.body === undefined ? undefined : JSON.parse(init.body),
      rawBody: init.body,
    };
    calls.push(call);
    return handler(call);
  };
  fn.calls = calls;
  return fn;
}

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    map,
  };
}

function fakeEnv(search = '') {
  const replaced = [];
  const assigned = [];
  return {
    location: { search, pathname: '/tabletop-scorecard/', hash: '#/account', assign: (u) => assigned.push(u) },
    history: { state: null, replaceState: (...args) => replaced.push(args) },
    replaced,
    assigned,
  };
}

function build({ handler, search = '', storage = memoryStorage(), clock = { t: 1_700_000_000_000 } } = {}) {
  const fetchImpl = fakeFetch(handler);
  const env = fakeEnv(search);
  const cloud = createCloud({
    authUrl: AUTH,
    dataUrl: DATA,
    appUrl: APP,
    fetchImpl,
    now: () => clock.t,
    location: env.location,
    history: env.history,
    storage,
  });
  return { cloud, fetchImpl, env, storage, clock };
}

// Standard handler: signed-in session with a fresh JWT, plus overrides by "METHOD path-prefix".
function sessionHandler(clock, overrides = {}) {
  return (call) => {
    for (const [key, fn] of Object.entries(overrides)) {
      const [method, prefix] = key.split(' ');
      if (call.method === method && call.path.startsWith(prefix)) return fn(call);
    }
    if (call.path.startsWith('/sign-in/email') || call.path.startsWith('/sign-up/email')) {
      return json({ token: 'x', user: USER });
    }
    if (call.path === '/token') return json({ token: makeJwt(clock.t / 1000 + 900, { sub: 'u1' }) });
    if (call.path.startsWith('/get-session')) return json({ session: {}, user: USER });
    if (call.path.startsWith('/sign-out')) return json({ success: true });
    return json(null, 204);
  };
}

async function signedIn(overrides = {}) {
  const clock = { t: 1_700_000_000_000 };
  const ctx = build({ handler: sessionHandler(clock, overrides), clock });
  await ctx.cloud.signIn({ email: USER.email, password: 'password1' });
  ctx.fetchImpl.calls.length = 0;
  return ctx;
}

const rejectsCode = (promise, code) =>
  assert.rejects(promise, (err) => err instanceof CloudError && err.code === code);

describe('credentials modes', () => {
  test('auth endpoints use include, data and anonymous use omit', async () => {
    const clock = { t: 1_700_000_000_000 };
    const anonJwt = makeJwt(clock.t / 1000 + 3600, { role: 'anonymous' });
    const ctx = build({
      clock,
      handler: sessionHandler(clock, {
        'GET /token/anonymous': () => json({ token: anonJwt, expires_at: new Date(clock.t + 3600_000).toISOString() }),
        'GET /games': () => json([]),
        'POST /rpc/get_shared_game': () => json(null),
      }),
    });
    const { cloud, fetchImpl } = ctx;
    await cloud.signIn({ email: USER.email, password: 'password1' });
    await cloud.rest('games?select=id');
    await cloud.getShared('A'.repeat(22));
    await cloud.signOut();
    const by = (method, path) => fetchImpl.calls.find((c) => c.method === method && c.path.startsWith(path));
    assert.equal(by('POST', '/sign-in/email').credentials, 'include');
    assert.equal(by('GET', '/token').credentials, 'include');
    assert.equal(by('POST', '/sign-out').credentials, 'include');
    assert.equal(by('GET', '/token/anonymous').credentials, 'omit');
    assert.equal(by('GET', '/games').credentials, 'omit');
    assert.equal(by('POST', '/rpc/get_shared_game').credentials, 'omit');
    assert.match(by('GET', '/games').headers.Authorization, /^Bearer /);
  });

  test('sign-up and social sign-in use include; google assigns the returned url', async () => {
    const clock = { t: 1_700_000_000_000 };
    const ctx = build({
      clock,
      handler: sessionHandler(clock, {
        'POST /sign-in/social': () => json({ url: 'https://accounts.google.com/x' }),
      }),
    });
    await ctx.cloud.signUp({ email: USER.email, password: 'password1', name: 'Ann' });
    await ctx.cloud.signInWithGoogle();
    const up = ctx.fetchImpl.calls.find((c) => c.path === '/sign-up/email');
    assert.equal(up.credentials, 'include');
    assert.deepEqual(up.body, { email: USER.email, password: 'password1', name: 'Ann' });
    const social = ctx.fetchImpl.calls.find((c) => c.path === '/sign-in/social');
    assert.equal(social.credentials, 'include');
    assert.deepEqual(social.body, { provider: 'google', callbackURL: APP, disableRedirect: true });
    assert.deepEqual(ctx.env.assigned, ['https://accounts.google.com/x']);
  });
});

describe('init', () => {
  test('with no flag makes no calls and is signed-out', async () => {
    const { cloud, fetchImpl } = build({ handler: () => json(null) });
    const events = [];
    cloud.onChange((s) => events.push(s.status));
    await cloud.init();
    assert.equal(fetchImpl.calls.length, 0);
    assert.deepEqual(cloud.getSession(), { status: 'signed-out', user: null });
    assert.deepEqual(events, ['signed-out']);
  });

  test('with the flag refreshes the JWT then loads the session', async () => {
    const clock = { t: 1_700_000_000_000 };
    const ctx = build({ clock, storage: memoryStorage({ [FLAG]: '1' }), handler: sessionHandler(clock) });
    await ctx.cloud.init();
    assert.deepEqual(ctx.fetchImpl.calls.map((c) => c.path), ['/token', '/get-session']);
    assert.deepEqual(ctx.cloud.getSession(), { status: 'signed-in', user: USER });
  });

  test('with the flag and a 401 token clears the flag and signs out', async () => {
    const clock = { t: 1_700_000_000_000 };
    const ctx = build({
      clock,
      storage: memoryStorage({ [FLAG]: '1' }),
      handler: sessionHandler(clock, { 'GET /token': () => json({ message: 'no' }, 401) }),
    });
    await ctx.cloud.init();
    assert.equal(ctx.cloud.getSession().status, 'signed-out');
    assert.equal(ctx.storage.getItem(FLAG), null);
  });

  test('with the OAuth verifier strips the param and reads set-auth-jwt', async () => {
    const clock = { t: 1_700_000_000_000 };
    const jwt = makeJwt(clock.t / 1000 + 900);
    const ctx = build({
      clock,
      search: '?a=1&neon_auth_session_verifier=ver%2B1',
      handler: sessionHandler(clock, {
        'GET /get-session': () => json({ session: {}, user: USER }, 200, { 'set-auth-jwt': jwt }),
      }),
    });
    await ctx.cloud.init();
    assert.equal(ctx.env.replaced.length, 1);
    assert.equal(ctx.env.replaced[0][2], '/tabletop-scorecard/?a=1#/account');
    assert.equal(ctx.fetchImpl.calls.length, 1);
    assert.equal(ctx.fetchImpl.calls[0].path, '/get-session?neon_auth_session_verifier=ver%2B1');
    assert.equal(ctx.fetchImpl.calls[0].credentials, 'include');
    assert.deepEqual(ctx.cloud.getSession(), { status: 'signed-in', user: USER });
    assert.equal(ctx.storage.getItem(FLAG), '1');
    // The JWT from the header is cached: no /token call is needed.
    assert.equal(await ctx.cloud.getJwt(), jwt);
    assert.equal(ctx.fetchImpl.calls.length, 1);
  });

  test('offline during init with the flag gives unknown (not signed-out) and keeps the flag', async () => {
    const storage = memoryStorage({ [FLAG]: '1' });
    const { cloud } = build({
      storage,
      handler: () => {
        throw new TypeError('fetch failed');
      },
    });
    const events = [];
    cloud.onChange((s) => events.push(s.status));
    await cloud.init();
    assert.equal(cloud.getSession().status, 'unknown');
    assert.deepEqual(events, []);
    assert.equal(storage.getItem(FLAG), '1');
  });

  test('a 5xx during init with the flag gives unknown and keeps the flag', async () => {
    const clock = { t: 1_700_000_000_000 };
    const ctx = build({
      clock,
      storage: memoryStorage({ [FLAG]: '1' }),
      handler: sessionHandler(clock, { 'GET /token': () => json({ message: 'down' }, 503) }),
    });
    await ctx.cloud.init();
    assert.equal(ctx.cloud.getSession().status, 'unknown');
    assert.equal(ctx.storage.getItem(FLAG), '1');
  });

  test('retryInit recovers after a network failure and is a no-op once the status is known', async () => {
    const clock = { t: 1_700_000_000_000 };
    let down = true;
    const ctx = build({
      clock,
      storage: memoryStorage({ [FLAG]: '1' }),
      handler: (call) => {
        if (down) throw new TypeError('fetch failed');
        return sessionHandler(clock)(call);
      },
    });
    await ctx.cloud.init();
    assert.equal(ctx.cloud.getSession().status, 'unknown');
    down = false;
    await ctx.cloud.retryInit();
    assert.deepEqual(ctx.cloud.getSession(), { status: 'signed-in', user: USER });
    const calls = ctx.fetchImpl.calls.length;
    await ctx.cloud.retryInit();
    assert.equal(ctx.fetchImpl.calls.length, calls);
  });

  test('without the flag a failed verifier init is signed-out, not unknown', async () => {
    const { cloud } = build({
      search: '?neon_auth_session_verifier=v',
      handler: () => {
        throw new TypeError('fetch failed');
      },
    });
    await cloud.init();
    assert.equal(cloud.getSession().status, 'signed-out');
  });
});

describe('JWT handling', () => {
  test('caches the JWT and refreshes when under 60 s remain', async () => {
    const ctx = await signedIn();
    const { cloud, fetchImpl, clock } = ctx;
    const first = await cloud.getJwt();
    assert.equal(fetchImpl.calls.length, 0, 'sign-in already cached the token');
    clock.t += 800_000; // 100 s remain
    assert.equal(await cloud.getJwt(), first);
    assert.equal(fetchImpl.calls.length, 0);
    clock.t += 50_000; // 50 s remain
    const second = await cloud.getJwt();
    assert.equal(fetchImpl.calls.filter((c) => c.path === '/token').length, 1);
    assert.notEqual(second, first);
  });

  test('concurrent getJwt shares a single /token call', async () => {
    const clock = { t: 1_700_000_000_000 };
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    const ctx = build({
      clock,
      handler: sessionHandler(clock, {
        'GET /token': async () => {
          await gate;
          return json({ token: makeJwt(clock.t / 1000 + 900) });
        },
      }),
    });
    const all = Promise.all([ctx.cloud.getJwt(), ctx.cloud.getJwt(), ctx.cloud.getJwt()]);
    release();
    const [a, b, c] = await all;
    assert.equal(a, b);
    assert.equal(b, c);
    assert.equal(ctx.fetchImpl.calls.filter((x) => x.path === '/token').length, 1);
  });

  test('a 401 sets signed-out, fires onChange and clears the flag', async () => {
    let tokenStatus = 200;
    const ctx = await signedIn({
      'GET /token': () => (tokenStatus === 401
        ? json({ message: 'nope' }, 401)
        : json({ token: makeJwt(1_700_000_000 + 900) })),
    });
    const events = [];
    ctx.cloud.onChange((s) => events.push(s.status));
    assert.equal(ctx.storage.getItem(FLAG), '1');
    tokenStatus = 401;
    ctx.clock.t += 900_000;
    await rejectsCode(ctx.cloud.getJwt(), 'signed-out');
    assert.deepEqual(ctx.cloud.getSession(), { status: 'signed-out', user: null });
    assert.deepEqual(events, ['signed-out']);
    assert.equal(ctx.storage.getItem(FLAG), null);
  });

  test('unsubscribe stops onChange events', async () => {
    const { cloud } = build({ handler: () => json(null) });
    const events = [];
    const off = cloud.onChange((s) => events.push(s.status));
    off();
    await cloud.init();
    assert.deepEqual(events, []);
  });

  test('tokens are never written to storage and only the boolean flag is persisted', async () => {
    const ctx = await signedIn();
    for (const [k, v] of ctx.storage.map) {
      assert.equal(k, FLAG);
      assert.equal(v, '1');
    }
    assert.equal(ctx.storage.map.size, 1);
  });
});

describe('JWT generation', () => {
  test('a token fetched before signOut is discarded when it resolves afterwards', async () => {
    const clock = { t: 1_700_000_000_000 };
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    let tokenCalls = 0;
    const ctx = build({
      clock,
      storage: memoryStorage({ [FLAG]: '1' }),
      handler: sessionHandler(clock, {
        'GET /token': async () => {
          tokenCalls += 1;
          if (tokenCalls === 1) await gate;
          return json({ token: makeJwt(clock.t / 1000 + 900, { n: tokenCalls }) });
        },
      }),
    });
    const stale = ctx.cloud.getJwt();
    stale.catch(() => {});
    await new Promise((r) => setImmediate(r));
    await ctx.cloud.signOut();
    release();
    await rejectsCode(stale, 'signed-out');
    // Nothing was cached: the next call asks the server again.
    await ctx.cloud.getJwt();
    assert.equal(tokenCalls, 2);
    assert.equal(ctx.cloud.getSession().status, 'signed-out');
  });
});

describe('sign-in errors', () => {
  test('sign-in followed by a /token 401 gives cookies-blocked and status unavailable', async () => {
    const clock = { t: 1_700_000_000_000 };
    const ctx = build({
      clock,
      handler: sessionHandler(clock, { 'GET /token': () => json({ message: 'x' }, 401) }),
    });
    const events = [];
    ctx.cloud.onChange((s) => events.push(s.status));
    await rejectsCode(ctx.cloud.signIn({ email: USER.email, password: 'password1' }), 'cookies-blocked');
    assert.equal(ctx.cloud.getSession().status, 'unavailable');
    assert.deepEqual(events, ['unavailable']);
    assert.equal(ctx.storage.getItem(FLAG), null);
  });

  test('a non-https Google redirect url is rejected and never assigned', async () => {
    for (const url of ['http://accounts.google.com/x', 'javascript:alert(1)', 'not a url', 'data:text/html,hi']) {
      const clock = { t: 1_700_000_000_000 };
      const ctx = build({ clock, handler: sessionHandler(clock, { 'POST /sign-in/social': () => json({ url }) }) });
      await rejectsCode(ctx.cloud.signInWithGoogle(), 'unknown');
      assert.deepEqual(ctx.env.assigned, [], url);
    }
  });

  test('maps auth error responses to stable codes with friendly messages', async () => {
    const cases = [
      [422, { code: 'USER_ALREADY_EXISTS', message: 'raw' }, 'user-exists', 'An account with this email already exists.'],
      [401, { code: 'INVALID_EMAIL_OR_PASSWORD', message: 'raw' }, 'invalid-credentials', 'Email or password is incorrect.'],
      [400, { code: 'PASSWORD_TOO_SHORT', message: 'raw' }, 'weak-password', null],
      [500, { message: 'raw' }, 'http-500', null],
    ];
    for (const [status, body, code, message] of cases) {
      const clock = { t: 1_700_000_000_000 };
      const ctx = build({ clock, handler: sessionHandler(clock, { 'POST /sign-in/email': () => json(body, status) }) });
      await assert.rejects(ctx.cloud.signIn({ email: 'a@b.co', password: 'x' }), (err) => {
        assert.ok(err instanceof CloudError);
        assert.equal(err.code, code);
        if (message) assert.equal(err.message, message);
        assert.doesNotMatch(err.message, /raw/);
        return true;
      });
      assert.notEqual(ctx.cloud.getSession().status, 'signed-in');
    }
  });

  test('a network failure maps to offline', async () => {
    const { cloud } = build({
      handler: () => {
        throw new TypeError('fetch failed');
      },
    });
    await rejectsCode(cloud.signIn({ email: 'a@b.co', password: 'password1' }), 'offline');
  });

  test('signOut clears the flag even when the request fails', async () => {
    const clock = { t: 1_700_000_000_000 };
    const ctx = await signedIn();
    ctx.storage.setItem(FLAG, '1');
    const failing = build({
      clock,
      storage: ctx.storage,
      handler: () => {
        throw new TypeError('down');
      },
    });
    await failing.cloud.signOut();
    assert.equal(ctx.storage.getItem(FLAG), null);
    assert.equal(failing.cloud.getSession().status, 'signed-out');
  });
});

describe('rest', () => {
  test('non-2xx throws http-<status>, TypeError throws offline, 201/204/empty return null', async () => {
    const ctx = await signedIn({
      'GET /a': () => json({ message: 'bad' }, 403),
      'GET /b': () => {
        throw new TypeError('fetch failed');
      },
      'POST /c': () => new Response(null, { status: 201 }),
      'GET /d': () => new Response('', { status: 200 }),
      'GET /e': () => json([{ ok: 1 }]),
    });
    const { cloud } = ctx;
    await rejectsCode(cloud.rest('a'), 'http-403');
    await rejectsCode(cloud.rest('b'), 'offline');
    assert.equal(await cloud.rest('c', { method: 'POST', body: {} }), null);
    assert.equal(await cloud.rest('d'), null);
    assert.deepEqual(await cloud.rest('e'), [{ ok: 1 }]);
  });

  test('a 401 clears the JWT, refreshes once and retries once', async () => {
    let dataCalls = 0;
    let tokenCalls = 0;
    const ctx = await signedIn({
      'GET /token': () => {
        tokenCalls += 1;
        return json({ token: makeJwt(1_700_000_000 + 900, { n: tokenCalls }) });
      },
      'GET /things': () => {
        dataCalls += 1;
        return dataCalls === 1 ? json({ message: 'jwt expired' }, 401) : json([{ ok: 1 }]);
      },
    });
    const before = tokenCalls;
    assert.deepEqual(await ctx.cloud.rest('things'), [{ ok: 1 }]);
    assert.equal(dataCalls, 2);
    assert.equal(tokenCalls, before + 1);
    const [first, second] = ctx.fetchImpl.calls.filter((c) => c.path === '/things');
    assert.notEqual(first.headers.Authorization, second.headers.Authorization);
  });

  test('a second 401 after the retry throws http-401 without looping', async () => {
    let dataCalls = 0;
    const ctx = await signedIn({
      'GET /things': () => {
        dataCalls += 1;
        return json({ message: 'no' }, 401);
      },
    });
    await rejectsCode(ctx.cloud.rest('things'), 'http-401');
    assert.equal(dataCalls, 2);
  });

  test('sends JSON, Authorization and Prefer headers', async () => {
    const ctx = await signedIn({ 'POST /t': () => new Response(null, { status: 204 }) });
    await ctx.cloud.rest('t', { method: 'POST', body: { a: 1 }, prefer: 'return=minimal' });
    const call = ctx.fetchImpl.calls.find((c) => c.path === '/t');
    assert.equal(call.headers['Content-Type'], 'application/json');
    assert.equal(call.headers.Prefer, 'return=minimal');
    assert.match(call.headers.Authorization, /^Bearer .+\..+\..+$/);
    assert.deepEqual(call.body, { a: 1 });
  });
});

describe('push', () => {
  const emptyPush = { games: [], gameDeletes: [], roster: [], rosterDeletes: [], settings: null };

  test('batches 120 games into 3 requests with on_conflict=id and no user_id', async () => {
    const ctx = await signedIn({ 'POST /games': () => new Response(null, { status: 201 }) });
    const games = Array.from({ length: 120 }, (_, i) => {
      const g = createGame({ name: `G${i}`, players: ['A', 'B'] }, 1_000 + i);
      return { ...g, id: `id-${i}` };
    });
    await ctx.cloud.push({ ...emptyPush, games });
    const posts = ctx.fetchImpl.calls.filter((c) => c.method === 'POST');
    assert.equal(posts.length, 3);
    assert.deepEqual(posts.map((c) => c.body.length), [50, 50, 20]);
    for (const c of posts) {
      assert.equal(c.path, '/games?on_conflict=id');
      assert.equal(c.headers.Prefer, 'resolution=merge-duplicates,return=minimal');
      assert.equal(c.credentials, 'omit');
      assert.doesNotMatch(c.rawBody, /user_id/);
    }
  });

  test('maps every kind of row exactly', async () => {
    const ctx = await signedIn({ 'POST /': () => new Response(null, { status: 201 }) });
    const token = 'T'.repeat(22);
    const game = { ...createGame({ name: 'Catan', players: ['A'] }, 5_000), id: 'g1', shareToken: token };
    const { shareToken, ...gameData } = game;
    const settings = { theme: 'dark', defaultLowWins: true, keepAwake: false, haptics: true, updatedAt: 9_000 };
    await ctx.cloud.push({
      games: [game],
      gameDeletes: [{ id: 'g2', deletedAt: 6_000 }],
      roster: [{ key: 'ann', name: 'Ann', color: 3, updatedAt: 7_000 }],
      rosterDeletes: [{ key: 'x'.repeat(40), deletedAt: 8_000 }],
      settings,
    });
    const posts = ctx.fetchImpl.calls.filter((c) => c.method === 'POST');
    assert.deepEqual(posts.map((c) => c.path), [
      '/games?on_conflict=id',
      '/games?on_conflict=id',
      '/players?on_conflict=user_id,key',
      '/players?on_conflict=user_id,key',
      '/user_settings?on_conflict=user_id',
    ]);
    assert.equal(shareToken, token);
    assert.deepEqual(posts[0].body, [{
      id: 'g1',
      data: gameData,
      updated_at: new Date(5_000).toISOString(),
      deleted_at: null,
      share_token: token,
    }]);
    assert.ok(!('shareToken' in posts[0].body[0].data));
    assert.deepEqual(posts[1].body, [{
      id: 'g2',
      data: null,
      updated_at: new Date(6_000).toISOString(),
      deleted_at: new Date(6_000).toISOString(),
      share_token: null,
    }]);
    assert.deepEqual(posts[2].body, [{
      key: 'ann',
      name: 'Ann',
      color: 3,
      updated_at: new Date(7_000).toISOString(),
      deleted_at: null,
    }]);
    assert.deepEqual(posts[3].body, [{
      key: 'x'.repeat(40),
      name: 'x'.repeat(30),
      color: 0,
      updated_at: new Date(8_000).toISOString(),
      deleted_at: new Date(8_000).toISOString(),
    }]);
    assert.deepEqual(posts[4].body, [{ data: settings, updated_at: new Date(9_000).toISOString() }]);
    for (const c of posts) assert.doesNotMatch(c.rawBody, /user_id/);
  });

  test('an empty push makes no data requests', async () => {
    const ctx = await signedIn();
    const res = await ctx.cloud.push(emptyPush);
    assert.equal(ctx.fetchImpl.calls.length, 0);
    assert.deepEqual(res, { pushed: emptyPush, failed: [] });
  });

  test('returns the pushed and failed shapes for markPushed and markQuarantined', async () => {
    const ctx = await signedIn({ 'POST /': () => new Response(null, { status: 201 }) });
    const game = { ...createGame({ name: 'Catan', players: ['A'] }, 5_000), id: 'g1' };
    const settings = { theme: 'dark', defaultLowWins: true, keepAwake: false, haptics: true, updatedAt: 9_000 };
    const res = await ctx.cloud.push({
      games: [game],
      gameDeletes: [{ id: 'g2', deletedAt: 6_000 }],
      roster: [{ key: 'ann', name: 'Ann', color: 3, updatedAt: 7_000 }],
      rosterDeletes: [{ key: 'bob', deletedAt: 8_000 }],
      settings,
    });
    assert.deepEqual(res, {
      pushed: {
        games: [{ id: 'g1', updatedAt: 5_000 }],
        gameDeletes: [{ id: 'g2', deletedAt: 6_000 }],
        roster: [{ key: 'ann', updatedAt: 7_000 }],
        rosterDeletes: [{ key: 'bob', deletedAt: 8_000 }],
        settings: 9_000,
      },
      failed: [],
    });
  });

  test('a batch rejected with a 4xx is retried row by row: the bad row fails, the rest are pushed', async () => {
    const BAD = 'id-7';
    const ctx = await signedIn({
      'POST /games': (call) => (call.body.some((r) => r.id === BAD)
        ? json({ message: 'check violation' }, 400)
        : new Response(null, { status: 201 })),
    });
    const games = Array.from({ length: 10 }, (_, i) => ({ ...createGame({ name: `G${i}`, players: ['A'] }, 1_000 + i), id: `id-${i}` }));
    const res = await ctx.cloud.push({ ...emptyPush, games });
    assert.deepEqual(res.failed, [{ kind: 'game', id: BAD, time: 1_007 }]);
    assert.equal(res.pushed.games.length, 9);
    assert.ok(!res.pushed.games.some((g) => g.id === BAD));
    const posts = ctx.fetchImpl.calls.filter((c) => c.method === 'POST');
    // one batch of 10, then ten single-row retries
    assert.deepEqual(posts.map((c) => c.body.length), [10, ...Array(10).fill(1)]);
  });

  test('a rejected tombstone and roster row go to failed with their times', async () => {
    const reject = () => json({ message: 'no' }, 422);
    const ctx = await signedIn({ 'POST /games': reject, 'POST /players': reject });
    const res = await ctx.cloud.push({
      ...emptyPush,
      gameDeletes: [{ id: 'g2', deletedAt: 6_000 }],
      roster: [{ key: 'ann', name: 'Ann', color: 3, updatedAt: 7_000 }],
    });
    assert.deepEqual(res.failed, [
      { kind: 'game', id: 'g2', time: 6_000 },
      { kind: 'roster', id: 'ann', time: 7_000 },
    ]);
    assert.equal(res.pushed.gameDeletes.length, 0);
  });

  test('5xx and offline throw instead of falling back per row', async () => {
    const games = [{ ...createGame({ name: 'A', players: ['A'] }, 1_000), id: 'a' }, { ...createGame({ name: 'B', players: ['A'] }, 1_001), id: 'b' }];
    const down = await signedIn({ 'POST /games': () => json({ message: 'boom' }, 503) });
    await rejectsCode(down.cloud.push({ ...emptyPush, games }), 'http-503');
    assert.equal(down.fetchImpl.calls.filter((c) => c.method === 'POST').length, 1);
    const offline = await signedIn({
      'POST /games': () => {
        throw new TypeError('fetch failed');
      },
    });
    await rejectsCode(offline.cloud.push({ ...emptyPush, games }), 'offline');
  });

  test('a 401 during push refreshes and retries; a 401 after the retry throws', async () => {
    let calls = 0;
    const ctx = await signedIn({
      'POST /games': () => {
        calls += 1;
        return calls === 1 ? json({ message: 'expired' }, 401) : new Response(null, { status: 201 });
      },
    });
    const game = { ...createGame({ name: 'A', players: ['A'] }, 1_000), id: 'a' };
    const res = await ctx.cloud.push({ ...emptyPush, games: [game] });
    assert.deepEqual(res.pushed.games, [{ id: 'a', updatedAt: 1_000 }]);
    assert.equal(calls, 2);
    const always = await signedIn({ 'POST /games': () => json({ message: 'no' }, 401) });
    await rejectsCode(always.cloud.push({ ...emptyPush, games: [game] }), 'http-401');
  });
});

describe('pull', () => {
  const NO_CURSORS = { games: null, players: null, settings: null };
  const tables = () => ({
    'GET /games': () => json([
      { id: 'g1', data: { id: 'g1' }, deleted_at: null, share_token: 'S'.repeat(22), server_updated_at: '2026-01-01T00:00:01+00:00' },
      { id: 'g2', data: null, deleted_at: '2026-01-02T00:00:00+00:00', share_token: null, server_updated_at: '2026-01-02T00:00:01+00:00' },
    ]),
    'GET /players': () => json([
      { key: 'ann', name: 'Ann', color: 2, updated_at: '2026-01-01T00:00:00+00:00', deleted_at: null, server_updated_at: '2026-01-01T00:00:02+00:00' },
    ]),
    'GET /user_settings': () => json([{ data: { theme: 'dark' }, server_updated_at: '2026-01-01T00:00:03+00:00' }]),
  });

  test('maps rows to the remote shapes and returns per-table cursors', async () => {
    const ctx = await signedIn(tables());
    const result = await ctx.cloud.pull(NO_CURSORS);
    assert.deepEqual(result, {
      games: [
        { id: 'g1', data: { id: 'g1' }, deletedAt: null, shareToken: 'S'.repeat(22), serverUpdatedAt: '2026-01-01T00:00:01+00:00' },
        { id: 'g2', data: null, deletedAt: Date.parse('2026-01-02T00:00:00+00:00'), shareToken: null, serverUpdatedAt: '2026-01-02T00:00:01+00:00' },
      ],
      roster: [
        { key: 'ann', name: 'Ann', color: 2, updatedAt: Date.parse('2026-01-01T00:00:00+00:00'), deletedAt: null, serverUpdatedAt: '2026-01-01T00:00:02+00:00' },
      ],
      settings: { data: { theme: 'dark' }, serverUpdatedAt: '2026-01-01T00:00:03+00:00' },
      cursors: {
        games: '2026-01-02T00:00:01+00:00',
        players: '2026-01-01T00:00:02+00:00',
        settings: '2026-01-01T00:00:03+00:00',
      },
    });
  });

  test('builds paged queries with a stable order and no filter when the cursor is null', async () => {
    const ctx = await signedIn(tables());
    await ctx.cloud.pull(NO_CURSORS);
    const paths = ctx.fetchImpl.calls.map((c) => c.path).sort();
    assert.deepEqual(paths, [
      '/games?select=id,data,deleted_at,share_token,server_updated_at&order=server_updated_at.asc,id.asc&limit=500&offset=0',
      '/players?select=key,name,color,updated_at,deleted_at,server_updated_at&order=server_updated_at.asc,key.asc&limit=500&offset=0',
      '/user_settings?select=data,server_updated_at&order=server_updated_at.asc&limit=500&offset=0',
    ]);
    for (const c of ctx.fetchImpl.calls) assert.equal(c.credentials, 'omit');
  });

  test('a missing cursors argument behaves like all-null cursors', async () => {
    const ctx = await signedIn(tables());
    const result = await ctx.cloud.pull();
    assert.equal(result.games.length, 2);
    assert.ok(ctx.fetchImpl.calls.every((c) => !c.path.includes('server_updated_at=')));
  });

  test('filters with gte and a 30 second overlap before each table cursor', async () => {
    const ctx = await signedIn(tables());
    await ctx.cloud.pull({
      games: '2026-01-01T00:01:00.000Z',
      players: '2026-03-05T10:00:45.500000+00:00',
      settings: null,
    });
    const by = (table) => ctx.fetchImpl.calls.find((c) => c.path.startsWith(`/${table}?`)).path;
    assert.ok(by('games').includes('&server_updated_at=gte.2026-01-01T00%3A00%3A30.000Z&limit=500&offset=0'), by('games'));
    assert.ok(by('players').includes('&server_updated_at=gte.2026-03-05T10%3A00%3A15.500Z&limit=500&offset=0'), by('players'));
    assert.ok(!by('user_settings').includes('server_updated_at=gte'), by('user_settings'));
  });

  test('pages 1200 rows in 3 requests of 500 and returns the newest cursor', async () => {
    const row = (i) => ({
      id: `g${i}`,
      data: { id: `g${i}` },
      deleted_at: null,
      share_token: null,
      server_updated_at: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
    });
    const offsets = [];
    const ctx = await signedIn({
      ...tables(),
      'GET /games': (call) => {
        const offset = Number(/offset=(\d+)/.exec(call.path)[1]);
        offsets.push(offset);
        const rows = [];
        for (let i = offset; i < Math.min(offset + 500, 1200); i += 1) rows.push(row(i));
        return json(rows);
      },
    });
    const result = await ctx.cloud.pull(NO_CURSORS);
    assert.deepEqual(offsets, [0, 500, 1000]);
    assert.equal(result.games.length, 1200);
    assert.equal(result.games[1199].id, 'g1199');
    assert.equal(result.cursors.games, row(1199).server_updated_at);
  });

  test('an exact multiple of the page size needs one extra empty page', async () => {
    const offsets = [];
    const ctx = await signedIn({
      ...tables(),
      'GET /games': (call) => {
        const offset = Number(/offset=(\d+)/.exec(call.path)[1]);
        offsets.push(offset);
        const rows = offset === 0
          ? Array.from({ length: 500 }, (_, i) => ({ id: `g${i}`, data: { id: `g${i}` }, deleted_at: null, share_token: null, server_updated_at: '2026-01-01T00:00:01+00:00' }))
          : [];
        return json(rows);
      },
    });
    const result = await ctx.cloud.pull(NO_CURSORS);
    assert.deepEqual(offsets, [0, 500]);
    assert.equal(result.games.length, 500);
  });

  test('empty tables give empty results, null settings and the input cursors', async () => {
    const ctx = await signedIn({
      'GET /games': () => json([]),
      'GET /players': () => json([]),
      'GET /user_settings': () => json([]),
    });
    assert.deepEqual(await ctx.cloud.pull(NO_CURSORS), { games: [], roster: [], settings: null, cursors: NO_CURSORS });
    const given = { games: '2026-01-01T00:00:00Z', players: '2026-01-02T00:00:00Z', settings: null };
    assert.deepEqual((await ctx.cloud.pull(given)).cursors, given);
  });

  test('the cursor never moves backwards when the overlap re-delivers older rows', async () => {
    const ctx = await signedIn({
      ...tables(),
      'GET /games': () => json([
        { id: 'g1', data: { id: 'g1' }, deleted_at: null, share_token: null, server_updated_at: '2026-01-01T00:00:10Z' },
      ]),
    });
    const result = await ctx.cloud.pull({ games: '2026-01-01T00:00:20Z', players: null, settings: null });
    assert.equal(result.cursors.games, '2026-01-01T00:00:20Z');
  });

  test('offline surfaces as CloudError offline', async () => {
    const ctx = await signedIn({
      'GET /games': () => {
        throw new TypeError('fetch failed');
      },
      'GET /players': () => json([]),
      'GET /user_settings': () => json([]),
    });
    await rejectsCode(ctx.cloud.pull(NO_CURSORS), 'offline');
  });
});

describe('getShared', () => {
  function sharedCtx(gameBody) {
    const clock = { t: 1_700_000_000_000 };
    const anonJwt = makeJwt(clock.t / 1000 + 3600, { role: 'anonymous' });
    let anonCalls = 0;
    const ctx = build({
      clock,
      handler: sessionHandler(clock, {
        'GET /token/anonymous': () => {
          anonCalls += 1;
          return json({ token: anonJwt, expires_at: new Date(clock.t + 3600_000).toISOString() });
        },
        'POST /rpc/get_shared_game': () => json(gameBody),
      }),
    });
    return { ...ctx, anonJwt, anonCalls: () => anonCalls };
  }

  test('uses the anonymous JWT, caches it, and sanitizes the game', async () => {
    const good = { ...createGame({ name: 'Shared', players: ['A', 'B'] }, 100), id: 'g1', junk: 'drop me' };
    const ctx = sharedCtx({ game: good, updatedAt: '2026-01-01T00:00:00+00:00' });
    const token = 'A'.repeat(22);
    const res = await ctx.cloud.getShared(token);
    assert.equal(res.updatedAt, '2026-01-01T00:00:00+00:00');
    assert.equal(res.game.id, 'g1');
    assert.ok(!('junk' in res.game));
    await ctx.cloud.getShared(token);
    assert.equal(ctx.anonCalls(), 1);
    const rpc = ctx.fetchImpl.calls.filter((c) => c.path === '/rpc/get_shared_game');
    assert.equal(rpc.length, 2);
    for (const c of rpc) {
      assert.equal(c.headers.Authorization, `Bearer ${ctx.anonJwt}`);
      assert.deepEqual(c.body, { p_token: token });
      assert.equal(c.method, 'POST');
    }
    assert.ok(!ctx.fetchImpl.calls.some((c) => c.path === '/token'), 'no user session needed');
  });

  test('refreshes the anonymous JWT 5 minutes before expires_at', async () => {
    const good = { ...createGame({ name: 'Shared', players: ['A'] }, 100), id: 'g1' };
    const ctx = sharedCtx({ game: good, updatedAt: 'x' });
    await ctx.cloud.getShared('A'.repeat(22));
    ctx.clock.t += 3600_000 - 6 * 60_000;
    await ctx.cloud.getShared('A'.repeat(22));
    assert.equal(ctx.anonCalls(), 1);
    ctx.clock.t += 2 * 60_000;
    await ctx.cloud.getShared('A'.repeat(22));
    assert.equal(ctx.anonCalls(), 2);
  });

  test('returns null for no match and for an invalid game', async () => {
    assert.equal(await sharedCtx(null).cloud.getShared('A'.repeat(22)), null);
    const bad = sharedCtx({ game: { id: 5 }, updatedAt: 'x' });
    assert.equal(await bad.cloud.getShared('A'.repeat(22)), null);
  });

  test('offline while fetching the anonymous JWT gives offline', async () => {
    const { cloud } = build({
      handler: () => {
        throw new TypeError('fetch failed');
      },
    });
    await rejectsCode(cloud.getShared('A'.repeat(22)), 'offline');
  });
});
