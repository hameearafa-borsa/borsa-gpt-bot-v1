"use strict";
const assert = require("node:assert/strict");
const { formatProviderError } = require("../core/ai");

const result = formatProviderError(400, {
  code: "invalid_request_error",
  type: "test_error",
  param: "temperature",
  message: "Synthetic invalid parameter"
});
assert.match(result, /AI HTTP 400/);
assert.match(result, /code=invalid_request_error/);
assert.match(result, /type=test_error/);
assert.match(result, /param=temperature/);
assert.match(result, /Synthetic invalid parameter/);

const secret = "sk-test-12345678901234567890";
const redacted = formatProviderError(400, {
  code: "test_error",
  message: "Synthetic failure with key " + secret
});
assert.equal(redacted.includes(secret), false);
console.log("AI error diagnostics tests: OK");
