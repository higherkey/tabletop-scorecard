# Branch Notes: feat/neon-backend

Plan: Neon Auth (email+password, Google) + Data API with RLS, local-first sync, stats, sharing, settings, and a visual refresh. There is no custom server.

## 1. Discoveries & Deviations
- The Neon SDK is `@neon/neon-js` (the scope is `@neon/`, not `@neondatabase/`). It is pre-1.0, so pin it.
- The Data API's anonymous role needs a JWT (`allowAnonymous`). The spike verifies this.
- Deviation: the saved-players table is keyed by `(user_id, key = lower(trim(name)))` instead of a uuid. That way, two devices adding "Alice" offline converge instead of colliding on a unique index.
- Addition: a server-side last-writer-wins guard. A `BEFORE UPDATE` trigger skips stale writes (`NEW.updated_at < OLD.updated_at`), which closes the race between pull and push.
- Sync pushes items changed since `lastPushedAt` (the device clock) and pulls by `server_updated_at`, which is set by the server.

- Provisioned: project `late-haze-23135872` (aws-us-east-2), branch `br-old-mountain-bdcbtobt`, db `neondb`. Email+password is on by default, Google is shared, and the trusted domains are github.io and 127.0.0.1:5173. The Data API uses CORS with the same origins.
- Data API grants are explicit: `grant usage on schema public to anonymous, authenticated`, plus per-table grants.
- `allowAnonymous` works: `GET <auth>/token/anonymous` returns a JWT that can call SECURITY DEFINER RPCs.

## 2. Blockers & Risks (4a)
- RESOLVED BY DECISION: Neon Auth has no cookieless mode. Spike 2 showed bearer session tokens are ignored and there is no bearer plugin. The session is a third-party cookie on github.io, so Safari and iOS cannot sign in.
  - User decision (2026-11-08): stay on github.io for now. Sign-in works on Chrome, Edge, Firefox, and Android.
  - Safari and iOS detect `cookies-blocked` and show "Sign-in isn't available in this browser". Share links (anonymous JWT) work everywhere.
- The SDK is 146 KB gzipped, over the 120 KB threshold, so it is replaced by a thin `fetch` client (`js/cloud.js`). The auth URL is a single config value, ready for a same-origin proxy later.

- Worker verified locally: same-origin sign-up gives a first-party cookie (Path=/tabletop-scorecard/auth, no Domain, Lax, `Partitioned` dropped), plus JWT and session. Dry-run deploy OK. Neon trusts the www domain, and the Data API CORS includes it.
- Trade-off: `wrangler.dev.toml` duplicates `wrangler.toml` minus `routes`. With routes set, `wrangler dev` rewrites Origin to the production host and Neon rejects it (INVALID_ORIGIN).
- Fixed: the `mergeRemote` games loop skipped `data:null` delete rows from the DB, so remote deletes never propagated. Rows are now keyed by `row.id`, with a regression test.
- Database: all 30 rls-check checks pass (isolation, stale-write guard, anonymous limited to the RPC). The migration is idempotent.

- Sitewright Web Design pass (user request). The local CLI at `Z:\Programming\e1f\e1f-web-design-core` was used for tokens, typography, and audit:
  - The OKLCH solver tokens pass APCA and WCAG on all pairs for #1f6f5c (light) and #5cc4a5 (dark).
  - The "artisan" (Bahnschrift/DIN) system stack replaces the Manrope webfont, so there are zero font downloads. This also removes the devDependency and `fonts/`.
  - The pass applies logical properties only, 48px targets, no pills, the bottom-sheet keypad on mobile, `overscroll-behavior: contain`, and a reduced-motion block in every stylesheet.
  - Trade-off: Sitewright's `CSS_BYTE_BUDGET` (6 KB hard) targets marketing concept pages. App CSS is about 20 KB. Not pursued.
- Sitewright bug, to report in its repo and not fixed here: the `NO_BANNED_FONTS` audit rule false-positives on `cursor: pointer` and `pointer-events`, because it matches the substring "inter".

