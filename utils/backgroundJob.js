/**
 * utils/backgroundJob.js
 * ──────────────────────
 * Lightweight fire-and-forget helper for running async work after the HTTP
 * response has been sent — no external queue library required.
 *
 * Usage:
 *   const { runInBackground } = require("../utils/backgroundJob");
 *
 *   runInBackground("sumsub:pendingReview+aml", async () => {
 *     await requestPendingReview(applicantId);
 *     await triggerAmlCheck(customer);
 *   });
 *
 * Behaviour:
 *  • Uses setImmediate so work runs after the current event-loop tick (i.e.
 *    after res.json() has returned to Express internals).
 *  • Errors are caught and logged — they never propagate to the caller and
 *    never crash the process.
 *  • Logs [BG] <name> start / ✓ done / ✗ failed lines so jobs are traceable.
 */

const colors = require("colors");

/**
 * Run `fn` in the background after the current event-loop tick.
 *
 * @param {string}            name  — label used in log output
 * @param {() => Promise<*>}  fn    — async function to execute
 */
const runInBackground = (name, fn) => {
  setImmediate(async () => {
    console.log(`[BG] ${name} — started`.cyan);
    try {
      await fn();
      console.log(`[BG] ${name} — done ✓`.green);
    } catch (err) {
      console.error(`[BG] ${name} — failed ✗`.red, err.message);
    }
  });
};

module.exports = { runInBackground };
