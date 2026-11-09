import { sanitizeRemoteGame } from './model.js';

const HAD_SESSION_KEY = 'tabletop-scorecard:had-session';
const VERIFIER_PARAM = 'neon_auth_session_verifier';
const JWT_MIN_REMAINING_MS = 60 * 1000;
const ANON_EARLY_MS = 5 * 60 * 1000;
const FALLBACK_TTL_MS = 15 * 60 * 1000;
const BATCH_SIZE = 50;
const PAGE_SIZE = 500;
const PULL_OVERLAP_MS = 30 * 1000;
const NO_ROW_RETRY = new Set(['http-401', 'http-408', 'http-429']);

export class CloudError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = 'CloudError';
    this.code = code;
  }
}

const FRIENDLY = {
  'cookies-blocked': 'This browser blocks the cookie our sign-in needs.',
  'signed-out': 'You are signed out.',
  offline: 'You appear to be offline. Check your connection and try again.',
  'invalid-credentials': 'Email or password is incorrect.',
  'user-exists': 'An account with this email already exists.',
  'weak-password': 'Choose a stronger password (at least 8 characters).',
  unknown: 'Something went wrong. Please try again.',
};

const friendly = (code) => FRIENDLY[code] ?? FRIENDLY.unknown;

function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function decodeExpMs(token) {
  try {
    const part = String(token).split('.')[1];
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const json = new TextDecoder().decode(Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)));
    const exp = JSON.parse(json).exp;
    return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}

