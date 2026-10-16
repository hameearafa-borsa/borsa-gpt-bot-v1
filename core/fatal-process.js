"use strict";

/** Install fail-closed handlers for process-level failures.
 * A process with an uncaught exception or unhandled rejection must not keep
 * serving updates in an unknown state. Reporting and shutdown are best-effort;
 * the process exits non-zero even if either operation fails.
 */
function installFatalProcessHandlers({ processRef = process, reportFatal, shutdown, exit = code => processRef.exit(code), timeoutMs = 10_000, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (typeof reportFatal !== "function" || typeof shutdown !== "function") {
    throw new TypeError("installFatalProcessHandlers requires reportFatal and shutdown");
  }
  let handling = false;

  async function handle(stage, error) {
    if (handling) return;
    handling = true;
    const timer = setTimer(() => exit(1), timeoutMs);
    try {
      try { await reportFatal(stage, error); }
      catch (reportError) {
        console.error(`[FATAL_REPORT_FAILED] ${stage}:`, reportError?.message || reportError);
      }
      try { await shutdown(`FATAL_${stage}`); }
      catch (shutdownError) {
        console.error(`[FATAL_SHUTDOWN_FAILED] ${stage}:`, shutdownError?.message || shutdownError);
      }
    } finally {
      clearTimer(timer);
      exit(1);
    }
  }

  const onRejection = reason => { void handle("unhandledRejection", reason instanceof Error ? reason : new Error(String(reason))); };
  const onException = error => { void handle("uncaughtException", error instanceof Error ? error : new Error(String(error))); };
  processRef.on("unhandledRejection", onRejection);
  processRef.on("uncaughtException", onException);
  return () => {
    processRef.removeListener("unhandledRejection", onRejection);
    processRef.removeListener("uncaughtException", onException);
  };
}

module.exports = { installFatalProcessHandlers };
