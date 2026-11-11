import { h } from '../dom.js';
import { emptyState } from '../ui.js';
import { icon } from '../icons.js';
import { renderGame } from './game.js';

export function renderShared(result, actions, { token, isOwner = false } = {}) {
  const header = h('div', { class: 'view-header' },
    h('h2', { class: 'view-title', tabindex: '-1' }, 'Shared game'));

  switch (result.status) {
    case 'missing':
      return h('section', { class: 'view view-shared' },
        header,
        emptyState({
          icon: 'link-2-off',
          title: 'This game is no longer shared',
          text: 'Ask the owner for a new link.',
        }));
    case 'error':
      return h('section', { class: 'view view-shared' },
        header,
        emptyState({
          icon: 'cloud-off',
          title: "Couldn't load this game",
          text: 'Check your connection. We will keep trying.',
        }));
    case 'ready':
      return renderReady(result, actions, { isOwner });
    default:
      return h('section', { class: 'view view-shared' },
        header,
        h('p', { class: 'muted', 'aria-busy': 'true' }, 'Loading scoreboard…'));
  }
}

function renderReady(result, actions, { isOwner }) {
  const { game, updatedAt } = result;

  const banner = h('div', { class: 'share-banner' },
    icon('users'),
    h('span', null, 'Live scoreboard · updates automatically'),
    h('span', { class: 'readonly-badge' }, 'Read-only'));

  const stopBtn = isOwner
    ? h('button', {
      type: 'button',
      class: 'btn',
      onClick: () => actions.unshareGame(game.id),
    }, icon('link-2-off'), 'Stop sharing')
    : null;

  const updated = updatedAt
    ? h('p', { class: 'muted' },
      'Updated ',
      h('time', { datetime: updatedAt }, relativeTime(updatedAt)))
    : null;

  return h('section', { class: 'view view-shared' },
    banner,
    renderGame(game, actions, { canShare: false, readOnly: true }),
    stopBtn,
    updated);
}

function relativeTime(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const diff = Date.now() - t;
  if (diff < 60_000) return 'just now';
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins} min ago`;
  return new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
