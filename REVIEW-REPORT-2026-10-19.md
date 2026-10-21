# Borsa GPT Bot V1 — local review report

**Candidate status:** local review candidate; not pushed to GitHub and not deployed to Railway.

## Current verification

- `npm run check`: PASS.
- `npm test`: PASS across the project suites and link/diagnostics suite.
- Adaptive price-list parsing and actual PNG rasterization tested using the October 2026 Unilever list.
- Company/date/wholesale metadata parsed independently from product-section headings. Explicit per-piece pricing markers (`بالقطعة`, `قطعة`, standalone `ق`) are retained and shown on the corresponding product row.
- 66 rows extracted: 65 accepted for preview, one ambiguous currency row sent to review.
- 65 accepted rows rendered into five real PNG pages (up to 14 rows per page) using locally available `sharp 0.34.1`.
- Tests assert PNG signature, dimensions, channels, non-empty output, page count, and review behavior.
- Transactional persistence for a price-list run and its rows remains in place.

## Known dependency/integration limits

- `package.json` declares `sharp ^0.34.4`; only `sharp 0.34.1` is available globally in this lab.
- The package-lock refresh could not resolve `sharp` because npm registry access failed (`EAI_AGAIN`); offline refresh also failed (`ENOTCACHED`). Do not run `npm ci` until `package-lock.json` is refreshed in a network-enabled Termux environment.
- Telegram media-group delivery is implemented but not live-tested.
- The preview image is based on deterministic local parsing, not an independent verification of the prices. Ambiguous `205 ح` remains review-only.
- No live bot, production database, GitHub push, or Railway deployment was used.
