import { markPushed, markQuarantined, setSyncMarks } from './model.js';
import { collectPush, isEmptyPush, mergeRemote } from './sync.js';

export function createSyncer({ store, cloud, now = () => Date.now(), debounceMs = 1500 }) {
  let status = 'idle';
  let current = null;
  let rerun = false;
  let timer = null;
  const listeners = new Set();
  const warned = new Set();

  function setStatus(next) {
    if (status === next) return;
    status = next;
    for (const fn of [...listeners]) {
      try {
        fn(status);
      } catch (err) {
        console.error(err);
      }
    }
  }

  async function runOnce() {
    setStatus('syncing');
    try {
      const r = await cloud.pull(store.getState().sync.cursors);
      store.update((st) => setSyncMarks(mergeRemote(st, r), { cursors: r.cursors }));
      const p = collectPush(store.getState());
      const invalid = p.invalid ?? [];
      let failed = [];
      if (!isEmptyPush(p)) {
        const res = await cloud.push(p);
        failed = res?.failed ?? [];
        store.update((st) => markQuarantined(markPushed(st, res?.pushed ?? {}), [...failed, ...invalid]));
      } else if (invalid.length) {
        store.update((st) => markQuarantined(st, invalid));
      }
      const bad = [...failed, ...invalid];
      for (const item of bad) {
        const key = `${item.kind}:${item.id}:${item.time}`;
        if (warned.has(key)) continue;
        warned.add(key);
        console.warn('Sync skipped an item:', item.kind, item.id, item.reason ?? 'rejected');
      }
      if (bad.length) {
        setStatus('error');
        return false;
      }
      setStatus('synced');
      return true;
    } catch (err) {
      const code = err?.code;
      if (code === 'offline') {
        setStatus('offline');
      } else if (code === 'signed-out') {
        setStatus('idle');
      } else {
        console.warn('Sync failed:', code ?? err?.name ?? 'unknown');
        setStatus('error');
      }
      return false;
    }
  }

  async function loop() {
    try {
      do {
        rerun = false;
        if (!(await runOnce())) rerun = false;
      } while (rerun);
    } finally {
      current = null;
    }
  }

  function syncNow() {
    if (cloud.getSession().status !== 'signed-in') return Promise.resolve();
    if (current) {
      rerun = true;
      return current;
    }
    current = loop();
    return current;
  }

  function schedule() {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      syncNow();
    }, debounceMs);
  }

  return {
    syncNow,
    schedule,
    getStatus: () => status,
    onStatus(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}
