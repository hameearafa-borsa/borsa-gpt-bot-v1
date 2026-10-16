# Borsa GPT Bot V1 — Repair Pass 2

Date: 2026-10-15

## Implemented in this local candidate
- Fixed the protection middleware gate so caption-only messages are actually inspected, rather than requiring `m.text`.
- Added per-process rate-window detection (default: more than 5 messages per user per chat within 60 seconds). Detection is audit-only: it records a `moderation_events` row and emits a sanitized diagnostic log; it does not delete messages or mute users.
- Added regression tests for rate-window threshold, per-user separation, expiry, and caption/link inspection.

## Verification
- `npm run check`: PASS
- `npm test`: PASS (all existing suites plus protection regression)
- Runtime used for this pass: Node version reported by the execution environment; this is not the project's required Node 24 runtime. Re-run under Node 24 before deployment.

## Important limitations / not claimed as complete
- Rate-window state is in memory and per process. It is not persistent or cross-replica safe, and should not be used for destructive enforcement until an atomic database/Redis counter and multi-instance strategy are implemented.
- Image/video daily quotas, media-group limits, automatic mute/escalation workflow, and full legacy moderation parity are still not implemented.
- Telegram 409 polling conflict is unresolved; it requires checking all running instances/services and deployment configuration.
- No live Telegram/API calls, production DB access, GitHub push, or Railway deployment were performed.
