"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { isOwnMessage, isEligibleMessage, isBulkPriceList, observe } = require("../modules/price-monitor");
const registry = require("../data/product-registry.json");
const { extractPriceCandidates, parseStructuredPriceTable, parseInvoiceTable, productIdentityKey } = require("../modules/price-intelligence");

(async () => {
  const base = { chatType: "supergroup", text: "بريكس ارضيات ٢٥ جم جملة ١٨.٧٥ ج" };
  assert.equal(isEligibleMessage({ ...base, isLogChannel: false, isCommand: false, ownMessage: false }), true);
  assert.equal(isEligibleMessage({ ...base, chatType: "private", isLogChannel: false, isCommand: false, ownMessage: false }), false);
  assert.equal(isEligibleMessage({ ...base, isLogChannel: true, isCommand: false, ownMessage: false }), false);
  assert.equal(isEligibleMessage({ ...base, isLogChannel: false, isCommand: true, ownMessage: false }), false);
  assert.equal(isEligibleMessage({ ...base, isLogChannel: false, isCommand: false, ownMessage: true }), false);
  const oxyTextCatalog = fs.readFileSync(path.join(__dirname, "..", "قائمة أسعار أوكسي.txt"), "utf8");
  const bahiTextCatalog = fs.readFileSync(path.join(__dirname, "..", "قائمة أسعار باهي.txt"), "utf8");
  assert.equal(parseInvoiceTable(oxyTextCatalog).length, 63, "all Oxy text-catalog product rows must be parsed");
  assert.equal(parseStructuredPriceTable(bahiTextCatalog).length, 49, "all Bahi ASC2 product rows must be parsed");
  const unileverList = fs.readFileSync(path.join(__dirname, "fixtures-unilever-oct-2026.txt"), "utf8");
  assert.equal(isBulkPriceList(unileverList), true, "a long Unilever price list is a catalog, not one ordinary price observation");
  assert.equal(isEligibleMessage({ ...base, text: unileverList, isLogChannel: false, isCommand: false, ownMessage: false }), false,
    "bulk price lists must not generate dozens of individual review messages");
  assert.equal(isBulkPriceList(base.text), false, "a single product price remains eligible");
  const asc2September = parseStructuredPriceTable("تصفية اسعار سبتمبر ASC2 2026\nالاصناف\tعدد القطع\tالسعر الصافي بعد الخصم 2%\tصافي سعر القطعة\nالصابون الريحة\nدوش 60 جرام 48 313.60 6.50\nدوش 110 جرام 48 570.27 11.90\nعرض التوفير على شراء 2 كرتونه\nباهي 1000جرام 6 367.34 61.20\nعرض التوفير على شراء 3 كرتونه\nباهي  جرام 4 468.83 117.20\nالهاند ووش والشاور جل ريفولي\nشاور جل ريفولي 1 لتر 12 1,147.58 95.60");
  assert.equal(asc2September.length, 5, "structured price table should retain each complete product row");
  assert.deepEqual(asc2September.slice(0, 2).map(row => [row.product_text, row.pack_count, row.package_sale_price, row.listed_base_price, row.weight_g]),
    [["دوش 60 جرام", 48, 313.6, 6.5, 60], ["دوش 110 جرام", 48, 570.27, 11.9, 110]],
    "carton count, carton total, unit price, and product weight must remain distinct");
  assert.equal(asc2September[2].package_sale_price, 367.34);
  assert.match(asc2September[2].product_text, /شراء 2 كرتونه/);
  assert.match(asc2September[3].product_text, /باهي 2000 جرام/);
  assert.equal(asc2September[3].weight_g, 2000);
  assert.match(asc2September[3].product_text, /شراء 3 كرتونه/);
  assert.equal(asc2September[4].package_sale_price, 1147.58);
  assert.equal(asc2September[4].listed_base_price, 95.6);
  assert.equal(asc2September[4].volume_ml, 1000);
  assert.ok(asc2September.every(row => row.trusted_catalog_row && !row.needs_review && row.confidence >= 0.8 && row.price_kind === "wholesale"),
    "interpreted structured catalog rows must be trusted wholesale observations with no review");

  const oxyInvoice = parseInvoiceTable(`الصنف
سعر الفاتورة بعد 14% والعرض الترويجي
جوي
110 جرام 48 قطعة
628.64
جوي هاندويش
250 ملل
427.28
أوكسي كبسولات
14 جرام 20 عبوة
1,107.40
كبسولات
14 جرام 30 عبوة
1,421.00
أوكسي منعم أقمشة
1 لتر 6 زجاجة
444.43`);
  assert.equal(oxyInvoice.length, 5, "invoice parser should assemble multiline product descriptions and amount-only lines");
  assert.deepEqual(oxyInvoice.slice(0, 3).map(row => [row.product_text, row.pack_count, row.package_sale_price, row.weight_g, row.volume_ml]), [
    ["جوي 110 جرام", 48, 628.64, 110, null],
    ["جوي هاندويش 250 ملل", null, 427.28, null, 250],
    ["أوكسي كبسولات 14 جرام", 20, 1107.4, 14, null]
  ], "invoice total, product size, and package count must be stored separately");
  assert.equal(oxyInvoice[3].product_text, "كبسولات 14 جرام",
    "a row without a brand name must not inherit the previous row's brand");
  assert.equal(oxyInvoice[3].package_sale_price, 1421);
  assert.equal(oxyInvoice[4].pack_count, 6, "bottle counts must be extracted, not confused with price or size");
  assert.equal(oxyInvoice[4].volume_ml, 1000, "litre sizes must normalize to millilitres");
  assert.equal(extractPriceCandidates("جوي كبسولات 14 جرام سعر الفاتورة بعد 14%: 1,107.40")[0].package_sale_price, 1107.4,
    "inline invoice totals with thousands separators must remain intact after label extraction");
  assert.equal(extractPriceCandidates("شاور جل ريفولي 1 لتر جملة 1,147.58")[0].package_sale_price, 1147.58,
    "a thousands comma in a price must not be parsed as a decimal separator");
  assert.ok(oxyInvoice.every(row => row.trusted_catalog_row && !row.needs_review && row.confidence >= 0.8 && row.price_kind === "wholesale"),
    "interpreted invoice rows must be trusted wholesale observations with no review");
  assert.equal(extractPriceCandidates(`الصنف
سعر الفاتورة بعد 14% والعرض الترويجي
أوكسي كبسولات
14 جرام 20 عبوة
1,107.40`)[0].package_sale_price, 1107.4,
    "invoice parser must accept thousands separators and return the invoice total");

  const invoiceAfterVatRows = extractPriceCandidates(`- **دوش** **60** - سعر الفاتورة بعد 14%: 329.28
- **دوش** **110** - سعر الفاتورة بعد 14%: 612.50
- **باهي** **5** **جم** **24** **كيس** - قيمة العرض: 2 - سعر الفاتورة بعد 14%: 92.54
- **باهي** **10** **جم** **20** **كيس** - قيمة العرض: 10 - سعر الفاتورة بعد 14%: 152.26`);
  assert.deepEqual(invoiceAfterVatRows.map(row => row.package_sale_price), [329.28, 612.5, 92.54, 152.26],
    "invoice total after 14% must win over product size and offer-value numbers");
  assert.equal(invoiceAfterVatRows[2].pack_count, 24,
    "Bahi 5 g with 24 sachets must preserve the pack count");
  assert.equal(invoiceAfterVatRows[2].product_text.includes("قيمة العرض"), false,
    "offer metadata must not contaminate the normalized product identity");
  assert.equal(invoiceAfterVatRows[0].product_text, "دوش 60 جرام",
    "the Doush product-specific convention must preserve and normalize its bare gram weight");
  assert.equal(invoiceAfterVatRows[1].product_text, "دوش 110 جرام",
    "different Doush gram weights must remain separate normalized product identities");
  assert.notEqual(invoiceAfterVatRows[0].product_text, invoiceAfterVatRows[1].product_text,
    "Doush 60 and Doush 110 must not be merged just because the unit is omitted");
  assert.equal(invoiceAfterVatRows[0].product_text, "دوش 60 جرام",
    "the product-specific Doush shorthand must normalize to a 60-gram soap identity");
  assert.equal(invoiceAfterVatRows[0].weight_g, 60,
    "the Doush 60 shorthand must populate the weight field as 60 grams");
  assert.equal(invoiceAfterVatRows[1].product_text, "دوش 110 جرام",
    "the product-specific Doush shorthand must normalize to a 110-gram soap identity");
  assert.equal(invoiceAfterVatRows[1].weight_g, 110,
    "the Doush 110 shorthand must populate the weight field as 110 grams");
  assert.notEqual(
    productIdentityKey({ product_text: "منظف معروف", price_kind: "wholesale_candidate", weight_g: 500, pack_count: 12 }),
    productIdentityKey({ product_text: "منظف معروف", price_kind: "wholesale_candidate", weight_g: 1000, pack_count: 12 }),
    "different weights must have independent identities even when display names omit the size"
  );
  assert.equal(
    productIdentityKey({ product_text: "منظف معروف", price_kind: "wholesale_candidate", weight_g: 500, pack_count: 12 }),
    productIdentityKey({ product_text: "منظف معروف", price_kind: "wholesale_candidate", weight_g: 500, pack_count: 24 }),
    "different carton counts are separate observations of the same product identity"
  );
  assert.equal(require("../modules/price-intelligence").commercialMetrics({ package_sale_price: 300, pack_count: null }).piece_sale_price, null,
    "do not invent a piece price when carton count is unknown");
  assert.notEqual(
    productIdentityKey({ product_text: invoiceAfterVatRows[0].product_text, price_kind: invoiceAfterVatRows[0].price_kind }),
    productIdentityKey({ product_text: invoiceAfterVatRows[1].product_text, price_kind: invoiceAfterVatRows[1].price_kind }),
    "Doush 60 g and 110 g must have separate product identity keys and price histories"
  );
  const regularDoushRows = extractPriceCandidates("دوش 60 جملة 25 ج\nدوش 110 جملة 30 ج");
  assert.deepEqual(regularDoushRows.map(row => row.product_text), ["دوش 60 جرام", "دوش 110 جرام"],
    "Doush shorthand must normalize in ordinary price rows too, not only invoice exports");
  assert.deepEqual(regularDoushRows.map(row => row.weight_g), [60, 110],
    "ordinary Doush rows must store the inferred gram weight separately from the price");
  const arielPromoList = `اريال ٢ك يدوي ٤٩٠ج ٤ق
اريال ١ك يدوي ٣٩٦ج ٦ق
اريال ١.٥ك يدوي ٣٨٠ج ٤ق
اريال ٢.٥ك اتوماتيك ٨٢٨ج ٤ق
اريال ٤ك اتوماتيك ٧٨٦ج ٣ق
اريال ٩ك ١٠١٠ج ٢ق
بونكس ٩ك ٨٠٠ج ٢ق
تايد ٢،٥ك ٦٧٢ج ٤ق
تايد ٩ك ٤٩٠ج ٢ق
في برضو ب٥ج ب١٠ج ب٢٥ج`;
  assert.equal(isBulkPriceList(arielPromoList), true,
    "a multiline detergent list with price followed by pack count must be excluded from individual price monitoring");
  assert.equal(isEligibleMessage({ ...base, text: arielPromoList, isLogChannel: false, isCommand: false, ownMessage: false }), false,
    "an entire promotional list must not produce per-row observations, including its incomplete final commentary line");
  const oneLineUnilever = unileverList.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
  assert.equal(isBulkPriceList(oneLineUnilever), true,
    "a full catalog pasted as one long Telegram paragraph must not trigger per-product monitoring");
  assert.equal(isBulkPriceList("أريال مسحوق 2 كجم ١٥٠ ج"), false,
    "a single product observation must remain eligible even when its price is written inline");
  const unileverSeptemberNoCurrency = `أسعار شركة يونيليفر
أسعار الشامبو
صنسيلك 90 عرض 30
صنسيلك 180 عرض 47
صنسيلك 350 عرض 76.25
صنسيلك 350 مل+170 مل عرض 237.65
صنسيلك 600 مل عرض 114
كلير 180 رجالي عرض 81
دوف 180 مل 75.5
تريزيمي شامبو 600 مل 202.5
سيجنال 25 مل 12.37
لوكس 75 جرام 14.20ج
كمفورت لتر عرض 87.15`;
  assert.equal(isBulkPriceList(unileverSeptemberNoCurrency), true,
    "a company list with many numeric prices but no currency suffix on most rows must be detected as bulk");
  assert.equal(isEligibleMessage({ ...base, text: unileverSeptemberNoCurrency, isLogChannel: false, isCommand: false, ownMessage: false }), false,
    "a September-style Unilever catalog must not become many individual monitor observations");
  assert.equal(isOwnMessage({ botUserId: 123, fromId: "123" }), true);
  assert.equal(isOwnMessage({ botUserId: 123, fromId: 456 }), false);

  const savedQueries = [];
  const pool = {
    async query(sql, params) {
      savedQueries.push({ sql, params });
      if (sql.includes("reviewed_price_products")) return { rows: [], rowCount: 0 };
      if (sql.includes("SELECT product_identity_key")) return { rows: [], rowCount: 0 };
      if (sql.includes("SELECT 1 FROM price_observations")) return { rows: [], rowCount: 0 };
      if (sql.includes("INSERT INTO price_observations")) return { rows: [{ id: 91 }], rowCount: 1 };
      throw new Error("unexpected query");
    }
  };
  const result = await observe({
    pool,
    message: { chatId: -100123, messageId: 456, userId: 789, text: base.text },
    registry
  });
  assert.equal(result.silent, true);
  assert.equal(result.saved, 1);
  assert.equal(result.savedRows[0].id, 91);
  assert.equal(result.accepted[0].price_kind, "wholesale");
  assert.equal(result.accepted[0].package_sale_price, 18.75);
  assert.equal(result.accepted[0].decision, "accepted");
  assert.equal(savedQueries.length, 4);
  assert.ok(savedQueries[3].sql.includes("INSERT INTO price_observations"));
  assert.ok(savedQueries[3].sql.includes("product_text"));
  assert.ok(savedQueries[3].sql.includes("offer_extra_weight_g"));
  assert.equal(savedQueries[3].params[13], "accepted");

  // Unit type must survive the full monitor -> database INSERT path.
  let pieceInsertParams = null;
  const piecePool = {
    async query(sql, params) {
      if (sql.includes("reviewed_price_products")) return { rows: [], rowCount: 0 };
      if (sql.includes("SELECT product_identity_key")) return { rows: [], rowCount: 0 };
      if (sql.includes("SELECT 1 FROM price_observations")) return { rows: [], rowCount: 0 };
      if (sql.includes("INSERT INTO price_observations")) {
        pieceInsertParams = params;
        return { rows: [{ id: 92 }], rowCount: 1 };
      }
      throw new Error("unexpected query in piece-price persistence test");
    }
  };
  const pieceResult = await observe({
    pool: piecePool,
    message: { chatId: -100123, messageId: 457, userId: 789, text: "سيجنال 120مل ق 42.33 ج" },
    registry
  });
  assert.equal(pieceResult.saved, 1);
  assert.equal(pieceInsertParams[23], "بالقطعة",
    "unit_price_type must be persisted in the new final INSERT parameter");

  // A standalone "ق" is a piece-price marker, not part of the product name.
  const dovePiece = extractPriceCandidates("دوف 350مل ق 121 ج")[0];
  assert.equal(dovePiece.product_text, "دوف");
  assert.equal(dovePiece.volume_ml, 350);
  assert.equal(dovePiece.package_sale_price, 121);
  assert.equal(dovePiece.unit_price_type, "بالقطعة");

  // Historical accepted observations are compared before insertion, without posting a chat message.
  let historyInsertParams = null;
  const historyPool = {
    async query(sql, params) {
      if (sql.includes("reviewed_price_products")) return { rows: [], rowCount: 0 };
      if (sql.includes("SELECT 1 FROM price_observations")) return { rows: [], rowCount: 0 };
      if (sql.includes("SELECT product_identity_key")) {
        return { rows: [{
          product_identity_key: params[0], price_kind: params[1], product_text: "بريكس ارضيات",
          package_sale_price: 17.50, weight_g: 25, volume_ml: null, pack_count: null,
          offer_extra_weight_g: null, package_type: null, brand_key: null
        }], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO price_observations")) {
        historyInsertParams = params;
        return { rows: [{ id: 96 }], rowCount: 1 };
      }
      throw new Error("unexpected history query");
    }
  };
  const historical = await observe({
    pool: historyPool,
    message: { chatId: -100123, messageId: 462, userId: 789, text: base.text },
    registry
  });
  assert.equal(historical.saved, 1);
  assert.equal(historical.savedRows[0].row.change_type, "price_change");
  assert.equal(historyInsertParams[17], "price_change");

  // A known carton count can enrich a later observation that omits it, without being invented from the current message.
  let inheritedInsertParams = null;
  const inheritedCountPool = {
    async query(sql) {
      if (sql.includes("reviewed_price_products")) return { rows: [], rowCount: 0 };
      if (sql.includes("SELECT 1 FROM price_observations")) return { rows: [], rowCount: 0 };
      if (sql.includes("SELECT product_identity_key")) return { rows: [{
        product_identity_key: "prior-product", price_kind: "wholesale", product_text: "بريكس ارضيات",
        package_sale_price: 216, weight_g: 25, volume_ml: null, pack_count: 12,
        offer_extra_weight_g: null, package_type: null, brand_key: null
      }], rowCount: 1 };
      if (sql.includes("INSERT INTO price_observations")) return { rows: [{ id: 99 }], rowCount: 1 };
      throw new Error("unexpected inherited-count query");
    }
  };
  const inheritedCount = await observe({
    pool: inheritedCountPool,
    message: { chatId: -100123, messageId: 465, text: "بريكس ارضيات ٢٥ جم جملة ١٨.٧٥ ج" },
    registry
  });
  assert.equal(inheritedCount.saved, 1);
  assert.equal(inheritedCount.savedRows[0].row.pack_count, 12);
  assert.equal(inheritedCount.savedRows[0].row.pack_count_inferred, true);
  assert.equal(inheritedCount.savedRows[0].row.piece_sale_price, 18.75 / 12);

  // A plausible price without an explicit wholesale marker or registry match
  // is retained as pending review data instead of being silently discarded.
  const uncertain = await observe({
    pool,
    message: { chatId: -100123, messageId: 457, userId: 789, text: "منظف مجهول 30 جنيه" },
    registry
  });
  assert.equal(uncertain.silent, true);
  assert.equal(uncertain.saved, 1);
  assert.equal(uncertain.savedRows[0].row.decision, "pending");
  assert.ok(uncertain.savedRows[0].row.confidence < 0.8);
  assert.equal(savedQueries.length, 7);

  const noDb = await observe({ message: { text: base.text }, registry });
  assert.equal(noDb.saved, 0);
  assert.equal(noDb.silent, true);

  // A bare 503 must not trigger any database lookup or insert.
  let bare503Queries = 0;
  const bare503 = await observe({
    pool: { async query() { bare503Queries += 1; throw new Error("503 should not reach persistence"); } },
    message: { chatId: -100123, messageId: 458, text: "503" },
    registry
  });
  assert.equal(bare503.saved, 0);
  assert.equal(bare503.accepted.length, 0);
  assert.equal(bare503Queries, 0);

  // Multi-price Pearl rows keep the labelled wholesale price but remain pending.
  const pearlQueries = [];
  const pearlPool = {
    async query(sql, params) {
      pearlQueries.push({ sql, params });
      if (sql.includes("reviewed_price_products")) return { rows: [], rowCount: 0 };
      if (sql.includes("SELECT product_identity_key")) return { rows: [], rowCount: 0 };
      if (sql.includes("SELECT 1 FROM price_observations")) return { rows: [], rowCount: 0 };
      if (sql.includes("INSERT INTO price_observations")) return { rows: [{ id: 92 }], rowCount: 1 };
      throw new Error("unexpected Pearl query");
    }
  };
  const pearl = await observe({
    pool: pearlPool,
    message: {
      chatId: -100123, messageId: 459, userId: 789,
      text: "بيرل 9 ك: 505.31 | جملة 487.40 | مستهلك 525"
    },
    registry
  });
  assert.equal(pearl.saved, 1);
  assert.equal(pearl.savedRows[0].row.package_sale_price, 487.40, "the monitor must save the explicitly labelled wholesale amount");
  assert.equal(pearl.savedRows[0].row.listed_base_price, 505.31, "the unlabelled amount must remain available for review");
  assert.equal(pearlQueries[2].params[18], 505.31, "the unlabelled amount must be persisted separately");
  assert.equal(pearlQueries[2].params[19], 487.4, "the explicit wholesale amount must be persisted separately");
  assert.match(pearlQueries[2].params[20], /explicit_wholesale_selected/);
  assert.equal(pearlQueries[2].params[21], true, "ambiguous companion columns must remain flagged for review");
  assert.equal(pearlQueries[2].params[22], 525, "consumer price must be persisted separately from the wholesale price");
  assert.match(pearlQueries[2].sql, /needs_review,consumer_price/, "observation insert must store the consumer price in its own column");
  assert.equal(pearl.savedRows[0].row.price_kind, "wholesale");
  assert.equal(pearl.savedRows[0].row.decision, "pending");
  assert.ok(pearl.savedRows[0].row.confidence < 0.8);
  assert.equal(pearlQueries.length, 3);

  // Full Pearl October catalog: test field-level correctness, not merely parser success.
  const pearlOctoberList = `أسعار بيرل – أكتوبر
..... أوتوماتيك
• 9 ك: 505.31 | جملة 487.40 | مستهلك 525
• 5 ك: 308.43 | جملة 915.87 | مستهلك 325
• 2.5 ك: 179.15 | جملة 716.63 | مستهلك 200
..... أوزان وشكاير
• شكارة 10 ك: 618.35 | مستهلك 630
• شكارة 7 ك: 432.84 | مستهلك 450
• 2 ك: 129.22 | جملة 516.90 | مستهلك 145
• 1.5 ك: 98.96 | جملة 395.85 | مستهلك 110
• 1 ك: 66.28 | جملة 265.15 | مستهلك 75
.. العبوات الصغيرة
• 290 جم: 22.03 | جملة 176.29 | مستهلك 25
• 160 جم: 12 | جملة 144.06 | مستهلك 15
• 120 جم: 8.46 | جملة 135.49 | مستهلك 10
• 50 جم: 3.96 | جملة 47.52 | مستهلك 5
• 30 جم: 3.79 | جملة 75.95 | مستهلك 5`;
  const pearlOctoberRows = extractPriceCandidates(pearlOctoberList);
  assert.equal(pearlOctoberRows.length, 13, "all 13 Pearl October rows must be extracted");
  assert.deepEqual(pearlOctoberRows.map(row => row.package_sale_price), [
    487.40, 915.87, 716.63, 618.35, 432.84, 516.90, 395.85, 265.15,
    176.29, 144.06, 135.49, 47.52, 75.95
  ], "package_sale_price must select the labelled wholesale price, or the only non-consumer amount when no wholesale label exists");
  assert.deepEqual(pearlOctoberRows.map(row => row.consumer_price), [
    525, 325, 200, 630, 450, 145, 110, 75, 25, 15, 10, 5, 5
  ], "consumer prices must be stored separately and never replace the wholesale observation");
  assert.deepEqual(pearlOctoberRows.slice(0, 3).map(row => row.listed_base_price), [505.31, 308.43, 179.15],
    "unlabelled amounts preceding explicit wholesale labels must be preserved separately");
  assert.deepEqual(pearlOctoberRows.map(row => row.weight_g), [
    9000, 5000, 2500, 10000, 7000, 2000, 1500, 1000, 290, 160, 120, 50, 30
  ], "every Pearl product size must be preserved independently of its price");
  assert.deepEqual(pearlOctoberRows.slice(3, 5).map(row => row.package_type), ["sack", "sack"],
    "the 10 kg and 7 kg sack rows must be recognized as sack packaging");
  assert.equal(pearlOctoberRows[3].pack_count, null,
    "missing sack/carton unit count must remain unknown, not cause the observation to be discarded");
  assert.ok(pearlOctoberRows.every(row => row.price_kind === "wholesale" || row.context_inferred_price_kind),
    "the wholesale column context must be carried to rows whose wholesale label is absent without changing their amount");

  // Verify the same full Pearl list persists every parsed field through the database write path.
  const pearlPersistedParams = [];
  const pearlDatabasePool = {
    async query(sql, params) {
      if (sql.includes("reviewed_price_products")) return { rows: [], rowCount: 0 };
      if (sql.includes("SELECT 1 FROM price_observations")) return { rows: [], rowCount: 0 };
      if (sql.includes("SELECT product_identity_key")) return { rows: [], rowCount: 0 };
      if (sql.includes("INSERT INTO price_observations")) {
        pearlPersistedParams.push(params);
        return { rows: [{ id: 100 + pearlPersistedParams.length }], rowCount: 1 };
      }
      throw new Error("unexpected full Pearl persistence query");
    }
  };
  const pearlPersisted = await observe({
    pool: pearlDatabasePool,
    message: { chatId: -100123, messageId: 464, userId: 789, text: pearlOctoberList },
    registry
  });
  assert.equal(pearlPersisted.saved, 13, "all thirteen Pearl rows must reach persistence without losing rows for missing pack counts");
  assert.deepEqual(pearlPersisted.savedRows.map(item => item.row.package_sale_price), [
    487.40, 915.87, 716.63, 618.35, 432.84, 516.90, 395.85, 265.15,
    176.29, 144.06, 135.49, 47.52, 75.95
  ], "the database-bound observations must retain the selected wholesale price in every row");
  assert.deepEqual(pearlPersisted.savedRows.map(item => item.row.consumer_price), [
    525, 325, 200, 630, 450, 145, 110, 75, 25, 15, 10, 5, 5
  ], "consumer prices must remain separately available on every persisted observation");
  assert.deepEqual(pearlPersistedParams.map(params => params[22]), [
    525, 325, 200, 630, 450, 145, 110, 75, 25, 15, 10, 5, 5
  ], "consumer prices must be passed to the dedicated database column for every row");
  assert.equal(pearlPersistedParams[3][15], "sack", "the 10 kg sack type must be persisted");
  assert.equal(pearlPersistedParams[3][9], 10000, "the 10 kg sack weight must be persisted");
  assert.equal(pearlPersistedParams[3][11], null, "unknown sack unit count must stay NULL in the database");
  assert.ok(pearlPersistedParams.every(params => params[13] === "pending"),
    "unreviewed catalog rows must remain pending rather than being silently auto-approved");

  // Re-processing the same Telegram message row must not create a second observation.
  let duplicateChecks = 0;
  let duplicateInserts = 0;
  const duplicatePool = {
    async query(sql) {
      if (sql.includes("reviewed_price_products")) return { rows: [], rowCount: 0 };
      if (sql.includes("SELECT 1 FROM price_observations")) {
        duplicateChecks += 1;
        return { rows: [{ "?column?": 1 }], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO price_observations")) {
        duplicateInserts += 1;
        return { rows: [{ id: 93 }], rowCount: 1 };
      }
      throw new Error("unexpected duplicate query");
    }
  };
  const duplicate = await observe({
    pool: duplicatePool,
    message: {
      chatId: -100123, messageId: 459, userId: 789,
      text: "بيرل 9 ك: 505.31 | جملة 487.40 | مستهلك 525"
    },
    registry
  });
  assert.equal(duplicate.saved, 0);
  assert.equal(duplicateChecks, 1);
  assert.equal(duplicateInserts, 0);

  // Explicit consumer/retail prices are ignored by the wholesale observation flow.
  let retailQueries = 0;
  const retail = await observe({
    pool: { async query() { retailQueries += 1; throw new Error("retail row should not be persisted"); } },
    message: { chatId: -100123, messageId: 460, text: "منظف معروف 30 جنيه مستهلك" },
    registry
  });
  assert.equal(retail.saved, 0);
  assert.equal(retail.accepted.length, 0);
  assert.equal(retailQueries, 0);

  // Caption-only price lists should be observed just like text messages.
  const captionQueries = [];
  const captionPool = {
    async query(sql) {
      captionQueries.push(sql);
      if (sql.includes("reviewed_price_products")) return { rows: [], rowCount: 0 };
      if (sql.includes("SELECT product_identity_key")) return { rows: [], rowCount: 0 };
      if (sql.includes("SELECT 1 FROM price_observations")) return { rows: [], rowCount: 0 };
      if (sql.includes("INSERT INTO price_observations")) return { rows: [{ id: 94 }], rowCount: 1 };
      throw new Error("unexpected caption query");
    }
  };
  const caption = await observe({
    pool: captionPool,
    message: {
      chatId: -100123, messageId: 461, userId: 789,
      text: "", caption: "بريكس ارضيات ٢٥ جم جملة ١٨.٧٥ ج"
    },
    registry
  });
  assert.equal(caption.saved, 1);
  assert.equal(caption.savedRows[0].row.package_sale_price, 18.75);
  assert.equal(captionQueries.length, 4);

  // An explicitly approved identity prevents repeated review for the same clear wholesale product.
  const { identityKey } = require("../modules/price-review");
  const identity = identityKey({ product_text: "منظف جديد", weight_g: 500, volume_ml: null, pack_count: null, brand_key: null });
  const reviewedProductPool = {
    async query(sql) {
      if (sql.includes("reviewed_price_products")) return { rows: [{ "?column?": 1 }], rowCount: 1 };
      if (sql.includes("SELECT product_identity_key")) return { rows: [], rowCount: 0 };
      if (sql.includes("SELECT 1 FROM price_observations")) return { rows: [], rowCount: 0 };
      if (sql.includes("INSERT INTO price_observations")) return { rows: [{ id: 95 }], rowCount: 1 };
      throw new Error("unexpected reviewed product query");
    }
  };
  assert.equal(identity.length, 64);
  const reviewed = await observe({
    pool: reviewedProductPool,
    message: { chatId: -100123, messageId: 462, text: "منظف جديد 500 جم جملة 22 ج" },
    registry: []
  });
  assert.equal(reviewed.saved, 1);
  assert.equal(reviewed.savedRows[0].row.decision, "accepted");

  // A previously approved product must reuse its identity memory when a later
  // seller post omits the word "جملة". This is the core repeat-observation path.
  const rememberedPool = {
    async query(sql) {
      if (sql.includes("reviewed_price_products")) return { rows: [{ "?column?": 1 }], rowCount: 1 };
      if (sql.includes("SELECT 1 FROM price_observations")) return { rows: [], rowCount: 0 };
      if (sql.includes("SELECT product_identity_key")) return { rows: [], rowCount: 0 };
      if (sql.includes("INSERT INTO price_observations")) return { rows: [{ id: 97 }], rowCount: 1 };
      throw new Error("unexpected remembered-product query");
    }
  };
  const remembered = await observe({
    pool: rememberedPool,
    message: { chatId: -100123, messageId: 463, text: "منظف جديد 500 جم 22 ج" },
    registry: []
  });
  assert.equal(remembered.saved, 1);
  assert.equal(remembered.savedRows[0].row.decision, "accepted",
    "previously approved product identities should not be sent back to review just because this post omits the wholesale label");
  assert.equal(remembered.savedRows[0].row.price_kind, "wholesale");
  assert.equal(remembered.savedRows[0].row.product_identity_key, productIdentityKey(remembered.savedRows[0].row),
    "when reviewer memory promotes a candidate to wholesale, the canonical history key must be recomputed too");

  // Reviewer memory must also be consulted for products matched by the registry.
  // A previously corrected Ariel identity should not be re-reviewed merely because
  // its next post omits the explicit wholesale word.
  const registryMemoryQueries = [];
  const registryRememberedPool = {
    async query(sql) {
      registryMemoryQueries.push(sql);
      if (sql.includes("reviewed_price_products")) return { rows: [{ "?column?": 1 }], rowCount: 1 };
      if (sql.includes("SELECT product_identity_key")) return { rows: [], rowCount: 0 };
      if (sql.includes("SELECT 1 FROM price_observations")) return { rows: [], rowCount: 0 };
      if (sql.includes("INSERT INTO price_observations")) return { rows: [{ id: 101 }], rowCount: 1 };
      throw new Error("unexpected registry-memory query");
    }
  };
  const registryRemembered = await observe({
    pool: registryRememberedPool,
    message: { chatId: -100123, messageId: 466, text: "أريال مسحوق 2 كجم 150 ج" },
    registry
  });
  assert.equal(registryRemembered.saved, 1);
  assert.equal(registryRemembered.savedRows[0].row.decision, "accepted",
    "reviewer identity memory must be honored even when the product registry matches");
  assert.ok(registryMemoryQueries.some(sql => sql.includes("reviewed_price_products")),
    "registry-matched products must still look up reviewer approval memory");
  assert.equal(registryRemembered.savedRows[0].row.product_identity_key, productIdentityKey(registryRemembered.savedRows[0].row),
    "registry-matched approval memory must also persist the canonical wholesale identity key");

  // Multi-product context can infer wholesale classification, but must not
  // auto-approve a brand-new identity without registry or prior approval.
  const contextual = extractPriceCandidates("منظف ألف 500 جم 22 ج\nمنظف باء 1 لتر 35 ج");
  assert.ok(contextual.length >= 2);
  const contextPool = {
    async query(sql) {
      if (sql.includes("reviewed_price_products")) return { rows: [], rowCount: 0 };
      if (sql.includes("SELECT product_identity_key")) return { rows: [], rowCount: 0 };
      if (sql.includes("SELECT 1 FROM price_observations")) return { rows: [], rowCount: 0 };
      if (sql.includes("INSERT INTO price_observations")) return { rows: [{ id: 98 }], rowCount: 1 };
      throw new Error("unexpected context query");
    }
  };
  const contextualObserved = await observe({
    pool: contextPool,
    message: { chatId: -100123, messageId: 464, text: "منظف ألف 500 جم 22 ج\nمنظف باء 1 لتر 35 ج" },
    registry: []
  });
  assert.ok(contextualObserved.accepted.every(row => row.price_kind === "wholesale"),
    "the message-level context should classify multiple unlabelled product prices as wholesale candidates");
  assert.ok(contextualObserved.savedRows.every(item => item.row.decision === "pending"),
    "context inference alone must not silently approve a brand-new product identity");


  // Pearl October regression test: the monitor must choose the explicitly labelled
  // wholesale amount, not the preceding base amount or the consumer amount.
  const pearlOctober = `أسعار بيرل – أكتوبر
..... أوتوماتيك
• 9 ك: 505.31 | جملة 487.40 | مستهلك 525
• 5 ك: 308.43 | جملة 915.87 | مستهلك 325
• 2.5 ك: 179.15 | جملة 716.63 | مستهلك 200
..... أوزان وشكاير
• شكارة 10 ك: 618.35 | مستهلك 630
• شكارة 7 ك: 432.84 | مستهلك 450
• 2 ك: 129.22 | جملة 516.90 | مستهلك 145
• 1.5 ك: 98.96 | جملة 395.85 | مستهلك 110
• 1 ك: 66.28 | جملة 265.15 | مستهلك 75
.. العبوات الصغيرة
• 290 جم: 22.03 | جملة 176.29 | مستهلك 25
• 160 جم: 12 | جملة 144.06 | مستهلك 15
• 120 جم: 8.46 | جملة 135.49 | مستهلك 10
• 50 جم: 3.96 | جملة 47.52 | مستهلك 5
• 30 جم: 3.79 | جملة 75.95 | مستهلك 5`;
  const pearlRows = extractPriceCandidates(pearlOctober);
  const pearlExpectedWholesale = [487.40, 915.87, 716.63, 618.35, 432.84, 516.90, 395.85, 265.15, 176.29, 144.06, 135.49, 47.52, 75.95];
  assert.equal(pearlRows.length, 13, "Pearl October list must preserve all 13 products");
  assert.deepEqual(pearlRows.map(row => row.package_sale_price), pearlExpectedWholesale,
    "each row must select its explicit wholesale price where present, or its listed price when no wholesale label exists");
  assert.equal(pearlRows[3].package_type, "sack", "10 kg sack must be preserved as a distinct package type");
  assert.equal(pearlRows[4].package_type, "sack", "7 kg sack must be preserved as a distinct package type");
  assert.equal(pearlRows[3].weight_g, 10000, "10 kg sack weight must be preserved");
  assert.equal(pearlRows[4].weight_g, 7000, "7 kg sack weight must be preserved");
  assert.deepEqual(pearlRows.slice(0, 3).map(row => row.listed_base_price), [505.31, 308.43, 179.15],
    "the unlabeled pre-wholesale amount must remain separate from the selected wholesale price");

  console.log("price monitor eligibility, extraction, persistence, captions, duplicate protection, retail exclusion, identity memory, context inference, and silent-mode tests: OK");
})().catch(error => { console.error(error); process.exitCode = 1; });
