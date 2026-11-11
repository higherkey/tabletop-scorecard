import { h } from '../dom.js';
import { avatar, segmented, toggle } from '../ui.js';
import { icon } from '../icons.js';

const SYNC_LABELS = {
  synced: 'Up to date',
  syncing: 'Syncing…',
  offline: 'Offline, will sync later',
  error: 'Sync problem',
};

export function renderSettings(state, actions, { account = { status: 'signed-out' } } = {}) {
  const signedIn = account.status === 'signed-in';
  const settings = state.settings;

  const header = h('div', { class: 'view-header' },
    h('h2', { class: 'view-title', tabindex: '-1' }, 'Settings'));

  const accountGroup = h('section', { class: 'settings-group', 'aria-labelledby': 'settings-account-title' },
    h('h3', { class: 'group-title', id: 'settings-account-title' }, 'Account'),
    h('a', { class: 'settings-row', href: '#/account' },
      avatar(signedIn && account.email ? account.email : '?', 1, { size: 'md' }),
      h('span', { class: 'settings-row-text' },
        h('span', { class: 'settings-row-title' }, signedIn && account.email ? account.email : 'Sign in to sync'),
        h('span', { class: 'muted' }, signedIn
          ? `Sync: ${SYNC_LABELS[account.sync] ?? SYNC_LABELS.synced}`
          : 'Back up games and use them on any device')),
      icon('chevron-right')));

  const appearanceGroup = h('section', { class: 'settings-group', 'aria-labelledby': 'settings-appearance-title' },
    h('h3', { class: 'group-title', id: 'settings-appearance-title' }, 'Appearance'),
    segmented({
      name: 'theme',
      legend: 'Theme',
      options: [
        { value: 'system', label: 'System' },
        { value: 'light', label: 'Light' },
        { value: 'dark', label: 'Dark' },
      ],
      value: settings.theme,
      onChange: (v) => actions.updateSettings({ theme: v }),
    }));

  const gameplayGroup = h('section', { class: 'settings-group', 'aria-labelledby': 'settings-gameplay-title' },
    h('h3', { class: 'group-title', id: 'settings-gameplay-title' }, 'Gameplay'),
    segmented({
      name: 'scoring',
      legend: 'Default scoring',
      options: [
        { value: 'high', label: 'Highest wins' },
        { value: 'low', label: 'Lowest wins' },
      ],
      value: settings.defaultLowWins ? 'low' : 'high',
      onChange: (v) => actions.updateSettings({ defaultLowWins: v === 'low' }),
    }),
    toggle({
      id: 'settings-keep-awake',
      label: 'Keep screen awake',
      description: 'While a game is open',
      checked: settings.keepAwake,
      onChange: (v) => actions.updateSettings({ keepAwake: v }),
    }),
    toggle({
      id: 'settings-haptics',
      label: 'Haptic feedback',
      description: 'Vibrate on keypad taps (supported phones)',
      checked: settings.haptics,
      onChange: (v) => actions.updateSettings({ haptics: v }),
    }));

  const input = h('input', {
    type: 'text',
    class: 'text-input',
    maxlength: 30,
    placeholder: 'Add a name',
    autocomplete: 'off',
    'aria-label': 'Add player name',
  });

  const rosterList = state.roster.length > 0
    ? h('ul', { class: 'roster-list' }, state.roster.map((entry) => h('li', { class: 'roster-item' },
      avatar(entry.name, entry.color, { size: 'md' }),
      h('span', { class: 'settings-row-text' },
        h('span', { class: 'settings-row-title' }, entry.name)),
      h('button', {
        type: 'button',
        class: 'icon-btn',
        'aria-label': `Remove ${entry.name}`,
        onclick: () => actions.removeRosterEntry(entry.key),
      }, icon('x')))))
    : h('p', { class: 'muted' }, 'Players are saved automatically when a game finishes.');

  const playersGroup = h('section', { class: 'settings-group', 'aria-labelledby': 'settings-players-title' },
    h('h3', { class: 'group-title', id: 'settings-players-title' }, 'Saved players'),
    rosterList,
    h('form', {
      class: 'roster-add',
      onsubmit: (event) => {
        event.preventDefault();
        const name = input.value.trim();
        if (name) actions.addRosterName(name);
        input.value = '';
        input.focus();
      },
    },
    input,
    h('button', { class: 'btn', type: 'submit' }, 'Add')));

  const dataGroup = h('section', { class: 'settings-group', 'aria-labelledby': 'settings-data-title' },
    h('h3', { class: 'group-title', id: 'settings-data-title' }, 'Data'),
    h('button', {
      class: 'btn',
      type: 'button',
      onclick: () => actions.exportData(),
    }, icon('download'), 'Export games (JSON)'),
    h('p', { class: 'muted' },
      `Your games are stored on this device${signedIn ? ' and synced to your account' : ''}.`));

  const footer = h('p', { class: 'muted app-version' }, 'Tabletop Scorecard · v2');

  return h('section', { class: 'view view-settings' },
    header,
    accountGroup,
    appearanceGroup,
    gameplayGroup,
    playersGroup,
    dataGroup,
    footer);
}
