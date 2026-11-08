# Tabletop Scorecard

An installable, offline-first scorecard for any tabletop game. It has no framework and no build step: just native ES modules, plain CSS, and a service worker.

## Features
- Games with any number of players (up to 12), scored highest-wins or lowest-wins.
- Round-by-round score table with live totals and standings, including ties.
- A touch-friendly keypad for score entry. It supports negative scores, and **Next** advances to the next player and round. Keyboard entry also works.
- Rematch with the same players, rename, and delete.
- Saved locally in `localStorage`. If saved data is corrupt or partially invalid, the raw data is backed up under `tabletop-scorecard:backup:<timestamp>` before anything is discarded.
- PWA: installable, works offline, and shows an in-app "Update available" prompt (it never reloads without consent).
- Light and dark themes come from the system preference.

## Develop
```sh
npm install          # dev-only: playwright-core for the e2e smoke test
npm start            # http://127.0.0.1:5173
npm test             # node:test unit tests (model + store)
npm run e2e          # browser smoke test (uses installed Edge; E2E_CHANNEL=chrome to switch)
npm run icons        # regenerate PNG icons from the drawing code
```

## Structure
| Path | Role |
|------|------|
| `js/model.js` | Pure data functions (games, rounds, scores, standings, validation) |
| `js/store.js` | State container + persistence with backup-before-discard |
| `js/dom.js` | `h()` element helper (rejects inline styles) |
| `js/views/*.js` | Presentational render functions: home, setup, game |
| `js/keypad.js` | Score-entry dialog controller |
| `js/app.js` | Hash router, render loop, actions, toast, service-worker registration |
| `sw.js` | Cache-first app shell. Bump `VERSION` when assets change |
| `css/tokens.css` → `base.css` → `components.css` | Design tokens, base layout, components |

## Releasing a change
Bump `VERSION` in `sw.js` (for example `v2`) whenever you change any cached asset. Otherwise installed clients keep the old shell.

GitHub Pages serves the site straight from the `main` branch root, with no build step. Pushing to `main` deploys.
