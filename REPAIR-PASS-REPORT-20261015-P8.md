# Borsa GPT Bot V1 — Repair Pass 8

## Scope
Added durable, cross-replica **audit-only** rate-limit detection to complement the existing durable media quota events.

## Changes
- Added `migrations/007_rate_limit_events.sql` with unique `(chat_id, message_id)` events and a recent-event index.
- Registered migration 007 in the startup migration list.
- Added `recordRate()` in `modules/protection.js`: inserts each message idempotently, counts the user's events within the configured rolling window, and performs opportunistic one-day retention cleanup every 100 calls.
- Updated group moderation middleware to use PostgreSQL rate events when a pool and message ID are available; retains process-local fallback otherwise.
- Added `tests/rate-limit-durable.test.js` for retry idempotency, limit detection, user isolation, and invalid input.
- Added the new test to `tests/run-all.js` and updated the cumulative changelog.

## Verification performed
- `node --check` on all JavaScript files: PASS under Node `v22.16.0`.
- `node tests/rate-limit-durable.test.js`: PASS.
- `node tests/media-quota-durable.test.js`: PASS.
- `node tests/protection-regression.test.js`: PASS.
- ZIP integrity: checked after archive creation.

## Limitations / cautions
- Project engine requires Node `>=24 <25`; this pass was not validated on Node 24.
- The new rate-limit test uses a fake pool and does not prove behavior against a real PostgreSQL server. No live database or Telegram tests were run.
- Rate limiting remains **audit-only**: it logs/records detections but does not mute users or delete messages. `PROTECTION_ENFORCE` remains a separate setting for message inspection behavior.
- Retention cleanup is opportunistic and best-effort; it is not a scheduled database maintenance job.
- Telegram `409 Conflict` remains unresolved. No GitHub push, Railway deployment, production database operation, or live API call was performed.
