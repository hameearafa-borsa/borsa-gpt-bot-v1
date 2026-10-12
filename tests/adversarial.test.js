"use strict";
const assert = require("node:assert/strict");
const { extractPriceCandidates, commercialMetrics } = require("../modules/price-intelligence");
const { isEligibleMessage } = require("../modules/price-monitor");
const { deterministicType } = require("../core/gpt-core");
const { isMaster, isLogChat } = require("../core/permissions");
const { safetyGate } = require("../modules/chemical-assistant");

// 1) Numeric garbage must not become a product.
const garbage = extractPriceCandidates("505.31 487.40 525");
assert.equal(garbage.length, 0);

// 2) Retail-only lines are rejected.
assert.equal(extractPriceCandidates("بريكس 1 لتر مستهلك 55 ج").length, 0);

// 3) Package price remains primary when weight changes.
const a = extractPriceCandidates("مسحوق X 2 كجم 100ج")[0];
const b = extractPriceCandidates("مسحوق X 2.5 كجم 110ج")[0];
assert.equal(commercialMetrics(a).package_sale_price, 100);
assert.equal(commercialMetrics(b).package_sale_price, 110);
assert.notEqual(a.weight_g, b.weight_g);

// 4) Extra-weight offer is a separate commercial state.
const offer = extractPriceCandidates("مسحوق X 2 كجم + 500 جم 110ج")[0];
assert.equal(offer.offer_extra_weight_g, 500);
assert.equal(commercialMetrics(offer).effective_weight_g, 2500);

// 5) Self messages and log channel never enter the monitor.
assert.equal(isEligibleMessage({ chatType:"supergroup", text:"بريكس 1 كجم 50ج", isLogChannel:false, isCommand:false, ownMessage:true }), false);
assert.equal(isEligibleMessage({ chatType:"supergroup", text:"بريكس 1 كجم 50ج", isLogChannel:true, isCommand:false, ownMessage:false }), false);

// 6) Chemical routing is deterministic and does not require an AI call.
assert.equal(deterministicType("هل يجوز خلط الكلور مع المطهر؟"), "chemical");

// 7) Chemical safety rules override AI.
assert.match(safetyGate("هل أخلط الكلور مع حمض؟"), /تحذير سلامة/);
assert.equal(safetyGate("ما وظيفة مادة غير معروفة؟"), null);

// 8) Only the master is a permanent global authority in this foundation.
assert.equal(isMaster(5256328556), true);
assert.equal(isMaster(123456789), false);
assert.equal(isLogChat(-1004344288353), true);

console.log("adversarial tests: OK");
