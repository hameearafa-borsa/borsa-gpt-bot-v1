# Borsa GBT Bot V1 RC1+ — Change Log and Honest Release Gate

## Implemented in this patch
- Added `/claim` in an unclaimed group. It queries Telegram's current administrator list and only binds the group if the command sender is the Telegram `creator`; knowing a chat ID or being a regular administrator is not sufficient.
- Added real current-weather lookup using Open-Meteo geocoding + current forecast. Failures are reported without inventing weather values. The included test uses mocked HTTP responses and is not a live network test.
- Added `OPENAI_API_KEY_3` to OpenAI provider rotation.
- Changed the `/schedule` parser to interpret the provided local timestamp as UTC+03:00 (Cairo offset on the build date) and set timezone metadata. This is not a DST-aware timezone parser; see remaining gaps.
- Updated `package.json` engine requirement to Node `>=24 <25` and regenerated the root lockfile with npm.
- Updated README and migration map so remaining gaps are explicit rather than described as completed.

## Local verification
- `npm run check`: PASS.
- `npm test`: PASS, including the new mocked weather parser test.
- `npm install --package-lock-only --ignore-scripts --no-audit --no-fund`: completed successfully and updated root lockfile metadata.
- `npm ci`: attempted but the tool environment timed out. Must be rerun on Termux with Node 24.x.

## Still not complete / not live-verified
- Full migration of legacy bad-word lists, image/video limits, media-group limits, and rate-limit/mute workflow.
- Complete parity of all legacy settings controls and report/activity panel features.
- A DST-aware `Africa/Cairo` timestamp parser for scheduled messages; current command parser uses a fixed +03:00 offset.
- Real Telegram `/claim`, private-panel, and command-menu tests.
- Live Open-Meteo call from the deployed runtime.
- Live API tests for OpenAI/Gemini/xAI; current local tests do not validate credentials, quotas, or model access.
- Live retailer/ScraperAPI tests and verified product extraction.
- Production PostgreSQL schema review and backup; no production DB was accessed or migrated.
- Resolution of the Telegram `409 Conflict` getUpdates issue; this patch does not prove there is only one polling process.

## Deployment decision
This is a tested local repair candidate, **not a production-approved final release**. Do not deploy until the remaining required legacy features and live preflight gates are completed. No GitHub push or Railway deployment was performed.

## Audit repair pass (2026-10-15, local candidate only)
- Added `core/cairo-time.js`: strict IANA `Africa/Cairo` wall-clock conversion based on `Intl`, rejects invalid/nonexistent/ambiguous local times instead of silently applying a fixed UTC offset.
- Updated `/schedule` to use the timezone-aware converter.
- Updated daily scheduled-message recurrence to calculate the next local Cairo wall-clock occurrence instead of adding a fixed 24-hour database interval; a spring-forward gap advances to the first valid local minute.
- Added regression tests for winter/summer offsets, invalid dates, and daily wall-clock preservation across the April 2026 offset change.
- Added legacy bad-word patterns to the audit-first protection inspection and expanded middleware entry to inspect captions as well as text.
- Added protection regression tests for legacy spam patterns and caption link detection.
- Verification in this workspace: syntax check and local `npm test` passed under Node 22.16.0 with dependencies present. This is not the required Node 24 release verification and is not a live integration test.
- Still not implemented in this repair pass: full daily photo/video/media-group quotas, persistent rate limiting and mute workflow, full settings-panel parity, production DB compatibility review, and proof that only one Telegram polling process is active. Do not deploy on the basis of these changes alone.

## Repair pass 3 — 2026-10-15
- Added a PostgreSQL session advisory lock around scheduled-message dispatch using a dedicated pooled connection.
- Added regression coverage for lock acquisition and skip behavior when another replica holds the lock.
- `npm run check` and `npm test` passed in the current local environment; Node.js 24 verification remains required.
- Exactly-once delivery, media quotas, persistent rate limits, full escalation, and Telegram 409 remain unresolved.

## Repair Pass 4 — audit-only media quota detection
- Added photo/video daily quota detection, scoped per chat/user/type/day, with environment overrides and tests.
- Quota exceedances are logged only; no deletion or mute is triggered.
- Counters remain in-process only; cross-replica persistence and album aggregation are explicitly unresolved.
- Full local `npm run check` and `npm test` passed in the current environment; Node 24 runtime validation and live checks remain outstanding.

## Repair Pass 5 — durable media quota counters (2026-10-15)
- Added additive migration `006_media_quota_events.sql` for persisted photo/video quota events, with unique `(chat_id, message_id)` idempotency and a daily lookup index.
- Middleware now uses PostgreSQL-backed counters when `db.pool` is available, so counts survive restarts and are shared across replicas. In-memory fallback remains audit-only when no DB is configured.
- Added `recordMediaQuota()` and mocked-pool regression tests for retry idempotency, per-user separation, quota boundaries, and video counts.
- Album items continue to count individually by policy; album-level grouping is not implemented. No automatic deletion or muting was enabled.
- No live database, Telegram, external API, GitHub push, or Railway deployment was used.

