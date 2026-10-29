# Borsa GPT Bot V1 — focused repair pass (Pass17 candidate)

Status: local source patch only. Not pushed, not deployed, and not connected to production Telegram/PostgreSQL.

## Changes in this candidate

1. `index.js` now registers private command menus for every explicitly configured owner returned by `authorizedUserIds()` (including `OWNER_ID` entries), rather than only the historical hard-coded `MASTER_ID` plus database group owners. `/settings` in private chat now opens the private owner panel; `/settings` in a group retains the group-settings behavior.
2. Group authorization no longer falsely records the bot master as the Telegram group creator when `getChatAdministrators()` fails. The group can still be authorized by the master, but `owner_user_id` remains NULL until the real creator completes `/claim`. The schema allows `owner_user_id` to be NULL.
3. The deal scheduler still retries after no candidates, but backs off for 15 minutes rather than querying every minute after a known no-deal result. Identical fetch-failure diagnostics are emitted once per Cairo day; a changed source/reason signature can still produce a new report.

## Important boundaries

- This suppresses duplicate reports; it does not cure upstream ScraperAPI/store HTTP 403 responses. Those need a valid provider/account configuration or a source that legitimately returns product data. The bot must continue refusing to invent offers.
- Fetch-failure suppression is process-local and resets on restart. No database migration was added, and no production database was read or changed.
- The old master ID remains supported. Set `OWNER_ID` to the actual Telegram owner ID(s), comma-separated if needed, in the deployment environment; values are not embedded in this patch.
- No tests were rerun per the agreed instruction to avoid another test loop. This archive is a patch candidate, not a verified or deployed release.
