"use strict";
const assert = require("node:assert/strict");
const {
  CATALOG_REGION, CATALOG_STORES, safeCatalogUrl, catalogUrlBelongsToStore, extractCatalogs, isRelevantOffer, changedCatalogs, formatCatalogNotice, persistCatalogSnapshots, listPendingCatalogSnapshots, markCatalogSnapshot
} = require("../modules/catalog-newsletter");

assert.deepEqual(Object.keys(CATALOG_STORES).sort(), ["bim", "kazyon", "metro_market"]);
assert.equal(CATALOG_REGION, "محافظة القاهرة");
assert.ok(Object.values(CATALOG_STORES).every(store => store.region === CATALOG_REGION));
assert.equal(safeCatalogUrl("https://snapflyer.io/eg/downtown/offers/kazyon/1376"), "https://snapflyer.io/eg/downtown/offers/kazyon/1376");
assert.equal(safeCatalogUrl("https://evil.example/eg/downtown/offers/kazyon/1376"), null);
assert.equal(safeCatalogUrl("http://snapflyer.io/eg/downtown/offers/kazyon/1376"), null);
assert.equal(catalogUrlBelongsToStore("https://snapflyer.io/eg/downtown/offers/kazyon/1376", "kazyon"), true);
assert.equal(catalogUrlBelongsToStore("https://snapflyer.io/eg/downtown/offers/bim/1376", "kazyon"), false);
assert.equal(catalogUrlBelongsToStore("https://snapflyer.io/eg/downtown/offers/metro-market/1376", "bim"), false);
assert.equal(catalogUrlBelongsToStore("https://evil.example/eg/downtown/offers/kazyon/1376", "kazyon"), false);
const html = `
<a href="/eg/downtown/offers/kazyon/1376"><span>Kazyon — Lowest Price Everyday</span></a>
<a href="/eg/downtown/offers/bim/1376"><span>BIM weekly offers November 2026</span></a>
<a href="/eg/downtown/offers/metro-market/1376"><span>Metro Market offers November 2026</span></a>
<a href="https://evil.example/eg/downtown/offers/kazyon/1377">Bad link should not pass</a>
<a href="http://[">Malformed URL should not crash parsing</a>
<a href="/eg/downtown/stores/kazyon">Store link should not pass</a>
`;
const catalogs = extractCatalogs(html, "kazyon");
assert.equal(catalogs.length, 1, "only the configured store's catalog should be accepted");
assert.equal(catalogs[0].store, "kazyon");
assert.equal(catalogs[0].region, "محافظة القاهرة");
assert.equal(catalogs[0].url, "https://snapflyer.io/eg/downtown/offers/kazyon/1376");
const liveStyleCatalog = extractCatalogs(
  '<a href="/eg/downtown/offers/kazyon/1567"><span>✨ New Kazyon — Win Gold and Cash 7 days left 27 Oct - 2 Nov</span></a>',
  "kazyon"
);
assert.equal(liveStyleCatalog.length, 1, "store listing style should be extracted");
assert.equal(liveStyleCatalog[0].displayedDateRange, "27 Oct - 2 Nov",
  "date ranges rendered in flyer link text should be captured, not only title attributes");
assert.ok(catalogs[0].fingerprint);
const firstEdition = extractCatalogs(
  '<a title="1 Nov - 7 Nov" href="/eg/downtown/offers/kazyon/1376"><span>Kazyon weekly flyer</span></a>',
  "kazyon"
);
const secondEdition = extractCatalogs(
  '<a title="8 Nov - 14 Nov" href="/eg/downtown/offers/kazyon/1376"><span>Kazyon weekly flyer</span></a>',
  "kazyon"
);
assert.equal(firstEdition[0].url, secondEdition[0].url);
assert.notEqual(firstEdition[0].fingerprint, secondEdition[0].fingerprint,
  "a changed displayed validity range must create a new catalog fingerprint");
const countdownVariant = extractCatalogs(
  '<a href="/eg/downtown/offers/kazyon/1567"><span>✨ New Kazyon — Win Gold and Cash 6 days left 27 Oct - 2 Nov</span></a>',
  "kazyon"
);
const countdownVariantNextDay = extractCatalogs(
  '<a href="/eg/downtown/offers/kazyon/1567"><span>✨ New Kazyon — Win Gold and Cash 5 days left 27 Oct - 2 Nov</span></a>',
  "kazyon"
);
assert.equal(countdownVariant[0].fingerprint, countdownVariantNextDay[0].fingerprint,
  "a changing days-left countdown must not create a duplicate catalog edition");
const meaningfulTitleChange = extractCatalogs(
  '<a href="/eg/downtown/offers/kazyon/1567"><span>✨ New Kazyon — Summer cleaning offers 27 Oct - 2 Nov</span></a>',
  "kazyon"
);
assert.notEqual(countdownVariant[0].fingerprint, meaningfulTitleChange[0].fingerprint,
  "meaningful title changes must still be detected when a catalog URL is reused");
