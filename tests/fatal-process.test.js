"use strict";
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { installFatalProcessHandlers } = require("../core/fatal-process");

async function exercise(eventName, reason, reportFails = false) {
  const processRef = new EventEmitter();
  const events = [];
  let exitCode = null;
  const timers = new Map();
  let timerId = 0;
  const remove = installFatalProcessHandlers({
    processRef,
    reportFatal: async (stage, error) => {
      events.push(["report", stage, error.message]);
      if (reportFails) throw new Error("report unavailable");
    },
    shutdown: async signal => { events.push(["shutdown", signal]); },
    exit: code => { exitCode = code; events.push(["exit", code]); },
    setTimer: fn => { const id = ++timerId; timers.set(id, fn); return id; },
    clearTimer: id => timers.delete(id),
  });
  processRef.emit(eventName, reason);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(exitCode, 1, `${eventName} must terminate non-zero`);
  assert.equal(events.filter(e => e[0] === "report").length, 1);
  assert.equal(events.filter(e => e[0] === "shutdown").length, 1);
  assert.equal(events.at(-1)[0], "exit");
  assert.equal(timers.size, 0, "grace timer cleared after shutdown");
  remove();
}

(async () => {
  await exercise("unhandledRejection", new Error("rejected"));
  await exercise("uncaughtException", new Error("uncaught"));
  await exercise("unhandledRejection", new Error("report failed"), true);
  console.log("Fatal process lifecycle tests: OK");
})().catch(error => { console.error(error); process.exitCode = 1; });
