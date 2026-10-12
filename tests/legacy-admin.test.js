"use strict";
const assert = require("node:assert/strict");
const { recordActivity, addWarning, listWarnings, clearWarnings, listInactive } = require("../modules/legacy-admin");
(async()=>{
 const calls=[];
 const pool={query:async(sql,params=[])=>{calls.push({sql,params}); if(sql.includes("COUNT(*)"))return {rows:[{count:3}]}; if(sql.includes("RETURNING id,created_at"))return {rows:[{id:8,created_at:new Date()}]}; if(sql.includes("SELECT id,reason"))return {rows:[{id:8,reason:"تكرار مزعج",issued_by:5,created_at:new Date()}]}; if(sql.includes("UPDATE member_warnings"))return {rowCount:2}; if(sql.includes("FROM member_activity"))return {rows:[{user_id:7,inactive_days:45,message_count:10}]}; return {rows:[],rowCount:1};}};
 assert.equal(await recordActivity(pool,{chatId:-1001,userId:7,username:"test",displayName:"عضو"}),true);
 const warning=await addWarning(pool,{chatId:-1001,userId:7,issuedBy:5,reason:"تكرار مزعج"});
 assert.equal(warning.count,3); assert.equal(warning.id,8);
 assert.equal((await listWarnings(pool,-1001,7)).length,1);
 assert.equal(await clearWarnings(pool,{chatId:-1001,userId:7,clearedBy:5}),2);
 assert.equal((await listInactive(pool,-1001,30,20))[0].inactive_days,45);
 assert.ok(calls.every(c=>!c.sql.includes("DROP TABLE")));
 console.log("legacy activity + warning workflow tests: OK");
})().catch(e=>{console.error(e);process.exit(1)});
