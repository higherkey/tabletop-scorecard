import { emptyState, validateState } from './model.js';

export const STORAGE_KEY = 'tabletop-scorecard:v1';
export const BACKUP_PREFIX = 'tabletop-scorecard:backup:';

export function safeLocalStorage() {
  try {
    if (typeof window === 'undefined') return null;
    const storage = window.localStorage;
    const probe = STORAGE_KEY + ':probe';
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
}

export function createStore(storage = safeLocalStorage(), now = () => Date.now(), {
  syncTabs = storage !== null && typeof window !== 'undefined' && storage === window.localStorage,
} = {}) {
  const listeners = new Set();
  let persistStatus = storage ? 'ok' : 'unavailable';
  let backupFailed = false;
  let pendingBackupRaw = null;
  let state = loadState();

  function backup(raw) {
    try {
      storage.setItem(BACKUP_PREFIX + now(), raw);
    } catch {
      // best effort: a failed backup must not block loading, but persist must retry it
      backupFailed = true;
      pendingBackupRaw = raw;
    }
  }

  function loadState() {
    if (!storage) return emptyState();
    let raw;
    try {
      raw = storage.getItem(STORAGE_KEY);
    } catch {
      persistStatus = 'unavailable';
      storage = null;
      return emptyState();
    }
    if (raw === null) return emptyState();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      backup(raw);
      return emptyState();
    }
    const { state: valid, dropped } = validateState(parsed);
    if (valid === null || dropped > 0) backup(raw);
    return valid ?? emptyState();
  }

  function persist(next) {
    if (!storage) return;
    if (backupFailed) {
      try {
        storage.setItem(BACKUP_PREFIX + now(), pendingBackupRaw);
        backupFailed = false;
      } catch {
        persistStatus = 'error';
        return;
      }
    }
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(next));
      persistStatus = 'ok';
    } catch {
      persistStatus = 'error';
    }
  }

  function notify(next) {
    for (const listener of [...listeners]) {
      try {
        listener(next);
      } catch (err) {
        console.error(err);
      }
    }
  }

  function update(fn) {
    const next = fn(state);
    if (next === state) return;
    state = next;
    persist(next);
    notify(next);
  }

  function onStorage(e) {
    if (e.key !== STORAGE_KEY || e.newValue == null) return;
    let parsed;
    try {
      parsed = JSON.parse(e.newValue);
    } catch {
      return;
    }
    const { state: incoming } = validateState(parsed);
    if (incoming === null) return;
    state = incoming;
    notify(state);
  }

  if (syncTabs) window.addEventListener('storage', onStorage);

  function subscribe(listener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  return {
    getState: () => state,
    update,
    subscribe,
    getPersistStatus: () => persistStatus,
    destroy() {
      if (syncTabs) window.removeEventListener('storage', onStorage);
    },
  };
}
