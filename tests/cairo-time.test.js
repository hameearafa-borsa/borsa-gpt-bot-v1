"use strict";
const assert = require("node:assert/strict");
const { parseLocalDateTime, partsAt, nextDailyOccurrence } = require("../core/cairo-time");

const winter = parseLocalDateTime("2026-01-15T12:00");
assert.equal(winter.toISOString(), "2026-01-15T10:00:00.000Z");
const summer = parseLocalDateTime("2026-07-15T12:00");
assert.equal(summer.toISOString(), "2026-07-15T09:00:00.000Z");
assert.throws(() => parseLocalDateTime("2026-02-30T12:00"), /غير صالح/);
assert.throws(() => parseLocalDateTime("not-a-date"), /صيغة/);

// Daily schedules preserve Cairo wall-clock time when the UTC offset changes.
const beforeShift = parseLocalDateTime("2026-04-23T12:00");
const afterShift = nextDailyOccurrence(beforeShift);
const p = partsAt(afterShift);
assert.equal(p.hour, 12);
assert.equal(p.minute, 0);
assert.equal(afterShift.toISOString(), "2026-04-24T09:00:00.000Z");
assert.equal((afterShift.getTime() - beforeShift.getTime()) / 3600000, 23);
console.log("Cairo wall-clock scheduler tests: OK");
