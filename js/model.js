export const MAX_PLAYERS = 12;
export const MAX_ABS_SCORE = 9999999;

const DEFAULT_NAME = 'Untitled game';
const COLOR_COUNT = 8;

export function uid() {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// Edits must always move updatedAt forward, even when the clock is behind the stored value.
const stamp = (game, now) => Math.max(now, game.updatedAt + 1);

export const DEFAULT_SETTINGS = Object.freeze({
  theme: 'system',
  defaultLowWins: false,
  keepAwake: true,
  haptics: true,
  updatedAt: 0,
});

const THEMES = ['system', 'light', 'dark'];
const BOOL_SETTINGS = ['defaultLowWins', 'keepAwake', 'haptics'];
const MAX_ROSTER_NAME = 30;
const SHARE_TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;
const SYNC_CURSOR_TABLES = ['games', 'players', 'settings'];

export function emptySync() {
  return {
    cursors: { games: null, players: null, settings: null },
    serverVersions: { games: {}, roster: {}, settings: null },
    quarantine: { games: {}, roster: {} },
  };
}

export function emptyState() {
  return {
    version: 2,
    ownerId: null,
    games: [],
    tombstones: { games: {}, roster: {} },
    roster: [],
    settings: { ...DEFAULT_SETTINGS },
    sync: emptySync(),
  };
}

function cleanName(name) {
  return String(name ?? '').trim();
}

function newRound() {
  return { id: uid(), scores: {} };
}

export function createGame({ name, players, lowWins = false } = {}, now = Date.now()) {
  const names = (players ?? []).map(cleanName).filter(Boolean).slice(0, MAX_PLAYERS);
  if (names.length === 0) throw new Error('At least one player is required');
  return {
    id: uid(),
    name: cleanName(name) || DEFAULT_NAME,
    createdAt: now,
    updatedAt: now,
    lowWins: Boolean(lowWins),
    players: names.map((playerName, index) => ({
      id: uid(),
      name: playerName,
      color: index % COLOR_COUNT,
    })),
    rounds: [newRound()],
    finishedAt: null,
    shareToken: null,
  };
}

export function renameGame(game, name, now = Date.now()) {
  const trimmed = cleanName(name);
  if (!trimmed) return game;
  return { ...game, name: trimmed, updatedAt: stamp(game, now) };
}

export function addRound(game, now = Date.now()) {
  if (game.finishedAt != null) return game;
  return { ...game, rounds: [...game.rounds, newRound()], updatedAt: stamp(game, now) };
}

export function removeRound(game, roundId, now = Date.now()) {
  if (game.finishedAt != null) return game;
  if (!game.rounds.some((round) => round.id === roundId)) return game;
  return {
    ...game,
    rounds: game.rounds.filter((round) => round.id !== roundId),
    updatedAt: stamp(game, now),
  };
}

export function setScore(game, roundId, playerId, value, now = Date.now()) {
  if (value !== null && (typeof value !== 'number' || !Number.isInteger(value) || Math.abs(value) > MAX_ABS_SCORE)) {
    throw new RangeError(`Score must be an integer with absolute value <= ${MAX_ABS_SCORE}`);
  }
  if (game.finishedAt != null) return game;
  const round = game.rounds.find((r) => r.id === roundId);
  if (!round || !game.players.some((player) => player.id === playerId)) return game;
  const scores = { ...round.scores };
  if (value === null) {
    delete scores[playerId];
  } else {
    scores[playerId] = value;
  }
  return {
    ...game,
    rounds: game.rounds.map((r) => (r.id === roundId ? { ...r, scores } : r)),
    updatedAt: stamp(game, now),
  };
}

export function totals(game) {
  const result = {};
  for (const player of game.players) result[player.id] = 0;
  for (const round of game.rounds) {
    for (const [playerId, value] of Object.entries(round.scores)) {
      if (Object.hasOwn(result, playerId) && Number.isFinite(value)) result[playerId] += value;
    }
  }
  return result;
}

export function standings(game) {
  const sums = totals(game);
  const ordered = game.players
    .map((player, index) => ({ player, total: sums[player.id], index }))
    .sort((a, b) => (game.lowWins ? a.total - b.total : b.total - a.total) || a.index - b.index);
  let rank = 0;
  return ordered.map((entry, i) => {
    if (i === 0 || entry.total !== ordered[i - 1].total) rank = i + 1;
    return { player: entry.player, total: entry.total, rank };
  });
}

export function rematch(game, now = Date.now()) {
  return {
    id: uid(),
    name: game.name,
    createdAt: now,
    updatedAt: now,
    lowWins: game.lowWins,
    players: game.players.map((player) => ({ id: uid(), name: player.name, color: player.color })),
    rounds: [newRound()],
    finishedAt: null,
    shareToken: null,
  };
}

export function finishGame(game, now = Date.now()) {
  if (game.finishedAt != null) return game;
  const t = stamp(game, now);
  return { ...game, finishedAt: t, updatedAt: t };
}

export function reopenGame(game, now = Date.now()) {
  if (game.finishedAt == null) return game;
  return { ...game, finishedAt: null, updatedAt: stamp(game, now) };
}

export function setShareToken(game, token, now = Date.now()) {
  const next = token ?? null;
  if (game.shareToken === next) return game;
  return { ...game, shareToken: next, updatedAt: stamp(game, now) };
}

export function newShareToken() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function getGame(state, id) {
  return state.games.find((game) => game.id === id);
}

export function upsertGame(state, game) {
  const index = state.games.findIndex((g) => g.id === game.id);
  const games = index === -1
    ? [...state.games, game]
    : state.games.map((g, i) => (i === index ? game : g));
  games.sort((a, b) => b.updatedAt - a.updatedAt);
  const next = { ...state, games };
  if (state.tombstones && Object.hasOwn(state.tombstones.games, game.id)) {
    const gamesTomb = { ...state.tombstones.games };
    delete gamesTomb[game.id];
    next.tombstones = { ...state.tombstones, games: gamesTomb };
  }
  return next;
}

export function deleteGame(state, id, now = Date.now()) {
  const target = state.games.find((game) => game.id === id);
  if (!target) return state;
  return {
    ...state,
    games: state.games.filter((game) => game.id !== id),
    tombstones: { ...state.tombstones, games: { ...state.tombstones.games, [id]: stamp(target, now) } },
  };
}

export function rosterKey(name) {
  return String(name).trim().toLowerCase();
}

function sortRoster(roster) {
  return roster.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

export function addRosterNames(state, names, now = Date.now()) {
  let roster = state.roster;
  let rosterTomb = state.tombstones.roster;
  let changed = false;
  for (const raw of names ?? []) {
    const name = [...cleanName(raw)].slice(0, MAX_ROSTER_NAME).join('').trim();
    if (!name) continue;
    const key = rosterKey(name);
    if (roster.some((entry) => entry.key === key)) continue;
    const updatedAt = Math.max(now, (rosterTomb[key] ?? -Infinity) + 1);
    roster = [...roster, { key, name, color: roster.length % COLOR_COUNT, updatedAt }];
    if (Object.hasOwn(rosterTomb, key)) {
      rosterTomb = { ...rosterTomb };
      delete rosterTomb[key];
    }
    changed = true;
  }
  if (!changed) return state;
  return {
    ...state,
    roster: sortRoster([...roster]),
    tombstones: { ...state.tombstones, roster: rosterTomb },
  };
}

export function removeRosterEntry(state, key, now = Date.now()) {
  const target = state.roster.find((entry) => entry.key === key);
  if (!target) return state;
  return {
    ...state,
    roster: state.roster.filter((entry) => entry.key !== key),
    tombstones: { ...state.tombstones, roster: { ...state.tombstones.roster, [key]: Math.max(now, target.updatedAt + 1) } },
  };
}

export function updateSettings(state, patch, now = Date.now()) {
  const next = { ...state.settings };
  let changed = false;
  if (isObject(patch)) {
    if (THEMES.includes(patch.theme) && patch.theme !== next.theme) {
      next.theme = patch.theme;
      changed = true;
    }
    for (const key of BOOL_SETTINGS) {
      if (typeof patch[key] === 'boolean' && patch[key] !== next[key]) {
        next[key] = patch[key];
        changed = true;
      }
    }
  }
  if (!changed) return state;
  next.updatedAt = Math.max(now, state.settings.updatedAt + 1);
  return { ...state, settings: next };
}

export function setOwner(state, ownerId) {
  if (state.ownerId === ownerId) return state;
  return { ...state, ownerId };
}

export function setSyncMarks(state, { cursors } = {}) {
  if (!cursors) return state;
  const merged = { ...state.sync.cursors };
  let changed = false;
  for (const table of SYNC_CURSOR_TABLES) {
    if (cursors[table] !== undefined && cursors[table] !== merged[table]) {
      merged[table] = cursors[table];
      changed = true;
    }
  }
  if (!changed) return state;
  return { ...state, sync: { ...state.sync, cursors: merged } };
}

export function markPushed(state, pushed = {}) {
  const versions = { games: { ...state.sync.serverVersions.games }, roster: { ...state.sync.serverVersions.roster } };
  let settingsVersion = state.sync.serverVersions.settings;
  const quarantine = { games: { ...state.sync.quarantine.games }, roster: { ...state.sync.quarantine.roster } };
  let changed = false;
  const mark = (table, id, time) => {
    if (versions[table][id] !== time) {
      versions[table][id] = time;
      changed = true;
    }
    if (Object.hasOwn(quarantine[table], id)) {
      delete quarantine[table][id];
      changed = true;
    }
  };
  for (const g of pushed.games ?? []) mark('games', g.id, g.updatedAt);
  for (const g of pushed.gameDeletes ?? []) mark('games', g.id, g.deletedAt);
  for (const r of pushed.roster ?? []) mark('roster', r.key, r.updatedAt);
  for (const r of pushed.rosterDeletes ?? []) mark('roster', r.key, r.deletedAt);
  if (typeof pushed.settings === 'number' && pushed.settings !== settingsVersion) {
    settingsVersion = pushed.settings;
    changed = true;
  }
  if (!changed) return state;
  return {
    ...state,
    sync: { ...state.sync, serverVersions: { ...versions, settings: settingsVersion }, quarantine },
  };
}

export function markQuarantined(state, failed = []) {
  const quarantine = { games: { ...state.sync.quarantine.games }, roster: { ...state.sync.quarantine.roster } };
  let changed = false;
  for (const item of failed ?? []) {
    const table = item?.kind === 'game' ? 'games' : item?.kind === 'roster' ? 'roster' : null;
    if (!table || typeof item.id !== 'string' || !isFiniteNumber(item.time)) continue;
    if (quarantine[table][item.id] !== item.time) {
      quarantine[table][item.id] = item.time;
      changed = true;
    }
  }
  if (!changed) return state;
  return { ...state, sync: { ...state.sync, quarantine } };
}

export function resetForOwner(state, ownerId, { keepData = false } = {}) {
  if (!keepData) return { ...emptyState(), settings: state.settings, ownerId };
  const prev = state.ownerId;
  let games = state.games;
  // Rows from another account must not be reused: their ids would collide under RLS.
  if (typeof prev === 'string' && prev !== ownerId) {
    games = games.map((game) => ({ ...game, id: uid(), shareToken: null }));
  }
  return {
    ...state,
    ownerId,
    games,
    tombstones: { games: {}, roster: {} },
    sync: emptySync(),
  };
}

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const isValidScore = (value) => Number.isInteger(value) && Math.abs(value) <= MAX_ABS_SCORE;
const isColor = (value) => Number.isInteger(value) && value >= 0 && value < COLOR_COUNT;

function sanitizePlayers(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const players = [];
  for (const player of raw) {
    if (!isObject(player) || typeof player.id !== 'string' || typeof player.name !== 'string' || !isColor(player.color)) {
      return null;
    }
    players.push({ id: player.id, name: player.name, color: player.color });
  }
  return players;
}

function sanitizeGame(raw) {
  if (!isObject(raw) || typeof raw.id !== 'string' || typeof raw.name !== 'string') return null;
  if (!isFiniteNumber(raw.createdAt) || !isFiniteNumber(raw.updatedAt)) return null;
  const players = sanitizePlayers(raw.players);
  if (!players || !Array.isArray(raw.rounds)) return null;
  const playerIds = new Set(players.map((player) => player.id));
  if (playerIds.size !== players.length) return null;
  const rounds = [];
  for (const round of raw.rounds) {
    if (!isObject(round) || typeof round.id !== 'string' || !isObject(round.scores)) return null;
    const scores = {};
    for (const [playerId, value] of Object.entries(round.scores)) {
      if (playerIds.has(playerId) && isValidScore(value)) scores[playerId] = value;
    }
    rounds.push({ id: round.id, scores });
  }
  if (new Set(rounds.map((round) => round.id)).size !== rounds.length) return null;
  return {
    id: raw.id,
    name: raw.name,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    lowWins: Boolean(raw.lowWins),
    players,
    rounds,
    finishedAt: isFiniteNumber(raw.finishedAt) ? raw.finishedAt : null,
    shareToken: typeof raw.shareToken === 'string' && SHARE_TOKEN_RE.test(raw.shareToken) ? raw.shareToken : null,
  };
}

export function sanitizeRemoteGame(raw) {
  return sanitizeGame(raw);
}

export function sanitizeSettings(raw) {
  const out = { ...DEFAULT_SETTINGS };
  if (!isObject(raw)) return out;
  if (THEMES.includes(raw.theme)) out.theme = raw.theme;
  for (const key of BOOL_SETTINGS) if (typeof raw[key] === 'boolean') out[key] = raw[key];
  if (isFiniteNumber(raw.updatedAt)) out.updatedAt = raw.updatedAt;
  return out;
}

export function sanitizeRosterEntry(raw) {
  if (!isObject(raw) || typeof raw.name !== 'string' || typeof raw.key !== 'string') return null;
  if ([...raw.name].length < 1 || [...raw.name].length > MAX_ROSTER_NAME || raw.key !== rosterKey(raw.name)) return null;
  if (!isColor(raw.color) || !isFiniteNumber(raw.updatedAt)) return null;
  return { key: raw.key, name: raw.name, color: raw.color, updatedAt: raw.updatedAt };
}

function sanitizeTombstones(raw) {
  const out = {};
  if (isObject(raw)) {
    for (const [k, v] of Object.entries(raw)) if (isFiniteNumber(v)) out[k] = v;
  }
  return out;
}

function sanitizeSync(raw) {
  const out = emptySync();
  if (!isObject(raw)) return out;
  if (isObject(raw.cursors)) {
    for (const table of SYNC_CURSOR_TABLES) {
      if (typeof raw.cursors[table] === 'string') out.cursors[table] = raw.cursors[table];
    }
  }
  if (isObject(raw.serverVersions)) {
    out.serverVersions.games = sanitizeTombstones(raw.serverVersions.games);
    out.serverVersions.roster = sanitizeTombstones(raw.serverVersions.roster);
    if (isFiniteNumber(raw.serverVersions.settings)) out.serverVersions.settings = raw.serverVersions.settings;
  }
  if (isObject(raw.quarantine)) {
    out.quarantine.games = sanitizeTombstones(raw.quarantine.games);
    out.quarantine.roster = sanitizeTombstones(raw.quarantine.roster);
  }
  return out;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateState(raw) {
  try {
    if (!isObject(raw) || (raw.version !== 1 && raw.version !== 2) || !Array.isArray(raw.games)) {
      return { state: null, dropped: 0, migrated: false };
    }
    const games = [];
    const gameIds = new Set();
    let dropped = 0;
    let remapped = false;
    for (const rawGame of raw.games) {
      let game = sanitizeGame(rawGame);
      // Legacy non-UUID ids can never reach the server (uuid column), so give them fresh ids
      // instead of letting them sit in sync quarantine forever. They were never synced.
      if (game && !UUID_PATTERN.test(game.id)) {
        game = { ...game, id: uid(), shareToken: null };
        remapped = true;
      }
      if (game && !gameIds.has(game.id)) {
        gameIds.add(game.id);
        games.push(game);
      } else {
        dropped += 1;
      }
    }
    const state = emptyState();
    if (raw.version === 1) {
      state.games = games.map((g) => ({ ...g, finishedAt: null, shareToken: null }));
      return { state, dropped, migrated: true };
    }
    state.games = games;
    state.ownerId = typeof raw.ownerId === 'string' ? raw.ownerId : null;
    const tomb = isObject(raw.tombstones) ? raw.tombstones : {};
    state.tombstones = { games: sanitizeTombstones(tomb.games), roster: sanitizeTombstones(tomb.roster) };
    const byKey = new Map();
    if (Array.isArray(raw.roster)) {
      for (const rawEntry of raw.roster) {
        const entry = sanitizeRosterEntry(rawEntry);
        if (!entry) continue;
        const prev = byKey.get(entry.key);
        if (!prev || entry.updatedAt > prev.updatedAt) byKey.set(entry.key, entry);
      }
    }
    state.roster = sortRoster([...byKey.values()]);
    state.settings = sanitizeSettings(raw.settings);
    state.sync = sanitizeSync(raw.sync);
    return { state, dropped, migrated: remapped };
  } catch {
    return { state: null, dropped: 0, migrated: false };
  }
}
