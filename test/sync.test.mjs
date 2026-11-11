import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyState,
  createGame,
  upsertGame,
  deleteGame,
  addRosterNames,
  removeRosterEntry,
  updateSettings,
  setSyncMarks,
  markPushed,
  markQuarantined,
  setOwner,
} from '../js/model.js';
import { mergeRemote, collectPush, isEmptyPush, unownedCount } from '../js/sync.js';

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function gameAt(id, updatedAt, extra = {}) {
  const g = createGame({ name: id, players: ['A', 'B'] }, updatedAt);
  return { ...g, id, updatedAt, ...extra };
}

const rg = (game, over = {}) => ({
  id: game.id,
  data: game,
  deletedAt: null,
  shareToken: null,
  serverUpdatedAt: '2025-01-01T00:00:00.000Z',
  ...over,
});

describe('mergeRemote games', () => {
  test('remote newer wins', () => {
    const s = upsertGame(emptyState(), gameAt('g', 100, { name: 'local' }));
    const next = mergeRemote(s, { games: [rg(gameAt('g', 200, { name: 'remote' }))] });
    assert.equal(next.games[0].name, 'remote');
    assert.equal(s.games[0].name, 'local');
  });

  test('remote delete row with data: null removes the local game (as pulled from the DB)', () => {
    const s = markPushed(upsertGame(emptyState(), gameAt('g', 100)), { games: [{ id: 'g', updatedAt: 100 }] });
    const next = mergeRemote(s, { games: [{ id: 'g', data: null, deletedAt: 200, shareToken: null, serverUpdatedAt: '2025-01-02T00:00:00.000Z' }] });
    assert.equal(next.games.length, 0);
    assert.equal(next.tombstones.games.g, 200);
    assert.equal(next.sync.serverVersions.games.g, 200);
  });

  test('remote delete row with data: null and no id is ignored', () => {
    const s = upsertGame(emptyState(), gameAt('g', 100));
    assert.equal(mergeRemote(s, { games: [{ data: null, deletedAt: 200 }] }).games.length, 1);
  });

  test('remote shareToken is applied', () => {
    const tok = 'a'.repeat(22);
    const next = mergeRemote(emptyState(), { games: [rg(gameAt('g', 1), { shareToken: tok })] });
    assert.equal(next.games[0].shareToken, tok);
  });

  test('local newer kept; ties keep local and record the server version', () => {
    const s = upsertGame(emptyState(), gameAt('g', 200, { name: 'local' }));
    assert.equal(mergeRemote(s, { games: [rg(gameAt('g', 100, { name: 'r' }))] }), s);
    const tie = mergeRemote(s, { games: [rg(gameAt('g', 200, { name: 'r' }))] });
    assert.equal(tie.games[0].name, 'local');
    assert.equal(tie.sync.serverVersions.games.g, 200);
    assert.equal(tie.games.length, 1);
    const known = markPushed(s, { games: [{ id: 'g', updatedAt: 200 }] });
    assert.equal(mergeRemote(known, { games: [rg(gameAt('g', 200, { name: 'r' }))] }), known);
  });

  test('remote delete beats older local edit', () => {
    const s = markPushed(upsertGame(emptyState(), gameAt('g', 100)), { games: [{ id: 'g', updatedAt: 100 }] });
    const next = mergeRemote(s, { games: [rg(gameAt('g', 50), { deletedAt: 150 })] });
    assert.equal(next.games.length, 0);
    assert.equal(next.tombstones.games.g, 150);
  });

  test('newer local edit beats older remote delete', () => {
    const s = upsertGame(emptyState(), gameAt('g', 300));
    const next = mergeRemote(s, { games: [rg(gameAt('g', 50), { deletedAt: 150 })] });
    assert.equal(next.games.length, 1);
    assert.equal(next.tombstones.games.g, undefined);
  });

  test('local tombstone blocks older remote live row; newer live row resurrects', () => {
    const s = deleteGame(upsertGame(emptyState(), gameAt('g', 100)), 'g', 500);
    const blocked = mergeRemote(s, { games: [rg(gameAt('g', 400))] });
    assert.equal(blocked.games.length, 0);
    assert.equal(blocked.tombstones.games.g, 500);
    const back = mergeRemote(s, { games: [rg(gameAt('g', 600))] });
    assert.equal(back.games.length, 1);
    assert.equal(back.tombstones.games.g, undefined);
  });

  test('invalid remote data is ignored', () => {
    const s = emptyState();
    const next = mergeRemote(s, { games: [{ id: 'x', data: { id: 'x' }, deletedAt: null }, { id: 'y', data: null }] });
    assert.deepEqual(next.games, []);
    assert.deepEqual(next.tombstones.games, {});
    const bad = mergeRemote(s, { roster: [{ key: 'Bad', name: 'x', color: 1, updatedAt: 1, deletedAt: null }] });
    assert.deepEqual(bad.roster, []);
  });

  test('empty remote returns same reference', () => {
    const s = emptyState();
    assert.equal(mergeRemote(s, {}), s);
    assert.equal(mergeRemote(s, { games: [], roster: [], settings: null }), s);
  });
});

