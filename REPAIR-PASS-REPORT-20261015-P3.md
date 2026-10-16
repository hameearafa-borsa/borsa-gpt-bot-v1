# Borsa GPT Bot V1 — Repair Pass 3

Date: 2026-10-15

## Implemented
- Added a PostgreSQL session advisory lock around scheduled-message dispatch, held on a dedicated pooled connection across due-row selection, Telegram send, and schedule-state update.
- When another replica owns the lock, this scheduler tick skips dispatch rather than selecting/sending the same due rows concurrently.
- Added a regression test for successful lock acquisition and dispatch, and a competing-instance case that verifies no due-row query/send occurs while the lock is busy.
- Retained prior pass changes for Cairo DST-aware wall-clock scheduling, caption inspection, audit-only rate detection, and protection regression tests.

## Verification
- `npm run check`: PASS
- `npm test`: PASS (all listed suites)
- Runtime in this execution environment is not the required Node.js 24; repeat the full suite on Node.js 24 before any deployment.

## Important limitations
- The advisory lock reduces concurrent duplicate dispatch across replicas, but it does not guarantee exactly-once delivery if a process crashes after Telegram accepts a message but before PostgreSQL records the success. Exactly-once cannot be guaranteed by a simple send-then-update sequence without an idempotent delivery protocol.
- Image/video daily quotas, media-group limits, persistent cross-replica rate counting, and complete automatic warning/mute escalation remain unfinished.
- Telegram `409 Conflict` remains unresolved and still requires operational inspection of every process/service using the bot token.
- No live Telegram/API checks, production database changes, GitHub push, or Railway deployment were performed.
