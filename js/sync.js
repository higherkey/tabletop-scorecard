import {
  sanitizeRemoteGame,
  sanitizeRosterEntry,
  sanitizeSettings,
  uid,
  upsertGame,
} from './model.js';

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

function sortRoster(roster) {
  return roster.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

const GAME_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_GAME_JSON = 250000;

function setVersion(state, table, key, time) {
  if (state.sync.serverVersions[table][key] === time) return state;
  const serverVersions = {
    ...state.sync.serverVersions,
    [table]: { ...state.sync.serverVersions[table], [key]: time },
  };
  return { ...state, sync: { ...state.sync, serverVersions } };
}

function setSettingsVersion(state, time) {
  if (state.sync.serverVersions.settings === time) return state;
  return { ...state, sync: { ...state.sync, serverVersions: { ...state.sync.serverVersions, settings: time } } };
}

export function mergeRemote(state, { games = [], roster = [], settings = null } = {}) {
  let next = state;

  for (const row of games ?? []) {
    const deletedAt = isFiniteNumber(row?.deletedAt) ? row.deletedAt : null;
    // Deleted rows arrive with data: null, so identify them by row.id.
    const game = deletedAt === null ? sanitizeRemoteGame(row?.data) : null;
    if (deletedAt === null && !game) continue;
    const id = deletedAt === null ? game.id : row.id;
    if (typeof id !== 'string' || id === '') continue;
    const remoteTime = deletedAt ?? game.updatedAt;
    const local = next.games.find((g) => g.id === id);
    const localTime = Math.max(local?.updatedAt ?? -Infinity, next.tombstones.games[id] ?? -Infinity);
    if (remoteTime === localTime) {
      next = setVersion(next, 'games', id, remoteTime);
      continue;
    }
    if (!(remoteTime > localTime)) continue;
    // A newer remote row would overwrite edits the server never saw: keep them as a new game.
    if (local && local.updatedAt !== next.sync.serverVersions.games[id]) {
      next = upsertGame(next, { ...local, id: uid(), name: local.name + ' (conflict copy)', shareToken: null });
    }
    if (deletedAt !== null) {
      next = {
        ...next,
        games: next.games.filter((g) => g.id !== id),
        tombstones: { ...next.tombstones, games: { ...next.tombstones.games, [id]: deletedAt } },
      };
    } else {
      const shareToken = typeof row.shareToken === 'string' ? row.shareToken : null;
      next = upsertGame(next, { ...game, shareToken: sanitizeRemoteGame({ ...game, shareToken })?.shareToken ?? null });
    }
    next = setVersion(next, 'games', id, remoteTime);
  }

  for (const row of roster ?? []) {
    const entry = sanitizeRosterEntry(row);
    if (!entry) continue;
    const deletedAt = isFiniteNumber(row.deletedAt) ? row.deletedAt : null;
    const remoteTime = deletedAt ?? entry.updatedAt;
    const local = next.roster.find((e) => e.key === entry.key);
    const localTime = Math.max(local?.updatedAt ?? -Infinity, next.tombstones.roster[entry.key] ?? -Infinity);
    if (remoteTime === localTime) {
      next = setVersion(next, 'roster', entry.key, remoteTime);
      continue;
    }
    if (!(remoteTime > localTime)) continue;
    if (deletedAt !== null) {
      next = {
        ...next,
        roster: next.roster.filter((e) => e.key !== entry.key),
        tombstones: { ...next.tombstones, roster: { ...next.tombstones.roster, [entry.key]: deletedAt } },
      };
    } else {
      const rosterTomb = { ...next.tombstones.roster };
      delete rosterTomb[entry.key];
      next = {
        ...next,
        roster: sortRoster([...next.roster.filter((e) => e.key !== entry.key), entry]),
        tombstones: { ...next.tombstones, roster: rosterTomb },
      };
    }
    next = setVersion(next, 'roster', entry.key, remoteTime);
  }

  if (settings && isFiniteNumber(settings.data?.updatedAt)) {
    const remote = sanitizeSettings(settings.data);
    if (remote.updatedAt > next.settings.updatedAt) {
      next = setSettingsVersion({ ...next, settings: remote }, remote.updatedAt);
    } else if (remote.updatedAt === next.settings.updatedAt) {
      next = setSettingsVersion(next, remote.updatedAt);
    }
  }

  return next;
}

export function collectPush(state) {
  const { serverVersions, quarantine } = state.sync;
  const pending = (table, key, time) =>
    time !== serverVersions[table][key] && quarantine[table][key] !== time;
  const games = [];
  const invalid = [];
  for (const game of state.games) {
    if (!pending('games', game.id, game.updatedAt)) continue;
    if (!GAME_ID_RE.test(game.id)) {
      invalid.push({ kind: 'game', id: game.id, time: game.updatedAt, reason: 'invalid id' });
    } else if (JSON.stringify(game).length >= MAX_GAME_JSON) {
      invalid.push({ kind: 'game', id: game.id, time: game.updatedAt, reason: 'too large' });
    } else {
      games.push(game);
    }
  }
  return {
    games,
    gameDeletes: Object.entries(state.tombstones.games)
      .filter(([id, t]) => pending('games', id, t))
      .map(([id, deletedAt]) => ({ id, deletedAt })),
    roster: state.roster.filter((e) => pending('roster', e.key, e.updatedAt)),
    rosterDeletes: Object.entries(state.tombstones.roster)
      .filter(([key, t]) => pending('roster', key, t))
      .map(([key, deletedAt]) => ({ key, deletedAt })),
    settings:
      state.settings.updatedAt > 0 && state.settings.updatedAt !== serverVersions.settings ? state.settings : null,
    invalid,
  };
}

export function isEmptyPush(push) {
  return (
    push.games.length === 0 &&
    push.gameDeletes.length === 0 &&
    push.roster.length === 0 &&
    push.rosterDeletes.length === 0 &&
    push.settings === null
  );
}

export function unownedCount(state, userId) {
  return state.ownerId !== userId ? state.games.length : 0;
}
