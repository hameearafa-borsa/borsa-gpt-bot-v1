"use strict";
const assert = require("node:assert/strict");
process.env.OWNER_ID = "777,888";
const permissions = require("../core/permissions");

assert.equal(permissions.isMaster(permissions.MASTER_ID), true, "fixed bot owner retains global administration");
assert.equal(permissions.isMaster("777"), false, "review operator must not become bot owner");
assert.equal(permissions.isMaster("888"), false, "additional review operator must not become bot owner");
assert.equal(permissions.isReviewOperator(777), true);
assert.equal(permissions.isReviewOperator("888"), true);
assert.equal(permissions.isReviewOperator(999), false);
assert.equal(permissions.authorizedUserIds().has(permissions.MASTER_ID), true);
assert.equal(permissions.authorizedUserIds().has(777), true);

(async () => {
  const telegram = {
    getChatAdministrators: async chatId => [{ status: "creator", user: { id: chatId === -100123 ? 999 : 1000 } }]
  };
  assert.equal(await permissions.canManage(telegram, -100123, permissions.MASTER_ID), true);
  assert.equal(await permissions.canManage(telegram, -100123, 999), true, "group creator manages their own group");
  assert.equal(await permissions.canManage(telegram, -100123, 777), false, "price reviewer cannot manage another group's settings");
  assert.equal(await permissions.canManage(telegram, -100123, 1000), false, "different group's creator cannot manage this group");
  console.log("permission separation tests: OK");
})().catch(error => { console.error(error); process.exitCode = 1; });
