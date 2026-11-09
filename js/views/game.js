import { h } from '../dom.js';
import { standings, totals } from '../model.js';
import { avatar, medal } from '../ui.js';
import { icon } from '../icons.js';

export function renderGame(game, actions, { canShare = false, readOnly = false } = {}) {
  const players = game.players;
  const totalMap = totals(game);
  const ranked = standings(game);
  const anyScore = game.rounds.some((r) => Object.keys(r.scores).length > 0);
  const finished = game.finishedAt != null;
  const frozen = finished || readOnly;

  const shareBtn = canShare
    ? h('button', {
      type: 'button',
      class: 'icon-btn',
      'aria-label': 'Share game',
      onClick: () => actions.shareGame(game.id),
    }, icon('share-2'))
    : null;

  const renameBtn = readOnly ? null : h('button', {
    type: 'button',
    class: 'icon-btn',
    'aria-label': 'Rename game',
    onClick: () => {
      const next = window.prompt('Rename game', game.name);
      if (next !== null) actions.renameGame(game.id, next);
    },
  }, h('span', { 'aria-hidden': 'true' }, 'Aa'));

  const header = h('div', { class: 'view-header' },
    h('h2', { class: 'view-title', tabindex: '-1' }, game.name),
    h('div', { class: 'view-header-actions' }, shareBtn, renameBtn));

  const mode = h('p', { class: 'muted game-mode' },
    (game.lowWins ? 'Lowest score wins' : 'Highest score wins') + (game.shareToken ? ' · Shared' : ''));

  let banner = null;
  if (finished) {
    const top = ranked.filter((s) => s.rank === 1);
    let title = 'Game finished';
    let subtitle = null;
    if (anyScore && top.length > 0) {
      const names = top.map((s) => s.player.name);
      title = top.length === 1 ? `${names[0]} wins!` : `${names.join(' & ')} tie!`;
      subtitle = `Final · ${top[0].total} points`;
    }
    banner = h('div', { class: 'winner-banner', role: 'status' },
      icon('trophy', { size: 28 }),
      h('div', null,
        h('p', { class: 'winner-title' }, title),
        subtitle ? h('p', { class: 'muted' }, subtitle) : null));
  }

  const standingsList = h('ol', { class: 'standings', 'aria-label': 'Standings' },
    ranked.map((s) => {
      const isLeader = anyScore && s.rank === 1;
      return h('li', { class: `standing pc-${s.player.color}${isLeader ? ' is-leader' : ''}` },
        medal(s.rank),
        avatar(s.player.name, s.player.color, { size: 'sm' }),
        h('span', { class: 'standing-name truncate', title: s.player.name }, s.player.name),
        h('span', { class: 'standing-total' }, String(s.total)));
    }));

  const thead = h('thead', null,
    h('tr', null,
      h('th', { scope: 'col', class: 'round-col' }, 'Round'),
      players.map((p) => h('th', { scope: 'col', class: `player-col pc-${p.color}` },
        avatar(p.name, p.color, { size: 'sm' }),
        ' ',
        h('span', { class: 'truncate', title: p.name }, p.name))),
      frozen ? null : h('th', { scope: 'col', class: 'round-actions' },
        h('span', { class: 'visually-hidden' }, 'Actions'))));

  const tbody = h('tbody', null,
    game.rounds.map((round, i) => {
      const n = i + 1;
      return h('tr', null,
        h('th', { scope: 'row', class: 'round-col' }, String(n)),
        players.map((p) => {
          const v = round.scores[p.id];
          const has = typeof v === 'number';
          const label = `Round ${n}, ${p.name}: ${has ? v : 'no score'}`;
          if (frozen) {
            return h('td', null,
              h('span', { class: 'score-value' }, has ? String(v) : '–'));
          }
          return h('td', null,
            h('button', {
              type: 'button',
              class: has ? 'score-cell' : 'score-cell is-empty',
              dataset: { round: round.id, player: p.id },
              'aria-label': label,
              onClick: () => actions.openScore(game.id, round.id, p.id),
            }, has ? String(v) : '–'));
        }),
        frozen ? null : h('td', { class: 'round-actions' },
          h('button', {
            type: 'button',
            class: 'icon-btn',
            'aria-label': `Delete round ${n}`,
            onClick: () => actions.removeRound(game.id, round.id),
          }, icon('x', { size: 18 }))));
    }));

  const tfoot = h('tfoot', null,
    h('tr', { class: 'totals-row' },
      h('th', { scope: 'row', class: 'round-col' }, 'Total'),
      players.map((p) => h('td', { class: 'total-cell' }, String(totalMap[p.id] ?? 0))),
      frozen ? null : h('td', { class: 'round-actions' })));

  const table = h('div', { class: 'table-scroll' },
    h('table', { class: 'score-table' },
      h('caption', { class: 'visually-hidden' }, 'Scores by round'),
      thead,
      tbody,
      tfoot));

  const actionsBar = readOnly ? null : h('div', { class: 'game-actions' },
    finished
      ? [
        h('button', {
          type: 'button',
          class: 'btn',
          onClick: () => actions.reopenGame(game.id),
        }, icon('rotate-ccw'), 'Reopen'),
        h('button', {
          type: 'button',
          class: 'btn btn-primary',
          onClick: () => actions.rematch(game.id),
        }, icon('dice-5'), 'Rematch'),
      ]
      : [
        h('button', {
          type: 'button',
          class: 'btn btn-primary',
          onClick: () => actions.addRound(game.id),
        }, icon('plus'), 'Add round'),
        h('button', {
          type: 'button',
          class: 'btn',
          onClick: () => actions.finishGame(game.id),
        }, icon('flag'), 'Finish'),
      ]);

  return h('section', { class: 'view view-game' },
    header, mode, banner, standingsList, table, actionsBar);
}
