"use strict";
const assert = require("node:assert/strict");
const { DAILY_HOUR, DAILY_MINUTE, cairoClock, msUntilNextCheck, fetchStorePage, checkCatalogsOnce } = require("../modules/catalog-newsletter-scheduler");
const { newsletterKindAt } = require("../modules/deal-scheduler");
const { currentWeatherSlot } = require("../modules/weather-scheduler");

assert.equal(DAILY_HOUR, 10);
assert.equal(DAILY_MINUTE, 10);
assert.equal(typeof cairoClock().hour, "number");

// Catalog check has a 50-minute buffer before the existing 11:00 weather bulletin,
// and is many hours away from the 17:00/18:00 deal newsletters.
assert.equal(currentWeatherSlot(new Date("2026-10-25T07:10:00.000Z")), null); // 10:10 Cairo
assert.equal(currentWeatherSlot(new Date("2026-10-25T08:00:00.000Z"))?.hour, 11); // 11:00 Cairo
assert.equal(newsletterKindAt(new Date("2026-10-25T07:10:00.000Z")), null); // 10:10 Cairo
assert.equal(newsletterKindAt(new Date("2026-10-25T14:00:00.000Z")), "amazon"); // 17:00 Cairo
assert.equal(newsletterKindAt(new Date("2026-10-25T15:00:00.000Z")), "other_sites"); // 18:00 Cairo

const before = new Date("2026-10-25T07:09:00.000Z"); // 10:09 Cairo
assert.equal(msUntilNextCheck(before), 60 * 1000);
const after = new Date("2026-10-25T07:11:00.000Z"); // 10:11 Cairo
assert.equal(msUntilNextCheck(after), 23 * 60 * 60 * 1000 - 60 * 1000);

(async () => {
  await assert.rejects(() => fetchStorePage("https://evil.example/"), /catalog_source_not_allowed/);
  const html = await fetchStorePage("https://snapflyer.io/eg/downtown/stores/kazyon", {
    fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => "text/html" }, text: async () => "<html>ok</html>" })
  });
  assert.equal(html, "<html>ok</html>");
  const skipped = await checkCatalogsOnce({ pool: null, telegram: null, chatId: null });
  assert.equal(skipped.skipped, true);
  console.log("catalog newsletter scheduler tests: OK");
})().catch(error => { console.error(error); process.exitCode = 1; });