## Repair Pass 6 — regex whitespace matching (2026-10-15)
- Fixed double-escaped whitespace tokens in blocked-word/scam regex literals so patterns match spaces as intended.
- Aligned the Arabic `كس أم` pattern with the normalized text produced by `normalizeArabic()`.
- Added regression cases for spaced/unspaced Arabic and English variants; dedicated protection regression test passed.
- All JavaScript syntax checks passed. Node 24 and full-suite verification remain outstanding; no live services or production deployment were touched.


## Repair Pass 7 — Cairo-local daily media quota reset (2026-10-15)
- Fixed daily photo/video quota day keys to use the IANA `Africa/Cairo` calendar date instead of UTC date.
- Both PostgreSQL-backed and in-memory audit counters now reset at Cairo midnight, including date-boundary behavior.
- Added regression tests around the Cairo midnight boundary for durable and in-memory counters.
- Verification is local-only; no production DB, Telegram, external APIs, GitHub push, or Railway deployment was used. Node 24 and full-suite verification remain required.

## Repair Pass 8 — durable rate-limit audit
- Added migration `007_rate_limit_events.sql` with idempotent per-message events and recent-event index.
- Added PostgreSQL-backed rolling-window rate detection across replicas; kept behavior audit-only and process-local fallback.
- Added `rate-limit-durable.test.js` and registered it in the test runner.
- Verification: all JS syntax checks and focused protection/media/rate tests passed on Node 22.16.0. Node 24 and live PostgreSQL remain unverified.

## Repair Pass 9 — Diagnostic input normalization
- Fixed a double-escaped whitespace expression in `core/diagnostics.js`; diagnostic log summaries now collapse actual whitespace/newlines rather than looking for a literal `\\s` sequence.
- Added regression coverage in `tests/links-diagnostics.test.js` for newline/space normalization in diagnostic logs.
- Scope is limited to diagnostic presentation; input fingerprints still hash the original input and are not displayed as raw text.

## Pass 10 — transactional database migrations
- Centralized migrations 000–007 in `core/migrations.js`.
- Runs the migration set in one PostgreSQL transaction with a transaction-scoped advisory lock to avoid concurrent startup migration races.
- Startup now fails explicitly if the database pool is unavailable instead of silently skipping schema setup.
- Added success/failure-path tests for lock ordering, transaction outcome, and stop-on-first-error behavior.
- `npm test` passed locally. No live PostgreSQL, Telegram, API, or Railway verification was performed.

## Pass 11 — Telegram 409 startup diagnosis
- Added structured classification and actionable startup diagnostics for Telegram `409 Conflict` / competing `getUpdates` polling.
- Added unit tests for message-based and structured API error shapes, plus non-409 fallback behavior.
- This is diagnostic hardening only; it does not identify or terminate the external competing process. No live Telegram/Railway operation was performed.

## Pass 12 — Telegram group discovery
- Explicitly requests Telegram update types required for membership-based group recognition and command handling.
- Adds safe startup/update diagnostics for polling configuration and successful group authorization.
- Adds static regression test for update subscriptions and creator-only `/claim` flow.
- Does not resolve or claim to resolve the historical 409 by code alone; token rotation reportedly cleared it, and runtime confirmation is still required.

## Pass 13 — Process lifecycle and graceful failure (2026-10-15)
- Added centralized fatal-process handlers. Unhandled rejections and uncaught exceptions are reported best-effort, trigger orderly shutdown, and terminate non-zero instead of leaving the bot running in an unknown state.
- Added a 10-second forced-exit safeguard for stuck reporting/shutdown.
- Startup failures (including Telegram polling startup failures such as 409) now attempt to stop schedulers, stop Telegraf, and close the PostgreSQL pool before exit.
- Added fatal process lifecycle tests; complete `npm test` and recursive JavaScript syntax checks passed in the available environment.
- Not live-tested against Telegram/PostgreSQL/Railway; run the suite on Node 24 before deployment.

## Pass 14 — Startup cancellation during shutdown
- Added `shutdownRequested` lifecycle state for SIGINT/SIGTERM.
- Avoid starting schedulers or Telegram polling after shutdown has been requested.
- Avoid treating a startup operation cancelled by a shutdown signal as an independent startup failure requiring forced exit code 1.
- Validation: full `npm test` passed; all JavaScript files passed `node --check` under Node 22.16.0. Node 24, live Telegram/PostgreSQL, and Railway remain unverified.

## Pass 15 — startup cancellation and shutdown ordering
- Fixed the signal-during-startup race: defer shared-resource shutdown until the active awaited startup step settles, then cancel startup and await the unified shutdown.
- Added shutdown-request checks between startup phases and switched to normal signal shutdown when polling is about to start.
- Verification: full `npm test` and JavaScript syntax checks pass on Node v22.16.0; Node 24 and live integrations remain unverified.
