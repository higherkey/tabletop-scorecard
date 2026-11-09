import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, STORAGE_KEY, BACKUP_PREFIX, safeLocalStorage } from '../js/store.js';
import { createGame, emptyState, upsertGame, validateState } from '../js/model.js';

function fakeStorage(initial = {}) {
  const storage = {
    data: new Map(Object.entries(initial)),
    getItem(k) {
      return storage.data.has(k) ? storage.data.get(k) : null;
    },
    setItem(k, v) {
      storage.data.set(k, String(v));
    },
    removeItem(k) {
      storage.data.delete(k);
    },
    key(i) {
      return [...storage.data.keys()][i] ?? null;
    },
    get length() {
      return storage.data.size;
    },
  };
  return storage;
}

function throwingStorage() {
  return {
    data: new Map(),
    getItem() {
      return null;
    },
    setItem() {
      throw new Error('QuotaExceededError');
    },
  };
}

function sampleGame(name = 'Sample') {
  return createGame({ name, players: ['Ann', 'Ben'] }, 1000);
}

describe('safeLocalStorage', () => {
  test('returns null in Node where window is undefined', () => {
    assert.equal(typeof window, 'undefined');
    assert.equal(safeLocalStorage(), null);
  });
});

describe('createStore load', () => {
  test('empty storage loads emptyState with ok status', () => {
    const store = createStore(fakeStorage(), () => 1);
    assert.deepEqual(store.getState(), emptyState());
    assert.equal(store.getPersistStatus(), 'ok');
  });

  test('a valid round-trip restores the same state', () => {
    const storage = fakeStorage();
    const first = createStore(storage, () => 1);
    const game = sampleGame();
    first.update((s) => upsertGame(s, game));

    const second = createStore(storage, () => 2);
    assert.deepEqual(second.getState(), first.getState());
    assert.equal(second.getState().games[0].name, 'Sample');
    assert.equal(storage.data.has(BACKUP_PREFIX + 2), false);
  });

  test('corrupt JSON writes a backup and does not overwrite STORAGE_KEY', () => {
    const corrupt = '{not valid json';
    const storage = fakeStorage({ [STORAGE_KEY]: corrupt });
    const store = createStore(storage, () => 1234);

    assert.equal(storage.data.get(BACKUP_PREFIX + 1234), corrupt);
    assert.equal(storage.data.get(STORAGE_KEY), corrupt);
    assert.deepEqual(store.getState(), emptyState());
  });

  test('invalid top-level state writes a backup and does not overwrite STORAGE_KEY', () => {
    const raw = JSON.stringify({ version: 3, games: [] });
    const storage = fakeStorage({ [STORAGE_KEY]: raw });
    const store = createStore(storage, () => 77);

    assert.equal(storage.data.get(BACKUP_PREFIX + 77), raw);
    assert.equal(storage.data.get(STORAGE_KEY), raw);
    assert.deepEqual(store.getState(), emptyState());
  });

  test('dropped games write a backup, then persist the normalized state with the valid games', () => {
    const good = sampleGame('Keep');
    const raw = JSON.stringify({ version: 1, games: [good, { id: 3 }] });
    const storage = fakeStorage({ [STORAGE_KEY]: raw });
    const store = createStore(storage, () => 555);

    assert.equal(storage.data.get(BACKUP_PREFIX + 555), raw);
    assert.equal(store.getState().games.length, 1);
    assert.equal(store.getState().games[0].name, 'Keep');
    assert.deepEqual(validateState(JSON.parse(storage.data.get(STORAGE_KEY))).state, store.getState());
    assert.equal(JSON.parse(storage.data.get(STORAGE_KEY)).games.length, 1);
  });

  test('valid storage writes no backup', () => {
    const raw = JSON.stringify(emptyState());
    const storage = fakeStorage({ [STORAGE_KEY]: raw });
    createStore(storage, () => 9);
    assert.equal(storage.data.size, 1);
  });
});

