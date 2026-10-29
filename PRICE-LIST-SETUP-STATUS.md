# /pricelist setup status — 2026-10-19 (adaptive Unilever fixture pass)

## Implemented in this local candidate

- Canonical Telegram menu command: `/pricelist`; Arabic `/قائمة` remains supported inside messages.
- Company, month, wholesale/retail price type, and colon-terminated product-section headings are parsed separately. Section headings no longer overwrite the company name.
- A clear company list with at least three accepted rows from one company uses deterministic parsing first and avoids an AI call.
- Product labels preserve sizes, variants, bonus quantities, and trailing offer notes when removing the price token.
- Ambiguous currency text such as `205 ح` is retained for review rather than silently corrected or published.
- The PNG design adapts to list length by generating adaptive pages with up to 14 products per page (smaller pages remain shorter), with section labels, a dynamic company/date/price-type header, and a per-piece label when `بالقطعة`/`قطعة`/standalone `ق` is explicit, a diagonal watermark, and a footer watermark: `بورصة المنظفات لأصحاب المحلات`.
- Long lists are sent as a Telegram media group when the Telegraf context supports `replyWithMediaGroup`; a sequential photo fallback is retained.
- Price-list run and extracted rows remain saved transactionally.

## Realistic fixture test

Input fixture: `tests/fixtures-unilever-oct-2026.txt`.

- Company parsed: `شركة يونيليفر`
- Month parsed: `أكتوبر 2026`
- Price type parsed: `أسعار جملة`
- Product rows extracted: 66
- Accepted for preview: 65
- Sent to review: 1 (`تريزيمي بلسم 600 مل ق 205 ح`)
- Actual raster output: 5 PNG pages (14 products per page maximum), each rendered by the real locally available `sharp 0.34.1`.
- PNG signature, dimensions, channels, non-empty output, and pagination are asserted by `tests/price-list-image-real.test.js`.
- `npm run check`: PASS
- `npm test`: PASS (all suites; a simulated `[FATAL_REPORT_FAILED] unhandledRejection: report unavailable` line is expected in the fatal-process test).

## Still not complete / not claimed

1. `package.json` requests `sharp ^0.34.4`, but this lab only has globally available `sharp 0.34.1`.
2. `package-lock.json` still lacks the resolved `node_modules/sharp` package entry. Both online refresh attempts were blocked by registry connectivity (`EAI_AGAIN`); offline refresh failed because the sharp metadata/package is not cached (`ENOTCACHED`).
3. No Telegram `sendPhoto`/media-group delivery was run against a real bot or test group.
4. This is a local review candidate only. No production bot, production database, GitHub push, or Railway deployment was used.