- Adversarial audit (Sonnet, 17 findings), all classified valid. Fixed via contract `CONTRACT-v3-delta` (sync hardening):
  - Sync tracking: per-item `serverVersions` replaces the single global `lastPushedAt`, so the sync no longer depends on device clocks. Per-table cursors with paging and a 30 s overlap replace the single `lastPulledAt`, so truncated pulls can't skip rows.
  - Clock skew: edits get monotonic stamps, and a conflict copy is made before remote data overwrites unpushed local edits.
  - Bad rows: rows are validated before push and retried per row, and failures are quarantined, so one bad row can't block all sync.
  - Account switches: `resetForOwner` resets sync state and, on a switch from another user, regenerates ids.
  - Sign-out and unshare: sign-out only wipes after a verified sync plus a backup. Unshare reports success only after the change is confirmed synced.
  - Store: a migrated load persists once (no backup on every load), and backups are pruned to 5.
  - Proxy: a request-header allowlist, a Neon-only cookie filter, and path traversal is rejected.
  - Smaller fixes: the wake-lock in-flight bug; the setup form is no longer wiped by sync re-renders; offline init retries; a 401 refreshes and retries once; the JWT generation counter; the https check on the OAuth URL; split Worker routes.
  - DB migration 002 relaxes the player key check (JS and Postgres lowercase rules differ).
- e2e found: under Workers Assets, `index.html` is a 307 redirect, and the SW served that redirected response for navigations (ERR_FAILED on reload). The SW now precaches `./` and unwraps redirected responses (VERSION v3).
- The skill `e1f-web-design` is now installed globally (~/.claude/skills), with a local-CLI note. A Sitewright auditor fix is in progress in the e1f repo on a `fix/` branch, uncommitted, for the user's review.

## 3. Quick Wins (4b)
- The SW precache list was stale after v2. It now lists every asset, and `test/sw-assets.test.mjs` fails if an app file is missing from it.
- Done: uninstalled `esbuild` and `@neon/neon-js` (spike only); added `wrangler` as a devDependency; set `engines.node` to `>=22` (the migrate script needs a global WebSocket).

- Design review: fixed a stats-table class mismatch (`stat-player` vs `stats-player`, which jammed the avatar against the name). Styled `.empty-icon`, `.auth-name`, and `.auth-sync`. Legacy non-UUID game ids are remapped on load, so they no longer sit in sync quarantine forever.

## 4. Deferred Items (4c)
- Pre-existing: `www.eight1fivedesign.com` returns a 522 on all other paths (the origin is unreachable).
- Google button: add the official "G" mark per Google's branding guidelines once the user's own OAuth client is set up.
- Sitewright: review and commit `fix/banned-font-false-positive` in the e1f repo. Follow-up: also catch banned fonts inside custom properties and `@font-face`.
- Decide whether github.io should redirect to the eight1fivedesign.com host (localStorage is per origin, so signed-out games stay behind).
- CI: a GitHub Actions workflow for `npm test` and `npm run e2e`. The cloud and worker e2e need `NEON_API_KEY` as a secret.
- Password-reset and magic-link emails need an email provider (e.g. Resend) on the user's domain.
- Use the user's own Google OAuth client to remove the Neon branding on the consent screen.
- PULLED INTO SCOPE (user, 2026-11-08): host at `www.eight1fivedesign.com/tabletop-scorecard` with a Cloudflare Worker route scoped to that path. The Worker serves the assets and proxies `/tabletop-scorecard/auth/*` to Neon Auth, which makes the cookie first-party. github.io stays as a secondary host where Safari can't sign in.
- Found: `www.eight1fivedesign.com` returns a Cloudflare 522 on every path (the origin is unreachable; this predates our work). The apex works. The Worker route answers without touching the origin.
- Decide later: whether to redirect github.io to the domain (localStorage is per origin, so local-only games don't move without sign-in).