describe('createStore update', () => {
  test('returning the same reference is a no-op: no persist and no notify', () => {
    let writes = 0;
    const storage = fakeStorage();
    const originalSet = storage.setItem;
    storage.setItem = (k, v) => {
      writes += 1;
      originalSet(k, v);
    };
    const store = createStore(storage, () => 1);
    let calls = 0;
    store.subscribe(() => {
      calls += 1;
    });

    store.update((s) => s);

    assert.equal(writes, 0);
    assert.equal(calls, 0);
    assert.equal(store.getPersistStatus(), 'ok');
  });

  test('a changed state persists and notifies listeners with the next state', () => {
    const storage = fakeStorage();
    const store = createStore(storage, () => 1);
    const received = [];
    store.subscribe((next) => received.push(next));

    store.update((s) => upsertGame(s, sampleGame()));

    assert.equal(received.length, 1);
    assert.equal(received[0], store.getState());
    assert.deepEqual(validateState(JSON.parse(storage.data.get(STORAGE_KEY))).state, store.getState());
  });

  test('a setItem failure sets status error and still updates state', () => {
    const store = createStore(throwingStorage(), () => 1);
    assert.doesNotThrow(() => store.update((s) => upsertGame(s, sampleGame())));
    assert.equal(store.getPersistStatus(), 'error');
    assert.equal(store.getState().games.length, 1);
  });

  test('a later successful persist restores status ok', () => {
    let fail = true;
    const storage = fakeStorage();
    const originalSet = storage.setItem;
    storage.setItem = (k, v) => {
      if (fail) throw new Error('QuotaExceededError');
      originalSet(k, v);
    };
    const store = createStore(storage, () => 1);
    store.update((s) => upsertGame(s, sampleGame('A')));
    assert.equal(store.getPersistStatus(), 'error');
    fail = false;
    store.update((s) => upsertGame(s, sampleGame('B')));
    assert.equal(store.getPersistStatus(), 'ok');
  });

  test('a null storage gives status unavailable and never persists', () => {
    const store = createStore(null, () => 1);
    assert.deepEqual(store.getState(), emptyState());
    assert.equal(store.getPersistStatus(), 'unavailable');
    store.update((s) => upsertGame(s, sampleGame()));
    assert.equal(store.getState().games.length, 1);
    assert.equal(store.getPersistStatus(), 'unavailable');
  });
});

describe('createStore subscribe', () => {
  test('unsubscribe stops further notifications', () => {
    const store = createStore(fakeStorage(), () => 1);
    let calls = 0;
    const unsubscribe = store.subscribe(() => {
      calls += 1;
    });
    store.update((s) => upsertGame(s, sampleGame('one')));
    unsubscribe();
    store.update((s) => upsertGame(s, sampleGame('two')));
    assert.equal(calls, 1);
  });

  test('a throwing listener does not block the others', (t) => {
    const errors = t.mock.method(console, 'error', () => {});
    const store = createStore(fakeStorage(), () => 1);
    let reached = 0;
    store.subscribe(() => {
      throw new Error('boom');
    });
    store.subscribe(() => {
      reached += 1;
    });
    store.update((s) => upsertGame(s, sampleGame()));
    assert.equal(reached, 1);
    assert.equal(errors.mock.callCount(), 1);
  });
});

