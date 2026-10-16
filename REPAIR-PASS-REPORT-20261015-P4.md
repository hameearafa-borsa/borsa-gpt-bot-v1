# Borsa GPT Bot V1 — Repair Pass 4

Date: 2026-10-15
Base: cumulative Repair Pass 3 archive.

## Changes
- Added audit-only daily media quota detection for photos and videos, scoped by chat, user, media type, and UTC date.
- Defaults: 3 photos/day and 1 video/day; override with `PROTECTION_DAILY_PHOTO_LIMIT` and `PROTECTION_DAILY_VIDEO_LIMIT`.
- Logged quota exceedances to `moderation_events` and diagnostic log channel when available. No media is deleted and no user is muted because of quota detection.
- Added video recognition to `messageData` and regression tests for quota boundaries, per-user separation, video limit, and non-applicable document messages.

## Verification
- `npm run check`: PASS in the current local environment.
- `npm test`: PASS, including foundation, Cairo time, protection, media quota audit, scheduler lock, and diagnostics suites.
- `node --version` in this environment must be checked against the package's required Node.js `>=24 <25` before calling this final runtime validation. This pass does not claim Node 24 validation.

## Important limitations
- Media counters are process-local and are not durable across restarts or shared across replicas. They are detection-only; do not use them for automatic enforcement in multi-replica production.
- The quota counts each Telegram media update; each photo in an album may count separately. Media-group aggregation and durable daily counters remain follow-up work.
- Telegram 409 polling conflict is still unresolved. This pass did not contact Telegram, OpenAI, external providers, or the production database.
- No GitHub push or Railway deployment was performed.
