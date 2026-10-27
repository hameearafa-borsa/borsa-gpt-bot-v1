"use strict";
const assert = require("node:assert/strict");
const { inspectMessage, inspectRate, resetRateWindows, inspectMediaQuota, resetMediaWindows } = require("../modules/protection");
assert.equal(inspectMessage({text:"استثمار مضمون" }).reasons.includes("spam_pattern"), true);
// Regression: whitespace patterns must use regex whitespace, not a literal backslash.
for (const text of ["كس أم", "كسأم", "ابن الكلب", "ابن الكل", "fuck you", "fuckyou", "signals vip", "signal vip", "استثمار مضمون", "ربح يومي"]) {
  assert.equal(inspectMessage({text}).reasons.includes("blocked_word"), true, `expected blocked-word detection for: ${text}`);
}
assert.equal(inspectMessage({caption:"عرض المنتج مع رابط https://example.com"}).linkCount, 1);
assert.equal(inspectMessage({text:"رسالة طبيعية"}).allowed, true);
resetRateWindows();
for (let i = 1; i <= 5; i++) assert.equal(inspectRate({chatId:-1001,userId:7,now:i*1000,limit:5}).limited, false);
assert.equal(inspectRate({chatId:-1001,userId:7,now:6000,limit:5}).limited, true);
assert.equal(inspectRate({chatId:-1001,userId:8,now:6000,limit:5}).limited, false);
assert.equal(inspectRate({chatId:-1001,userId:7,now:70000,limit:5}).limited, false);
console.log("protection regression tests: OK");

resetMediaWindows();
for (let i = 1; i <= 3; i++) assert.equal(inspectMediaQuota({chatId:-1001,userId:7,messageType:"photo",now:Date.UTC(2026,0,1,12),photoLimit:3}).exceeded, false);
assert.deepEqual(
  (({exceeded,count,limit}) => ({exceeded,count,limit}))(inspectMediaQuota({chatId:-1001,userId:7,messageType:"photo",now:Date.UTC(2026,0,1,12),photoLimit:3})),
  {exceeded:true,count:4,limit:3}
);
assert.equal(inspectMediaQuota({chatId:-1001,userId:8,messageType:"photo",now:Date.UTC(2026,0,1,12),photoLimit:3}).count, 1);
assert.equal(inspectMediaQuota({chatId:-1001,userId:7,messageType:"video",now:Date.UTC(2026,0,1,12),videoLimit:1}).exceeded, false);
assert.equal(inspectMediaQuota({chatId:-1001,userId:7,messageType:"video",now:Date.UTC(2026,0,1,12),videoLimit:1}).exceeded, true);
assert.equal(inspectMediaQuota({chatId:-1001,userId:7,messageType:"document"}).applicable, false);
console.log("media quota audit tests: OK");

// Cairo local-day boundary: 2026-01-01 21:59:59 UTC is 23:59:59 in Cairo,
// while 22:00:00 UTC is midnight on the next Cairo day.
resetMediaWindows();
const beforeCairoMidnight = inspectMediaQuota({chatId:-1001,userId:7,messageType:"photo",now:Date.UTC(2026,0,1,21,59,59),photoLimit:3});
const afterCairoMidnight = inspectMediaQuota({chatId:-1001,userId:7,messageType:"photo",now:Date.UTC(2026,0,1,22,0,0),photoLimit:3});
assert.equal(beforeCairoMidnight.day, "2026-01-01");
assert.equal(afterCairoMidnight.day, "2026-01-02");
assert.equal(afterCairoMidnight.count, 1, "daily quota resets at Cairo midnight");
console.log("Cairo-local media quota day tests: OK");

const runtimeSource = require("node:fs").readFileSync(require.resolve("../index.js"), "utf8");
assert.doesNotMatch(runtimeSource, /PROTECTION_ENFORCE|moderation_settings|moderation_events|recordActivity|recentLogAlerts/,
  "legacy moderation/protection utilities must not be wired into the Borsa runtime");
console.log("legacy protection utilities are isolated from the Borsa runtime: OK");
