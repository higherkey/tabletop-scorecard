import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_PLAYERS,
  MAX_ABS_SCORE,
  uid,
  emptyState,
  createGame,
  renameGame,
  addRound,
  removeRound,
  setScore,
  totals,
  standings,
  rematch,
  getGame,
  upsertGame,
  deleteGame,
  validateState,
} from '../js/model.js';

const NOW = 1_700_000_000_000;

function makeGame(players = ['Ann', 'Ben'], extra = {}) {
  return createGame({ name: 'Test', players, ...extra }, NOW);
}

function clone(value) {
  return structuredClone(value);
}

describe('uid', () => {
  test('returns unique non-empty strings', () => {
    const a = uid();
    const b = uid();
    assert.equal(typeof a, 'string');
    assert.ok(a.length > 0);
    assert.notEqual(a, b);
  });
});

describe('createGame', () => {
  test('trims names and drops blank players', () => {
    const game = makeGame(['  Ann ', '', '   ', 'Ben\t']);
    assert.deepEqual(game.players.map((p) => p.name), ['Ann', 'Ben']);
  });

  test('truncates to MAX_PLAYERS', () => {
    const names = Array.from({ length: MAX_PLAYERS + 3 }, (_, i) => `P${i}`);
    const game = makeGame(names);
    assert.equal(game.players.length, MAX_PLAYERS);
    assert.deepEqual(game.players.map((p) => p.name), names.slice(0, MAX_PLAYERS));
  });

  test('throws when no players remain after filtering', () => {
    assert.throws(() => makeGame(['  ', '']), { message: 'At least one player is required' });
    assert.throws(() => makeGame([]), { message: 'At least one player is required' });
  });

  test('assigns colors as index modulo 8', () => {
    const names = Array.from({ length: 10 }, (_, i) => `P${i}`);
    const game = makeGame(names);
    assert.deepEqual(game.players.map((p) => p.color), [0, 1, 2, 3, 4, 5, 6, 7, 0, 1]);
  });

  test('uses the trimmed name, or the default name when blank', () => {
    assert.equal(createGame({ name: '  Catan  ', players: ['A'] }, NOW).name, 'Catan');
    assert.equal(createGame({ name: '   ', players: ['A'] }, NOW).name, 'Untitled game');
    assert.equal(createGame({ players: ['A'] }, NOW).name, 'Untitled game');
  });

  test('starts with exactly one empty round and uses the given now', () => {
    const game = makeGame();
    assert.equal(game.rounds.length, 1);
    assert.deepEqual(game.rounds[0].scores, {});
    assert.equal(game.createdAt, NOW);
    assert.equal(game.updatedAt, NOW);
  });

  test('lowWins defaults to false and is honored when true', () => {
    assert.equal(makeGame().lowWins, false);
    assert.equal(makeGame(['A'], { lowWins: true }).lowWins, true);
  });
});

describe('renameGame', () => {
  test('sets the trimmed name and updatedAt without mutating input', () => {
    const game = makeGame();
    const before = clone(game);
    const renamed = renameGame(game, '  Chess  ', NOW + 5);
    assert.equal(renamed.name, 'Chess');
    assert.equal(renamed.updatedAt, NOW + 5);
    assert.deepEqual(game, before);
  });

  test('returns the same game when the name is blank after trim', () => {
    const game = makeGame();
    assert.equal(renameGame(game, '   ', NOW + 5), game);
  });
});

describe('addRound and removeRound', () => {
  test('addRound appends an empty round', () => {
    const game = makeGame();
    const next = addRound(game, NOW + 1);
    assert.equal(next.rounds.length, 2);
    assert.deepEqual(next.rounds[1].scores, {});
    assert.equal(game.rounds.length, 1);
  });

  test('removeRound removes the round by id without mutating input', () => {
    const game = addRound(makeGame(), NOW);
    const before = clone(game);
    const target = game.rounds[0].id;
    const next = removeRound(game, target, NOW + 2);
    assert.equal(next.rounds.length, 1);
    assert.ok(!next.rounds.some((r) => r.id === target));
    assert.equal(next.updatedAt, NOW + 2);
    assert.deepEqual(game, before);
  });

  test('removeRound returns the same reference for an unknown id', () => {
    const game = makeGame();
    assert.equal(removeRound(game, 'nope', NOW + 2), game);
  });
});

