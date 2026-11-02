"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");

// Pending observations are intentionally stored silently. Legacy inline review
// notification delivery and startup replay must stay disabled; reviewer actions
// remain available only for legacy queue entries that already exist.
assert.doesNotMatch(source, /priceReview\.formatReviewMessage\s*\(/,
  "new pending observations must not create inline/manual review notifications");
assert.doesNotMatch(source, /priceReviewRecovery\.recoverPendingNotifications\s*\(/,
  "startup must not replay legacy pending-review notifications");
assert.match(source, /Ambiguous observations are retained silently as pending data/,
  "ambiguous observations must remain stored as pending data");
assert.match(source, /const pendingRows = result\.savedRows\.filter\(item => item\.row\.decision === "pending"\)/,
  "pending rows must remain visible to operational diagnostics without reviewer messages");
assert.match(source, /pending: pendingRows\.length/,
  "the saved diagnostic must report pending counts without exposing review actions");
assert.match(source, /bot\.action\(\/\^prv:\(approve\|new\|ignore\):\(\\d\+\)\$/,
  "legacy review actions must remain available for existing log messages");
console.log("silent pending price behavior and legacy review-action compatibility tests: OK");
