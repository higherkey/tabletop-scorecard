export const MAX_PLAYERS = 12;
export const MAX_ABS_SCORE = 9999999;

const DEFAULT_NAME = 'Untitled game';
const COLOR_COUNT = 8;

export function uid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

export function emptyState() {
  return { version: 1, games: [] };
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
  };
}

export function renameGame(game, name, now = Date.now()) {
  const trimmed = cleanName(name);
  if (!trimmed) return game;
  return { ...game, name: trimmed, updatedAt: now };
}

export function addRound(game, now = Date.now()) {
  return { ...game, rounds: [...game.rounds, newRound()], updatedAt: now };
}

export function removeRound(game, roundId, now = Date.now()) {
  if (!game.rounds.some((round) => round.id === roundId)) return game;
  return {
    ...game,
    rounds: game.rounds.filter((round) => round.id !== roundId),
    updatedAt: now,
  };
}

export function setScore(game, roundId, playerId, value, now = Date.now()) {
  if (value !== null && (typeof value !== 'number' || !Number.isInteger(value) || Math.abs(value) > MAX_ABS_SCORE)) {
    throw new RangeError(`Score must be an integer with absolute value <= ${MAX_ABS_SCORE}`);
  }
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
    updatedAt: now,
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
  };
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
  return { ...state, games };
}

export function deleteGame(state, id) {
  return { ...state, games: state.games.filter((game) => game.id !== id) };
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
  };
}

export function validateState(raw) {
  try {
    if (!isObject(raw) || raw.version !== 1 || !Array.isArray(raw.games)) {
      return { state: null, dropped: 0 };
    }
    const games = [];
    const gameIds = new Set();
    let dropped = 0;
    for (const rawGame of raw.games) {
      const game = sanitizeGame(rawGame);
      if (game && !gameIds.has(game.id)) {
        gameIds.add(game.id);
        games.push(game);
      } else {
        dropped += 1;
      }
    }
    return { state: { version: 1, games }, dropped };
  } catch {
    return { state: null, dropped: 0 };
  }
}
