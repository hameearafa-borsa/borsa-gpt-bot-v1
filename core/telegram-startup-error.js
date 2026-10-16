"use strict";

function errorText(error) {
  return [error?.message, error?.description, error?.response?.description, error?.response?.body?.description]
    .filter(Boolean).join(" ");
}

function classifyTelegramStartupError(error) {
  const text = errorText(error);
  const code = Number(error?.response?.error_code ?? error?.error_code ?? error?.code);
  const isPollingConflict = code === 409 || /409\s+Conflict/i.test(text) || /terminated by other getUpdates request/i.test(text);
  if (isPollingConflict) {
    return {
      kind: "TELEGRAM_POLLING_CONFLICT",
      fatal: true,
      message: "Telegram rejected getUpdates because another polling request is active for this bot token.",
      checks: [
        "Stop every local/Termux process that runs this bot token.",
        "Check all Railway projects, services, environments, and recent deployments for the same token.",
        "Check any VPS, hosting panel, or other bot runner using the same token.",
        "Ensure webhook mode is not mixed with polling; inspect getWebhookInfo without deleting anything blindly.",
        "After stopping competing runners, restart exactly one instance and confirm 409 no longer repeats."
      ]
    };
  }
  return { kind: "TELEGRAM_STARTUP_ERROR", fatal: true, message: "Telegram startup failed for a reason other than a recognized polling conflict.", checks: [] };
}

function formatTelegramStartupError(error) {
  const result = classifyTelegramStartupError(error);
  const lines = [`[${result.kind}]`, result.message];
  if (result.checks.length) lines.push("Investigation checklist:", ...result.checks.map((item, index) => `${index + 1}. ${item}`));
  lines.push(`Original error: ${errorText(error).slice(0, 700) || "(no message)"}`);
  return lines.join("\n");
}

module.exports = { classifyTelegramStartupError, formatTelegramStartupError };
