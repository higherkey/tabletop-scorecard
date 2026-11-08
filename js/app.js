import * as model from './model.js';
import { createStore } from './store.js';
import { h, clear } from './dom.js';
import { renderHome } from './views/home.js';
import { renderSetup } from './views/setup.js';
import { renderGame } from './views/game.js';
import { createKeypad } from './keypad.js';

const appEl = document.getElementById('app');
const toastEl = document.getElementById('toast');
const store = createStore();
const keypad = createKeypad(document.getElementById('keypad'));
let toastTimer = 0;
let reloadRequested = false;
let toastIsUpdate = false;
let pendingUpdate = null;
let lastCell = null;

function parseRoute(hash) {
  const path = hash.replace(/^#/, '');
  if (path === '/new') return { name: 'setup' };
  const match = /^\/game\/([^/]+)$/.exec(path);
  if (match) return { name: 'game', id: match[1] };
  return { name: 'home' };
}

function hideToast() {
  const wasUpdate = toastIsUpdate;
  clearTimeout(toastTimer);
  toastTimer = 0;
  toastEl.hidden = true;
  clear(toastEl);
  toastIsUpdate = false;
  if (pendingUpdate && !wasUpdate) offerUpdate(pendingUpdate);
}

function showToast(message, { actionLabel, onAction } = {}) {
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
  toastTimer = actionLabel ? 0 : setTimeout(hideToast, 6000);
}

function mutateGame(gameId, fn) {
  store.update((state) => {
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

const actions = {
  navigate(hash) {
    location.hash = hash;
  },
  createGame({ name, players, lowWins }) {
    const game = model.createGame({ name, players, lowWins });
    store.update((state) => model.upsertGame(state, game));
    location.hash = `#/game/${game.id}`;
  },
  deleteGame(gameId) {
    store.update((state) => model.deleteGame(state, gameId));
  },
  renameGame(gameId, name) {
    mutateGame(gameId, (game) => model.renameGame(game, name));
  },
  addRound(gameId) {
    mutateGame(gameId, (game) => model.addRound(game));
  },
  removeRound(gameId, roundId) {
    mutateGame(gameId, (game) => model.removeRound(game, roundId));
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
    store.update((state) => model.upsertGame(state, next));
    location.hash = `#/game/${next.id}`;
  },
};

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

  let view;
  if (route.name === 'game') view = renderGame(game, actions);
  else if (route.name === 'setup') view = renderSetup(state, actions);
  else view = renderHome(state, actions);

  clear(appEl);
  appEl.append(view);
  document.title = game ? `${game.name} · Scorecard` : 'Scorecard';

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

window.addEventListener('hashchange', () => render({ routeChanged: true }));
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
render({ routeChanged: true });

if (store.getPersistStatus() === 'unavailable') {
  showToast('Storage is unavailable, so scores will not be saved.');
}

registerServiceWorker();
