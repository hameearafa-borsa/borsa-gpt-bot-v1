# Borsa GPT Bot V1 — Repair Pass 9

## Change
Fixed the diagnostic logger's input-summary normalization. The previous regular expression was double-escaped (`/\\s+/g`), so it matched literal backslash-s patterns instead of normal whitespace. It now uses `/\s+/g` and collapses line breaks/tabs/repeated spaces into one space before redaction and logging.

## Regression test
Extended `tests/links-diagnostics.test.js` to assert newline/space normalization in the diagnostic log output.

## Validation
- JavaScript syntax checks: run across every `.js` file in this archive.
- Focused diagnostics test: run.
- Full foundation suite: run if dependencies are present; results recorded in handoff, not assumed.
- ZIP integrity: run.

## Boundaries
No live Telegram calls, no production database access, no GitHub push, no Railway deployment. Current environment runtime may differ from project target Node `>=24 <25`.
