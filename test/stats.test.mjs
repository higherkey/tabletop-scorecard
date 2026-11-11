import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStats } from '../js/stats.js';

// Plain-object fixture builder: players are names, rows are per-round score arrays aligned to players.
function makeGame({ id, name = 'Game', players, rows = [], finishedAt = 1000, lowWins = false }) {
  const pl = players.map((n, i) => ({ id: `${id}-p${i}`, name: n, color: i }));
  const rounds = rows.map((row, r) => ({
    id: `${id}-r${r}`,
    scores: Object.fromEntries(row.map((v, i) => [pl[i].id, v])),
  }));
  return {
    id,
    name,
    createdAt: 0,
    updatedAt: 0,
    lowWins,
    finishedAt,
    shareToken: null,
    players: pl,
    rounds,
  };
}

describe('computeStats', () => {
  test('ignores unfinished games', () => {
    const games = [
      makeGame({ id: 'a', name: 'Chess', players: ['Ann', 'Ben'], rows: [[5, 1]], finishedAt: null }),
      makeGame({ id: 'b', name: 'Chess', players: ['Cal', 'Dee'], rows: [[2, 9]], finishedAt: 1000 }),
    ];
    const stats = computeStats(games);
    assert.equal(stats.gamesPlayed, 1);
    assert.deepEqual(stats.gameNames, [{ name: 'Chess', count: 1 }]);
    assert.deepEqual(
      stats.players.map((p) => p.name).sort(),
      ['Cal', 'Dee'],
    );
  });

  test('ties give every rank-1 player a win', () => {
    const games = [
      makeGame({ id: 'a', players: ['Ann', 'Ben', 'Cal'], rows: [[5, 5, 1]] }),
    ];
    const stats = computeStats(games);
    const byKey = Object.fromEntries(stats.players.map((p) => [p.key, p]));
    assert.equal(byKey.ann.wins, 1);
    assert.equal(byKey.ben.wins, 1);
    assert.equal(byKey.cal.wins, 0);
    assert.equal(byKey.cal.played, 1);
  });

  test('lowWins games award the win to the lowest total', () => {
    const games = [
      makeGame({ id: 'a', players: ['Ann', 'Ben'], rows: [[3, 7]], lowWins: true }),
    ];
    const stats = computeStats(games);
    const byKey = Object.fromEntries(stats.players.map((p) => [p.key, p]));
    assert.equal(byKey.ann.wins, 1);
    assert.equal(byKey.ben.wins, 0);
  });

  test('groups players case-insensitively and uses the name from the most recent finishedAt', () => {
    const newerFirst = [
      makeGame({ id: 'a', players: ['Alice', 'Bob'], rows: [[1, 2]], finishedAt: 2000 }),
      makeGame({ id: 'b', players: ['alice', 'Bob'], rows: [[1, 2]], finishedAt: 1000 }),
    ];
    const statsA = computeStats(newerFirst);
    assert.equal(statsA.players.length, 2);
    const alice = statsA.players.find((p) => p.key === 'alice');
    assert.equal(alice.name, 'Alice');
    assert.equal(alice.played, 2);

    const olderFirst = [
      makeGame({ id: 'c', players: ['ALICE', 'Bob'], rows: [[1, 2]], finishedAt: 1000 }),
      makeGame({ id: 'd', players: ['alice', 'Bob'], rows: [[1, 2]], finishedAt: 2000 }),
    ];
    const statsB = computeStats(olderFirst);
    const alice2 = statsB.players.find((p) => p.key === 'alice');
    assert.equal(alice2.name, 'alice');
    assert.equal(alice2.played, 2);
  });

  test('computes winRate, avgScore rounded to 1 decimal, and highScore', () => {
    const games = [
      makeGame({ id: 'a', players: ['Ann', 'Ben'], rows: [[10, 20]], finishedAt: 1000 }),
      makeGame({ id: 'b', players: ['Ann', 'Ben'], rows: [[11, 5]], finishedAt: 2000 }),
      makeGame({ id: 'c', players: ['Ann', 'Ben'], rows: [[11, 12]], finishedAt: 3000 }),
    ];
    const stats = computeStats(games);
    const ann = stats.players.find((p) => p.key === 'ann');
    assert.equal(ann.played, 3);
    assert.equal(ann.wins, 1);
    assert.equal(ann.winRate, 1 / 3);
    assert.equal(ann.avgScore, 10.7);
    assert.equal(ann.highScore, 11);
  });

  test('gameName filter is case-insensitive and gameNames still counts all finished games', () => {
    const games = [
      makeGame({ id: 'a', name: 'Catan', players: ['Ann', 'Ben'], rows: [[5, 1]], finishedAt: 1000 }),
      makeGame({ id: 'b', name: 'CATAN', players: ['Cal', 'Ben'], rows: [[2, 9]], finishedAt: 2000 }),
      makeGame({ id: 'c', name: 'Uno', players: ['Dee', 'Ann'], rows: [[7, 3]], finishedAt: 3000 }),
      makeGame({ id: 'd', name: 'Catan', players: ['Eve', 'Ann'], rows: [[1, 1]], finishedAt: null }),
    ];
    const stats = computeStats(games, { gameName: 'catan' });
    assert.equal(stats.gamesPlayed, 2);
    assert.deepEqual(
      stats.players.map((p) => p.key).sort(),
      ['ann', 'ben', 'cal'],
    );
    assert.equal(stats.players.find((p) => p.key === 'dee'), undefined);
    assert.deepEqual(stats.gameNames, [
      { name: 'CATAN', count: 2 },
      { name: 'Uno', count: 1 },
    ]);
  });

  test('sorts players by wins desc, winRate desc, then name asc', () => {
    const games = [
      makeGame({ id: 'g1', players: ['Dee', 'Xi'], rows: [[10, 1]], finishedAt: 1 }),
      makeGame({ id: 'g2', players: ['Dee', 'Xi'], rows: [[10, 1]], finishedAt: 2 }),
      makeGame({ id: 'g3', players: ['Dee', 'Xi'], rows: [[1, 10]], finishedAt: 3 }),
      makeGame({ id: 'g4', players: ['Dee', 'Xi'], rows: [[1, 10]], finishedAt: 4 }),
      makeGame({ id: 'g5', players: ['Yan', 'Zoe'], rows: [[5, 1]], finishedAt: 5 }),
      makeGame({ id: 'g6', players: ['Yan', 'Zoe'], rows: [[5, 1]], finishedAt: 6 }),
      makeGame({ id: 'g7', players: ['Yan', 'Zoe'], rows: [[1, 5]], finishedAt: 7 }),
      makeGame({ id: 'g8', players: ['Bo', 'Pip'], rows: [[5, 1]], finishedAt: 8 }),
    ];
    const stats = computeStats(games);
    assert.deepEqual(
      stats.players.map((p) => p.name),
      ['Yan', 'Dee', 'Xi', 'Bo', 'Zoe', 'Pip'],
    );
  });

  test('sorts gameNames by count desc, then name asc', () => {
    const games = [
      makeGame({ id: 'a', name: 'Uno', players: ['Ann', 'Ben'], rows: [[1, 2]], finishedAt: 1 }),
      makeGame({ id: 'b', name: 'Catan', players: ['Ann', 'Ben'], rows: [[1, 2]], finishedAt: 2 }),
      makeGame({ id: 'c', name: 'Catan', players: ['Ann', 'Ben'], rows: [[1, 2]], finishedAt: 3 }),
      makeGame({ id: 'd', name: 'azul', players: ['Ann', 'Ben'], rows: [[1, 2]], finishedAt: 4 }),
      makeGame({ id: 'e', name: 'azul', players: ['Ann', 'Ben'], rows: [[1, 2]], finishedAt: 5 }),
      makeGame({ id: 'f', name: 'Chess', players: ['Ann', 'Ben'], rows: [[1, 2]], finishedAt: 6 }),
    ];
    const stats = computeStats(games);
    assert.deepEqual(stats.gameNames, [
      { name: 'azul', count: 2 },
      { name: 'Catan', count: 2 },
      { name: 'Chess', count: 1 },
      { name: 'Uno', count: 1 },
    ]);
  });

  test('empty input gives an empty result', () => {
    assert.deepEqual(computeStats([]), { gamesPlayed: 0, gameNames: [], players: [] });
  });
});
