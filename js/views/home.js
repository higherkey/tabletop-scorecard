import { h } from '../dom.js';
import { standings } from '../model.js';
import { avatar, emptyState } from '../ui.js';
import { icon } from '../icons.js';

const MAX_AVATARS = 5;

export function renderHome(state, actions) {
  const header = h('div', { class: 'view-header' },
    h('h2', { class: 'view-title', tabindex: '-1' }, 'Games'),
    newGameLink());

  const children = [header];
  if (state.games.length === 0) {
    children.push(emptyState({
      icon: 'dice-5',
      title: 'No games yet',
      text: 'Start a game to keep score for anything on the table.',
      action: newGameLink(),
    }));
  } else {
    const inProgress = state.games.filter((g) => g.finishedAt == null);
    const finished = state.games.filter((g) => g.finishedAt != null);
    if (inProgress.length > 0) children.push(...renderGroup('In progress', inProgress, actions));
    if (finished.length > 0) children.push(...renderGroup('Finished', finished, actions));
  }

  return h('section', { class: 'view view-home' }, ...children);
}

function newGameLink() {
  return h('a', { class: 'btn btn-primary', href: '#/new' }, icon('plus'), 'New game');
}

function renderGroup(title, games, actions) {
  return [
    h('h3', { class: 'group-title' }, title),
    h('ul', { class: 'game-list' }, games.map((game) => renderCard(game, actions))),
  ];
}

function renderCard(game, actions) {
  const finished = game.finishedAt != null;
  const date = new Date(game.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const hasScores = game.rounds.some((r) => Object.keys(r.scores).length > 0);
  const players = game.players;
  const shown = players.slice(0, MAX_AVATARS);
  const extra = players.length - shown.length;

  let leader = null;
  if (hasScores) {
    const top = standings(game).filter((s) => s.rank === 1);
    if (top.length === 1) {
      const label = finished ? 'Winner' : 'Leader';
      leader = h('span', { class: 'game-card-leader' },
        icon('crown', { size: 16 }),
        `${label}: ${top[0].player.name} (${top[0].total})`);
    } else if (top.length > 1) {
      const names = top.map((s) => s.player.name).join(', ');
      leader = h('span', { class: 'game-card-leader' },
        icon('crown', { size: 16 }),
        `Tied: ${names} (${top[0].total})`);
    }
  }

  const avatarStack = h('span', { class: 'avatar-stack' },
    shown.map((p) => avatar(p.name, p.color, { size: 'sm' })),
    extra > 0 ? h('span', { class: 'avatar avatar-sm avatar-more' }, `+${extra}`) : null);

  return h('li', { class: 'game-card' },
    h('a', { class: 'game-card-link', href: `#/game/${game.id}` },
      h('span', { class: 'game-card-top' },
        h('span', { class: 'game-card-name' }, game.name),
        finished ? h('span', { class: 'chip chip-success' }, 'Finished') : null),
      avatarStack,
      h('span', { class: 'game-card-meta' },
        `${players.length} players · ${game.rounds.length} rounds · ${date}`),
      leader),
    h('button', {
      type: 'button',
      class: 'icon-btn',
      'aria-label': `Delete ${game.name}`,
      onClick: () => actions.deleteGame(game.id),
    }, icon('trash-2')));
}
