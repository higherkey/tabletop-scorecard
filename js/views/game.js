import { h } from '../dom.js';
import { standings, totals } from '../model.js';

export function renderGame(game, actions) {
  const players = game.players;
  const totalMap = totals(game);
  const ranked = standings(game);
  const anyScore = game.rounds.some((r) => Object.keys(r.scores).length > 0);

  const renameBtn = h('button', {
    type: 'button',
    class: 'btn btn-ghost',
    onclick: () => {
      const next = window.prompt('Rename game', game.name);
      if (next !== null) actions.renameGame(game.id, next);
    },
  }, 'Rename');

  const header = h('div', { class: 'view-header' },
    h('h2', { class: 'view-title', tabindex: '-1' }, game.name),
    h('div', { class: 'view-header-actions' }, renameBtn));

  const mode = h('p', { class: 'muted game-mode' },
    game.lowWins ? 'Lowest score wins' : 'Highest score wins');

  const standingsList = h('ol', { class: 'standings', 'aria-label': 'Standings' },
    ranked.map((s) => {
      const isLeader = anyScore && s.rank === 1;
      return h('li', { class: `standing pc-${s.player.color}${isLeader ? ' is-leader' : ''}` },
        h('span', { class: 'standing-rank' }, `#${s.rank}`),
        h('span', { class: 'swatch', 'aria-hidden': 'true' }),
        h('span', { class: 'standing-name truncate', title: s.player.name }, s.player.name),
        h('span', { class: 'standing-total' }, String(s.total)));
    }));

  const thead = h('thead', null,
    h('tr', null,
      h('th', { scope: 'col', class: 'round-col' }, 'Round'),
      players.map((p) => h('th', { scope: 'col', class: `player-col pc-${p.color}` },
        h('span', { class: 'swatch', 'aria-hidden': 'true' }),
        ' ',
        h('span', { class: 'truncate', title: p.name }, p.name))),
      h('th', { scope: 'col', class: 'round-actions' },
        h('span', { class: 'visually-hidden' }, 'Actions'))));

  const tbody = h('tbody', null,
    game.rounds.map((round, i) => {
      const n = i + 1;
      return h('tr', null,
        h('th', { scope: 'row', class: 'round-col' }, String(n)),
        players.map((p) => {
          const v = round.scores[p.id];
          const has = typeof v === 'number';
          return h('td', null,
            h('button', {
              type: 'button',
              class: has ? 'score-cell' : 'score-cell is-empty',
              dataset: { round: round.id, player: p.id },
              'aria-label': `Round ${n}, ${p.name}: ${has ? v : 'no score'}`,
              onclick: () => actions.openScore(game.id, round.id, p.id),
            }, has ? String(v) : '–'));
        }),
        h('td', { class: 'round-actions' },
          h('button', {
            type: 'button',
            class: 'icon-btn',
            'aria-label': `Delete round ${n}`,
            onclick: () => {
              const hasScore = Object.keys(round.scores).length > 0;
              if (hasScore && !window.confirm(`Delete round ${n}?`)) return;
              actions.removeRound(game.id, round.id);
            },
          }, h('span', { 'aria-hidden': 'true' }, '×'))));
    }));

  const tfoot = h('tfoot', null,
    h('tr', { class: 'totals-row' },
      h('th', { scope: 'row', class: 'round-col' }, 'Total'),
      players.map((p) => h('td', { class: 'total-cell' }, String(totalMap[p.id] ?? 0))),
      h('td', { class: 'round-actions' })));

  const table = h('div', { class: 'table-scroll' },
    h('table', { class: 'score-table' },
      h('caption', { class: 'visually-hidden' }, 'Scores by round'),
      thead,
      tbody,
      tfoot));

  const actionsBar = h('div', { class: 'game-actions' },
    h('button', {
      type: 'button',
      class: 'btn btn-primary',
      onclick: () => actions.addRound(game.id),
    }, '+ Add round'),
    h('button', {
      type: 'button',
      class: 'btn',
      onclick: () => actions.rematch(game.id),
    }, 'Rematch'));

  return h('section', { class: 'view view-game' },
    header, mode, standingsList, table, actionsBar);
}