describe('setScore', () => {
  test('sets a score and updatedAt without mutating input', () => {
    const game = makeGame();
    const before = clone(game);
    const roundId = game.rounds[0].id;
    const playerId = game.players[0].id;
    const next = setScore(game, roundId, playerId, 7, NOW + 3);
    assert.equal(next.rounds[0].scores[playerId], 7);
    assert.equal(next.updatedAt, NOW + 3);
    assert.deepEqual(game, before);
  });

  test('null clears the key', () => {
    const game = makeGame();
    const roundId = game.rounds[0].id;
    const playerId = game.players[0].id;
    const withScore = setScore(game, roundId, playerId, 4, NOW);
    const cleared = setScore(withScore, roundId, playerId, null, NOW);
    assert.equal(Object.hasOwn(cleared.rounds[0].scores, playerId), false);
    assert.equal(withScore.rounds[0].scores[playerId], 4);
  });

  test('accepts zero, negatives, and the score limits', () => {
    const game = makeGame();
    const roundId = game.rounds[0].id;
    const [p1, p2] = [game.players[0].id, game.players[1].id];
    assert.equal(setScore(game, roundId, p1, 0, NOW).rounds[0].scores[p1], 0);
    assert.equal(setScore(game, roundId, p1, -12, NOW).rounds[0].scores[p1], -12);
    assert.equal(setScore(game, roundId, p2, MAX_ABS_SCORE, NOW).rounds[0].scores[p2], MAX_ABS_SCORE);
    assert.equal(setScore(game, roundId, p2, -MAX_ABS_SCORE, NOW).rounds[0].scores[p2], -MAX_ABS_SCORE);
  });

  test('throws RangeError for NaN, Infinity, and out-of-range values', () => {
    const game = makeGame();
    const roundId = game.rounds[0].id;
    const playerId = game.players[0].id;
    for (const bad of [NaN, Infinity, -Infinity, MAX_ABS_SCORE + 1, -(MAX_ABS_SCORE + 1)]) {
      assert.throws(() => setScore(game, roundId, playerId, bad, NOW), RangeError);
    }
  });

  test('throws RangeError for non-integer numbers', () => {
    const game = makeGame();
    const roundId = game.rounds[0].id;
    const playerId = game.players[0].id;
    for (const bad of [1.5, -0.25, 2.0000001]) {
      assert.throws(() => setScore(game, roundId, playerId, bad, NOW), RangeError);
    }
  });

  test('returns the same reference for an unknown round', () => {
    const game = makeGame();
    assert.equal(setScore(game, 'nope', game.players[0].id, 5, NOW), game);
  });

  test('returns the same reference for an unknown player', () => {
    const game = makeGame();
    assert.equal(setScore(game, game.rounds[0].id, 'nope', 5, NOW), game);
  });
});

describe('totals', () => {
  test('sums scores per player across rounds', () => {
    let game = makeGame(['A', 'B']);
    const [a, b] = game.players.map((p) => p.id);
    game = addRound(game, NOW);
    game = setScore(game, game.rounds[0].id, a, 10, NOW);
    game = setScore(game, game.rounds[1].id, a, -3, NOW);
    game = setScore(game, game.rounds[1].id, b, 5, NOW);
    assert.deepEqual(totals(game), { [a]: 7, [b]: 5 });
  });

  test('returns zero for every player with no scores', () => {
    const game = makeGame(['A', 'B']);
    const [a, b] = game.players.map((p) => p.id);
    assert.deepEqual(totals(game), { [a]: 0, [b]: 0 });
  });
});

describe('standings', () => {
  function scored(lowWins) {
    let game = makeGame(['P1', 'P2', 'P3'], { lowWins });
    const [p1, p2, p3] = game.players.map((p) => p.id);
    const roundId = game.rounds[0].id;
    game = setScore(game, roundId, p1, 10, NOW);
    game = setScore(game, roundId, p2, 30, NOW);
    game = setScore(game, roundId, p3, 20, NOW);
    return game;
  }

  test('sorts high totals first when high wins', () => {
    const result = standings(scored(false));
    assert.deepEqual(result.map((s) => s.player.name), ['P2', 'P3', 'P1']);
    assert.deepEqual(result.map((s) => s.total), [30, 20, 10]);
    assert.deepEqual(result.map((s) => s.rank), [1, 2, 3]);
  });

  test('sorts low totals first when low wins', () => {
    const result = standings(scored(true));
    assert.deepEqual(result.map((s) => s.player.name), ['P1', 'P3', 'P2']);
    assert.deepEqual(result.map((s) => s.rank), [1, 2, 3]);
  });

  test('uses competition ranking (1,1,3)', () => {
    let game = makeGame(['A', 'B', 'C']);
    const [a, b, c] = game.players.map((p) => p.id);
    const roundId = game.rounds[0].id;
    game = setScore(game, roundId, a, 10, NOW);
    game = setScore(game, roundId, b, 10, NOW);
    game = setScore(game, roundId, c, 5, NOW);
    const result = standings(game);
    assert.deepEqual(result.map((s) => s.rank), [1, 1, 3]);
    assert.deepEqual(result.map((s) => s.player.name), ['A', 'B', 'C']);
  });

  test('ties keep player order', () => {
    const game = makeGame(['X', 'Y', 'Z']);
    const result = standings(game);
    assert.deepEqual(result.map((s) => s.player.name), ['X', 'Y', 'Z']);
    assert.deepEqual(result.map((s) => s.rank), [1, 1, 1]);
    assert.deepEqual(result.map((s) => s.total), [0, 0, 0]);
  });
});

describe('rematch', () => {
  test('creates a new game with new ids and the same name, mode, names, and colors', () => {
    let game = makeGame(['Ann', 'Ben'], { lowWins: true });
    game = setScore(game, game.rounds[0].id, game.players[0].id, 9, NOW);
    const before = clone(game);
    const next = rematch(game, NOW + 10);

    assert.notEqual(next.id, game.id);
    assert.equal(next.name, game.name);
    assert.equal(next.lowWins, true);
    assert.equal(next.createdAt, NOW + 10);
    assert.equal(next.updatedAt, NOW + 10);

    assert.equal(next.players.length, game.players.length);
    next.players.forEach((player, i) => {
      assert.notEqual(player.id, game.players[i].id);
      assert.equal(player.name, game.players[i].name);
      assert.equal(player.color, game.players[i].color);
    });

    assert.equal(next.rounds.length, 1);
    assert.notEqual(next.rounds[0].id, game.rounds[0].id);
    assert.deepEqual(next.rounds[0].scores, {});
    assert.deepEqual(game, before);
  });
});