describe('mergeRemote roster and settings', () => {
  const rr = (key, name, updatedAt, over = {}) => ({
    key, name, color: 2, updatedAt, deletedAt: null, serverUpdatedAt: '2025-01-01T00:00:00.000Z', ...over,
  });

  test('remote roster newer wins; ties keep local', () => {
    const s = addRosterNames(emptyState(), ['Ann'], 100);
    const win = mergeRemote(s, { roster: [rr('ann', 'Ann', 200)] });
    assert.equal(win.roster[0].color, 2);
    assert.equal(win.roster[0].updatedAt, 200);
    const tie = mergeRemote(s, { roster: [rr('ann', 'Ann', 100)] });
    assert.equal(tie.roster[0].color, 0);
  });

  test('remote roster delete and tombstone blocking', () => {
    const s = addRosterNames(emptyState(), ['Ann'], 100);
    const del = mergeRemote(s, { roster: [rr('ann', 'Ann', 100, { deletedAt: 150 })] });
    assert.deepEqual(del.roster, []);
    assert.equal(del.tombstones.roster.ann, 150);
    const kept = mergeRemote(s, { roster: [rr('ann', 'Ann', 100, { deletedAt: 50 })] });
    assert.equal(kept.roster.length, 1);
    const t = removeRosterEntry(s, 'ann', 500);
    assert.equal(mergeRemote(t, { roster: [rr('ann', 'Ann', 400)] }).roster.length, 0);
    const res = mergeRemote(t, { roster: [rr('ann', 'Ann', 600)] });
    assert.equal(res.roster.length, 1);
    assert.equal(res.tombstones.roster.ann, undefined);
  });

  test('settings adopted only when remote newer', () => {
    const s = updateSettings(emptyState(), { theme: 'dark' }, 100);
    const remote = (updatedAt, theme) => ({
      data: { theme, defaultLowWins: true, keepAwake: true, haptics: true, updatedAt },
      serverUpdatedAt: 'S1',
    });
    assert.equal(mergeRemote(s, { settings: remote(50, 'light') }).settings.theme, 'dark');
    assert.equal(mergeRemote(s, { settings: remote(100, 'light') }).settings.theme, 'dark');
    const newer = mergeRemote(s, { settings: remote(200, 'light') });
    assert.equal(newer.settings.theme, 'light');
    assert.equal(newer.settings.updatedAt, 200);
    assert.equal(newer.settings.defaultLowWins, true);
  });

  test('adopting remote rows sets serverVersions and never touches cursors', () => {
    const s = emptyState();
    const a = mergeRemote(s, {
      games: [rg(gameAt('g', 11)), rg(gameAt('h', 1), { deletedAt: 12 })],
      roster: [rr('k', 'K', 13), rr('j', 'J', 1, { deletedAt: 14 })],
      settings: { data: { theme: 'dark', defaultLowWins: false, keepAwake: true, haptics: true, updatedAt: 15 }, serverUpdatedAt: 'S' },
    });
    assert.deepEqual(a.sync.serverVersions, {
      games: { g: 11, h: 12 },
      roster: { k: 13, j: 14 },
      settings: 15,
    });
    assert.deepEqual(a.sync.cursors, s.sync.cursors);
    assert.equal(a.settings.theme, 'dark');
    assert.equal(isEmptyPush(collectPush(a)), true);
  });

  test('roster and settings ties record the server version; older remote does not', () => {
    const r = addRosterNames(emptyState(), ['Ann'], 100);
    const tie = mergeRemote(r, { roster: [rr('ann', 'Ann', 100)] });
    assert.equal(tie.sync.serverVersions.roster.ann, 100);
    assert.equal(tie.roster[0].color, 0);
    const older = mergeRemote(r, { roster: [rr('ann', 'Ann', 50)] });
    assert.equal(older, r);
    const st = updateSettings(emptyState(), { theme: 'dark' }, 100);
    const remote = (updatedAt) => ({ data: { theme: 'light', defaultLowWins: false, keepAwake: true, haptics: true, updatedAt }, serverUpdatedAt: 'S' });
    const stTie = mergeRemote(st, { settings: remote(100) });
    assert.equal(stTie.settings.theme, 'dark');
    assert.equal(stTie.sync.serverVersions.settings, 100);
    assert.equal(mergeRemote(st, { settings: remote(50) }), st);
  });
});

