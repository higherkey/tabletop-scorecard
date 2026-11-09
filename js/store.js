import { emptyState, validateState } from './model.js';

export const STORAGE_KEY = 'tabletop-scorecard:v1';
export const BACKUP_PREFIX = 'tabletop-scorecard:backup:';
const MAX_BACKUPS = 5;

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
      return true;
    } catch {
      // best effort: a failed backup must not block loading, but persist must retry it
      backupFailed = true;
      pendingBackupRaw = raw;
      return false;
    }
  }

  function pruneBackups() {
    try {
      const suffix = (k) => Number(k.slice(BACKUP_PREFIX.length));
      const keys = [];
      for (let i = 0; i < storage.length; i += 1) {
        const k = storage.key(i);
        if (typeof k === 'string' && k.startsWith(BACKUP_PREFIX) && Number.isFinite(suffix(k))) keys.push(k);
      }
      keys.sort((a, b) => suffix(b) - suffix(a));
      for (const k of keys.slice(MAX_BACKUPS)) storage.removeItem(k);
    } catch {
      // pruning is best effort
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
    const { state: valid, dropped, migrated } = validateState(parsed);
    if (valid === null || dropped > 0 || migrated) {
      const backedUp = backup(raw);
      // Once the original is safe, store the normalized state so the backup is not re-written on every load.
      if (backedUp && valid !== null) persist(valid);
    }
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
    backupState() {
      if (!storage) return false;
      try {
        storage.setItem(BACKUP_PREFIX + now(), JSON.stringify(state));
      } catch {
        return false;
      }
      pruneBackups();
      return true;
    },
    destroy() {
      if (syncTabs) window.removeEventListener('storage', onStorage);
    },
  };
}
