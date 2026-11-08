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
    assert.deepEqual(result, { state, dropped: 0 });
  });

  test('returns null state for bad top-level values', () => {
    const bad = [null, undefined, 42, 'text', true, [], {}, { version: 2, games: [] }, { version: 1 }, { version: 1, games: 'x' }];
    for (const raw of bad) {
      assert.deepEqual(validateState(raw), { state: null, dropped: 0 });
    }
  });

  test('never throws on garbage input', () => {
    const garbage = [null, 42, { version: 2 }, 'x', [1, 2], { version: 1, games: [null, 1, 'x', []] }];
    for (const raw of garbage) {
      assert.doesNotThrow(() => validateState(raw));
    }
    assert.deepEqual(validateState({ version: 1, games: [null, 1, 'x', []] }), {
      state: { version: 1, games: [] },
      dropped: 4,
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
