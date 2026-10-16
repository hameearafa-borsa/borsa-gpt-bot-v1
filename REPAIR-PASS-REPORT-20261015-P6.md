# Repair Pass 6 — regex whitespace and normalization regression (2026-10-15)

## Change
Corrected whitespace matching in `modules/protection.js` for blocked-word/scam patterns that had double-escaped `\\s` inside JavaScript regex literals. Those expressions matched a literal backslash plus `s` rather than arbitrary whitespace. Corrected the affected Arabic and English patterns, and aligned the Arabic phrase `كس أم` with `normalizeArabic()` output (`ام`).

## Regression coverage
Extended `tests/protection-regression.test.js` to cover variants with and without spaces for Arabic and English patterns, including `كس أم`, `كسأم`, `ابن الكلب`, `fuck you`, and `signals vip`.

## Verification
- All JavaScript files passed `node --check` in the available workspace.
- `node tests/protection-regression.test.js` passed, including its media quota audit assertions.
- This workspace uses Node.js 22.16.0, while `package.json` targets `>=24 <25`; Node 24 verification is still required.
- Full `npm run check` / `npm test` were not rerun in this pass; dependencies/full suite are not considered freshly verified.
- No production DB, Telegram, external API, GitHub push, or Railway deployment was used.

## Scope limits
This fixes regex matching only. It does not establish the correctness of all moderation policy, and no deletion/muting enforcement was enabled. Telegram polling `409 Conflict` remains unresolved.
