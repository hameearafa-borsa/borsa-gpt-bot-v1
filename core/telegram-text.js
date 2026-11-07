"use strict";

// Count HTML-escaped text conservatively because chemical replies are sent in HTML mode.
function escapedHtmlLength(value) {
  let length = 0;
  for (const char of String(value ?? "")) {
    length += char === "&" ? 5 : char === "<" || char === ">" ? 4 : char === "\"" ? 6 : char.length;
  }
  return length;
}

// Split plain text before HTML escaping/wrapping so Telegram entities are never cut in half.
function splitTelegramText(value, maxLength = 3900) {
  const text = String(value ?? "");
  const limit = Math.max(1, Math.floor(Number(maxLength) || 3900));
  if (!text) return [""];
  const chunks = [];
  let remaining = text;
  while (remaining.length) {
    let used = 0;
    let position = 0;
    let lastBreak = -1;
    let cut = remaining.length;
    for (const char of remaining) {
      const weight = escapedHtmlLength(char);
      if (used + weight > limit) {
        cut = lastBreak > Math.floor(limit * 0.55) ? lastBreak : Math.max(position, 1);
        break;
      }
      used += weight;
      position += char.length;
      if (char === "\n" || char === " ") lastBreak = position;
    }
    if (cut === remaining.length) {
      chunks.push(remaining);
      break;
    }
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  return chunks;
}

module.exports = { splitTelegramText, escapedHtmlLength };