describe('mergeRemote conflict copies', () => {
  test('a newer remote row over unpushed local edits keeps a conflict copy that will push', () => {
    const s = upsertGame(emptyState(), gameAt('g', 100, { name: 'local', shareToken: 'a'.repeat(22) }));
    const next = mergeRemote(s, { games: [rg(gameAt('g', 200, { name: 'remote' }))] });
    assert.equal(next.games.length, 2);
    const original = next.games.find((g) => g.id === 'g');
    const copy = next.games.find((g) => g.id !== 'g');
    assert.equal(original.name, 'remote');
    assert.equal(copy.name, 'local (conflict copy)');
    assert.match(copy.id, UUID_RE);
    assert.equal(copy.shareToken, null);
    assert.equal(copy.updatedAt, 100);
    assert.deepEqual(copy.players, s.games[0].players);
    assert.equal(next.sync.serverVersions.games.g, 200);
    assert.equal(next.sync.serverVersions.games[copy.id], undefined);
    assert.equal(s.games.length, 1);
    assert.equal(s.games[0].name, 'local');
  });

  test('a conflict copy is collected by the next push', () => {
    const s = upsertGame(emptyState(), gameAt(uuid(1), 100, { name: 'local' }));
    const next = mergeRemote(s, { games: [rg(gameAt(uuid(1), 200, { name: 'remote' }))] });
    const copy = next.games.find((g) => g.id !== uuid(1));
    assert.deepEqual(collectPush(next).games.map((g) => g.id), [copy.id]);
  });

  test('a newer remote delete over unpushed local edits keeps a conflict copy', () => {
    const s = upsertGame(emptyState(), gameAt('g', 100, { name: 'local' }));
    const next = mergeRemote(s, { games: [rg(gameAt('g', 50), { deletedAt: 150 })] });
    assert.equal(next.games.length, 1);
    assert.equal(next.games[0].name, 'local (conflict copy)');
    assert.notEqual(next.games[0].id, 'g');
    assert.equal(next.tombstones.games.g, 150);
    assert.equal(next.sync.serverVersions.games.g, 150);
  });

  test('no copy when the local game was already pushed', () => {
    const s = markPushed(upsertGame(emptyState(), gameAt('g', 100, { name: 'local' })), { games: [{ id: 'g', updatedAt: 100 }] });
    const next = mergeRemote(s, { games: [rg(gameAt('g', 200, { name: 'remote' }))] });
    assert.equal(next.games.length, 1);
    assert.equal(next.games[0].name, 'remote');
    const del = mergeRemote(s, { games: [rg(gameAt('g', 50), { deletedAt: 150 })] });
    assert.equal(del.games.length, 0);
  });

  test('no copy when the remote row is not newer, or when there is no local game', () => {
    const s = upsertGame(emptyState(), gameAt('g', 300, { name: 'local' }));
    const older = mergeRemote(s, { games: [rg(gameAt('g', 200, { name: 'remote' }))] });
    assert.equal(older, s);
    const fresh = mergeRemote(emptyState(), { games: [rg(gameAt('g', 200))] });
    assert.equal(fresh.games.length, 1);
    const tomb = deleteGame(upsertGame(emptyState(), gameAt('g', 100)), 'g', 500);
    const back = mergeRemote(tomb, { games: [rg(gameAt('g', 600))] });
    assert.equal(back.games.length, 1);
  });
});

