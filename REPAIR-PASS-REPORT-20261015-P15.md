# Repair Pass 15 — startup interruption and graceful shutdown

## Finding
A SIGINT/SIGTERM received while startup awaited database migrations, Telegram `getMe`, command-menu setup, or scheduler schema setup could start shutdown immediately and close the database pool while the startup operation was still using it. Startup could then continue into later steps or return without owning a final shutdown.

## Change
- Added a startup-phase flag.
- During startup, signal handling marks shutdown requested but lets the current awaited step settle before closing shared resources.
- Added cancellation checks between startup steps; each cancellation path awaits the idempotent shutdown routine.
- Switched to normal immediate shutdown handling after startup reaches Telegram polling.
- Existing startup failure and fatal-process cleanup paths remain in place.

## Verification
- `npm test`: passed in the local environment (Node v22.16.0).
- All JavaScript files passed `node --check`.
- Archive integrity checked after packaging.

## Limitations
- The package declares Node `>=24 <25`; Node 24 was not available in this environment, so compatibility on the required runtime remains unverified.
- No live Telegram, PostgreSQL, or Railway deployment tests were run.
- This change does not prove the historical Telegram 409 conflict is permanently resolved.