function parseExpiresAt(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value === 'string') {
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

const isoOf = (ms) => new Date(ms).toISOString();
const msOf = (iso) => (iso == null ? null : Date.parse(iso));

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function mapAuthError(status, body) {
  const code = String(body?.code ?? '').toUpperCase();
  if (code.includes('USER_ALREADY_EXISTS')) return new CloudError('user-exists', FRIENDLY['user-exists']);
  if (code === 'INVALID_EMAIL_OR_PASSWORD' || code === 'INVALID_PASSWORD' || code === 'INVALID_EMAIL') {
    return new CloudError('invalid-credentials', FRIENDLY['invalid-credentials']);
  }
  if (code.includes('PASSWORD_TOO_SHORT') || code.includes('PASSWORD_TOO_LONG') || code.includes('WEAK_PASSWORD')) {
    return new CloudError('weak-password', FRIENDLY['weak-password']);
  }
  return new CloudError(`http-${status}`, FRIENDLY.unknown);
}

export function createCloud({
  authUrl,
  dataUrl,
  appUrl = '',
  fetchImpl = globalThis.fetch?.bind(globalThis),
  now = () => Date.now(),
  location: loc = globalThis.location,
  history: hist = globalThis.history,
  storage = defaultStorage(),
} = {}) {
  let session = { status: 'unknown', user: null };
  let jwt = null;
  let jwtExpMs = 0;
  let jwtInflight = null;
  let jwtGen = 0;
  let initInflight = null;
  let anon = null;
  let anonInflight = null;
  const listeners = new Set();

  function flagGet() {
    try {
      return storage?.getItem(HAD_SESSION_KEY) === '1';
    } catch {
      return false;
    }
  }

  function flagSet(on) {
    try {
      if (on) storage?.setItem(HAD_SESSION_KEY, '1');
      else storage?.removeItem(HAD_SESSION_KEY);
    } catch {
      // best effort
    }
  }

  const getSession = () => ({ status: session.status, user: session.user });

  function setSession(status, user = null) {
    const same = session.status === status
      && session.user?.id === user?.id
      && session.user?.email === user?.email
      && session.user?.name === user?.name;
    if (same) return;
    session = { status, user };
    for (const fn of [...listeners]) {
      try {
        fn(getSession());
      } catch (err) {
        console.error(err);
      }
    }
  }

  function onChange(fn) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }

  async function call(url, init) {
    try {
      return await fetchImpl(url, init);
    } catch (err) {
      if (err instanceof TypeError) throw new CloudError('offline', friendly('offline'));
      if (err instanceof CloudError) throw err;
      throw new CloudError('unknown', friendly('unknown'));
    }
  }

  async function readJson(res) {
    let text = '';
    try {
      text = await res.text();
    } catch {
      throw new CloudError('unknown', friendly('unknown'));
    }
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new CloudError('unknown', friendly('unknown'));
    }
  }

  function authFetch(path, { method = 'GET', body } = {}) {
    const init = { method, credentials: 'include', headers: { Accept: 'application/json' } };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    return call(`${authUrl}${path}`, init);
  }

  function clearJwt() {
    jwt = null;
    jwtExpMs = 0;
    jwtInflight = null;
    jwtGen += 1;
  }

  function storeJwt(token) {
    jwt = token;
    jwtExpMs = decodeExpMs(token) ?? now() + FALLBACK_TTL_MS;
  }

  // Fetches /token with no session side effects. Throws signed-out on 401.
  async function requestToken() {
    const gen = jwtGen;
    const res = await authFetch('/token');
    if (res.status === 401) throw new CloudError('signed-out', friendly('signed-out'));
    if (!res.ok) throw new CloudError(`http-${res.status}`, friendly('unknown'));
    const body = await readJson(res);
    if (typeof body?.token !== 'string' || !body.token) throw new CloudError('unknown', friendly('unknown'));
    if (gen !== jwtGen) {
      // The session changed (sign-out or invalidation) while this request was in flight.
      const stale = new CloudError('signed-out', friendly('signed-out'));
      stale.stale = true;
      throw stale;
    }
    storeJwt(body.token);
    return body.token;
  }

  async function refreshJwt() {
    try {
      return await requestToken();
    } catch (err) {
      if (err instanceof CloudError && err.code === 'signed-out' && !err.stale) {
        clearJwt();
        flagSet(false);
        setSession('signed-out');
      }
      throw err;
    }
  }

  function getJwt() {
    if (jwt && jwtExpMs - now() > JWT_MIN_REMAINING_MS) return Promise.resolve(jwt);
    if (!jwtInflight) {
      const p = refreshJwt().finally(() => {
        if (jwtInflight === p) jwtInflight = null;
      });
      jwtInflight = p;
    }
    return jwtInflight;
  }

  async function fetchUser(query = '') {
    const res = await authFetch(`/get-session${query}`);
    if (!res.ok) throw new CloudError(`http-${res.status}`, friendly('unknown'));
    const body = await readJson(res);
    return { res, body };
  }

  function applyUser(body) {
    const user = body?.user;
    if (user && typeof user.id === 'string') {
      setSession('signed-in', { id: user.id, email: user.email ?? '', name: user.name ?? '' });
      flagSet(true);
      return true;
    }
    return false;
  }

  function signedOutLocally() {
    clearJwt();
    flagSet(false);
    setSession('signed-out');
  }

  function stripVerifier() {
    try {
      const params = new URLSearchParams(loc.search);
      params.delete(VERIFIER_PARAM);
      const search = params.toString();
      const url = `${loc.pathname ?? ''}${search ? `?${search}` : ''}${loc.hash ?? ''}`;
      hist.replaceState(hist.state ?? null, '', url);
    } catch {
      // best effort
    }
  }

  async function runInit() {
    const verifier = new URLSearchParams(loc?.search ?? '').get(VERIFIER_PARAM);
    try {
      if (verifier) {
        stripVerifier();
        const { res, body } = await fetchUser(`?${VERIFIER_PARAM}=${encodeURIComponent(verifier)}`);
        const header = res.headers?.get?.('set-auth-jwt');
        if (header) storeJwt(header);
        else await refreshJwt();
        if (!applyUser(body)) {
          const again = await fetchUser();
          if (!applyUser(again.body)) signedOutLocally();
        }
      } else if (flagGet()) {
        await refreshJwt();
        const { body } = await fetchUser();
        if (!applyUser(body)) signedOutLocally();
      } else {
        setSession('signed-out');
      }
    } catch (err) {
      if (err instanceof CloudError && err.code === 'signed-out') return;
      // Offline or server trouble: keep the had-session flag so a later retry can recover.
      clearJwt();
      const transient = err instanceof CloudError
        && (err.code === 'offline' || err.code === 'unknown' || /^http-5\d\d$/.test(err.code));
      setSession(transient && flagGet() ? 'unknown' : 'signed-out');
    }
  }

  function init() {
    if (!initInflight) {
      const p = runInit().finally(() => {
        if (initInflight === p) initInflight = null;
      });
      initInflight = p;
    }
    return initInflight;
  }

  // Re-attempts init after a transient failure; a no-op once the status is known.
  function retryInit() {
    if (session.status !== 'unknown') return Promise.resolve();
    return init();
  }

  async function authenticate(path, body) {
    const res = await authFetch(path, { method: 'POST', body });
    const data = await readJson(res).catch(() => null);
    if (!res.ok) throw mapAuthError(res.status, data);
    try {
      await requestToken();
    } catch (err) {
      if (err instanceof CloudError && err.code === 'signed-out') {
        clearJwt();
        setSession('unavailable');
        throw new CloudError('cookies-blocked', friendly('cookies-blocked'));
      }
      throw err;
    }
    if (!applyUser(data)) {
      const again = await fetchUser();
      if (!applyUser(again.body)) throw new CloudError('unknown', friendly('unknown'));
    }
  }

  const signUp = ({ email, password, name }) => authenticate('/sign-up/email', { email, password, name });
  const signIn = ({ email, password }) => authenticate('/sign-in/email', { email, password });

  async function signInWithGoogle() {
    const res = await authFetch('/sign-in/social', {
      method: 'POST',
      body: { provider: 'google', callbackURL: appUrl, disableRedirect: true },
    });
    const data = await readJson(res).catch(() => null);
    if (!res.ok) throw mapAuthError(res.status, data);
    if (typeof data?.url !== 'string' || !data.url) throw new CloudError('unknown', friendly('unknown'));
    let target;
    try {
      target = new URL(data.url);
    } catch {
      throw new CloudError('unknown', friendly('unknown'));
    }
    if (target.protocol !== 'https:') throw new CloudError('unknown', friendly('unknown'));
    loc.assign(target.href);
  }

  async function signOut() {
    try {
      await authFetch('/sign-out', { method: 'POST', body: {} });
    } catch {
      // ignored: local sign-out always succeeds
    }
    signedOutLocally();
  }

  async function fetchAnonymous() {
    const res = await call(`${authUrl}/token/anonymous`, {
      method: 'GET',
      credentials: 'omit',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new CloudError(`http-${res.status}`, friendly('unknown'));
    const body = await readJson(res);
    if (typeof body?.token !== 'string' || !body.token) throw new CloudError('unknown', friendly('unknown'));
    const exp = parseExpiresAt(body.expires_at) ?? decodeExpMs(body.token) ?? now() + FALLBACK_TTL_MS;
    anon = { token: body.token, validUntil: exp - ANON_EARLY_MS };
    return anon.token;
  }

  function getAnonymousJwt() {
    if (anon && anon.validUntil > now()) return Promise.resolve(anon.token);
    if (!anonInflight) {
      anonInflight = fetchAnonymous().finally(() => {
        anonInflight = null;
      });
    }
    return anonInflight;
  }

  async function rest(path, { method = 'GET', body, prefer, anonymous = false } = {}) {
    for (let attempt = 0; ; attempt += 1) {
      const token = anonymous ? await getAnonymousJwt() : await getJwt();
      const headers = { Accept: 'application/json', Authorization: `Bearer ${token}` };
      const init = { method, credentials: 'omit', headers };
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
      if (prefer) headers.Prefer = prefer;
      const res = await call(`${dataUrl}/${path}`, init);
      if (res.status === 401 && !anonymous && attempt === 0) {
        // The user JWT was rejected: drop it, fetch a fresh one, and retry once.
        clearJwt();
        continue;
      }
      if (!res.ok) throw new CloudError(`http-${res.status}`, friendly('unknown'));
      if (res.status === 201 || res.status === 204) return null;
      return readJson(res);
    }
  }

  async function pageAll(table, select, order, cursor) {
    const cursorMs = msOf(cursor);
    const filter = cursorMs != null && !Number.isNaN(cursorMs)
      ? `&server_updated_at=gte.${encodeURIComponent(isoOf(cursorMs - PULL_OVERLAP_MS))}`
      : '';
    const rows = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const page = (await rest(
        `${table}?select=${select}&order=${order}${filter}&limit=${PAGE_SIZE}&offset=${offset}`
      )) ?? [];
      rows.push(...page);
      if (page.length < PAGE_SIZE) return rows;
    }
  }

  // The cursor is the newest server_updated_at received, or the input when nothing arrived.
  function maxCursor(rows, input) {
    let best = input ?? null;
    let bestMs = msOf(best);
    for (const r of rows) {
      const ms = msOf(r.server_updated_at);
      if (ms == null || Number.isNaN(ms)) continue;
      if (bestMs == null || Number.isNaN(bestMs) || ms > bestMs) {
        best = r.server_updated_at;
        bestMs = ms;
      }
    }
    return best;
  }

  async function pull(cursors = null) {
    const c = cursors ?? {};
    const [games, players, settings] = await Promise.all([
      pageAll('games', 'id,data,deleted_at,share_token,server_updated_at', 'server_updated_at.asc,id.asc', c.games),
      pageAll('players', 'key,name,color,updated_at,deleted_at,server_updated_at', 'server_updated_at.asc,key.asc', c.players),
      pageAll('user_settings', 'data,server_updated_at', 'server_updated_at.asc', c.settings),
    ]);
    const settingsRow = settings.length ? settings[settings.length - 1] : null;
    return {
      games: games.map((r) => ({
        id: r.id,
        data: r.data,
        deletedAt: msOf(r.deleted_at),
        shareToken: r.share_token ?? null,
        serverUpdatedAt: r.server_updated_at,
      })),
      roster: players.map((r) => ({
        key: r.key,
        name: r.name,
        color: r.color,
        updatedAt: Date.parse(r.updated_at),
        deletedAt: msOf(r.deleted_at),
        serverUpdatedAt: r.server_updated_at,
      })),
      settings: settingsRow ? { data: settingsRow.data, serverUpdatedAt: settingsRow.server_updated_at } : null,
      cursors: {
        games: maxCursor(games, c.games),
        players: maxCursor(players, c.players),
        settings: maxCursor(settings, c.settings),
      },
    };
  }

  const isRowReject = (err) => err instanceof CloudError
    && /^http-4\d\d$/.test(err.code)
    && !NO_ROW_RETRY.has(err.code);

  // Posts items in batches. A batch the server rejects with a 4xx is retried row by row so one
  // bad row cannot block the others. Offline, 5xx and auth failures throw.
  async function upsert(table, onConflict, items, toRow, onPushed, onFailed) {
    const post = (rows) => rest(`${table}?on_conflict=${onConflict}`, {
      method: 'POST',
      body: rows,
      prefer: 'resolution=merge-duplicates,return=minimal',
    });
    for (const batch of chunk(items, BATCH_SIZE)) {
      try {
        await post(batch.map(toRow));
        batch.forEach(onPushed);
      } catch (err) {
        if (!isRowReject(err)) throw err;
        if (batch.length === 1) {
          onFailed(batch[0]);
          continue;
        }
        for (const item of batch) {
          try {
            await post([toRow(item)]);
            onPushed(item);
          } catch (rowErr) {
            if (!isRowReject(rowErr)) throw rowErr;
            onFailed(item);
          }
        }
      }
    }
  }

  async function push(p) {
    const pushed = { games: [], gameDeletes: [], roster: [], rosterDeletes: [], settings: null };
    const failed = [];

    await upsert('games', 'id', p.games ?? [], ({ shareToken, ...data }) => ({
      id: data.id,
      data,
      updated_at: isoOf(data.updatedAt),
      deleted_at: null,
      share_token: shareToken ?? null,
    }), (g) => pushed.games.push({ id: g.id, updatedAt: g.updatedAt }),
    (g) => failed.push({ kind: 'game', id: g.id, time: g.updatedAt }));

    await upsert('games', 'id', p.gameDeletes ?? [], (d) => ({
      id: d.id,
      data: null,
      updated_at: isoOf(d.deletedAt),
      deleted_at: isoOf(d.deletedAt),
      share_token: null,
    }), (d) => pushed.gameDeletes.push({ id: d.id, deletedAt: d.deletedAt }),
    (d) => failed.push({ kind: 'game', id: d.id, time: d.deletedAt }));

    await upsert('players', 'user_id,key', p.roster ?? [], (e) => ({
      key: e.key,
      name: e.name,
      color: e.color,
      updated_at: isoOf(e.updatedAt),
      deleted_at: null,
    }), (e) => pushed.roster.push({ key: e.key, updatedAt: e.updatedAt }),
    (e) => failed.push({ kind: 'roster', id: e.key, time: e.updatedAt }));

    await upsert('players', 'user_id,key', p.rosterDeletes ?? [], (d) => ({
      key: d.key,
      name: [...d.key].slice(0, 30).join(''),
      color: 0,
      updated_at: isoOf(d.deletedAt),
      deleted_at: isoOf(d.deletedAt),
    }), (d) => pushed.rosterDeletes.push({ key: d.key, deletedAt: d.deletedAt }),
    (d) => failed.push({ kind: 'roster', id: d.key, time: d.deletedAt }));

    if (p.settings) {
      await rest('user_settings?on_conflict=user_id', {
        method: 'POST',
        body: [{ data: p.settings, updated_at: isoOf(p.settings.updatedAt) }],
        prefer: 'resolution=merge-duplicates,return=minimal',
      });
      pushed.settings = p.settings.updatedAt;
    }
    return { pushed, failed };
  }

  async function getShared(token) {
    const res = await rest('rpc/get_shared_game', { method: 'POST', body: { p_token: token }, anonymous: true });
    if (!res || res.game == null) return null;
    const game = sanitizeRemoteGame(res.game);
    if (!game) return null;
    return { game, updatedAt: res.updatedAt };
  }

  return {
    getSession,
    onChange,
    init,
    retryInit,
    signUp,
    signIn,
    signInWithGoogle,
    signOut,
    getJwt,
    rest,
    pull,
    push,
    getShared,
  };
}
