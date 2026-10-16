# Borsa GPT Bot V1 — Repair Pass 5

Date: 2026-10-15
Base: cumulative Repair Pass 4 archive.

## Changes
- Added additive SQL migration `migrations/006_media_quota_events.sql` for durable audit-only photo/video quota events.
- Added unique `(chat_id, message_id)` key so retries/duplicate updates do not increment the same message more than once.
- Added a daily index by chat, user, day, and media type.
- Middleware now uses PostgreSQL-backed counters when the configured pool is available; in-memory counters remain a no-database fallback.
- Added mocked-pool tests covering duplicate retry, individual album item counting, user separation, photo/video thresholds, and invalid inputs.

## Verification performed
- `node --check index.js`: PASS.
- `node --check modules/protection.js`: PASS.
- `node --check tests/media-quota-durable.test.js`: PASS.
- `node tests/media-quota-durable.test.js`: PASS.
- Full suite / `npm run check` have not been re-run in this execution environment because dependencies are not installed here. Prior pass results are not represented as a fresh full-suite result.
- Runtime Node version here is 22.16.0, below the project's required Node.js `>=24 <25`; Node 24 validation remains required.

## Limitations / safety
- Each distinct Telegram message in an album counts as a media item; album-level grouping is not implemented.
- Counts use UTC calendar days. If policy requires Cairo-local days, that must be changed explicitly and tested.
- Counters are audit-only. No media deletion or muting is triggered by quota exceedance.
- This pass does not resolve Telegram `409 Conflict`, nor prove exactly-once scheduled delivery.
- No live database/API calls, GitHub push, or Railway deployment were performed.