assert.equal(extractCatalogs(html, "unknown").length, 0);
assert.equal(isRelevantOffer({ title: "Clorox laundry bleach", category: "groceries" }), true);
assert.equal(isRelevantOffer({ title: "Women's cotton dress", category: "fashion" }), false);
assert.equal(isRelevantOffer({ title: "Generic item", category: "personal_care" }), true);
const all = [{ fingerprint: "a" }, { fingerprint: "b" }, { fingerprint: "a" }];
assert.deepEqual(changedCatalogs(["a"], all).map(x => x.fingerprint), ["b"]);
const notice = formatCatalogNotice({ store_key: "kazyon", catalog_url: "https://snapflyer.io/eg/downtown/offers/kazyon/1376", title: "Kazyon flyer", region: CATALOG_REGION });
assert.match(notice, /النطاق الجغرافي: محافظة القاهرة/);
assert.match(notice, /https:\/\/snapflyer\.io/);
assert.equal(typeof persistCatalogSnapshots, "function");
assert.equal(typeof listPendingCatalogSnapshots, "function");
assert.equal(typeof markCatalogSnapshot, "function");

async function runPersistenceTests() {
  const calls = [];
  let latestFingerprint = null;
  const existingFingerprints = new Set();
  let nextId = 1;
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.startsWith("SELECT id FROM catalog_newsletter_snapshots WHERE store_key")) {
        return { rows: existingFingerprints.size ? [{ id: 1 }] : [] };
      }
      if (sql.startsWith("SELECT fingerprint")) {
        return { rows: latestFingerprint ? [{ fingerprint: latestFingerprint }] : [] };
      }
      if (sql.startsWith("INSERT") && sql.includes("RETURNING id")) {
        const key = [params[0], params[1], params[2]].join("|");
        if (existingFingerprints.has(key)) return { rowCount: 0, rows: [] };
        existingFingerprints.add(key);
        latestFingerprint = params[2];
        return { rowCount: 1, rows: [{ id: nextId++ }] };
      }
      if (sql.startsWith("INSERT")) {
        const key = [params[0], params[1], params[2]].join("|");
        existingFingerprints.add(key);
        latestFingerprint = params[2];
        return { rowCount: 1, rows: [] };
      }
      if (sql.startsWith("UPDATE") && sql.includes("last_seen_at")) {
        return { rowCount: 1, rows: [] };
      }
      if (sql.startsWith("SELECT id,store_key")) {
        return { rows: [{ id: 9, status: "pending" }] };
      }
      if (sql.startsWith("UPDATE") && sql.includes("RETURNING id")) {
        return { rowCount: params[1] === "published" ? 1 : 0, rows: [{ id: params[0] }] };
      }
      throw new Error("Unexpected SQL in persistence test: " + sql);
    }
  };
  const catalog = {
    store: "kazyon",
    url: "https://snapflyer.io/eg/downtown/offers/kazyon/1376",
    fingerprint: "fp-1",
    title: "Kazyon flyer",
    region: CATALOG_REGION
  };
  assert.deepEqual(await persistCatalogSnapshots(pool, [catalog]), { baseline: 1, changed: 0, unchanged: 0 });
  assert.match(calls.at(-1).sql, /ON CONFLICT\(store_key,catalog_url,fingerprint\) DO NOTHING/);
  assert.equal(calls.at(-1).params[6], "ignored");
  assert.deepEqual(await persistCatalogSnapshots(pool, [catalog]), { baseline: 0, changed: 0, unchanged: 1 });
  assert.match(calls.at(-1).sql, /last_seen_at=NOW\(\)/);
  assert.match(calls.at(-1).sql, /title=\$4, region=\$5, displayed_date_range=\$6/);
  assert.equal(calls.at(-1).params[3], catalog.title);
  const changed = { ...catalog, fingerprint: "fp-2", title: "Kazyon flyer updated" };
  assert.deepEqual(await persistCatalogSnapshots(pool, [changed]), { baseline: 0, changed: 1, unchanged: 0 });
  assert.match(calls.at(-1).sql, /'pending'/);
  assert.deepEqual(await persistCatalogSnapshots(pool, [changed]), { baseline: 0, changed: 0, unchanged: 1 });
  assert.deepEqual(await listPendingCatalogSnapshots(pool, 1000), [{ id: 9, status: "pending" }]);
  assert.match(calls.at(-1).sql, /LIMIT \$1/);
  assert.deepEqual(calls.at(-1).params, [100]);
  assert.equal(await markCatalogSnapshot(pool, 9, "published"), true);
  assert.match(calls.at(-1).sql, /status='pending'/);
  await assert.rejects(() => markCatalogSnapshot(pool, 9, "unknown"), /invalid catalog snapshot status/);
  await assert.rejects(() => persistCatalogSnapshots(null, [catalog]), /requires a PostgreSQL pool/);
}

runPersistenceTests().then(() => {
  console.log("catalog newsletter helper and mocked persistence tests: OK");
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});

