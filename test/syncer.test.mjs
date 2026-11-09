import { describe, test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../js/store.js';
import { createGame, upsertGame } from '../js/model.js';
import { createSyncer } from '../js/syncer.js';
import { CloudError } from '../js/cloud.js';

const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const LOCAL = uid(1);
const REMOTE = uid(2);
const NULL_CURSORS = { games: null, players: null, settings: null };

function gameAt(id, updatedAt) {
  return { ...createGame({ name: id, players: ['A', 'B'] }, updatedAt), id, updatedAt };
}

// Mirrors what the real cloud returns: everything sent counts as pushed.
function acceptAll(p) {
  return {
    pushed: {
      games: p.games.map((g) => ({ id: g.id, updatedAt: g.updatedAt })),
      gameDeletes: p.gameDeletes.map((d) => ({ id: d.id, deletedAt: d.deletedAt })),
      roster: p.roster.map((e) => ({ key: e.key, updatedAt: e.updatedAt })),
      rosterDeletes: p.rosterDeletes.map((d) => ({ key: d.key, deletedAt: d.deletedAt })),
      settings: p.settings ? p.settings.updatedAt : null,
    },
    failed: [],
  };
}

function setup({ status = 'signed-in', games = [], clock = { t: 10_000 }, pull, push } = {}) {
  const store = createStore(null, () => clock.t);
  for (const g of games) store.update((s) => upsertGame(s, g));
  const log = [];
  const cloud = {
    getSession: () => ({ status, user: status === 'signed-in' ? { id: 'u1', email: 'a@b.co', name: 'A' } : null }),
    pull: async (cursors) => {
      log.push(['pull', cursors]);
      return pull ? pull(cursors) : { games: [], roster: [], settings: null, cursors: cursors ?? NULL_CURSORS };
    },
    push: async (p) => {
      log.push(['push', p]);
      return push ? push(p) : acceptAll(p);
    },
  };
  const syncer = createSyncer({ store, cloud, now: () => clock.t, debounceMs: 1500 });
  return { store, cloud, syncer, log, clock };
}

const names = (log) => log.map(([n]) => n);

describe('syncNow', () => {
  test('does nothing when the cloud is not signed in', async () => {
    for (const status of ['unknown', 'signed-out', 'unavailable']) {
      const { syncer, log } = setup({ status });
      await syncer.syncNow();
      assert.deepEqual(log, []);
      assert.equal(syncer.getStatus(), 'idle');
    }
  });

  test('runs pull, merge, push, marks in order', async () => {
    const remoteGame = gameAt(REMOTE, 2_000);
    const cursors = { games: '2026-01-01T00:00:05+00:00', players: null, settings: null };
    const { syncer, store, log } = setup({
      games: [gameAt(LOCAL, 3_000)],
      pull: async () => ({
        games: [{ id: REMOTE, data: remoteGame, deletedAt: null, shareToken: null, serverUpdatedAt: cursors.games }],
        roster: [],
        settings: null,
        cursors,
      }),
    });
    const events = [];
    const unsubscribe = store.subscribe((s) => {
      events.push(`state games=${s.games.length} cursor=${s.sync.cursors.games} pushed=${s.sync.serverVersions.games[LOCAL]}`);
    });
    const origPush = log.push.bind(log);
    log.push = (entry) => {
      if (entry[0] === 'push') events.push('push-called');
      return origPush(entry);
    };
    await syncer.syncNow();
    unsubscribe();
    assert.deepEqual(names(log), ['pull', 'push']);
    assert.deepEqual(events, [
      `state games=2 cursor=${cursors.games} pushed=undefined`,
      'push-called',
      `state games=2 cursor=${cursors.games} pushed=3000`,
    ]);
    assert.deepEqual(store.getState().games.map((g) => g.id).sort(), [LOCAL, REMOTE]);
    assert.equal(syncer.getStatus(), 'synced');
    const pushed = log.find(([n]) => n === 'push')[1];
    assert.deepEqual(pushed.games.map((g) => g.id), [LOCAL]);
  });

  test('pulls from the stored cursors', async () => {
    const cursors = { games: null, players: null, settings: '2026-02-02T00:00:00+00:00' };
    const { syncer, log, store } = setup({
      pull: async () => ({
        games: [],
        roster: [],
        settings: { data: { theme: 'dark', updatedAt: 1 }, serverUpdatedAt: cursors.settings },
        cursors,
      }),
    });
    await syncer.syncNow();
    assert.deepEqual(log[0][1], NULL_CURSORS);
    assert.deepEqual(store.getState().sync.cursors, cursors);
    await syncer.syncNow();
    const pulls = log.filter(([n]) => n === 'pull');
    assert.deepEqual(pulls[1][1], cursors);
  });

  test('applies markPushed: a pushed game is not pushed again', async () => {
    const { syncer, store, log } = setup({ games: [gameAt(LOCAL, 5_000)] });
    await syncer.syncNow();
    assert.equal(store.getState().sync.serverVersions.games[LOCAL], 5_000);
    await syncer.syncNow();
    assert.equal(names(log).filter((n) => n === 'push').length, 1);
    assert.equal(syncer.getStatus(), 'synced');
  });

  test('skips the push when nothing is pending', async () => {
    const { syncer, log } = setup();
    await syncer.syncNow();
    assert.deepEqual(names(log), ['pull']);
    assert.equal(syncer.getStatus(), 'synced');
  });

  test('a call during a run reruns exactly once', async () => {
    let release;
    let gate = new Promise((r) => {
      release = r;
    });
    let pulls = 0;
    const { syncer, log } = setup({
      pull: async () => {
        pulls += 1;
        if (pulls === 1) await gate;
        return { games: [], roster: [], settings: null };
      },
    });
    const first = syncer.syncNow();
    await new Promise((r) => setImmediate(r));
    assert.equal(pulls, 1);
    const second = syncer.syncNow();
    const third = syncer.syncNow();
    release();
    gate = null;
    await Promise.all([first, second, third]);
    assert.equal(names(log).filter((n) => n === 'pull').length, 2);
    // A later call starts a fresh run.
    await syncer.syncNow();
    assert.equal(names(log).filter((n) => n === 'pull').length, 3);
  });

  test('reports syncing then synced to onStatus listeners', async () => {
    const { syncer } = setup();
    const seen = [];
    const off = syncer.onStatus((s) => seen.push(s));
    await syncer.syncNow();
    off();
    await syncer.syncNow();
    assert.deepEqual(seen, ['syncing', 'synced']);
  });
});

describe('error statuses', () => {
  const failing = (err) => ({
    pull: async () => {
      throw err;
    },
  });

  test('offline sets offline', async () => {
    const { syncer } = setup(failing(new CloudError('offline')));
    await syncer.syncNow();
    assert.equal(syncer.getStatus(), 'offline');
  });

  test('signed-out stays idle', async () => {
    const { syncer } = setup(failing(new CloudError('signed-out')));
    await syncer.syncNow();
    assert.equal(syncer.getStatus(), 'idle');
  });

  test('other errors set error and warn without leaking details', async () => {
    const warn = mock.method(console, 'warn', () => {});
    try {
      const { syncer } = setup(failing(new CloudError('http-500', 'secret-ish detail')));
      await syncer.syncNow();
      assert.equal(syncer.getStatus(), 'error');
      assert.equal(warn.mock.callCount(), 1);
      assert.doesNotMatch(JSON.stringify(warn.mock.calls[0].arguments), /secret-ish/);
    } finally {
      warn.mock.restore();
    }
  });

  test('a thrown push marks nothing and the next run recovers', async () => {
    let fail = true;
    const warn = mock.method(console, 'warn', () => {});
    try {
      const { syncer, store } = setup({
        games: [gameAt(LOCAL, 5_000)],
        push: async (p) => {
          if (fail) throw new CloudError('http-500');
          return acceptAll(p);
        },
      });
      await syncer.syncNow();
      assert.equal(syncer.getStatus(), 'error');
      assert.equal(store.getState().sync.serverVersions.games[LOCAL], undefined);
      fail = false;
      await syncer.syncNow();
      assert.equal(syncer.getStatus(), 'synced');
      assert.equal(store.getState().sync.serverVersions.games[LOCAL], 5_000);
    } finally {
      warn.mock.restore();
    }
  });

  test('failed rows are quarantined, set error, warn once, and are skipped until edited', async () => {
    const warn = mock.method(console, 'warn', () => {});
    try {
      const good = uid(3);
      const { syncer, store, log, clock } = setup({
        games: [gameAt(LOCAL, 5_000), gameAt(good, 6_000)],
        push: async (p) => {
          const res = acceptAll({ ...p, games: p.games.filter((g) => g.id !== LOCAL) });
          return { ...res, failed: p.games.some((g) => g.id === LOCAL) ? [{ kind: 'game', id: LOCAL, time: 5_000 }] : [] };
        },
      });
      await syncer.syncNow();
      assert.equal(syncer.getStatus(), 'error');
      const sync = store.getState().sync;
      assert.equal(sync.serverVersions.games[good], 6_000);
      assert.equal(sync.serverVersions.games[LOCAL], undefined);
      assert.equal(sync.quarantine.games[LOCAL], 5_000);
      assert.equal(warn.mock.callCount(), 1);
      // Quarantined: not pushed again, and the next run is clean.
      await syncer.syncNow();
      assert.equal(names(log).filter((n) => n === 'push').length, 1);
      assert.equal(syncer.getStatus(), 'synced');
      assert.equal(warn.mock.callCount(), 1);
      // An edit changes the item time, which lifts the quarantine.
      clock.t = 20_000;
      store.update((s) => upsertGame(s, gameAt(LOCAL, 7_000)));
      await syncer.syncNow();
      assert.equal(names(log).filter((n) => n === 'push').length, 2);
      assert.deepEqual(log.filter(([n]) => n === 'push')[1][1].games.map((g) => g.id), [LOCAL]);
    } finally {
      warn.mock.restore();
    }
  });

  test('invalid rows from collectPush are quarantined and set error without being pushed', async () => {
    const warn = mock.method(console, 'warn', () => {});
    try {
      const { syncer, store, log } = setup({ games: [gameAt('not-a-uuid', 5_000), gameAt(LOCAL, 6_000)] });
      await syncer.syncNow();
      assert.equal(syncer.getStatus(), 'error');
      const pushed = log.find(([n]) => n === 'push')[1];
      assert.deepEqual(pushed.games.map((g) => g.id), [LOCAL]);
      const sync = store.getState().sync;
      assert.equal(sync.quarantine.games['not-a-uuid'], 5_000);
      assert.equal(sync.serverVersions.games[LOCAL], 6_000);
      assert.equal(warn.mock.callCount(), 1);
    } finally {
      warn.mock.restore();
    }
  });

  test('only invalid rows: no push call, quarantined, error', async () => {
    const warn = mock.method(console, 'warn', () => {});
    try {
      const { syncer, store, log } = setup({ games: [gameAt('not-a-uuid', 5_000)] });
      await syncer.syncNow();
      assert.deepEqual(names(log), ['pull']);
      assert.equal(syncer.getStatus(), 'error');
      assert.equal(store.getState().sync.quarantine.games['not-a-uuid'], 5_000);
    } finally {
      warn.mock.restore();
    }
  });
});

describe('schedule', () => {
  afterEach(() => {
    mock.timers.reset();
  });

  test('debounces syncNow', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const { syncer, log } = setup();
    syncer.schedule();
    mock.timers.tick(1000);
    syncer.schedule();
    mock.timers.tick(1000);
    syncer.schedule();
    mock.timers.tick(1499);
    await new Promise((r) => setImmediate(r));
    assert.equal(log.length, 0);
    mock.timers.tick(1);
    await new Promise((r) => setImmediate(r));
    assert.equal(names(log).filter((n) => n === 'pull').length, 1);
    mock.timers.tick(10_000);
    await new Promise((r) => setImmediate(r));
    assert.equal(names(log).filter((n) => n === 'pull').length, 1);
  });

  test('a scheduled sync while signed out does nothing', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const { syncer, log } = setup({ status: 'signed-out' });
    syncer.schedule();
    mock.timers.tick(1500);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(log, []);
  });
});
