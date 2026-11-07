"use strict";

// Split plain text before HTML escaping/wrapping so Telegram entities are never cut in half.
function splitTelegramText(value, maxLength = 3900) {
  const text = String(value ?? "");
  const limit = Math.max(1, Math.floor(Number(maxLength) || 3900));
  if (!text) return [""];
  const chunks = [];
  let remaining = text;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf("\n", limit);
    if (cut < Math.floor(limit * 0.55)) cut = remaining.lastIndexOf(" ", limit);
    if (cut < Math.floor(limit * 0.55)) cut = limit;
    else if (remaining[cut] === "\n" || remaining[cut] === " ") cut += 1;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining.length) chunks.push(remaining);
  return chunks;
}

module.exports = { splitTelegramText };
