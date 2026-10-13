# Borsa GBT Bot V1 Mona Lisa — RC1 additive completion notes

## Preservation rule
This patch was applied to the supplied `Borsa-GPT-Bot-V1-RC1.zip` working copy. Existing project files were not deleted. The old source files used for reference are preserved under `legacy/reference/` and are not loaded into the runtime.

## Added
- `migrations/004_legacy_services.sql`: additive-only tables and columns for moderation events/settings, scheduled messages, feature settings, deal publications, and explicit price-list fields.
- `modules/protection.js`: deterministic spam/length/link inspection.
- `modules/scheduler.js`: PostgreSQL-backed one-time/daily message scheduler.
- `modules/weather.js`: honest weather fallback/search link; it does not fabricate live weather observations.
- `modules/deal-sources.js`: allowlisted Amazon Egypt/Jumia/Noon source adapter through ScraperAPI; requires `SCRAPER_API_KEY`.
- `modules/deal-publication.js`: category allowlist, scoring, category distribution, newsletter rendering.
- `modules/deal-scheduler.js`: Africa/Cairo daily window, automatic URL checks, weekly deduplication, and separate Amazon/other/best-deals batches without same-day overlap.
- Regression tests for Pearl and Ariel/Bonux/Tide price lists, moderation inspection, allowed source hosts, URL validation, category filtering, and Cairo scheduling.
- Full old source snapshots in `legacy/reference/` for comparison; these are references, not live dependencies.

## Safety defaults
- `PROTECTION_ENFORCE=false` by default. Moderation flags are logged; destructive message deletion is not enabled unless explicitly configured.
- Deal publication is disabled until `DEALS_CHAT_ID` is configured.
- Direct source scraping returns no offers if `SCRAPER_API_KEY` is missing. No offers are fabricated as a fallback.
- A failed or ambiguous price-list row is kept for review/skipped rather than given a guessed product identity.
- URL checks reject non-HTTPS links, credentials in URLs, and hosts outside the store allowlist. The verifier follows redirects only if the final host remains allowlisted.

## Tests run in this lab
- `node --check` for `index.js`, every `core/*.js`, `modules/*.js`, and `tests/*.js`: passed.
- `npm test`: passed, including foundation, adversarial, links/diagnostics, Pearl/Ariel regression, source allowlist and Cairo scheduling tests.
- These are local deterministic tests, not a live Telegram/Railway/PostgreSQL deployment test.

## Important unresolved release gate
The attempt to create a fresh `package-lock.json` using `npm install --package-lock-only --ignore-scripts --no-audit --no-fund` timed out after 60 seconds. This is recorded as a failure, not a success. The old project's lockfile is preserved at `legacy/reference/package-lock.json` and must not be copied over the RC1 lockfile because it belongs to the old dependency graph.

## Remaining before production
- Resolve a valid, reproducible RC1 `package-lock.json` in a network-enabled Node/npm environment.
- Live-test ScraperAPI credentials and current HTML structures for each store; site markup may change and a failed source must be visible in diagnostics.
- Complete remaining old management functions: full private button panel, inactive-member reports, welcome/goodbye settings, warning/escalation workflow, and remaining report controls.
- Verify current PostgreSQL schema/backups before running migrations against Railway. No production database was touched by this lab patch.
- Run a staging test with a separate Telegram test group before deploying to the existing Railway service.

## Additive completion update — private controller panel
- Added `modules/admin-panel.js` with a private inline-button panel for the chemical assistant, silent price monitoring, company lists, merchant intelligence, deals, reports, protection/activity, health, live ScraperAPI check, and recent diagnostics.
- Added callback authorization on every panel action. A callback from a group or from an unauthorized private user is rejected server-side; the keyboard itself is not treated as a security boundary.
- Added `/panel` and private `/start` entry points. The panel is never posted into group chats.
- Slash-command handling is controller-only; regular members continue to use automatic message-based services without needing commands.
- Command menus are cleared from the global and group scopes, then assigned to the master and recorded group-owner IDs in their private chats. Menu setup errors are logged without printing secrets.
- Group authorization now records the actual group creator as owner when the master adds the bot, so the creator can open the private panel. Channels remain master-only.
- Added regression tests for the private panel keyboard and included them in `npm test`.
- Validation after these additive changes: `node --check` and `npm test` passed in the local lab. No live Telegram callback, command-menu, PostgreSQL production, or ScraperAPI credential test has been claimed.

## Still-open release gates
- A new root `package-lock.json` is still not generated. The npm registry request timed out again in the lab; the legacy lockfile was not copied and no placeholder lockfile was fabricated. Generate the real RC1 lock in the network-enabled Node/npm environment, then require `npm ci` and the full test suite to pass.
- The ScraperAPI button can perform a real source request once a valid `SCRAPER_API_KEY` is set in the runtime. This environment has no user key, so live source access remains unverified here.

## Follow-up review patch — product identity and weekly duplicate suppression
- Added `dealProductFingerprint()` to separate stable product identity from the price/discount observation fingerprint.
- Weekly filtering now checks both the exact observation fingerprint and the stable product fingerprint.
- Retailer IDs are preferred for supported Amazon Egypt, Jumia Egypt, and Noon URL patterns. If no recognized ID exists, the conservative fallback uses merchant/host, normalized title, and category; pack/size wording in the title is retained.
- Added additive migration `005_deal_product_identity.sql` with nullable `product_fingerprint` and a recent-observation index; added it to the startup migration list.
- Added `tests/deal-identity.test.js` covering price changes, distinct retailer product IDs, pack-size distinction, and weekly filtering behavior.
- Validation: `npm run check` passed; full `npm test` passed, including the new deal identity tests.
- Limitations: this remains deterministic product matching, not proof that every retailer URL exposes a stable product ID. Existing historical rows have a NULL `product_fingerprint` until the same offer is observed and persisted again; their original exact-fingerprint deduplication remains active. No live database or Telegram test was run.
