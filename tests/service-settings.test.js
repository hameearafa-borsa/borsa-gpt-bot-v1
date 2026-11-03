"use strict";
const assert = require("node:assert/strict");
const { SERVICES, getSettings, setServiceSetting, isServiceEnabled, listOwnedGroups } = require("../core/service-settings");

const pool = { query: async (sql, params=[]) => {
  if (sql.includes("SELECT service_key, enabled")) return { rows: [{service_key:"chemical",enabled:false}] };
  if (sql.includes("INSERT INTO service_settings")) return { rows: [{service_key:params[2],enabled:params[3]}] };
  if (sql.includes("SELECT scope,enabled")) {
    return params[1] === -100123
      ? { rows: [{scope:"global",enabled:true},{scope:"group",enabled:false}] }
      : { rows: [{scope:"global",enabled:true}] };
  }
  if (sql.includes("owner_user_id=$1")) return { rows: [{chat_id:-100123,chat_type:"supergroup",owner_user_id:77}] };
  return { rows: [] };
}};
(async () => {
  assert.equal(SERVICES.length,9);
  const group = await getSettings(pool,"group",-100123);
  assert.equal(group.find(x=>x.key==="chemical").enabled,false);
  assert.equal(group.find(x=>x.key==="deals").enabled,true);
  const global = await getSettings(pool,"global",0);
  assert.equal(global.length,9);
  const saved = await setServiceSetting(pool,{scope:"group",chatId:-100123,serviceKey:"prices",enabled:false,actorId:77});
  assert.equal(saved.enabled,false);
  assert.equal(await isServiceEnabled(pool,"prices",-100123),false);
  assert.equal(await isServiceEnabled(pool,"prices",-100999),true);
  assert.equal((await listOwnedGroups(pool,77)).length,1);
  await assert.rejects(()=>setServiceSetting(pool,{scope:"group",chatId:123,serviceKey:"prices",enabled:false}),/INVALID_SERVICE_SETTING_SCOPE/);
  await assert.rejects(()=>setServiceSetting(pool,{scope:"global",serviceKey:"prices",enabled:"false"}),/SETTING_VALUE_MUST_BE_BOOLEAN/);
  console.log("persistent scoped service settings tests: OK");
})().catch(error=>{ console.error(error); process.exitCode=1; });
