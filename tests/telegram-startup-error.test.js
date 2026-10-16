"use strict";
const assert = require("node:assert/strict");
const { classifyTelegramStartupError, formatTelegramStartupError } = require("../core/telegram-startup-error");

const conflict = new Error("409: Conflict: terminated by other getUpdates request; make sure that only one bot instance is running");
assert.equal(classifyTelegramStartupError(conflict).kind, "TELEGRAM_POLLING_CONFLICT");
assert.equal(classifyTelegramStartupError(conflict).fatal, true);
assert.match(formatTelegramStartupError(conflict), /Railway projects/);
assert.match(formatTelegramStartupError(conflict), /Stop every local\/Termux process/);
assert.match(formatTelegramStartupError(conflict), /Original error: 409/);

const structured = { response: { error_code: 409, description: "Conflict: terminated by other getUpdates request" } };
assert.equal(classifyTelegramStartupError(structured).kind, "TELEGRAM_POLLING_CONFLICT");

const other = new Error("401: Unauthorized");
assert.equal(classifyTelegramStartupError(other).kind, "TELEGRAM_STARTUP_ERROR");
assert.deepEqual(classifyTelegramStartupError(other).checks, []);
console.log("Telegram startup error classification tests: OK");