describe('upsertGame, getGame, and deleteGame', () => {
  function gameAt(id, updatedAt) {
    return { ...makeGame(), id, updatedAt };
  }

  test('upsertGame adds games sorted by updatedAt desc', () => {
    let state = emptyState();
    state = upsertGame(state, gameAt('g1', 100));
    state = upsertGame(state, gameAt('g2', 300));
    state = upsertGame(state, gameAt('g3', 200));
    assert.deepEqual(state.games.map((g) => g.id), ['g2', 'g3', 'g1']);
  });

  test('upsertGame replaces a game with the same id and re-sorts', () => {
    let state = emptyState();
    state = upsertGame(state, gameAt('g1', 100));
    state = upsertGame(state, gameAt('g2', 300));
    state = upsertGame(state, gameAt('g3', 200));
    const before = clone(state);
    state = upsertGame(state, gameAt('g1', 400));
    assert.equal(state.games.length, 3);
    assert.deepEqual(state.games.map((g) => g.id), ['g1', 'g2', 'g3']);
    assert.deepEqual(before.games.map((g) => g.id), ['g2', 'g3', 'g1']);
  });

  test('getGame returns the game or undefined', () => {
    const state = upsertGame(emptyState(), gameAt('g1', 100));
    assert.equal(getGame(state, 'g1').id, 'g1');
    assert.equal(getGame(state, 'missing'), undefined);
  });

  test('deleteGame removes the game without mutating input', () => {
    let state = upsertGame(emptyState(), gameAt('g1', 100));
    state = upsertGame(state, gameAt('g2', 200));
    const before = clone(state);
    const next = deleteGame(state, 'g1');
    assert.deepEqual(next.games.map((g) => g.id), ['g2']);
    assert.equal(getGame(next, 'g1'), undefined);
    assert.deepEqual(state, before);
  });
});

describe('validateState', () => {
  test('accepts a valid state unchanged', () => {
    let game = makeGame(['Ann', 'Ben'], { lowWins: true });
    game = setScore(game, game.rounds[0].id, game.players[1].id, 4, NOW);
    const state = upsertGame(emptyState(), game);
    const raw = JSON.parse(JSON.stringify(state));
    const result = validateState(raw);
    assert.deepEqual(result, { state, dropped: 0, migrated: false });
  });

  test('returns null state for bad top-level values', () => {
    const bad = [null, undefined, 42, 'text', true, [], {}, { version: 3, games: [] }, { version: 1 }, { version: 1, games: 'x' }];
    for (const raw of bad) {
      assert.deepEqual(validateState(raw), { state: null, dropped: 0, migrated: false });
    }
  });

  test('never throws on garbage input', () => {
    const garbage = [null, 42, { version: 3 }, 'x', [1, 2], { version: 1, games: [null, 1, 'x', []] }];
    for (const raw of garbage) {
      assert.doesNotThrow(() => validateState(raw));
    }
    assert.deepEqual(validateState({ version: 1, games: [null, 1, 'x', []] }), {
      state: emptyState(),
      dropped: 4,
      migrated: true,
    });
  });

  test('drops bad games and counts them', () => {
    const good1 = makeGame(['A']);
    const good2 = makeGame(['B']);
    const raw = {
      version: 1,
      games: [
        good1,
        { ...good1, id: 5 },
        good2,
        { ...good1, id: 'noplayers', players: [] },
      ],
    };
    const result = validateState(raw);
    assert.equal(result.dropped, 2);
    assert.deepEqual(result.state.games.map((g) => g.id), [good1.id, good2.id]);
  });

  test('drops games with invalid fields', () => {
    const good = makeGame(['A']);
    const player = good.players[0];
    const badGames = [
      { ...good, name: 7 },
      { ...good, createdAt: 'now' },
      { ...good, updatedAt: Infinity },
      { ...good, players: [{ ...player, color: 8 }] },
      { ...good, players: [{ ...player, color: 1.5 }] },
      { ...good, players: [{ id: player.id, color: 0 }] },
      { ...good, players: [{ ...player, id: 9 }] },
      { ...good, rounds: 'none' },
      { ...good, rounds: [{ id: 'r1', scores: [] }] },
      { ...good, rounds: [{ id: 3, scores: {} }] },
    ];
    const result = validateState({ version: 1, games: badGames });
    assert.equal(result.dropped, badGames.length);
    assert.deepEqual(result.state.games, []);
  });

  test('strips score entries with unknown keys or non-finite values', () => {
    const game = makeGame(['A', 'B']);
    const [a, b] = game.players.map((p) => p.id);
    const raw = {
      version: 1,
      games: [
        {
          ...game,
          rounds: [
            {
              id: game.rounds[0].id,
              scores: { [a]: 5, [b]: 'x', ghost: 3, [`${b}-x`]: 1, nan: null, inf: 1e999 },
            },
          ],
        },
      ],
    };
    const result = validateState(raw);
    assert.equal(result.dropped, 0);
    assert.deepEqual(result.state.games[0].rounds[0].scores, { [a]: 5 });
  });

  test('coerces lowWins with Boolean', () => {
    const game = makeGame(['A']);
    const withTruthy = validateState({ version: 1, games: [{ ...game, lowWins: 'yes' }] });
    const withMissing = validateState({ version: 1, games: [{ ...game, lowWins: undefined }] });
    assert.equal(withTruthy.state.games[0].lowWins, true);
    assert.equal(withMissing.state.games[0].lowWins, false);
  });

  test('strips scores that are non-integers or exceed MAX_ABS_SCORE', () => {
    const game = makeGame(['A', 'B']);
    const [a, b] = game.players.map((p) => p.id);
    const raw = {
      version: 1,
      games: [
        {
          ...game,
          rounds: [
            {
              id: game.rounds[0].id,
              scores: { [a]: 5, [b]: 1.5 },
            },
          ],
        },
        {
          ...game,
          id: 'over-limit',
          rounds: [
            {
              id: game.rounds[0].id,
              scores: { [a]: 5, [b]: MAX_ABS_SCORE + 1 },
            },
          ],
        },
      ],
    };
    const result = validateState(raw);
    assert.equal(result.dropped, 0);
    assert.deepEqual(result.state.games[0].rounds[0].scores, { [a]: 5 });
    assert.deepEqual(result.state.games[1].rounds[0].scores, { [a]: 5 });
  });

  test('drops games with duplicate player ids or duplicate round ids', () => {
    const good = makeGame(['A', 'B']);
    const dupPlayers = { ...good, players: [good.players[0], { ...good.players[1], id: good.players[0].id }] };
    const dupRounds = { ...good, rounds: [good.rounds[0], { ...good.rounds[0] }] };
    const result = validateState({ version: 1, games: [good, dupPlayers, dupRounds] });
    assert.equal(result.dropped, 2);
    assert.deepEqual(result.state.games.map((g) => g.id), [good.id]);
  });

  test('drops a game whose id duplicates an earlier kept game', () => {
    const good = makeGame(['A']);
    const duplicate = { ...good, name: 'Duplicate' };
    const result = validateState({ version: 1, games: [good, duplicate] });
    assert.equal(result.dropped, 1);
    assert.equal(result.state.games.length, 1);
    assert.equal(result.state.games[0].name, 'Test');
  });
});

