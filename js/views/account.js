import { h, clear } from '../dom.js';
import { avatar, segmented, emptyState } from '../ui.js';
import { icon } from '../icons.js';

const SYNC_LABELS = {
  synced: 'Up to date',
  syncing: 'Syncing…',
  offline: 'Offline, will sync later',
  error: 'Sync problem',
};

// Kept at module level so the chosen mode survives full view re-renders.
// The mode switch only rebuilds the form, never the whole view.
let authMode = 'signin';

export function renderAccount(state, actions, { cloud }) {
  const header = h('div', { class: 'view-header' },
    h('h2', { class: 'view-title', tabindex: '-1' }, 'Account'));

  return h('section', { class: 'view view-account' },
    header,
    renderCard(cloud, actions));
}

function renderCard(cloud, actions) {
  switch (cloud.status) {
    case 'unavailable':
      return h('div', { class: 'auth-card' },
        emptyState({
          icon: 'cloud-off',
          title: "Sign-in isn't available in this browser",
          text: 'This browser blocks the cookie our sign-in needs (Safari and iPhone do this). Your games are still saved on this device. Try Chrome, Edge, Firefox or Android to sync.',
          action: h('button', {
            type: 'button',
            class: 'btn',
            onClick: () => actions.retryAuth(),
          }, 'Try again'),
        }));
    case 'signed-out':
      return h('div', { class: 'auth-card' }, ...signedOutContent(cloud, actions));
    case 'signed-in':
      return h('div', { class: 'auth-card' }, ...signedInContent(cloud, actions));
    default:
      return h('div', { class: 'auth-card', 'aria-busy': 'true' },
        h('p', { class: 'muted' }, 'Checking your account…'));
  }
}

function signedOutContent(cloud, actions) {
  return [
    h('p', { class: 'form-note' },
      'Sign in to back up your games, see them on every device and share live scoreboards.'),
    h('button', {
      type: 'button',
      class: 'btn btn-google btn-block',
      onClick: () => actions.signInWithGoogle(),
    }, 'Continue with Google'),
    h('div', { class: 'divider' }, 'or'),
    renderAuthForm(cloud, actions),
  ];
}

function renderAuthForm(cloud, actions) {
  const form = h('form', {
    class: 'stack',
    novalidate: true,
    onSubmit: (e) => submitAuth(e, form, actions),
  });
  fillAuthForm(form, cloud, actions, { email: '', password: '', error: cloud.error ?? '' });
  return form;
}

// Replaces the form's children only. Typed email and password are passed in via `values`.
function fillAuthForm(form, cloud, actions, values) {
  const creating = authMode === 'create';
  const busy = Boolean(cloud.busy);

  const children = [
    segmented({
      name: 'auth-mode',
      legend: 'Sign in or create account',
      options: [
        { value: 'signin', label: 'Sign in' },
        { value: 'create', label: 'Create account' },
      ],
      value: authMode,
      onChange: (value) => {
        authMode = value;
        const kept = readValues(form);
        fillAuthForm(form, cloud, actions, { ...kept, error: '' });
        form.querySelector(`input[name="auth-mode"][value="${value}"]`)?.focus();
      },
    }),
  ];

  if (creating) {
    children.push(h('div', { class: 'field' },
      h('label', { class: 'field-label', for: 'auth-name' }, 'Name'),
      h('input', {
        id: 'auth-name',
        class: 'text-input',
        type: 'text',
        name: 'name',
        autocomplete: 'name',
        maxlength: 60,
      })));
  }

  children.push(
    h('div', { class: 'field' },
      h('label', { class: 'field-label', for: 'auth-email' }, 'Email'),
      h('input', {
        id: 'auth-email',
        class: 'text-input',
        type: 'email',
        name: 'email',
        autocomplete: 'email',
        required: true,
        value: values.email ?? '',
      })),
    h('div', { class: 'field' },
      h('label', { class: 'field-label', for: 'auth-password' }, 'Password'),
      h('input', {
        id: 'auth-password',
        class: 'text-input',
        type: 'password',
        name: 'password',
        autocomplete: creating ? 'new-password' : 'current-password',
        minlength: 8,
        value: values.password ?? '',
      })),
    h('p', {
      class: 'form-error',
      role: 'alert',
      hidden: !values.error,
    }, values.error ?? ''),
    h('button', {
      type: 'submit',
      class: 'btn btn-primary btn-block',
      disabled: busy,
    }, busy ? 'Please wait…' : submitLabel(creating)),
  );

  clear(form);
  for (const child of children) form.appendChild(child);
}

function submitLabel(creating) {
  return creating ? 'Create account' : 'Sign in';
}

function readValues(form) {
  return {
    email: form.querySelector('#auth-email')?.value ?? '',
    password: form.querySelector('#auth-password')?.value ?? '',
  };
}

function validate({ name, email, password, creating }) {
  if (creating && !name) return 'Enter your name.';
  if (!email.includes('@')) return 'Enter a valid email address.';
  if (password.length < 8) return 'Password must be at least 8 characters.';
  return '';
}

function showFormError(errorEl, message) {
  errorEl.textContent = message;
  errorEl.hidden = message === '';
}

async function submitAuth(event, form, actions) {
  event.preventDefault();
  const creating = authMode === 'create';
  const submit = form.querySelector('button[type="submit"]');
  const errorEl = form.querySelector('.form-error');
  const name = form.querySelector('#auth-name')?.value.trim() ?? '';
  const email = form.querySelector('#auth-email').value.trim();
  const password = form.querySelector('#auth-password').value;

  const problem = validate({ name, email, password, creating });
  if (problem) {
    showFormError(errorEl, problem);
    return;
  }

  showFormError(errorEl, '');
  submit.disabled = true;
  submit.textContent = 'Please wait…';
  try {
    if (creating) await actions.signUp({ name, email, password });
    else await actions.signIn({ email, password });
  } catch (err) {
    showFormError(errorEl, err?.message || 'Something went wrong. Please try again.');
  } finally {
    submit.disabled = false;
    submit.textContent = submitLabel(creating);
  }
}

function signedInContent(cloud, actions) {
  const user = cloud.user ?? {};
  const label = user.name || user.email || '';
  return [
    avatar(label, 1, { size: 'lg' }),
    h('h3', { class: 'auth-name' }, label),
    h('p', { class: 'muted' }, user.email ?? ''),
    h('p', { class: 'auth-sync' },
      icon('cloud', { size: 16 }),
      ' ',
      SYNC_LABELS[cloud.sync] ?? ''),
    h('button', {
      type: 'button',
      class: 'btn',
      onClick: () => actions.syncNow(),
    }, 'Sync now'),
    h('button', {
      type: 'button',
      class: 'btn btn-ghost',
      onClick: () => actions.signOut(),
    }, icon('log-out'), 'Sign out'),
  ];
}
