"use strict";
const assert = require("node:assert/strict");
const { DAILY_HOUR, cairoClock, msUntilNextCheck, fetchStorePage, checkCatalogsOnce } = require("../modules/catalog-newsletter-scheduler");
const { newsletterKindAt } = require("../modules/deal-scheduler");

assert.equal(DAILY_HOUR, 10);
assert.equal(typeof cairoClock().hour, "number");

// Catalog checks run at 10:00 Cairo, well before the existing deal newsletters.
assert.equal(newsletterKindAt(new Date("2026-10-25T07:00:00.000Z")), null); // 10:00 Cairo: no deal newsletter
assert.equal(newsletterKindAt(new Date("2026-10-25T14:00:00.000Z")), "amazon"); // 17:00 Cairo
assert.equal(newsletterKindAt(new Date("2026-10-25T15:00:00.000Z")), "other_sites"); // 18:00 Cairo

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