describe('createStore storage failures', () => {
  test('a getItem failure marks storage unavailable and update never calls setItem', () => {
    let writes = 0;
    const storage = {
      getItem() {
        throw new Error('SecurityError');
      },
      setItem() {
        writes += 1;
      },
    };
    const store = createStore(storage, () => 1);
    assert.equal(store.getPersistStatus(), 'unavailable');
    store.update((s) => upsertGame(s, sampleGame()));
    store.update((s) => upsertGame(s, sampleGame('again')));
    assert.equal(writes, 0);
    assert.equal(store.getPersistStatus(), 'unavailable');
    assert.equal(store.getState().games.length, 2);
  });

  test('a backup that fails once is retried on the next persist, then the main key is written', () => {
    const raw = '{not valid json';
    const storage = fakeStorage({ [STORAGE_KEY]: raw });
    const originalSet = storage.setItem;
    let backupCalls = 0;
    const written = [];
    storage.setItem = (k, v) => {
      if (k.startsWith(BACKUP_PREFIX)) {
        backupCalls += 1;
        if (backupCalls === 1) throw new Error('QuotaExceededError');
      }
      originalSet(k, v);
      written.push(k);
    };
    const store = createStore(storage, () => 42);
    assert.deepEqual(written, []);

    store.update((s) => upsertGame(s, sampleGame()));

    assert.deepEqual(written, [BACKUP_PREFIX + 42, STORAGE_KEY]);
    assert.equal(storage.data.get(BACKUP_PREFIX + 42), raw);
    assert.equal(store.getPersistStatus(), 'ok');
    assert.deepEqual(validateState(JSON.parse(storage.data.get(STORAGE_KEY))).state, store.getState());
  });

  test('a backup that always fails never overwrites STORAGE_KEY and sets status error', () => {
    const raw = '{not valid json';
    const storage = fakeStorage({ [STORAGE_KEY]: raw });
    const attempted = [];
    storage.setItem = (k) => {
      attempted.push(k);
      throw new Error('QuotaExceededError');
    };
    const store = createStore(storage, () => 7);

    store.update((s) => upsertGame(s, sampleGame()));

    assert.equal(attempted.includes(STORAGE_KEY), false);
    assert.equal(storage.data.get(STORAGE_KEY), raw);
    assert.equal(store.getPersistStatus(), 'error');
    assert.equal(store.getState().games.length, 1);
  });
});

describe('v1 migration load', () => {
  function v1Raw() {
    const good = createGame({ name: 'Old', players: ['A'] }, 1);
    const { finishedAt, shareToken, ...v1game } = good;
    return JSON.stringify({ version: 1, games: [v1game] });
  }

  test('a migrated load backs up the original, then persists the v2 state', () => {
    const raw = v1Raw();
    const storage = fakeStorage({ [STORAGE_KEY]: raw });
    const written = [];
    const originalSet = storage.setItem;
    storage.setItem = (k, v) => {
      written.push(k);
      originalSet(k, v);
    };
    const store = createStore(storage, () => 321);

    assert.equal(store.getState().version, 2);
    assert.equal(store.getState().games.length, 1);
    assert.equal(store.getState().games[0].finishedAt, null);
    assert.deepEqual(written, [BACKUP_PREFIX + 321, STORAGE_KEY]);
    assert.equal(storage.data.get(BACKUP_PREFIX + 321), raw);
    assert.notEqual(storage.data.get(STORAGE_KEY), raw);
    assert.deepEqual(validateState(JSON.parse(storage.data.get(STORAGE_KEY))).state, store.getState());
    assert.equal(JSON.parse(storage.data.get(STORAGE_KEY)).version, 2);
  });

  test('a migrated load persists once: a second load writes nothing and adds no backup', () => {
    const storage = fakeStorage({ [STORAGE_KEY]: v1Raw() });
    const first = createStore(storage, () => 100);
    const keysAfterFirst = [...storage.data.keys()].sort();
    const mainAfterFirst = storage.data.get(STORAGE_KEY);
    assert.deepEqual(keysAfterFirst, [BACKUP_PREFIX + 100, STORAGE_KEY].sort());

    const written = [];
    const originalSet = storage.setItem;
    storage.setItem = (k, v) => {
      written.push(k);
      originalSet(k, v);
    };
    const second = createStore(storage, () => 200);

    assert.deepEqual(written, []);
    assert.equal(storage.data.has(BACKUP_PREFIX + 200), false);
    assert.deepEqual([...storage.data.keys()].sort(), keysAfterFirst);
    assert.equal(storage.data.get(STORAGE_KEY), mainAfterFirst);
    assert.deepEqual(second.getState(), first.getState());
  });

  test('when the load backup fails the main key is never written, and the backup is retried on the next persist', () => {
    const raw = v1Raw();
    const storage = fakeStorage({ [STORAGE_KEY]: raw });
    const originalSet = storage.setItem;
    let backupCalls = 0;
    const written = [];
    storage.setItem = (k, v) => {
      if (k.startsWith(BACKUP_PREFIX)) {
        backupCalls += 1;
        if (backupCalls === 1) throw new Error('QuotaExceededError');
      }
      originalSet(k, v);
      written.push(k);
    };
    const store = createStore(storage, () => 321);

    assert.equal(store.getState().version, 2);
    assert.equal(store.getState().games.length, 1);
    assert.deepEqual(written, []);
    assert.equal(storage.data.get(STORAGE_KEY), raw);

    store.update((s) => upsertGame(s, sampleGame('New')));
    assert.deepEqual(written, [BACKUP_PREFIX + 321, STORAGE_KEY]);
    assert.equal(storage.data.get(BACKUP_PREFIX + 321), raw);
  });

  test('when the load backup always fails the main key is never written', () => {
    const raw = v1Raw();
    const storage = fakeStorage({ [STORAGE_KEY]: raw });
    const attempted = [];
    storage.setItem = (k) => {
      attempted.push(k);
      throw new Error('QuotaExceededError');
    };
    const store = createStore(storage, () => 5);
    store.update((s) => upsertGame(s, sampleGame('New')));

    assert.equal(attempted.includes(STORAGE_KEY), false);
    assert.equal(storage.data.get(STORAGE_KEY), raw);
    assert.equal(store.getPersistStatus(), 'error');
    assert.equal(store.getState().games.length, 2);
  });
});