import {
  DEFAULT_SETTINGS,
  finishGame,
  reopenGame,
  setShareToken,
  newShareToken,
  rosterKey,
  addRosterNames,
  removeRosterEntry,
  updateSettings,
  setOwner,
  setSyncMarks,
  markPushed,
  markQuarantined,
  resetForOwner,
} from '../js/model.js';

const EMPTY_SYNC = {
  cursors: { games: null, players: null, settings: null },
  serverVersions: { games: {}, roster: {}, settings: null },
  quarantine: { games: {}, roster: {} },
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('v2 migration and validation', () => {
  test('v1 migrates to v2 with new fields', () => {
    const g = makeGame();
    const { finishedAt, shareToken, ...v1game } = g;
    const result = validateState({ version: 1, games: [v1game] });
    assert.equal(result.migrated, true);
    assert.equal(result.state.version, 2);
    assert.equal(result.state.ownerId, null);
    assert.equal(result.state.games[0].finishedAt, null);
    assert.equal(result.state.games[0].shareToken, null);
    assert.deepEqual(result.state.tombstones, { games: {}, roster: {} });
    assert.deepEqual(result.state.settings, DEFAULT_SETTINGS);
  });

  test('v2 game fields fall back to null when invalid', () => {
    const g = makeGame();
    const good = newShareToken();
    const a = '00000000-0000-4000-8000-00000000000a';
    const b = '00000000-0000-4000-8000-00000000000b';
    const r = validateState({
      ...emptyState(),
      games: [
        { ...g, id: a, finishedAt: 'x', shareToken: 'short' },
        { ...g, id: b, finishedAt: 5, shareToken: good },
      ],
    });
    assert.equal(r.state.games.find((x) => x.id === a).finishedAt, null);
    assert.equal(r.state.games.find((x) => x.id === a).shareToken, null);
    assert.equal(r.state.games.find((x) => x.id === b).finishedAt, 5);
    assert.equal(r.state.games.find((x) => x.id === b).shareToken, good);
    assert.equal(r.migrated, false);
  });

  test('legacy non-UUID game ids get fresh UUIDs (never synced) and mark the load as migrated', () => {
    const g = makeGame();
    const r = validateState({ ...emptyState(), games: [{ ...g, id: 'legacy-1', shareToken: newShareToken() }] });
    assert.equal(r.state.games.length, 1);
    assert.match(r.state.games[0].id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal(r.state.games[0].shareToken, null);
    assert.equal(r.state.games[0].name, g.name);
    assert.equal(r.migrated, true);
    assert.equal(r.dropped, 0);
  });

  test('v2 tombstones, roster, settings, owner, sync are sanitized', () => {
    const r = validateState({
      version: 2,
      games: [],
      ownerId: 42,
      tombstones: { games: { a: 1, b: 'x', c: NaN }, roster: { k: 2, j: null } },
      roster: [
        { key: 'ann', name: 'Ann', color: 1, updatedAt: 1 },
        { key: 'ann', name: 'Ann', color: 2, updatedAt: 5 },
        { key: 'WRONG', name: 'Bob', color: 1, updatedAt: 1 },
        { key: 'cy', name: 'Cy', color: 9, updatedAt: 1 },
        { key: 'dee', name: 'Dee', color: 1, updatedAt: Infinity },
        { key: 'x'.repeat(31), name: 'x'.repeat(31), color: 1, updatedAt: 1 },
        { key: 'bob', name: 'Bob', color: 0, updatedAt: 1 },
      ],
      settings: { theme: 'neon', defaultLowWins: 'y', keepAwake: false, haptics: true, updatedAt: 7 },
      sync: { lastPulledAt: 5, lastPushedAt: 'z' },
    });
    assert.equal(r.dropped, 0);
    assert.equal(r.state.ownerId, null);
    assert.deepEqual(r.state.tombstones, { games: { a: 1 }, roster: { k: 2 } });
    assert.deepEqual(r.state.roster.map((e) => [e.key, e.color]), [['ann', 2], ['bob', 0]]);
    assert.deepEqual(r.state.settings, { theme: 'system', defaultLowWins: false, keepAwake: false, haptics: true, updatedAt: 7 });
    assert.deepEqual(r.state.sync, EMPTY_SYNC);
  });

  test('v2 with missing sections gets defaults', () => {
    const r = validateState({ version: 2, games: [] });
    assert.deepEqual(r.state, emptyState());
  });
});

describe('finish, reopen, share token', () => {
  test('finished games are immutable for scoring', () => {
    const g = finishGame(makeGame(), NOW + 1);
    assert.equal(g.finishedAt, NOW + 1);
    assert.equal(g.updatedAt, NOW + 1);
    assert.equal(finishGame(g, NOW + 9), g);
    assert.equal(addRound(g, NOW + 5), g);
    assert.equal(removeRound(g, g.rounds[0].id, NOW + 5), g);
    assert.equal(setScore(g, g.rounds[0].id, g.players[0].id, 3, NOW + 5), g);
    assert.equal(renameGame(g, 'New', NOW + 5).name, 'New');
  });

  test('reopen clears finishedAt; unfinished returns same ref', () => {
    const open = makeGame();
    assert.equal(reopenGame(open, NOW + 1), open);
    const done = finishGame(open, NOW + 1);
    const re = reopenGame(done, NOW + 2);
    assert.equal(re.finishedAt, null);
    assert.equal(re.updatedAt, NOW + 2);
    assert.notEqual(addRound(re, NOW + 3), re);
  });

  test('setShareToken updates or returns same ref', () => {
    const g = makeGame();
    assert.equal(setShareToken(g, null, NOW + 1), g);
    const t = newShareToken();
    const s = setShareToken(g, t, NOW + 1);
    assert.equal(s.shareToken, t);
    assert.equal(s.updatedAt, NOW + 1);
    assert.equal(setShareToken(s, t, NOW + 2), s);
    assert.equal(setShareToken(s, null, NOW + 3).shareToken, null);
  });

  test('newShareToken is 22 base64url chars and unique', () => {
    const seen = new Set();
    for (let i = 0; i < 200; i++) {
      const t = newShareToken();
      assert.match(t, /^[A-Za-z0-9_-]{22}$/);
      seen.add(t);
    }
    assert.equal(seen.size, 200);
  });

  test('createGame and rematch include null finishedAt and shareToken', () => {
    const g = makeGame();
    assert.equal(g.finishedAt, null);
    assert.equal(g.shareToken, null);
    const r = rematch(finishGame(setShareToken(g, newShareToken(), NOW), NOW), NOW);
    assert.equal(r.finishedAt, null);
    assert.equal(r.shareToken, null);
  });
});

describe('tombstones for games', () => {
  test('deleteGame tombstones; unknown id returns same ref; upsert clears', () => {
    const g = { ...makeGame(['A']), id: 'g1', updatedAt: 100 };
    const state = upsertGame(emptyState(), g);
    assert.equal(deleteGame(state, 'nope', 5), state);
    const del = deleteGame(state, 'g1', 500);
    assert.equal(del.tombstones.games.g1, 500);
    assert.deepEqual(state.tombstones.games, {});
    const back = upsertGame(del, g);
    assert.equal(Object.hasOwn(back.tombstones.games, 'g1'), false);
    assert.equal(del.tombstones.games.g1, 500);
  });
});

describe('roster', () => {
  test('add, dedupe, colors, truncate, sort', () => {
    const s0 = emptyState();
    const s1 = addRosterNames(s0, ['  Zed ', 'ann', 'ANN', '', '   ', 'x'.repeat(40)], 10);
    assert.equal(s1.roster.length, 3);
    assert.deepEqual(s1.roster.map((e) => e.name), ['ann', 'x'.repeat(30), 'Zed']);
    assert.deepEqual(s0.roster, []);
    const byKey = Object.fromEntries(s1.roster.map((e) => [e.key, e]));
    assert.equal(byKey.zed.color, 0);
    assert.equal(byKey.ann.color, 1);
    assert.equal(byKey['x'.repeat(30)].color, 2);
    assert.equal(byKey.zed.updatedAt, 10);
    assert.equal(rosterKey('  Zed '), 'zed');
  });

  test('colors wrap at 8', () => {
    const names = Array.from({ length: 9 }, (_, i) => `P${i}`);
    const s = addRosterNames(emptyState(), names, 1);
    assert.equal(s.roster.find((e) => e.key === 'p8').color, 0);
  });

  test('no change returns same ref; existing untouched', () => {
    const s1 = addRosterNames(emptyState(), ['Ann'], 10);
    assert.equal(addRosterNames(s1, ['ann', ' '], 20), s1);
    assert.equal(addRosterNames(s1, [], 20), s1);
  });

  test('remove tombstones; re-add clears tombstone', () => {
    const s1 = addRosterNames(emptyState(), ['Ann'], 10);
    assert.equal(removeRosterEntry(s1, 'nope', 20), s1);
    const s2 = removeRosterEntry(s1, 'ann', 20);
    assert.deepEqual(s2.roster, []);
    assert.equal(s2.tombstones.roster.ann, 20);
    const s3 = addRosterNames(s2, ['Ann'], 30);
    assert.equal(Object.hasOwn(s3.tombstones.roster, 'ann'), false);
    assert.equal(s3.roster.length, 1);
  });
});

describe('settings, owner, sync marks', () => {
  test('updateSettings merges valid keys only', () => {
    const s = updateSettings(emptyState(), { theme: 'dark', haptics: false, keepAwake: 'no', bogus: 1, updatedAt: 99 }, 50);
    assert.deepEqual(s.settings, { theme: 'dark', defaultLowWins: false, keepAwake: true, haptics: false, updatedAt: 50 });
    assert.equal(Object.hasOwn(s.settings, 'bogus'), false);
  });

  test('updateSettings rejects invalid theme and returns same ref when unchanged', () => {
    const s0 = emptyState();
    assert.equal(updateSettings(s0, { theme: 'neon' }, 5), s0);
    assert.equal(updateSettings(s0, { theme: 'system', haptics: true }, 5), s0);
    assert.equal(updateSettings(s0, {}, 5), s0);
    assert.equal(s0.settings.updatedAt, 0);
  });

  test('DEFAULT_SETTINGS is frozen and emptyState copies it', () => {
    assert.ok(Object.isFrozen(DEFAULT_SETTINGS));
    const s = emptyState();
    assert.notEqual(s.settings, DEFAULT_SETTINGS);
    assert.deepEqual(s.settings, DEFAULT_SETTINGS);
  });

  test('setOwner and setSyncMarks', () => {
    const s = emptyState();
    assert.equal(setOwner(s, null), s);
    const o = setOwner(s, 'u1');
    assert.equal(o.ownerId, 'u1');
    assert.equal(setOwner(o, 'u1'), o);
    const m = setSyncMarks(o, { cursors: { games: 'T' } });
    assert.deepEqual(m.sync.cursors, { games: 'T', players: null, settings: null });
    assert.deepEqual(setSyncMarks(m, { cursors: { players: 'P' } }).sync.cursors, { games: 'T', players: 'P', settings: null });
  });

  test('setSyncMarks merges only provided cursor keys and returns the same reference when nothing changes', () => {
    const m = setSyncMarks(emptyState(), { cursors: { games: 'T', settings: 'S' } });
    assert.deepEqual(m.sync.cursors, { games: 'T', players: null, settings: 'S' });
    assert.equal(setSyncMarks(m, { cursors: { games: 'T' } }), m);
    assert.equal(setSyncMarks(m, { cursors: {} }), m);
    assert.equal(setSyncMarks(m, {}), m);
    assert.equal(setSyncMarks(m), m);
    assert.equal(setSyncMarks(m, { cursors: { games: undefined } }), m);
    const cleared = setSyncMarks(m, { cursors: { games: null } });
    assert.notEqual(cleared, m);
    assert.equal(cleared.sync.cursors.games, null);
    assert.equal(m.sync.cursors.games, 'T');
  });
});

describe('uid UUID fallback', () => {
  function withoutRandomUUID(fn) {
    Object.defineProperty(globalThis.crypto, 'randomUUID', { value: undefined, configurable: true, writable: true });
    try {
      fn();
    } finally {
      delete globalThis.crypto.randomUUID;
    }
  }

  test('uid uses crypto.randomUUID when available', () => {
    assert.match(uid(), UUID_RE);
  });

  test('without randomUUID, uid still returns RFC 4122 v4 UUIDs', () => {
    withoutRandomUUID(() => {
      assert.equal(globalThis.crypto.randomUUID, undefined);
      const seen = new Set();
      for (let i = 0; i < 200; i++) {
        const id = uid();
        assert.match(id, UUID_RE);
        seen.add(id);
      }
      assert.equal(seen.size, 200);
    });
    assert.equal(typeof globalThis.crypto.randomUUID, 'function');
  });

  test('without randomUUID, created games get UUID-formatted ids', () => {
    withoutRandomUUID(() => {
      const game = makeGame();
      assert.match(game.id, UUID_RE);
      assert.match(game.players[0].id, UUID_RE);
      assert.match(game.rounds[0].id, UUID_RE);
    });
  });
});

describe('monotonic stamps', () => {
  const FUTURE = NOW + 10 * 24 * 3600 * 1000;
  const futureGame = () => ({ ...makeGame(), updatedAt: FUTURE });

  test('every game edit increases updatedAt past a future-dated game', () => {
    const g = futureGame();
    const [p] = g.players;
    const edits = [
      renameGame(g, 'New', NOW),
      addRound(g, NOW),
      removeRound(addRound(g, NOW), g.rounds[0].id, NOW),
      setScore(g, g.rounds[0].id, p.id, 3, NOW),
      finishGame(g, NOW),
      setShareToken(g, newShareToken(), NOW),
    ];
    for (const edited of edits) assert.ok(edited.updatedAt > FUTURE, 'updatedAt must exceed the previous value');
    assert.equal(renameGame(g, 'New', NOW).updatedAt, FUTURE + 1);
    const done = finishGame(g, NOW);
    assert.equal(done.finishedAt, done.updatedAt);
    const re = reopenGame(done, NOW);
    assert.ok(re.updatedAt > done.updatedAt);
  });

  test('repeated edits in the same millisecond keep increasing', () => {
    let g = makeGame();
    const roundId = g.rounds[0].id;
    const pid = g.players[0].id;
    let last = g.updatedAt;
    for (let i = 1; i <= 5; i++) {
      g = setScore(g, roundId, pid, i, NOW);
      assert.ok(g.updatedAt > last);
      last = g.updatedAt;
    }
  });

  test('a normal clock still wins when it is ahead', () => {
    assert.equal(renameGame(makeGame(), 'X', NOW + 500).updatedAt, NOW + 500);
  });

  test('deleteGame tombstone is newer than the game', () => {
    const state = upsertGame(emptyState(), futureGame());
    const del = deleteGame(state, state.games[0].id, NOW);
    assert.equal(del.tombstones.games[state.games[0].id], FUTURE + 1);
  });

  test('roster and settings changes are monotonic', () => {
    const s1 = addRosterNames(emptyState(), ['Ann'], FUTURE);
    const s2 = removeRosterEntry(s1, 'ann', NOW);
    assert.equal(s2.tombstones.roster.ann, FUTURE + 1);
    const s3 = addRosterNames(s2, ['Ann'], NOW);
    assert.equal(s3.roster[0].updatedAt, FUTURE + 2);
    const set1 = updateSettings(emptyState(), { theme: 'dark' }, FUTURE);
    const set2 = updateSettings(set1, { theme: 'light' }, NOW);
    assert.equal(set2.settings.updatedAt, FUTURE + 1);
  });
});

describe('roster code-point truncation', () => {
  const EMOJI = String.fromCodePoint(0x1f600);

  test('truncates by code points and never splits a surrogate pair', () => {
    const s = addRosterNames(emptyState(), [EMOJI.repeat(40)], 10);
    const [entry] = s.roster;
    assert.equal([...entry.name].length, 30);
    assert.equal(entry.name, EMOJI.repeat(30));
    assert.equal(entry.name.isWellFormed(), true);
  });

  test('a truncated astral name survives a validateState round trip', () => {
    const s = addRosterNames(emptyState(), [EMOJI.repeat(40)], 10);
    const r = validateState(JSON.parse(JSON.stringify(s)));
    assert.equal(r.state.roster.length, 1);
    assert.deepEqual(r.state.roster, s.roster);
  });

  test('BMP names still truncate at 30', () => {
    const s = addRosterNames(emptyState(), ['y'.repeat(45)], 10);
    assert.equal(s.roster[0].name.length, 30);
  });
});

describe('sync shape migration', () => {
  test('the old lastPulledAt/lastPushedAt shape migrates to the empty shape', () => {
    const raw = JSON.parse(JSON.stringify(emptyState()));
    raw.sync = { lastPulledAt: '2025-01-01T00:00:00.000Z', lastPushedAt: 500 };
    const r = validateState(raw);
    assert.deepEqual(r.state.sync, EMPTY_SYNC);
    assert.equal(Object.hasOwn(r.state.sync, 'lastPulledAt'), false);
    assert.equal(Object.hasOwn(r.state.sync, 'lastPushedAt'), false);
  });

  test('missing or invalid sync values become the empty shape', () => {
    for (const sync of [undefined, null, 5, 'x', [], {}]) {
      const raw = { ...JSON.parse(JSON.stringify(emptyState())), sync };
      assert.deepEqual(validateState(raw).state.sync, EMPTY_SYNC);
    }
  });

  test('the new shape round-trips and is sanitized per field', () => {
    const good = {
      cursors: { games: 'G', players: 'P', settings: 'S' },
      serverVersions: { games: { a: 1 }, roster: { k: 2 }, settings: 3 },
      quarantine: { games: { a: 4 }, roster: { k: 5 } },
    };
    const state = { ...emptyState(), sync: good };
    assert.deepEqual(validateState(JSON.parse(JSON.stringify(state))).state.sync, good);
    const messy = {
      cursors: { games: 5, players: 'P', settings: null },
      serverVersions: { games: { a: 'x', b: 2 }, roster: 'no', settings: 'z' },
      quarantine: { games: { a: NaN, b: 7 } },
    };
    assert.deepEqual(validateState({ ...JSON.parse(JSON.stringify(emptyState())), sync: messy }).state.sync, {
      cursors: { games: null, players: 'P', settings: null },
      serverVersions: { games: { b: 2 }, roster: {}, settings: null },
      quarantine: { games: { b: 7 }, roster: {} },
    });
  });
});

describe('markPushed', () => {
  const pushedAll = {
    games: [{ id: 'g1', updatedAt: 10 }],
    gameDeletes: [{ id: 'g2', deletedAt: 20 }],
    roster: [{ key: 'ann', updatedAt: 30 }],
    rosterDeletes: [{ key: 'bob', deletedAt: 40 }],
    settings: 50,
  };

  test('sets serverVersions for every kind', () => {
    const s = markPushed(emptyState(), pushedAll);
    assert.deepEqual(s.sync.serverVersions, {
      games: { g1: 10, g2: 20 },
      roster: { ann: 30, bob: 40 },
      settings: 50,
    });
  });

  test('does not mutate the input state', () => {
    const input = emptyState();
    const before = clone(input);
    markPushed(input, pushedAll);
    assert.deepEqual(input, before);
  });

  test('returns the same reference when nothing changes', () => {
    const s = markPushed(emptyState(), pushedAll);
    assert.equal(markPushed(s, pushedAll), s);
    assert.equal(markPushed(s, {}), s);
    assert.equal(markPushed(s, { games: [], gameDeletes: [], roster: [], rosterDeletes: [], settings: null }), s);
    const e = emptyState();
    assert.equal(markPushed(e, { games: [], settings: null }), e);
  });

  test('a null settings value leaves the settings version untouched', () => {
    const s = markPushed(emptyState(), { settings: 50 });
    assert.equal(markPushed(s, { settings: null }), s);
    assert.equal(s.sync.serverVersions.settings, 50);
  });

  test('clears matching quarantine entries', () => {
    let s = markQuarantined(emptyState(), [
      { kind: 'game', id: 'g1', time: 10 },
      { kind: 'game', id: 'keep', time: 11 },
      { kind: 'roster', id: 'ann', time: 30 },
    ]);
    s = markPushed(s, { games: [{ id: 'g1', updatedAt: 10 }], roster: [{ key: 'ann', updatedAt: 30 }] });
    assert.deepEqual(s.sync.quarantine, { games: { keep: 11 }, roster: {} });
    assert.equal(s.sync.serverVersions.games.g1, 10);
  });
});

describe('markQuarantined', () => {
  test('records game and roster failures by time', () => {
    const s = markQuarantined(emptyState(), [
      { kind: 'game', id: 'g1', time: 10, reason: 'too large' },
      { kind: 'roster', id: 'ann', time: 20 },
    ]);
    assert.deepEqual(s.sync.quarantine, { games: { g1: 10 }, roster: { ann: 20 } });
  });

  test('returns the same reference for empty, repeated, or malformed input', () => {
    const e = emptyState();
    assert.equal(markQuarantined(e, []), e);
    assert.equal(markQuarantined(e, [{ kind: 'bogus', id: 'x', time: 1 }, { kind: 'game', id: 'x', time: 'no' }, null]), e);
    const s = markQuarantined(e, [{ kind: 'game', id: 'g1', time: 10 }]);
    assert.equal(markQuarantined(s, [{ kind: 'game', id: 'g1', time: 10 }]), s);
  });

  test('a newer time for the same id replaces the quarantined time', () => {
    const s = markQuarantined(emptyState(), [{ kind: 'game', id: 'g1', time: 10 }]);
    const n = markQuarantined(s, [{ kind: 'game', id: 'g1', time: 20 }]);
    assert.equal(n.sync.quarantine.games.g1, 20);
    assert.equal(s.sync.quarantine.games.g1, 10);
  });
});

describe('resetForOwner', () => {
  function populated(ownerId) {
    let s = upsertGame(emptyState(), { ...makeGame(), id: 'g1', shareToken: 'a'.repeat(22) });
    s = upsertGame(s, { ...makeGame(['Z']), id: 'g2' });
    s = deleteGame(s, 'g2', NOW + 100);
    s = addRosterNames(s, ['Ann'], NOW);
    s = updateSettings(s, { theme: 'dark' }, NOW);
    s = markQuarantined(markPushed(s, { games: [{ id: 'g1', updatedAt: NOW }], settings: NOW }), [{ kind: 'game', id: 'g1', time: 1 }]);
    s = setSyncMarks(s, { cursors: { games: 'C' } });
    return { ...s, ownerId };
  }

  test('keepData false returns an empty state with the same settings and the new owner', () => {
    const s = populated('u1');
    const r = resetForOwner(s, 'u2', { keepData: false });
    assert.deepEqual(r, { ...emptyState(), settings: s.settings, ownerId: 'u2' });
    assert.equal(r.settings, s.settings);
  });

  test('keepData true with a null previous owner keeps game ids and share tokens, resets sync and tombstones', () => {
    const s = populated(null);
    const r = resetForOwner(s, 'u1', { keepData: true });
    assert.equal(r.ownerId, 'u1');
    assert.deepEqual(r.games, s.games);
    assert.equal(r.games[0].shareToken, 'a'.repeat(22));
    assert.deepEqual(r.tombstones, { games: {}, roster: {} });
    assert.deepEqual(r.sync, EMPTY_SYNC);
    assert.deepEqual(r.roster, s.roster);
    assert.deepEqual(r.settings, s.settings);
  });

  test('keepData true with the same previous owner keeps game ids', () => {
    const s = populated('u1');
    const r = resetForOwner(s, 'u1', { keepData: true });
    assert.deepEqual(r.games, s.games);
    assert.deepEqual(r.sync, EMPTY_SYNC);
    assert.deepEqual(r.tombstones, { games: {}, roster: {} });
  });

  test('keepData true with a different non-null previous owner regenerates ids and nulls share tokens', () => {
    const s = populated('u1');
    const before = clone(s);
    const r = resetForOwner(s, 'u2', { keepData: true });
    assert.equal(r.ownerId, 'u2');
    assert.equal(r.games.length, s.games.length);
    for (const [i, game] of r.games.entries()) {
      assert.match(game.id, UUID_RE);
      assert.notEqual(game.id, s.games[i].id);
      assert.equal(game.shareToken, null);
      assert.deepEqual({ ...game, id: null }, { ...s.games[i], id: null, shareToken: null });
    }
    assert.deepEqual(r.tombstones, { games: {}, roster: {} });
    assert.deepEqual(r.sync, EMPTY_SYNC);
    assert.deepEqual(s, before);
  });
});
