"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { parseInvoiceTable, parseStructuredPriceTable } = require("../modules/price-intelligence");

const oxy = fs.readFileSync(path.join(__dirname, "..", "\u0642\u0627\u0626\u0645\u0629 \u0623\u0633\u0639\u0627\u0631 \u0623\u0648\u0643\u0633\u064a.txt"), "utf8");
const bahi = fs.readFileSync(path.join(__dirname, "..", "\u0642\u0627\u0626\u0645\u0629 \u0623\u0633\u0639\u0627\u0631 \u0628\u0627\u0647\u064a.txt"), "utf8");
const oxyRows = parseInvoiceTable(oxy);
const bahiRows = parseStructuredPriceTable(bahi);

assert.equal(oxyRows.length, 63, "Oxy: every product row should be parsed");
assert.equal(bahiRows.length, 49, "Bahi ASC2: every product row should be parsed");
assert.ok(oxyRows.every(r => r.trusted_catalog_row && !r.needs_review && r.price_kind === "wholesale"));
assert.ok(bahiRows.every(r => r.trusted_catalog_row && !r.needs_review && r.price_kind === "wholesale"));

const oxyNoPackCount = oxyRows.filter(r => r.pack_count == null);
assert.ok(oxyNoPackCount.length >= 1, "missing pack count is allowed and must not discard an otherwise valid price");
assert.ok(oxyRows.some(r => r.product_text.includes("جوي هاندويش 250 ملل") && r.package_sale_price === 427.28 && r.pack_count == null));

const bahiThreeCarton = bahiRows.find(r => r.product_text.includes("\u0628\u0627\u0647\u064a 2000 \u062c\u0631\u0627\u0645") && r.product_text.includes("\u0634\u0631\u0627\u0621 3"));
assert.ok(bahiThreeCarton, "the contextual Bahi 2000 g row must be recovered from the three-carton offer");
assert.equal(bahiThreeCarton.package_sale_price, 468.83);
assert.equal(bahiThreeCarton.listed_base_price, 117.20);
assert.equal(bahiThreeCarton.pack_count, 4);
assert.equal(bahiThreeCarton.weight_g, 2000);

const bahi2000Rows = bahiRows.filter(r => r.product_text.includes("\u0628\u0627\u0647\u064a 2000 \u062c\u0631\u0627\u0645"));
assert.equal(bahi2000Rows.length, 3, "all three Bahi 2000 g price contexts must be preserved separately");
assert.deepEqual(bahi2000Rows.map(r => r.package_sale_price), [478.24, 473.68, 468.83]);

console.log("FULL OXY + BAHI TEXT CATALOG REGRESSION: OK");
