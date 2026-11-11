import * as model from './model.js';
import { createStore } from './store.js';
import { h, clear } from './dom.js';
import { renderHome } from './views/home.js';
import { renderSetup } from './views/setup.js';
import { renderGame } from './views/game.js';
import { renderStats } from './views/stats.js';
import { renderSettings } from './views/settings.js';
import { renderAccount } from './views/account.js';
import { renderShared } from './views/shared.js';
import { createKeypad } from './keypad.js';
import { createCloud, CloudError } from './cloud.js';
import { createSyncer } from './syncer.js';
import { unownedCount, collectPush, isEmptyPush } from './sync.js';
import { AUTH_URL, DATA_URL, APP_URL } from './config.js';
import { avatar } from './ui.js';
import { icon } from './icons.js';

const appEl = document.getElementById('app');
const toastEl = document.getElementById('toast');
const syncStatusEl = document.getElementById('sync-status');
const accountLinkEl = document.getElementById('account-link');
const store = createStore();
const keypad = createKeypad(document.getElementById('keypad'), {
  onKey: () => {
    if (store.getState().settings.haptics) navigator.vibrate?.(8);
  },
});
const cloud = createCloud({ authUrl: AUTH_URL, dataUrl: DATA_URL, appUrl: APP_URL });
const syncer = createSyncer({ store, cloud });
const SYNC_LABELS = {
  syncing: 'Syncing…',
  synced: 'Synced',
  offline: 'Offline',
  error: 'Sync problem',
};
const UNDO_TIMEOUT_MS = 5000;
const SHARED_POLL_MS = 15000;
let toastTimer = 0;
let reloadRequested = false;
let toastIsUpdate = false;
let pendingUpdate = null;
let lastCell = null;
let accountBusy = false;
let ownershipUserId = null;
let sharedResult = { status: 'loading' };
let sharedToken = null;
let sharedTimer = 0;
let wakeLock = null;
let wakeWanted = false;
let wakePending = null;

