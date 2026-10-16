# Local Repair Pass Report — 2026-10-15

## Changes made
1. Replaced the fixed `+03:00` `/schedule` timestamp conversion with strict `Africa/Cairo` IANA-zone conversion.
2. Daily schedules now calculate the next local wall-clock occurrence rather than adding a fixed 24-hour interval.
3. Added regression coverage for summer/winter UTC offsets, invalid dates, and daily scheduling across the April 2026 offset change.
4. Added legacy moderation patterns to the existing audit-first message inspection.
5. Extended the protection middleware condition so captions are inspected as well as plain text.
6. Added tests for caption links and the legacy spam pattern.

## Verification
- JavaScript syntax check: PASS.
- `npm test`: PASS in the available workspace under Node 22.16.0.
- The project requires Node `>=24 <25`; rerun `npm ci`, `npm run check`, and `npm test` under Node 24 before release.
- No Telegram API, PostgreSQL, AI-provider, or ScraperAPI live tests were run.
- No GitHub push, Railway deployment, or production database access was performed.

## Explicitly unresolved
- Image/video daily quotas and media-group handling are not fully implemented.
- Persistent rate limiting and mute/escalation workflow are not fully implemented.
- Full legacy settings-panel parity remains incomplete.
- Telegram 409 polling conflict cause remains unproven; deployment/runtime inspection is required.
- Production schema compatibility and backup are not verified.
