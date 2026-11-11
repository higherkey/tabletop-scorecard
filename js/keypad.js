const MAX_DIGITS = 7;

const KEY_ACTIONS = new Map([
  ['Backspace', 'back'],
  ['Enter', 'done'],
  ['Delete', 'clear'],
  ['-', 'neg'],
]);

export function createKeypad(dialog, { onKey } = {}) {
  const titleEl = dialog.querySelector('#keypad-title');
  const displayEl = dialog.querySelector('#keypad-display');
  const doneBtn = dialog.querySelector('[data-key="done"]');
  let buffer = '';
  let negative = false;
  let submit = null;

  function currentValue() {
    if (buffer === '') return null;
    const n = Number(buffer);
    return negative && n !== 0 ? -n : n;
  }

  function render() {
    displayEl.textContent = negative ? `-${buffer}` : buffer || '–';
    displayEl.classList.toggle('is-empty', buffer === '');
  }

  function close() {
    if (dialog.open) dialog.close();
  }

  function finish(value, advance) {
    const cb = submit;
    if (!advance) close();
    cb?.(value, advance);
  }

  function addDigit(d) {
    if (buffer === '0') buffer = d;
    else if (buffer.length < MAX_DIGITS) buffer += d;
  }

  function press(key) {
    onKey?.(key);
    if (key === 'done') return finish(currentValue(), false);
    if (key === 'next') return finish(currentValue(), true);
    if (key === 'clear') return finish(null, false);
    if (key === 'neg') negative = !negative;
    else if (key === 'back') buffer = buffer.slice(0, -1);
    else if (/^[0-9]$/.test(key)) addDigit(key);
    else return;
    render();
  }

  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) {
      close();
      return;
    }
    const btn = e.target.closest('[data-key]');
    if (btn && dialog.contains(btn)) press(btn.dataset.key);
  });

  dialog.addEventListener('keydown', (e) => {
    if (e.repeat && (e.key === 'Enter' || e.key === 'Delete')) { e.preventDefault(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const key = /^[0-9]$/.test(e.key) ? e.key : KEY_ACTIONS.get(e.key);
    if (!key) return;
    if (e.key === 'Enter') {
      const focusedBtn = e.target.closest('button[data-key]');
      if (focusedBtn && focusedBtn.dataset.key !== 'done') return;
    }
    e.preventDefault();
    press(key);
  });

  function open({ title, value, onSubmit }) {
    submit = onSubmit;
    buffer = value == null ? '' : String(Math.abs(value));
    negative = value != null && value < 0;
    titleEl.textContent = title;
    render();
    if (!dialog.open) dialog.showModal();
    doneBtn.focus();
  }

  return { open, close };
}
