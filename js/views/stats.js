import { h } from '../dom.js';
import { avatar, emptyState } from '../ui.js';
import { icon } from '../icons.js';
import { computeStats } from '../stats.js';
import { rosterKey } from '../model.js';

const COLOR_COUNT = 8;

export function renderStats(state, actions, { gameName = null } = {}) {
  const stats = computeStats(state.games, { gameName });
  const selectedValue = gameName == null
    ? ''
    : (stats.gameNames.find((g) => rosterKey(g.name) === rosterKey(gameName))?.name ?? '');

  const header = h('div', { class: 'view-header' },
    h('h2', { class: 'view-title', tabindex: '-1' }, 'Stats'),
    stats.gameNames.length > 1
      ? h('label', { class: 'select-wrap' },
        h('span', { class: 'visually-hidden' }, 'Filter by game'),
        h('select', {
          class: 'select',
          onchange: (event) => {
            const v = event.target.value;
            actions.navigate('#/stats' + (v ? '?game=' + encodeURIComponent(v) : ''));
          },
        },
        h('option', { value: '', selected: selectedValue === '' }, 'All games'),
        stats.gameNames.map((g) => h('option', {
          value: g.name,
          selected: g.name === selectedValue,
        }, `${g.name} (${g.count})`))))
      : null);

  if (stats.gameNames.length === 0) {
    return h('section', { class: 'view view-stats' },
      header,
      emptyState({
        icon: 'bar-chart-3',
        title: 'No stats yet',
        text: 'Finish a game to see wins, averages and records.',
      }));
  }

  const topGame = stats.gameNames[0]?.name ?? '–';
  const topPlayer = stats.players[0];
  const topWinner = topPlayer && topPlayer.wins > 0
    ? h('span', { class: 'stat-value' }, icon('crown', { size: 18 }), ` ${topPlayer.name}`)
    : h('span', { class: 'stat-value' }, '–');

  const tiles = h('div', { class: 'stat-tiles' },
    h('div', { class: 'stat-tile' },
      h('span', { class: 'stat-label' }, 'Games played'),
      h('span', { class: 'stat-value' }, String(stats.gamesPlayed))),
    h('div', { class: 'stat-tile' },
      h('span', { class: 'stat-label' }, 'Most played'),
      h('span', { class: 'stat-value' }, topGame)),
    h('div', { class: 'stat-tile' },
      h('span', { class: 'stat-label' }, 'Top winner'),
      topWinner));

  const rows = stats.players.map((player, index) => {
    const rosterEntry = state.roster.find((entry) => entry.key === player.key);
    const color = rosterEntry ? rosterEntry.color : index % COLOR_COUNT;
    return h('tr', null,
      h('th', { scope: 'row' },
        h('span', { class: 'stats-player' }, avatar(player.name, color, { size: 'sm' }), player.name)),
      h('td', null, String(player.played)),
      h('td', null, String(player.wins)),
      h('td', null, `${Math.round(player.winRate * 100)}%`),
      h('td', null, String(player.avgScore)),
      h('td', null, String(player.highScore)));
  });

  const table = h('div', { class: 'table-scroll' },
    h('table', { class: 'stats-table' },
      h('caption', { class: 'visually-hidden' }, 'Player stats'),
      h('thead', null,
        h('tr', null,
          h('th', { scope: 'col' }, 'Player'),
          h('th', { scope: 'col' }, 'Played'),
          h('th', { scope: 'col' }, 'Wins'),
          h('th', { scope: 'col' }, 'Win %'),
          h('th', { scope: 'col' }, 'Avg'),
          h('th', { scope: 'col' }, 'Best'))),
      h('tbody', null, rows)));

  return h('section', { class: 'view view-stats' }, header, tiles, table);
}
