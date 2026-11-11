# Tabletop Scorecard

An installable, offline-first scorecard for any tabletop game. It has no framework and no build step: just native ES modules, plain CSS, and a service worker. An optional Neon backend adds accounts, sync, and live share links.

**Live:** https://www.eight1fivedesign.com/tabletop-scorecard/ (all browsers) · https://higherkey.github.io/tabletop-scorecard/ (sign-in is unavailable in Safari/iOS there)

## Features
- **Scoring:** up to 12 players, highest- or lowest-wins scoring, a round-by-round table, live standings (with ties and medals), and a touch keypad (negatives, **Next**, keyboard entry, haptics). On mobile the keypad is a bottom sheet.
- **Games:** finish a game for a winner banner (read-only until reopened), rematch, rename, and Undo for deleted games and rounds.
- **Saved players:** names from finished games become tap-to-add chips in setup, and you can manage them in Settings.
- **Stats:** games played, most played, and per-player wins, win %, average, and best, with a filter by game.
- **Settings:** theme (System, Light, Dark), default scoring, keep screen awake during a game, haptic feedback, and JSON export.
- **Accounts and sync:** email+password or Google sign-in. Games, saved players, and settings sync across devices. The sync is local-first: the app keeps working offline and syncs later.
- **Sharing:** a live, read-only scoreboard link (`#/s/<token>`) that anyone can open without an account. It refreshes every 15 s, and the owner can stop sharing at any time.
- **Data safety:** backups are made before anything is discarded. Sync uses per-item server versions and a server-side stale-write guard. A conflict copy is made before a remote change overwrites unsynced local edits.

## Develop
```sh
npm install              # dev-only tooling (Playwright core, Neon driver, wrangler, Lucide icons)
npm start                # http://127.0.0.1:5173 (auth goes directly to Neon)
npm test                 # node:test unit tests (model, sync, store, stats, cloud, syncer, SW precache)
npm run e2e              # local browser smoke test (installed Edge; E2E_CHANNEL=chrome to switch)
npm run e2e:cloud        # real-Neon e2e: sync across devices, sharing (creates and cleans up test users)
npm run e2e:worker       # Cloudflare Worker host and same-origin auth proxy via wrangler dev
npm run vendor           # regenerate js/icons-data.js from lucide-static
npm run icons            # regenerate PNG app icons
```
Node 22 or later. The cloud scripts read the owner connection string through `neonctl` (it needs `NEON_API_KEY`) and only ever hold it in the process environment.

## Backend (Neon)
- Project `late-haze-23135872`, db `neondb`. It uses **Neon Auth** (Better Auth) and the **Data API** (PostgREST) with RLS on every table. There is no custom server.
- Schema: `db/migrations/*.sql`, applied with `DATABASE_URL=… npm run db:migrate` (idempotent), followed by a Data API schema refresh. `npm run db:check` proves RLS isolation, the stale-write guard, and anonymous share access.
- The client is `js/cloud.js`, a plain `fetch` client with no SDK. `js/syncer.js` handles pull, merge, and push. `js/config.js` holds the public endpoints.

## Hosting
- **Cloudflare Worker** (`worker/index.js`, `wrangler.toml`): serves `dist/` at `www.eight1fivedesign.com/tabletop-scorecard/` and proxies `/tabletop-scorecard/auth/*` to Neon Auth, which makes the session cookie first-party and lets Safari and iOS sign in. Deploy with `npm run deploy:worker`. Use `npm run worker:dev` locally (it uses `wrangler.dev.toml`).
- **GitHub Pages** serves the `main` branch root, with no build step. Neon Auth's session cookie is third-party there, so Safari and iOS can't sign in.
- Adding an origin means updating both the Neon Auth trusted domains and the Data API CORS (see `neonctl neon-auth domain add` / `neonctl data-api update`).

## Structure
| Path | Role |
|------|------|
| `js/model.js` | Pure data functions: games, roster, settings, sync bookkeeping, validation and migration |
| `js/sync.js` | Pure merge logic (`mergeRemote`) and push collection (`collectPush`) |
| `js/store.js` | State container and persistence, with backup-before-discard and multi-tab sync |
| `js/cloud.js`, `js/syncer.js` | The Neon auth and Data API client, and the sync orchestration |
| `js/stats.js` | Pure stats over finished games |
| `js/dom.js`, `js/ui.js`, `js/icons.js` | `h()` (rejects inline styles), UI primitives, and the Lucide icons |
| `js/views/*.js` | Views: home, setup, game, stats, settings, account, shared |
| `js/app.js` | Router, render loop, actions, sync and ownership flows, toasts, wake lock, SW registration |
| `sw.js` | Cache-first app shell that never caches `/auth/`. Bump `VERSION` when assets change |
| `css/tokens.css` → `base.css` → `components.css` | Sitewright Web Design tokens (OKLCH, APCA-verified), the "artisan" type, logical properties |

## Releasing a change
1. Bump `VERSION` in `sw.js` whenever any cached asset changes. `test/sw-assets.test.mjs` fails if a new app file isn't precached.
2. Run `npm test`, `npm run e2e`, `npm run e2e:cloud`, and `npm run e2e:worker`.
3. Merging to `main` deploys GitHub Pages. Run `npm run deploy:worker` for the domain.