describe('backupState', () => {
  test('writes the current state under BACKUP_PREFIX + now and returns true', () => {
    const storage = fakeStorage();
    const store = createStore(storage, () => 777);
    store.update((s) => upsertGame(s, sampleGame('Snap')));
    assert.equal(store.backupState(), true);
    assert.equal(storage.data.get(BACKUP_PREFIX + 777), JSON.stringify(store.getState()));
  });

  test('returns false when the write fails or storage is unavailable', () => {
    const failing = createStore(throwingStorage(), () => 1);
    assert.equal(failing.backupState(), false);
    assert.equal(createStore(null, () => 1).backupState(), false);
  });

  test('prunes to the newest 5 backups by numeric suffix and leaves other keys alone', () => {
    const storage = fakeStorage({ other: 'x' });
    let t = 0;
    const times = [2, 10, 9, 100, 1, 8, 3];
    const store = createStore(storage, () => times[t++]);
    const results = times.map(() => store.backupState());
    assert.deepEqual(results, times.map(() => true));
    const backups = [...storage.data.keys()].filter((k) => k.startsWith(BACKUP_PREFIX));
    assert.deepEqual(
      backups.map((k) => Number(k.slice(BACKUP_PREFIX.length))).sort((a, b) => b - a),
      [100, 10, 9, 8, 3],
    );
    assert.equal(storage.data.get('other'), 'x');
  });

  test('a failed backup does not prune existing backups', () => {
    const storage = fakeStorage();
    for (let i = 1; i <= 6; i++) storage.setItem(BACKUP_PREFIX + i, '{}');
    const originalSet = storage.setItem;
    storage.setItem = (k, v) => {
      if (k === BACKUP_PREFIX + 50) throw new Error('QuotaExceededError');
      originalSet(k, v);
    };
    const store = createStore(storage, () => 50);
    assert.equal(store.backupState(), false);
    assert.equal([...storage.data.keys()].filter((k) => k.startsWith(BACKUP_PREFIX)).length, 6);
  });
});
