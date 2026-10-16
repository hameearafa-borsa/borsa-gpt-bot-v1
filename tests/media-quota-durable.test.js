"use strict";
const assert = require("node:assert/strict");
const { recordMediaQuota } = require("../modules/protection");

(async () => {
  const rows = new Map();
  const fakePool = {
    async query(sql, params) {
      if (/INSERT INTO media_quota_events/i.test(sql)) {
        const [chatId, userId, type, day, messageId, groupId] = params;
        const key = `${chatId}:${messageId}`;
        if (!rows.has(key)) rows.set(key, { chatId, userId, type, day, messageId, groupId });
        return { rowCount: rows.has(key) ? 1 : 0, rows: [] };
      }
      if (/SELECT COUNT\(\*\)::int AS count FROM media_quota_events/i.test(sql)) {
        const [chatId, userId, type, day] = params;
        const count = [...rows.values()].filter(r => String(r.chatId) === String(chatId) && String(r.userId) === String(userId) && r.type === type && r.day === day).length;
        return { rows: [{ count }] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };
  const base = { chatId: -1001, userId: 7, messageType: "photo", now: Date.UTC(2026, 0, 1, 12), photoLimit: 2, mediaGroupId: "album-A" };
  const first = await recordMediaQuota(fakePool, { ...base, messageId: 101 });
  assert.equal(first.count, 1);
  assert.equal(first.durable, true);
  const retry = await recordMediaQuota(fakePool, { ...base, messageId: 101 });
  assert.equal(retry.count, 1, "same Telegram message retry must not increment twice");
  const secondAlbumItem = await recordMediaQuota(fakePool, { ...base, messageId: 102 });
  assert.equal(secondAlbumItem.count, 2, "album items are counted individually under current policy");
  const exceeded = await recordMediaQuota(fakePool, { ...base, messageId: 103 });
  assert.equal(exceeded.exceeded, true);
  const otherUser = await recordMediaQuota(fakePool, { ...base, userId: 8, messageId: 104 });
  assert.equal(otherUser.count, 1);
  const video = await recordMediaQuota(fakePool, { ...base, messageType: "video", messageId: 105, videoLimit: 1 });
  assert.equal(video.count, 1);
  // Quota day follows Cairo's local calendar, not UTC date.
  const beforeMidnight = await recordMediaQuota(fakePool, { ...base, now: Date.UTC(2026,0,1,21,59,59), messageId: 106 });
  const afterMidnight = await recordMediaQuota(fakePool, { ...base, now: Date.UTC(2026,0,1,22,0,0), messageId: 107 });
  assert.equal(beforeMidnight.day, "2026-01-01");
  assert.equal(afterMidnight.day, "2026-01-02");
  assert.equal(afterMidnight.count, 1, "durable daily quota resets at Cairo midnight");
  const invalid = await recordMediaQuota(fakePool, { ...base, messageId: undefined });
  assert.equal(invalid.applicable, false);
  console.log("durable media quota tests: OK");
})().catch(err => { console.error(err); process.exit(1); });
