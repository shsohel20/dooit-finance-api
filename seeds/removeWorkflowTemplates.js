/**
 * removeWorkflowTemplates.js — delete the seeded Workflow Studio templates
 *
 * The inverse of seeds/workflowTemplates.js. Removes the system templates that
 * seed created, and their version snapshots.
 *
 *   node seeds/removeWorkflowTemplates.js              # DRY RUN — prints, deletes nothing
 *   node seeds/removeWorkflowTemplates.js --yes        # actually delete
 *   node seeds/removeWorkflowTemplates.js --yes --all-system
 *                                                      # also delete system templates
 *                                                      # this seed did not create
 *
 * Scope, deliberately narrow by default:
 *   - Only `client: null` documents. A client's own workflows are never
 *     touched, including copies made from a template via "Use this template" —
 *     those are client-owned and are somebody's work.
 *   - Only the workflowIds this seed defines, read from the seed module itself
 *     so the two can never drift apart.
 *
 * Deleting is hard. Dry run is the default for that reason: run it once, read
 * what it says it will remove, then re-run with --yes.
 */

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../config/config.env") });
const mongoose = require("mongoose");
// `colors` patches String.prototype; config/db.js logs through it.
require("colors");
const { connectDB } = require("../config/db");
const Workflow = require("../models/Workflow");
const WorkflowVersion = require("../models/WorkflowVersion");
const seedModule = require("./workflowTemplates");

const APPLY = process.argv.includes("--yes");
const ALL_SYSTEM = process.argv.includes("--all-system");

/** The exact ids this seed creates — derived, never hardcoded twice. */
const seededIds = () => {
  const ids = [seedModule.DOOIT_FULL_FLOW.workflowId];
  for (const row of seedModule.STUBS || []) ids.push(row[0]);
  return ids;
};

const removeWorkflowTemplates = async () => {
  const filter = ALL_SYSTEM
    ? { client: null }
    : { client: null, workflowId: { $in: seededIds() } };

  const docs = await Workflow.find(filter).select("workflowId name status").lean();

  if (!docs.length) {
    console.log("Nothing to remove — no matching system templates found.");
    return;
  }

  console.log(`${APPLY ? "Deleting" : "Would delete"} ${docs.length} workflow(s):`);
  for (const d of docs) {
    console.log(`  ${d.workflowId}  ${d.name}  [${d.status}]`);
  }

  const versionFilter = { workflow: { $in: docs.map((d) => d._id) } };
  const versionCount = await WorkflowVersion.countDocuments(versionFilter);
  console.log(`${APPLY ? "Deleting" : "Would delete"} ${versionCount} version snapshot(s).`);

  if (!APPLY) {
    console.log("\nDRY RUN — nothing was changed. Re-run with --yes to apply.");
    return;
  }

  // Snapshots first: if the workflow delete fails, orphaned history is worse
  // than history for a document that still exists.
  const v = await WorkflowVersion.deleteMany(versionFilter);
  const w = await Workflow.deleteMany(filter);
  console.log(`Deleted ${w.deletedCount} workflow(s) and ${v.deletedCount} snapshot(s).`);
};

module.exports = removeWorkflowTemplates;

if (require.main === module) {
  (async () => {
    await connectDB();
    await removeWorkflowTemplates();
    await mongoose.disconnect();
    process.exit(0);
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
