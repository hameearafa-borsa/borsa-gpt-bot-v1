"use strict";

const { normalizeArabic } = require("../core/normalization");

const LINK_RE = /(?:https?:\/\/|www\.|t\.me\/|telegram\.me\/)/i;
const SPAM_PATTERNS = [
  /(.)\1{9,}/u,
  /(?:ربح مضمون|اكسب بسرعة|استثمار مضمون|اضغط هنا|سجل الآن|اربح مجانا)/iu,
  /(?:crypto|bitcoin|forex).{0,35}(?:guaranteed|profit|investment)/iu,
];

function inspectMessage({ text = "", caption = "", isForward = false, trustedForward = false } = {}, options = {}) {
  const raw = `${text} ${caption}`.trim();
  const normalized = normalizeArabic(raw);
  const reasons = [];
  const maxLength = Number(options.maxLength || 5000);
  if (raw.length > maxLength) reasons.push("message_too_long");
  if (SPAM_PATTERNS.some(re => re.test(normalized))) reasons.push("spam_pattern");
  const links = (raw.match(/(?:https?:\/\/|www\.|t\.me\/|telegram\.me\/)/ig) || []).length;
  if (links >= Number(options.maxLinks || 5)) reasons.push("excessive_links");
  if (isForward && !trustedForward && options.blockUntrustedForwards === true) reasons.push("untrusted_forward");
  return { allowed: reasons.length === 0, reasons, linkCount: links, length: raw.length };
}

function repeatedMessageKey(text) { return normalizeArabic(text).replace(/\s+/g, " ").trim(); }

module.exports = { inspectMessage, repeatedMessageKey, LINK_RE };
