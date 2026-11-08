# Branch Notes: feat/scorecard-pwa

## 1. Discoveries & Deviations
- Greenfield repo. Uses no framework: native ES modules, a small `h()` DOM helper, hash routing, and no build step.
- Score entry uses a custom keypad in a `<dialog>`. On iOS, `inputmode="numeric"` has no minus key, and tabletop games often need negative scores.

- The e2e test uses `playwright-core` with the system Edge (`channel: 'msedge'`), so no browser download is needed.
- `.visually-hidden` content inside `.table-scroll` escaped the overflow clip, because absolute positioning resolves against the nearest positioned ancestor. Fixed by adding `position: relative` to the scroller.

## 2. Blockers & Risks (4a)
- None.

## 3. Quick Wins (4b)
- Truncate long player names (ellipsis plus a `title` tooltip) in the standings and the table header.
- The keypad display shows `-` rather than `-–` for an empty negative entry.

## 4. Deferred Items (4c)
- Export and import games as JSON (backup and moving between devices).
- Screen Wake Lock during an active game, so the phone doesn't sleep mid-round.
- Undo for the last score edit and for deleting a round.
- Edit players mid-game (add, rename, or remove a player).
- CI: a GitHub Actions workflow running `npm test` and `npm run e2e` (with a Playwright Chromium install).

## Audit triage (Sonnet adversarial audit, 14 items)
- Fixed: keypad Enter/repeat handling; store read-fail, backup-fail, and multi-tab safety; validation of score range, integers, and duplicate ids; the `h()` style/on* bypass; keypad close on route change; focus retention; update toast survives other toasts; SW cache cleanup scoped to `scorecard-*`, plus waitUntil and an offline fallback; IME Enter; dev server denies dotfiles.
- Trade-off: a single named cache per release. Bump `VERSION` in `sw.js` on every asset change (see README).
- Trade-off: `serve.mjs` has no Host-header check (localhost dev server only).
- Dismissed: the drive-root edge case in the server containment check.
- Deploy: GitHub Pages from `main` at `/` (static, so no build). `.nojekyll` makes Pages serve the files as-is.
