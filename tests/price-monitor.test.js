"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { isOwnMessage, isEligibleMessage, isBulkPriceList, observe } = require("../modules/price-monitor");
const registry = require("../data/product-registry.json");

(async () => {
  const base = { chatType: "supergroup", text: "بريكس ارضيات ٢٥ جم جملة ١٨.٧٥ ج" };
  assert.equal(isEligibleMessage({ ...base, isLogChannel: false, isCommand: false, ownMessage: false }), true);
  assert.equal(isEligibleMessage({ ...base, chatType: "private", isLogChannel: false, isCommand: false, ownMessage: false }), false);
  assert.equal(isEligibleMessage({ ...base, isLogChannel: true, isCommand: false, ownMessage: false }), false);
  assert.equal(isEligibleMessage({ ...base, isLogChannel: false, isCommand: true, ownMessage: false }), false);
  assert.equal(isEligibleMessage({ ...base, isLogChannel: false, isCommand: false, ownMessage: true }), false);
  const unileverList = fs.readFileSync(path.join(__dirname, "fixtures-unilever-oct-2026.txt"), "utf8");
  assert.equal(isBulkPriceList(unileverList), true, "a long Unilever price list is a catalog, not one ordinary price observation");
  assert.equal(isEligibleMessage({ ...base, text: unileverList, isLogChannel: false, isCommand: false, ownMessage: false }), false,
    "bulk price lists must not generate dozens of individual review messages");
  assert.equal(isBulkPriceList(base.text), false, "a single product price remains eligible");
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
  assert.equal(isOwnMessage({ botUserId: 123, fromId: "123" }), true);
  assert.equal(isOwnMessage({ botUserId: 123, fromId: 456 }), false);

  const savedQueries = [];
  const pool = {
    async query(sql, params) {
      savedQueries.push({ sql, params });
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
  assert.equal(savedQueries.length, 3);
  assert.ok(savedQueries[2].sql.includes("INSERT INTO price_observations"));
  assert.ok(savedQueries[2].sql.includes("product_text"));
  assert.ok(savedQueries[2].sql.includes("offer_extra_weight_g"));
  assert.equal(savedQueries[2].params[13], "accepted");

  // Historical accepted observations are compared before insertion, without posting a chat message.
  let historyInsertParams = null;
  const historyPool = {
    async query(sql, params) {
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
  assert.equal(savedQueries.length, 5);

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
  assert.equal(pearl.savedRows[0].row.price_kind, "wholesale");
  assert.equal(pearl.savedRows[0].row.decision, "pending");
  assert.ok(pearl.savedRows[0].row.confidence < 0.8);
  assert.equal(pearlQueries.length, 2);

  // Re-processing the same Telegram message row must not create a second observation.
  let duplicateChecks = 0;
  let duplicateInserts = 0;
  const duplicatePool = {
    async query(sql) {
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
  assert.equal(captionQueries.length, 3);

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

  console.log("price monitor eligibility, extraction, persistence, captions, duplicate protection, retail exclusion, and silent-mode tests: OK");
})().catch(error => { console.error(error); process.exitCode = 1; });
