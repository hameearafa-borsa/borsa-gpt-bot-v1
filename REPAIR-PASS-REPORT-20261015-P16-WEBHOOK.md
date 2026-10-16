# Repair Pass 16 — Webhook transport

Date: 2026-10-15

## Change
- Replaced the active `bot.launch()` polling startup with a Node HTTP server and Telegraf `webhookCallback`.
- Added required `WEBHOOK_URL` (full public HTTPS endpoint), `WEBHOOK_SECRET`, and `PORT` configuration.
- Added `/health` and local HTTP/configuration tests.
- Registers Telegram webhook with required update types and `drop_pending_updates: false`.
- Shutdown closes the HTTP listener and intentionally does not delete the webhook or discard queued updates.
- Documented the required environment settings and updated `.env.example`.

## Verification scope
- Run `npm run check` and `npm test` on the archive before treating this pass as verified.
- No live Telegram API, PostgreSQL, Railway domain, or deployment was contacted as part of this repair.
- Production readiness is not implied. Configure the Railway public HTTPS endpoint and secret only in the target environment, then verify `getWebhookInfo` and delivery during an explicitly authorized live test.
