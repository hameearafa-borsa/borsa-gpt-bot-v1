"use strict";
const assert = require("node:assert/strict");
const { merchantKey } = require("../modules/merchant-intelligence");
assert.equal(merchantKey({ phone: "+201001234567" }), "+201001234567");
assert.equal(merchantKey({ name: "  محل  النور " }), "محل النور");
console.log("merchant tests: OK");
