"use strict";

const assert = require("node:assert/strict");
const { isMaster, isLogChat } = require("../core/permissions");
const { fingerprint } = require("../core/diagnostics");

assert.equal(isMaster(5256328556), true);
assert.equal(isMaster("5256328556"), true);
assert.equal(isLogChat(-1004344288353), true);
assert.equal(isLogChat(4344288353), false);
assert.equal(fingerprint("abc").length, 16);

console.log("foundation tests: OK");
