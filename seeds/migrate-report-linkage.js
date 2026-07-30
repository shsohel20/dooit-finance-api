// seeds/migrate-report-linkage.js
//
// Phase 2 of docs/43-CORE-ENTITY-LINKING-ROADMAP.md.
// Backfills the canonical linkage (Case = hub, Alert = provenance) onto EXISTING
// report/RFI documents created before the Phase 1/3 model+controller changes.
//
// Two situations:
//
//   A) REPURPOSED HUB FIELD  (EcddReport.caseId, SMR.caseId, RFI.case)
//      These fields used to be `ref: 'Alert'` and historically hold an ALERT _id.
//      For each legacy doc (its new `alert` field still unset):
//        • move the Alert id  →  `alert`        (provenance)
//        • set the hub field  →  alert.linkedCase (the owning Case, or null)
//        • backfill `customer` / `client` / `branch` from the Alert (or Case)
//
//   B) FRESH LINK FIELDS  (TTR, IFTI, GFS)
//      These never had a case/alert ref. Best-effort backfill:
//        • TTR — resolve `referenceNumber` (may be a Case.uid / Alert.uid)
//        • GFS — resolve `customer` from `customerUID` (Customer.uid)
//        • IFTI — no reliable source; reported only, link on next edit
//      Plus: ECDD CRA-origin rows (riskAssessment set, no alert) get `customer`
//      backfilled from the IndividualRiskAssessment.
//
// Idempotent — safe to re-run. Migrated docs drop out of each step's filter.
//
// Usage:
//   node seeds/migrate-report-linkage.js
//   node seeds/migrate-report-linkage.js --dry-run

require('dotenv').config({ path: './config/config.env' });
const mongoose = require('mongoose');

const DRY_RUN = process.argv.includes('--dry-run');

// ─── tiny logger ─────────────────────────────────────────────────────────────
const log = (...a) => console.log('[migrate]', ...a);
const warn = (...a) => console.warn('[migrate] ⚠ ', ...a);
const ok = (...a) => console.log('[migrate] ✓', ...a);
const err = (...a) => console.error('[migrate] ✗', ...a);

// ─── models / helpers ────────────────────────────────────────────────────────
const Case = require('../models/Case');
const Customer = require('../models/Customer');
const { resolveCaseLinkage } = require('../utils/resolveCaseLinkage');

const EcddReport = require('../models/EcddReport'); // hub: caseId  (repurposed)
const SMR = require('../models/SmrReport');         // hub: caseId  (repurposed)
const RFI = require('../models/Rfi');               // hub: case    (repurposed)
const TTR = require('../models/TtrReport');         // hub: case    (fresh)
const IFTI = require('../models/IftiReport');       // hub: case    (fresh)
const GFS = require('../models/gfsReport');         // hub: case    (fresh)

const REPORT_MODELS = [
  ['EcddReport', EcddReport, 'caseId'],
  ['SMR', SMR, 'caseId'],
  ['RFI', RFI, 'case'],
  ['TTR', TTR, 'case'],
  ['IFTI', IFTI, 'case'],
  ['GFS', GFS, 'case'],
];

