import { h } from './dom.js';
import { icon } from './icons.js';

function initials(name) {
  const words = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) {
    const chars = [...words[0]];
    return chars.length === 1
      ? chars[0].toUpperCase()
      : chars[0].toUpperCase() + chars[1].toLowerCase();
  }
  return [...words[0]][0].toUpperCase() + [...words[1]][0].toUpperCase();
}

export function avatar(name, color, { size = 'md' } = {}) {
  return h(
    'span',
    { class: `avatar avatar-${size} pc-${color}`, 'aria-hidden': 'true' },
    initials(name),
  );
}

export function segmented({ name, legend, options, value, onChange }) {
  return h(
    'fieldset',
    { class: 'segmented' },
    h('legend', { class: 'field-label' }, legend),
    h(
      'div',
      { class: 'segmented-track' },
      options.map((option) =>
        h(
          'label',
          { class: 'segmented-option' },
          h('input', {
            type: 'radio',
            class: 'visually-hidden-input',
            name,
            value: option.value,
            checked: String(option.value) === String(value),
            onChange: (e) => onChange(e.target.value),
          }),
          h('span', null, option.label),
        ),
      ),
    ),
  );
}

export function toggle({ id, label, description, checked, onChange }) {
  return h(
    'div',
    { class: 'toggle-row' },
    h(
      'div',
      { class: 'toggle-text' },
      h('label', { for: id, class: 'toggle-label' }, label),
      h('p', { class: 'toggle-desc muted' }, description),
    ),
    h('input', {
      type: 'checkbox',
      role: 'switch',
      id,
      class: 'switch',
      checked: Boolean(checked),
      onChange: (e) => onChange(e.target.checked),
    }),
  );
}

export function emptyState({ icon: iconName, title, text, action }) {
  return h(
    'div',
    { class: 'empty-state' },
    h('span', { class: 'empty-icon' }, icon(iconName, { size: 32 })),
    h('h3', { class: 'empty-title' }, title),
    h('p', { class: 'muted' }, text),
    action,
  );
}

export function medal(rank) {
  if (rank === 1 || rank === 2 || rank === 3) {
    return h('span', { class: `medal medal-${rank}`, 'aria-label': `Rank ${rank}` }, String(rank));
  }
  return h('span', { class: 'rank-num' }, `#${rank}`);
}
