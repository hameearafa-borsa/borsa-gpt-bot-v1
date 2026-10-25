"use strict";
const assert = require("node:assert/strict");
const { DAILY_HOUR, cairoClock, msUntilNextCheck, fetchStorePage, checkCatalogsOnce } = require("../modules/catalog-newsletter-scheduler");

assert.equal(DAILY_HOUR, 10);
assert.equal(typeof cairoClock().hour, "number");
const before = new Date("2026-10-25T06:00:00.000Z"); // 09:00 Cairo
assert.equal(msUntilNextCheck(before), 60 * 60 * 1000);
const after = new Date("2026-10-25T08:00:00.000Z"); // 11:00 Cairo
assert.equal(msUntilNextCheck(after), 23 * 60 * 60 * 1000);
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