function parseRoute(hash) {
  const [path, query = ''] = hash.replace(/^#/, '').split('?');
  if (path === '/new') return { name: 'setup' };
  if (path === '/stats') return { name: 'stats', gameName: new URLSearchParams(query).get('game') || null };
  if (path === '/settings') return { name: 'settings' };
  if (path === '/account') return { name: 'account' };
  const shared = /^\/s\/([^/]+)$/.exec(path);
  if (shared) return { name: 'shared', token: shared[1] };
  const match = /^\/game\/([^/]+)$/.exec(path);
  if (match) return { name: 'game', id: match[1] };
  return { name: 'home' };
}

const NAV_ROUTE = {
  home: 'home', setup: 'home', game: 'home', stats: 'stats', settings: 'settings',
};

function hideToast() {
  const wasUpdate = toastIsUpdate;
  clearTimeout(toastTimer);
  toastTimer = 0;
  toastEl.hidden = true;
  clear(toastEl);
  toastIsUpdate = false;
  if (pendingUpdate && !wasUpdate) offerUpdate(pendingUpdate);
}

function showToast(message, { actionLabel, onAction, timeout = 0 } = {}) {
  clearTimeout(toastTimer);
  toastIsUpdate = false;
  const children = [h('span', null, message)];
  if (actionLabel) {
    children.push(
      h('button', {
        type: 'button',
        class: 'toast-action',
        onClick: () => {
          hideToast();
          onAction?.();
        },
      }, actionLabel),
    );
  }
  clear(toastEl);
  toastEl.append(...children);
  toastEl.hidden = false;
  const ms = timeout || (actionLabel ? 0 : 6000);
  toastTimer = ms ? setTimeout(hideToast, ms) : 0;
}

function mutate(fn) {
  store.update(fn);
  if (cloud.getSession().status === 'signed-in') syncer.schedule();
}

function mutateGame(gameId, fn) {
  mutate((state) => {
    const game = model.getGame(state, gameId);
    if (!game) return state;
    const next = fn(game);
    return next === game ? state : model.upsertGame(state, next);
  });
}

function focusCell(roundId, playerId) {
  requestAnimationFrame(() => {
    const selector = `.score-cell[data-round="${CSS.escape(roundId)}"][data-player="${CSS.escape(playerId)}"]`;
    appEl.querySelector(selector)?.focus();
  });
}

function openCell(gameId, ri, pi) {
  const game = model.getGame(store.getState(), gameId);
  if (!game) return;
  const round = game.rounds[ri];
  const player = game.players[pi];
  const current = round.scores[player.id];
  lastCell = { roundId: round.id, playerId: player.id };
  keypad.open({
    title: `${player.name} · Round ${ri + 1}`,
    value: typeof current === 'number' ? current : null,
    onSubmit: (value, advance) => submitScore(gameId, round.id, player.id, value, advance),
  });
}

document.getElementById('keypad').addEventListener('close', () => {
  if (lastCell) focusCell(lastCell.roundId, lastCell.playerId);
});

function submitScore(gameId, roundId, playerId, value, advance) {
  try {
    mutateGame(gameId, (game) => model.setScore(game, roundId, playerId, value));
  } catch (err) {
    if (!(err instanceof RangeError)) throw err;
    keypad.close();
    showToast('Score is too large.');
    focusCell(roundId, playerId);
    return;
  }
  if (advance) {
    const game = model.getGame(store.getState(), gameId);
    const ri = game ? game.rounds.findIndex((r) => r.id === roundId) : -1;
    const pi = game ? game.players.findIndex((p) => p.id === playerId) : -1;
    if (ri < 0 || pi < 0) {
      keypad.close();
    } else {
      let nextRound = ri;
      let nextPlayer = pi + 1;
      if (nextPlayer >= game.players.length) {
        nextRound += 1;
        nextPlayer = 0;
      }
      if (nextRound < game.rounds.length) {
        openCell(gameId, nextRound, nextPlayer);
        return;
      }
      keypad.close();
    }
  }
  focusCell(roundId, playerId);
}

function showUndo(message, restore) {
  showToast(message, { actionLabel: 'Undo', timeout: UNDO_TIMEOUT_MS, onAction: restore });
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function authError(err) {
  if (err instanceof CloudError) return { message: err.message };
  return { message: 'Something went wrong. Please try again.' };
}

async function runAuth(fn) {
  accountBusy = true;
  try {
    await fn();
  } catch (err) {
    throw authError(err);
  } finally {
    accountBusy = false;
  }
}

const KEPT_UNSYNCED_MESSAGE = "Some changes haven't synced, so they were kept on this device.";

async function runOwnershipFlow(user) {
  const state = store.getState();
  if (state.ownerId !== user.id) {
    const count = unownedCount(state, user.id);
    if (count > 0) {
      const label = count === 1 ? '1 game' : `${count} games`;
      if (window.confirm(`Add ${label} on this device to ${user.email}?`)) {
        store.update((s) => model.resetForOwner(s, user.id, { keepData: true }));
      } else {
        if (store.backupState() !== true) {
          await cloud.signOut();
          showToast("Couldn't back up this device's games; nothing was changed.");
          return;
        }
        store.update((s) => model.resetForOwner(s, user.id, { keepData: false }));
      }
    } else {
      store.update((s) => model.resetForOwner(s, user.id, { keepData: true }));
    }
  }
  await syncer.syncNow();
}

function handleSessionChange(session) {
  if (session.status === 'signed-in' && session.user) {
    if (ownershipUserId !== session.user.id) {
      ownershipUserId = session.user.id;
      runOwnershipFlow(session.user).catch((err) => console.warn('Ownership flow failed:', err));
    }
  } else if (session.status !== 'unknown') {
    ownershipUserId = null;
  }
  render({ routeChanged: false });
}

const actions = {
  navigate(hash) {
    location.hash = hash;
  },
  createGame({ name, players, lowWins }) {
    const game = model.createGame({ name, players, lowWins });
    mutate((state) => model.upsertGame(state, game));
    location.hash = `#/game/${game.id}`;
  },
  deleteGame(gameId) {
    const game = model.getGame(store.getState(), gameId);
    if (!game) return;
    mutate((state) => model.deleteGame(state, gameId));
    showUndo('Game deleted', () => {
      mutate((state) => model.upsertGame(state, { ...game, updatedAt: Date.now() }));
    });
  },
  renameGame(gameId, name) {
    mutateGame(gameId, (game) => model.renameGame(game, name));
  },
  addRound(gameId) {
    mutateGame(gameId, (game) => model.addRound(game));
  },
  removeRound(gameId, roundId) {
    const before = model.getGame(store.getState(), gameId);
    if (!before) return;
    mutateGame(gameId, (game) => model.removeRound(game, roundId));
    const after = model.getGame(store.getState(), gameId);
    if (!after || after === before) return;
    showUndo('Round removed', () => {
      mutate((state) => model.upsertGame(state, { ...before, updatedAt: Date.now() }));
    });
  },
  finishGame(gameId) {
    mutate((state) => {
      const game = model.getGame(state, gameId);
      if (!game) return state;
      const next = model.finishGame(game);
      if (next === game) return state;
      return model.addRosterNames(model.upsertGame(state, next), game.players.map((p) => p.name));
    });
  },
  reopenGame(gameId) {
    mutateGame(gameId, (game) => model.reopenGame(game));
  },
  openScore(gameId, roundId, playerId) {
    const game = model.getGame(store.getState(), gameId);
    if (!game) return;
    const ri = game.rounds.findIndex((r) => r.id === roundId);
    const pi = game.players.findIndex((p) => p.id === playerId);
    if (ri < 0 || pi < 0) return;
    openCell(gameId, ri, pi);
  },
  rematch(gameId) {
    const game = model.getGame(store.getState(), gameId);
    if (!game) return;
    const next = model.rematch(game);
    mutate((state) => model.upsertGame(state, next));
    location.hash = `#/game/${next.id}`;
  },
  updateSettings(patch) {
    mutate((state) => model.updateSettings(state, patch));
  },
  addRosterName(name) {
    mutate((state) => model.addRosterNames(state, [name]));
  },
  removeRosterEntry(key) {
    mutate((state) => model.removeRosterEntry(state, key));
  },
  exportData() {
    const state = store.getState();
    const now = new Date();
    const stamp = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
    downloadJson(`tabletop-scorecard-${stamp}.json`, {
      exportedAt: now.toISOString(),
      games: state.games,
      roster: state.roster,
      settings: state.settings,
    });
  },
  async shareGame(gameId) {
    if (cloud.getSession().status !== 'signed-in') {
      showToast('Sign in to share games');
      location.hash = '#/account';
      return;
    }
    let game = model.getGame(store.getState(), gameId);
    if (!game) return;
    if (!game.shareToken) {
      mutate((state) => {
        const current = model.getGame(state, gameId);
        return current ? model.upsertGame(state, model.setShareToken(current, model.newShareToken())) : state;
      });
      await syncer.syncNow();
      if (!gameSynced(gameId)) {
        showToast("Couldn't share right now");
        return;
      }
      game = model.getGame(store.getState(), gameId);
      if (!game?.shareToken) return;
    }
    const url = `${APP_URL}#/s/${game.shareToken}`;
    if (navigator.share) {
      try {
        await navigator.share({ title: game.name, url });
        return;
      } catch (err) {
        if (err?.name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      showToast('Share link copied');
    } catch {
      showToast("Couldn't copy the share link");
    }
  },
  async unshareGame(gameId) {
    mutate((state) => {
      const current = model.getGame(state, gameId);
      return current ? model.upsertGame(state, model.setShareToken(current, null)) : state;
    });
    await syncer.syncNow();
    if (!gameSynced(gameId)) {
      showToast("Couldn't stop sharing yet. Will retry when online.");
      return;
    }
    showToast('Sharing stopped');
    location.hash = `#/game/${gameId}`;
  },
  signIn({ email, password }) {
    return runAuth(() => cloud.signIn({ email, password }));
  },
  signUp({ name, email, password }) {
    return runAuth(() => cloud.signUp({ name, email, password }));
  },
  async signInWithGoogle() {
    try {
      await cloud.signInWithGoogle();
    } catch (err) {
      showToast(authError(err).message);
    }
  },
  async signOut() {
    const wipe = window.confirm('Remove games from this device too?');
    let keep = !wipe;
    if (wipe) {
      await syncer.syncNow();
      if (syncer.getStatus() !== 'synced' || !isEmptyPush(collectPush(store.getState()))) {
        keep = true;
        showToast(KEPT_UNSYNCED_MESSAGE);
      }
    }
    if (wipe && !keep) {
      // Wipe only once the backup is safely written.
      if (store.backupState() !== true) {
        keep = true;
        showToast(KEPT_UNSYNCED_MESSAGE);
      }
    }
    await cloud.signOut();
    if (wipe && !keep) store.update((state) => ({ ...model.emptyState(), settings: state.settings }));
    else if (!wipe) store.update((state) => model.setOwner(state, null));
  },
  retryAuth() {
    return cloud.init();
  },
  syncNow() {
    return syncer.syncNow();
  },
};

function gameSynced(gameId) {
  if (syncer.getStatus() !== 'synced') return false;
  const pending = collectPush(store.getState());
  return !pending.games.some((g) => g.id === gameId);
}

function syncLabelState() {
  const status = syncer.getStatus();
  return status === 'idle' ? 'synced' : status;
}

function updateHeader(route) {
  const active = NAV_ROUTE[route.name] ?? null;
  for (const link of document.querySelectorAll('.nav-link[data-route], .tab[data-route]')) {
    if (link.dataset.route === active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  if (route.name === 'account') accountLinkEl.setAttribute('aria-current', 'page');
  else accountLinkEl.removeAttribute('aria-current');

  const session = cloud.getSession();
  const signedIn = session.status === 'signed-in' && session.user;
  syncStatusEl.hidden = !signedIn;
  if (signedIn) {
    const state = syncLabelState();
    syncStatusEl.textContent = SYNC_LABELS[state] ?? '';
    syncStatusEl.classList.toggle('is-error', state === 'error');
  } else {
    syncStatusEl.textContent = '';
    syncStatusEl.classList.remove('is-error');
  }
  clear(accountLinkEl);
  accountLinkEl.append(signedIn
    ? avatar(session.user.name || session.user.email, 1, { size: 'sm' })
    : icon('user-round'));
}

async function syncWakeLock() {
  let pending = null;
  try {
    if (!wakeWanted) {
      const lock = wakeLock;
      wakeLock = null;
      await lock?.release();
      return;
    }
    if (wakeLock || wakePending || document.visibilityState !== 'visible') return;
    pending = Promise.resolve(navigator.wakeLock?.request('screen'));
    wakePending = pending;
    const lock = await pending;
    if (wakePending === pending) wakePending = null;
    if (!lock) return;
    if (!wakeWanted || wakeLock) {
      await lock.release();
      return;
    }
    wakeLock = lock;
    lock.addEventListener('release', () => {
      if (wakeLock === lock) wakeLock = null;
    });
  } catch {
    // wake lock is best effort
  } finally {
    if (pending && wakePending === pending) wakePending = null;
  }
}

function setWakeWanted(wanted) {
  wakeWanted = wanted;
  syncWakeLock();
}

function stopSharedPolling() {
  clearInterval(sharedTimer);
  sharedTimer = 0;
  sharedToken = null;
}

async function loadShared(token) {
  let next;
  try {
    const result = await cloud.getShared(token);
    next = result
      ? { status: 'ready', game: result.game, updatedAt: result.updatedAt }
      : { status: 'missing' };
  } catch {
    if (sharedResult.status === 'ready') return;
    next = { status: 'error' };
  }
  if (sharedToken !== token) return;
  if (JSON.stringify(next) === JSON.stringify(sharedResult)) return;
  sharedResult = next;
  render({ routeChanged: false });
}

function startSharedPolling(token) {
  stopSharedPolling();
  sharedToken = token;
  sharedResult = { status: 'loading' };
  sharedTimer = setInterval(() => {
    if (document.visibilityState === 'visible') loadShared(token);
  }, SHARED_POLL_MS);
}

function onRouteChange() {
  const route = parseRoute(location.hash);
  if (route.name === 'shared') startSharedPolling(route.token);
  else stopSharedPolling();
  setWakeWanted(false);
  render({ routeChanged: true });
  if (route.name === 'shared') loadShared(route.token);
}

function render({ routeChanged }) {
  const route = parseRoute(location.hash);
  const state = store.getState();
  let game = null;
  if (route.name === 'game') {
    game = model.getGame(state, route.id);
    if (!game) {
      location.replace('#/');
      return;
    }
  }

  document.documentElement.dataset.theme = state.settings.theme;
  if (state.settings.theme === 'system') delete document.documentElement.dataset.theme;

  if (!routeChanged && route.name === 'setup' && appEl.firstElementChild) {
    // The setup form keeps its DOM state; only the chrome is refreshed.
    updateHeader(route);
    return;
  }

  if (routeChanged) keypad.close();

  const saved = routeChanged
    ? null
    : {
        y: window.scrollY,
        x: appEl.querySelector('.table-scroll')?.scrollLeft ?? 0,
      };

  let focusKey = null;
  if (!routeChanged) {
    const active = document.activeElement;
    if (active && appEl.contains(active)) {
      if (active.classList.contains('score-cell')) {
        focusKey = { round: active.dataset.round, player: active.dataset.player };
      } else {
        focusKey = {
          tag: active.tagName,
          cls: active.className,
          label: active.getAttribute('aria-label'),
          text: active.textContent,
        };
      }
    }
  }

  const session = cloud.getSession();
  const signedIn = session.status === 'signed-in';
  let view;
  if (route.name === 'game') view = renderGame(game, actions, { canShare: session.status !== 'unavailable' });
  else if (route.name === 'setup') view = renderSetup(state, actions);
  else if (route.name === 'stats') view = renderStats(state, actions, { gameName: route.gameName });
  else if (route.name === 'settings') {
    view = renderSettings(state, actions, {
      account: signedIn
        ? { status: 'signed-in', email: session.user?.email, sync: syncLabelState() }
        : { status: 'signed-out' },
    });
  } else if (route.name === 'account') {
    view = renderAccount(state, actions, {
      cloud: {
        status: session.status,
        user: session.user,
        busy: accountBusy,
        error: null,
        sync: syncLabelState(),
      },
    });
  } else if (route.name === 'shared') {
    const isOwner = signedIn && state.games.some((g) => g.shareToken === route.token);
    view = renderShared(sharedResult, actions, { token: route.token, isOwner });
  } else view = renderHome(state, actions);

  clear(appEl);
  appEl.append(view);
  document.title = game ? `${game.name} · Scorecard` : 'Scorecard';
  updateHeader(route);
  setWakeWanted(Boolean(game && game.finishedAt == null && state.settings.keepAwake));

  if (routeChanged) {
    window.scrollTo(0, 0);
    appEl.querySelector('.view-title')?.focus({ preventScroll: true });
  } else {
    window.scrollTo(0, saved.y);
    const table = appEl.querySelector('.table-scroll');
    if (table) table.scrollLeft = saved.x;
    if (focusKey) {
      let target = null;
      if ('round' in focusKey) {
        target = appEl.querySelector(
          `.score-cell[data-round="${CSS.escape(focusKey.round)}"][data-player="${CSS.escape(focusKey.player)}"]`,
        );
      } else {
        target = Array.from(appEl.querySelectorAll('*')).find(
          (el) =>
            el.tagName === focusKey.tag &&
            el.className === focusKey.cls &&
            el.getAttribute('aria-label') === focusKey.label &&
            el.textContent === focusKey.text,
        ) ?? null;
      }
      (target ?? appEl.querySelector('.view-title'))?.focus({ preventScroll: true });
    }
  }
}

function offerUpdate(worker) {
  pendingUpdate = worker;
  showToast('Update available.', {
    actionLabel: 'Reload',
    onAction: () => {
      pendingUpdate = null;
      reloadRequested = true;
      worker.postMessage({ type: 'SKIP_WAITING' });
    },
  });
  toastIsUpdate = true;
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloadRequested) location.reload();
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('./sw.js')
      .then((reg) => {
        if (reg.waiting) offerUpdate(reg.waiting);
        reg.addEventListener('updatefound', () => {
          const worker = reg.installing;
          if (!worker) return;
          worker.addEventListener('statechange', () => {
            if (worker.state === 'installed' && navigator.serviceWorker.controller) {
              offerUpdate(worker);
            }
          });
        });
      })
      .catch((err) => console.warn('Service worker registration failed:', err));
  });
}

window.addEventListener('hashchange', onRouteChange);
let persistWarningShown = false;
store.subscribe(() => {
  render({ routeChanged: false });
  const status = store.getPersistStatus();
  if (status === 'error' && !persistWarningShown) {
    showToast("Couldn't save. Storage may be full or blocked.");
    persistWarningShown = true;
  } else if (status === 'ok') {
    persistWarningShown = false;
  }
});
cloud.onChange(handleSessionChange);
syncer.onStatus(() => {
  const route = parseRoute(location.hash);
  updateHeader(route);
  const session = cloud.getSession();
  if ((route.name === 'account' || route.name === 'settings') && session.status === 'signed-in') {
    render({ routeChanged: false });
  }
});
function retryAuthIfUnknown() {
  if (cloud.getSession().status === 'unknown') {
    Promise.resolve(cloud.retryInit()).catch((err) => console.warn('Auth re-init failed:', err));
  }
}
window.addEventListener('online', () => {
  retryAuthIfUnknown();
  if (cloud.getSession().status === 'signed-in') syncer.syncNow();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  syncWakeLock();
  retryAuthIfUnknown();
  if (cloud.getSession().status === 'signed-in') syncer.syncNow();
});
for (const tab of document.querySelectorAll('.tab[data-route]')) {
  const name = { home: 'dice-5', stats: 'bar-chart-3', settings: 'settings' }[tab.dataset.route];
  tab.querySelector('.tab-icon')?.append(icon(name, { size: 22 }));
}
onRouteChange();

if (store.getPersistStatus() === 'unavailable') {
  showToast('Storage is unavailable, so scores will not be saved.');
}

registerServiceWorker();
cloud.init().catch((err) => console.warn('Auth init failed:', err));
