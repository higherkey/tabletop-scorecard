import { h } from '../dom.js';
import { MAX_PLAYERS } from '../model.js';
import { avatar } from '../ui.js';

export function renderSetup(state, actions) {
  const defaultLowWins = state.settings.defaultLowWins === true;
  const rows = [];
  const list = h('ol', { class: 'player-rows' });
  const addBtn = h('button', {
    type: 'button',
    class: 'btn btn-ghost add-player',
    onClick: () => addRow(true),
  }, '+ Add player');

  const nameInput = h('input', {
    id: 'game-name',
    class: 'text-input',
    name: 'name',
    autocomplete: 'off',
    maxlength: 60,
    placeholder: 'e.g. Catan night',
  });

  const errorEl = h('p', { class: 'form-error', role: 'alert', hidden: true }, 'Add at least one player.');

  function makeEntry() {
    const input = h('input', {
      class: 'text-input',
      maxlength: 30,
      autocomplete: 'off',
      onInput: () => refreshAvatar(entry),
      onKeydown: (e) => {
        if (e.isComposing || e.keyCode === 229) return;
        if (e.key !== 'Enter') return;
        if (rows[rows.length - 1] !== entry) return;
        if (!input.value.trim() || rows.length >= MAX_PLAYERS) return;
        e.preventDefault();
        addRow(true);
      },
    });
    const removeBtn = h('button', {
      type: 'button',
      class: 'icon-btn',
      onClick: () => removeRow(entry),
    }, '×');
    const avatarEl = avatar('', 0, { size: 'md' });
    const row = h('li', { class: 'player-row' }, avatarEl, input, removeBtn);
    const entry = { row, input, removeBtn, avatarEl, color: 0 };
    return entry;
  }

  function refreshAvatar(entry) {
    const next = avatar(entry.input.value.trim(), entry.color, { size: 'md' });
    entry.avatarEl.replaceWith(next);
    entry.avatarEl = next;
  }

  function renumber() {
    rows.forEach((entry, i) => {
      const n = i + 1;
      if (entry.color !== i % 8) {
        entry.color = i % 8;
        refreshAvatar(entry);
      }
      entry.input.setAttribute('aria-label', `Player ${n} name`);
      entry.input.setAttribute('placeholder', `Player ${n}`);
      entry.removeBtn.setAttribute('aria-label', `Remove player ${n}`);
    });
    addBtn.disabled = rows.length >= MAX_PLAYERS;
    rows.forEach((entry) => {
      entry.removeBtn.disabled = rows.length <= 1;
    });
  }

  function addRow(focus) {
    if (rows.length >= MAX_PLAYERS) return null;
    const entry = makeEntry();
    rows.push(entry);
    list.appendChild(entry.row);
    renumber();
    if (focus) entry.input.focus();
    return entry;
  }

  function removeRow(entry) {
    const idx = rows.indexOf(entry);
    if (idx === -1 || rows.length <= 1) return;
    rows.splice(idx, 1);
    entry.row.remove();
    renumber();
    rows[Math.min(idx, rows.length - 1)].input.focus();
  }

  addRow(false);
  addRow(false);

  function findEmptyEntry() {
    return rows.find((entry) => !entry.input.value.trim()) ?? null;
  }

  function findEntryByName(name) {
    const target = name.toLowerCase();
    return rows.find((entry) => entry.input.value.trim().toLowerCase() === target) ?? null;
  }

  function toggleRosterChip(rosterEntry, btn) {
    if (btn.getAttribute('aria-pressed') === 'true') {
      const match = findEntryByName(rosterEntry.name);
      if (match) {
        if (rows.length === 1) {
          match.input.value = '';
          refreshAvatar(match);
        } else {
          removeRow(match);
        }
      }
      btn.setAttribute('aria-pressed', 'false');
      return;
    }

    let target = findEmptyEntry();
    if (!target) target = addRow(false);
    if (!target) return;
    target.input.value = rosterEntry.name;
    refreshAvatar(target);
    btn.setAttribute('aria-pressed', 'true');
  }

  const rosterField = state.roster.length > 0
    ? h('div', { class: 'field' },
      h('span', { class: 'field-label', id: 'roster-label' }, 'Saved players'),
      h('div', { class: 'chip-row', role: 'group', 'aria-labelledby': 'roster-label' },
        state.roster.map((rosterEntry) => {
          const btn = h('button', {
            type: 'button',
            class: `chip chip-player pc-${rosterEntry.color}`,
            'aria-pressed': 'false',
            onClick: () => toggleRosterChip(rosterEntry, btn),
          },
          avatar(rosterEntry.name, rosterEntry.color, { size: 'sm' }),
          rosterEntry.name);
          return btn;
        })))
    : null;

  const form = h('form', {
    class: 'setup-form stack',
    novalidate: true,
    onSubmit: (e) => {
      e.preventDefault();
      const names = rows.map((entry) => entry.input.value.trim()).filter(Boolean);
      if (names.length === 0) {
        errorEl.hidden = false;
        rows[0].input.focus();
        return;
      }
      errorEl.hidden = true;
      const lowWins = form.elements.namedItem('lowWins').value === '1';
      actions.createGame({ name: nameInput.value, players: names, lowWins });
    },
  },
  h('div', { class: 'field' },
    h('label', { class: 'field-label', for: 'game-name' }, 'Game name'),
    nameInput),
  rosterField,
  h('fieldset', { class: 'field' },
    h('legend', { class: 'field-label' }, 'Players'),
    list,
    addBtn),
  h('fieldset', { class: 'field' },
    h('legend', { class: 'field-label' }, 'Scoring'),
    h('div', { class: 'radio-group' },
      h('label', { class: 'radio-option' },
        h('input', { type: 'radio', name: 'lowWins', value: '0', checked: !defaultLowWins }),
        ' Highest score wins'),
      h('label', { class: 'radio-option' },
        h('input', { type: 'radio', name: 'lowWins', value: '1', checked: defaultLowWins }),
        ' Lowest score wins'))),
  errorEl,
  h('div', { class: 'form-actions' },
    h('button', { type: 'submit', class: 'btn btn-primary' }, 'Start game')));

  return h('section', { class: 'view view-setup' },
    h('div', { class: 'view-header' },
      h('h2', { class: 'view-title', tabindex: '-1' }, 'New game'),
      h('a', { class: 'btn btn-ghost', href: '#/' }, 'Cancel')),
    form);
}
