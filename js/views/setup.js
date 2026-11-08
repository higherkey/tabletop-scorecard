import { h } from '../dom.js';
import { MAX_PLAYERS } from '../model.js';

export function renderSetup(state, actions) {
  const rows = [];
  const list = h('ol', { class: 'player-rows' });
  const addBtn = h('button', {
    type: 'button',
    class: 'btn btn-ghost add-player',
    onclick: () => addRow(true),
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
    const swatch = h('span', { class: 'swatch', 'aria-hidden': 'true' });
    const input = h('input', {
      class: 'text-input',
      maxlength: 30,
      autocomplete: 'off',
      onkeydown: (e) => {
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
      onclick: () => removeRow(entry),
    }, '×');
    const row = h('li', { class: 'player-row' }, swatch, input, removeBtn);
    const entry = { row, input, removeBtn, swatch };
    return entry;
  }

  function renumber() {
    rows.forEach((entry, i) => {
      const n = i + 1;
      entry.swatch.className = `swatch pc-${i % 8}`;
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

  const form = h('form', {
    class: 'setup-form stack',
    novalidate: true,
    onsubmit: (e) => {
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
  h('fieldset', { class: 'field' },
    h('legend', { class: 'field-label' }, 'Players'),
    list,
    addBtn),
  h('fieldset', { class: 'field' },
    h('legend', { class: 'field-label' }, 'Scoring'),
    h('div', { class: 'radio-group' },
      h('label', { class: 'radio-option' },
        h('input', { type: 'radio', name: 'lowWins', value: '0', checked: true }),
        ' Highest score wins'),
      h('label', { class: 'radio-option' },
        h('input', { type: 'radio', name: 'lowWins', value: '1' }),
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