describe('collectPush, isEmptyPush, unownedCount', () => {
  const [A, B, C, D, E] = [1, 2, 3, 4, 5].map(uuid);

  test('collectPush uses serverVersions, not a time threshold', () => {
    let s = emptyState();
    s = upsertGame(s, gameAt(A, 100));
    s = upsertGame(s, gameAt(B, 300));
    s = upsertGame(s, gameAt(C, 50));
    s = deleteGame(s, C, 400);
    s = addRosterNames(s, ['Ann'], 500);
    s = addRosterNames(s, ['Bob'], 100);
    s = removeRosterEntry(addRosterNames(s, ['Cy'], 1), 'cy', 600);
    s = updateSettings(s, { theme: 'dark' }, 700);
    s = markPushed(s, {
      games: [{ id: A, updatedAt: 100 }],
      roster: [{ key: 'bob', updatedAt: 100 }],
    });
    const p = collectPush(s);
    assert.deepEqual(p.games.map((g) => g.id), [B]);
    assert.deepEqual(p.gameDeletes, [{ id: C, deletedAt: 400 }]);
    assert.deepEqual(p.roster.map((e) => e.key), ['ann']);
    assert.deepEqual(p.rosterDeletes, [{ key: 'cy', deletedAt: 600 }]);
    assert.equal(p.settings.theme, 'dark');
    assert.deepEqual(p.invalid, []);
    assert.equal(isEmptyPush(p), false);
  });

  test('an older-than-server game still pushes when its time differs from serverVersions', () => {
    let s = upsertGame(emptyState(), gameAt(A, 100));
    s = markPushed(s, { games: [{ id: A, updatedAt: 999 }] });
    assert.deepEqual(collectPush(s).games.map((g) => g.id), [A]);
  });

  test('items equal to their serverVersions are not pushed; empty push', () => {
    let s = upsertGame(emptyState(), gameAt(A, 200));
    s = updateSettings(s, { theme: 'dark' }, 200);
    s = markPushed(s, { games: [{ id: A, updatedAt: 200 }], settings: 200 });
    const p = collectPush(s);
    assert.deepEqual(p, { games: [], gameDeletes: [], roster: [], rosterDeletes: [], settings: null, invalid: [] });
    assert.equal(isEmptyPush(p), true);
  });

  test('default settings (updatedAt 0) are never pushed', () => {
    assert.equal(collectPush(emptyState()).settings, null);
  });

  test('a quarantined item is skipped until its time changes', () => {
    let s = upsertGame(emptyState(), gameAt(A, 100));
    s = addRosterNames(s, ['Ann'], 100);
    s = deleteGame(upsertGame(s, gameAt(B, 10)), B, 100);
    s = markQuarantined(s, [
      { kind: 'game', id: A, time: 100 },
      { kind: 'game', id: B, time: 100 },
      { kind: 'roster', id: 'ann', time: 100 },
    ]);
    assert.equal(isEmptyPush(collectPush(s)), true);
    const edited = upsertGame(s, gameAt(A, 101));
    assert.deepEqual(collectPush(edited).games.map((g) => g.id), [A]);
    const removed = removeRosterEntry(s, 'ann', 150);
    assert.deepEqual(collectPush(removed).rosterDeletes, [{ key: 'ann', deletedAt: 150 }]);
    assert.equal(collectPush(s).games.length, 0);
  });

  test('markPushed clears quarantine so a later edit to the same id pushes', () => {
    let s = markQuarantined(upsertGame(emptyState(), gameAt(A, 100)), [{ kind: 'game', id: A, time: 100 }]);
    s = markPushed(s, { games: [{ id: A, updatedAt: 100 }] });
    assert.deepEqual(s.sync.quarantine, { games: {}, roster: {} });
    assert.equal(isEmptyPush(collectPush(s)), true);
    assert.equal(collectPush(upsertGame(s, gameAt(A, 101))).games.length, 1);
  });

  test('games with a non-UUID id go to invalid, not games', () => {
    let s = upsertGame(emptyState(), gameAt('not-a-uuid', 100));
    s = upsertGame(s, gameAt(A, 200));
    const p = collectPush(s);
    assert.deepEqual(p.games.map((g) => g.id), [A]);
    assert.equal(p.invalid.length, 1);
    assert.deepEqual({ ...p.invalid[0], reason: undefined }, { kind: 'game', id: 'not-a-uuid', time: 100, reason: undefined });
    assert.equal(typeof p.invalid[0].reason, 'string');
    assert.equal(isEmptyPush(p), false);
  });

  test('uppercase UUIDs are valid ids', () => {
    const s = upsertGame(emptyState(), gameAt('ABCDEF01-ABCD-4BCD-8BCD-ABCDEF012345', 100));
    assert.equal(collectPush(s).games.length, 1);
    assert.equal(collectPush(s).invalid.length, 0);
  });

  test('oversized games go to invalid, not games', () => {
    const big = gameAt(D, 100, { name: 'x'.repeat(250000) });
    const ok = gameAt(E, 100, { name: 'x'.repeat(1000) });
    const p = collectPush(upsertGame(upsertGame(emptyState(), big), ok));
    assert.deepEqual(p.games.map((g) => g.id), [E]);
    assert.equal(p.invalid.length, 1);
    assert.equal(p.invalid[0].id, D);
    assert.equal(p.invalid[0].kind, 'game');
    assert.equal(p.invalid[0].time, 100);
    assert.equal(typeof p.invalid[0].reason, 'string');
  });

  test('isEmptyPush ignores invalid', () => {
    const p = collectPush(upsertGame(emptyState(), gameAt('bad', 100)));
    assert.equal(p.invalid.length, 1);
    assert.equal(isEmptyPush(p), true);
  });

  test('unownedCount', () => {
    const s = upsertGame(upsertGame(emptyState(), gameAt('a', 1)), gameAt('b', 2));
    assert.equal(unownedCount(s, 'u1'), 2);
    assert.equal(unownedCount(setOwner(s, 'u1'), 'u1'), 0);
    assert.equal(unownedCount(setOwner(s, 'u2'), 'u1'), 2);
  });
});