// ─────────────────────────────────────────────────────────────────────────────
// A) Repurposed hub field (ECDD / SMR / RFI): Alert id → Case + alert provenance
// ─────────────────────────────────────────────────────────────────────────────
async function migrateRepurposed({ Model, label, hubField }) {
  log(`\n── ${label}: ${hubField} (legacy Alert id) → Case + alert provenance ──`);

  // Not-yet-migrated = `alert` unset/null but the hub field holds a value.
  const filter = {
    $and: [
      { $or: [{ alert: null }, { alert: { $exists: false } }] },
      { [hubField]: { $exists: true, $ne: null } },
    ],
  };
  const docs = await Model.find(filter).lean();
  log(`   ${docs.length} candidate doc(s)`);

  let toCase = 0, alertOnly = 0, alreadyCase = 0, orphan = 0;

  for (const doc of docs) {
    const legacyId = doc[hubField];
    const link = await resolveCaseLinkage({ alertId: legacyId });
    const set = {};

    if (link.alert) {
      // Hub held an Alert id → provenance, and hub becomes its Case (or null).
      set.alert = link.alert;
      set[hubField] = link.caseId || null;
      if (link.caseId) {
        set.caseNumber = link.caseNumber;
        toCase++;
      } else {
        alertOnly++; // alert wasn't escalated to a case
      }
      if (!doc.customer && link.customer) set.customer = link.customer;
      if (!doc.client && link.client) set.client = link.client;
      if (!doc.branch && link.branch) set.branch = link.branch;
    } else {
      // Not an Alert. Maybe it's already a Case id, or an orphan (deleted ref).
      const asCase = await Case.findById(legacyId)
        .select('_id uid client branch')
        .lean();
      if (asCase) {
        set[hubField] = asCase._id; // unchanged, but normalises caseNumber/tenant
        set.caseNumber = asCase.uid;
        if (!doc.client && asCase.client) set.client = asCase.client;
        if (!doc.branch && asCase.branch) set.branch = asCase.branch;
        alreadyCase++;
      } else {
        // Orphan: clear the hub (so it leaves this filter on re-run) + keep an audit crumb.
        set[hubField] = null;
        set['metadata.migratedLegacyHubId'] = String(legacyId);
        orphan++;
      }
    }

    if (Object.keys(set).length && !DRY_RUN) {
      await Model.updateOne({ _id: doc._id }, { $set: set });
    }
  }

  ok(
    `   linked→Case: ${toCase} | alert-only(no case yet): ${alertOnly} | ` +
    `already-Case: ${alreadyCase} | orphan-cleared: ${orphan}${DRY_RUN ? ' (dry-run)' : ''}`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// B1) ECDD CRA-origin: backfill customer from the IndividualRiskAssessment
// ─────────────────────────────────────────────────────────────────────────────
async function migrateEcddCra() {
  log('\n── ECDD: CRA-origin customer backfill (from riskAssessment) ──');
  const IndividualRiskAssessment = require('../models/IndividualRiskAssessment');

  const filter = {
    $and: [
      { riskAssessment: { $exists: true, $ne: null } },
      { $or: [{ customer: null }, { customer: { $exists: false } }] },
    ],
  };
  const docs = await EcddReport.find(filter).lean();
  log(`   ${docs.length} candidate doc(s)`);

  let linked = 0;
  for (const doc of docs) {
    const cra = await IndividualRiskAssessment.findById(doc.riskAssessment)
      .select('customer client branch')
      .lean();
    if (!cra || !cra.customer) continue;
    const set = { customer: cra.customer };
    if (!doc.client && cra.client) set.client = cra.client;
    if (!doc.branch && cra.branch) set.branch = cra.branch;
    if (!DRY_RUN) await EcddReport.updateOne({ _id: doc._id }, { $set: set });
    linked++;
  }
  ok(`   ${linked} doc(s) customer backfilled from CRA${DRY_RUN ? ' (dry-run)' : ''}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// B2) TTR: backfill case/alert from referenceNumber
// ─────────────────────────────────────────────────────────────────────────────
async function migrateTtrByReference() {
  log('\n── TTR: backfill case/alert from referenceNumber ──');
  const filter = {
    $and: [
      { $or: [{ alert: null }, { alert: { $exists: false } }] },
      { $or: [{ case: null }, { case: { $exists: false } }] },
      { referenceNumber: { $exists: true, $nin: [null, ''] } },
    ],
  };
  const docs = await TTR.find(filter).lean();
  log(`   ${docs.length} candidate doc(s)`);

  let linked = 0;
  for (const doc of docs) {
    const link = await resolveCaseLinkage({ caseNumber: doc.referenceNumber });
    if (!link.caseId && !link.alert) continue; // referenceNumber is a free string
    const set = {};
    if (link.caseId) set.case = link.caseId;
    if (link.alert) set.alert = link.alert;
    if (!doc.customer && link.customer) set.customer = link.customer;
    if (!doc.client && link.client) set.client = link.client;
    if (!doc.branch && link.branch) set.branch = link.branch;
    if (Object.keys(set).length && !DRY_RUN) {
      await TTR.updateOne({ _id: doc._id }, { $set: set });
    }
    linked++;
  }
  ok(`   ${linked} doc(s) linked from referenceNumber${DRY_RUN ? ' (dry-run)' : ''}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// B3) GFS: backfill customer from customerUID
// ─────────────────────────────────────────────────────────────────────────────
async function migrateGfsCustomer() {
  log('\n── GFS: backfill customer from customerUID ──');
  const filter = {
    $and: [
      { $or: [{ customer: null }, { customer: { $exists: false } }] },
      { customerUID: { $exists: true, $nin: [null, ''] } },
    ],
  };
  const docs = await GFS.find(filter).lean();
  log(`   ${docs.length} candidate doc(s)`);

  let linked = 0;
  for (const doc of docs) {
    const cust = await Customer.findOne({ uid: doc.customerUID }).select('_id').lean();
    if (!cust) continue;
    if (!DRY_RUN) await GFS.updateOne({ _id: doc._id }, { $set: { customer: cust._id } });
    linked++;
  }
  ok(`   ${linked} doc(s) linked to Customer${DRY_RUN ? ' (dry-run)' : ''}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// B4) IFTI: no reliable automatic source — report only
// ─────────────────────────────────────────────────────────────────────────────
async function reportIfti() {
  log('\n── IFTI: link audit (no automatic backfill source) ──');
  const total = await IFTI.countDocuments({});
  const unlinked = await IFTI.countDocuments({
    $and: [
      { $or: [{ case: null }, { case: { $exists: false } }] },
      { $or: [{ alert: null }, { alert: { $exists: false } }] },
    ],
  });
  if (unlinked > 0) {
    warn(`   ${unlinked}/${total} IFTI doc(s) unlinked — embeds customer data only; link via case/alert on next edit.`);
  } else {
    ok(`   all ${total} IFTI doc(s) linked`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Index sync + reconciliation
// ─────────────────────────────────────────────────────────────────────────────
async function syncAllIndexes() {
  log('\n── syncing indexes (Mongoose models) ──');
  if (DRY_RUN) return warn('   (dry-run) skipping syncIndexes');
  for (const [label, M] of REPORT_MODELS) {
    try {
      const r = await M.syncIndexes();
      ok(`   ${label}:`, JSON.stringify(r));
    } catch (e) {
      warn(`   ${label} syncIndexes failed: ${e.message}`);
    }
  }
}

async function reconcile() {
  log('\n══════════════ RECONCILIATION ══════════════');
  for (const [label, M, hub] of REPORT_MODELS) {
    const total = await M.countDocuments({});
    const withCase = await M.countDocuments({ [hub]: { $exists: true, $ne: null } });
    const withAlert = await M.countDocuments({ alert: { $exists: true, $ne: null } });
    const withCustomer = await M.countDocuments({ customer: { $exists: true, $ne: null } });
    log(
      `   ${label.padEnd(11)} total=${String(total).padEnd(5)} ` +
      `case=${String(withCase).padEnd(5)} alert=${String(withAlert).padEnd(5)} customer=${withCustomer}`
    );
  }
  log('═════════════════════════════════════════════');
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────
async function run() {
  log(`connecting to MongoDB${DRY_RUN ? ' (DRY-RUN — no writes)' : ''}…`);
  await mongoose.connect(process.env.MONGO_URI);
  log('connected');

  try {
    // A) repurposed hub fields
    await migrateRepurposed({ Model: EcddReport, label: 'ECDD', hubField: 'caseId' });
    await migrateRepurposed({ Model: SMR, label: 'SMR', hubField: 'caseId' });
    await migrateRepurposed({ Model: RFI, label: 'RFI', hubField: 'case' });

    // B) fresh / best-effort
    await migrateEcddCra();
    await migrateTtrByReference();
    await migrateGfsCustomer();
    await reportIfti();

    await syncAllIndexes();
    await reconcile();

    log(`\n══ ALL DONE${DRY_RUN ? ' (dry-run — nothing written)' : ''} ══\n`);
  } finally {
    await mongoose.disconnect();
    log('disconnected');
  }
}

run().catch(async (e) => {
  err('migration failed:', e);
  try { await mongoose.disconnect(); } catch (_) { /* noop */ }
  process.exit(1);
});
