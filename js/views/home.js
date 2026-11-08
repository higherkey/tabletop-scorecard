import { h } from '../dom.js';
import { standings } from '../model.js';

export function renderHome(state, actions) {
  const header = h('div', { class: 'view-header' },
    h('h2', { class: 'view-title', tabindex: '-1' }, 'Your games'),
    h('a', { class: 'btn btn-primary', href: '#/new' }, 'New game'));

  const body = state.games.length === 0
    ? h('div', { class: 'empty-state' },
      h('p', null, 'No games yet.'),
      h('p', { class: 'muted' }, 'Start one to keep score for any tabletop game.'))
    : h('ul', { class: 'game-list' }, state.games.map((game) => renderCard(game, actions)));

  return h('section', { class: 'view view-home' }, header, body);
}

function renderCard(game, actions) {
  const date = new Date(game.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const hasScores = game.rounds.some((r) => Object.keys(r.scores).length > 0);

  let leader = null;
  if (hasScores) {
    const top = standings(game).filter((s) => s.rank === 1);
    if (top.length === 1) {
      leader = h('span', { class: 'game-card-leader' }, `Leader: ${top[0].player.name} (${top[0].total})`);
    } else if (top.length > 1) {
      const names = top.map((s) => s.player.name).join(', ');
      leader = h('span', { class: 'game-card-leader' }, `Tied: ${names} (${top[0].total})`);
    }
  }

  return h('li', { class: 'game-card' },
    h('a', { class: 'game-card-link', href: `#/game/${game.id}` },
      h('span', { class: 'game-card-name' }, game.name),
      h('span', { class: 'game-card-meta' },
        `${game.players.length} players · ${game.rounds.length} rounds · ${date}`),
      leader),
    h('button', {
      type: 'button',
      class: 'icon-btn icon-btn-danger',
      'aria-label': `Delete ${game.name}`,
      onclick: () => {
        if (window.confirm(`Delete "${game.name}"? This cannot be undone.`)) {
          actions.deleteGame(game.id);
        }
      },
    }, h('span', { 'aria-hidden': 'true' }, '×')));
}
