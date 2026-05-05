// seeds/migrate-alert-case-schema.js
//
// Migrates the `alerts` and `cases` collections to the new schema shapes.
//
// ALERT changes:
//   1. Restore single `transaction` field (reverses any prior array migration)
//   2. Remove legacy fields: activityNote, settings
//   3. Fix activity sub-docs:  details  →  message
//   4. Backfill new field defaults: priority, slaStatus, isDeleted,
//      deletedAt, auditLogs, statusReason, closedAt
//   5. ruleVersion: coerce string → Number where needed
//   6. Sync indexes
//
// CASE changes:
//   1. assignedTo ([ObjectId])  →  assignedTo (ObjectId) — take first, null if empty
//   2. Remove legacy field: relatedEntities
//   3. Migrate flat SAR fields → nested sarReport object
//      (sarFiled → sarReport.filed, sarFiledAt → sarReport.filedAt, sarNotes → sarReport.notes)
//   4. Backfill new field defaults: caseType, tags, watchers, decision,
//      decisionNotes, decidedAt, decidedBy, isDeleted, deletedAt
//   5. Sync indexes
//
// Idempotent — safe to re-run.
//
// Usage:
//   node seeds/migrate-alert-case-schema.js
//   node seeds/migrate-alert-case-schema.js --dry-run

require('dotenv').config({ path: './config/config.env' });
const mongoose = require('mongoose');

const DRY_RUN = process.argv.includes('--dry-run');

// ─── tiny logger ─────────────────────────────────────────────────────────────
const log = (...args) => console.log('[migrate]', ...args);
const warn = (...args) => console.warn('[migrate] ⚠ ', ...args);
const ok = (...args) => console.log('[migrate] ✓', ...args);
const err = (...args) => console.error('[migrate] ✗', ...args);

// ─────────────────────────────────────────────────────────────────────────────
// ALERT MIGRATION
// ─────────────────────────────────────────────────────────────────────────────

async function migrateAlerts(db) {
  const coll = db.collection('alerts');

  log('\n══════════════════════════════════');
  log(' ALERTS');
  log('══════════════════════════════════');

  // ── Step A1: restore single `transaction` field (schema uses single ObjectId) ─
  // A previous migration run may have converted `transaction` → `transactions[]`.
  // This step reverses that: takes the first element of `transactions` back into
  // `transaction` and removes the `transactions` array field.
  log('\n[A1] restoring single `transaction` field (reverting any prior array migration)');
  const a1Filter = { transactions: { $exists: true } };
  const a1Count  = await coll.countDocuments(a1Filter);
  log(`     ${a1Count} document(s) still have a \`transactions\` array`);

  if (a1Count > 0) {
    if (DRY_RUN) {
      warn(`     (dry-run) would restore ${a1Count} document(s)`);
    } else {
      // Write the first element of `transactions` back into `transaction`
      const res = await coll.updateMany(a1Filter, [
        {
          $set: {
            transaction: {
              $cond: {
                if:   { $gt: [{ $size: { $ifNull: ['$transactions', []] } }, 0] },
                then: { $arrayElemAt: ['$transactions', 0] },
                else: null,
              },
            },
          },
        },
        { $unset: 'transactions' },
      ]);
      ok(`     restored ${res.modifiedCount} document(s)`);
    }
  } else {
    ok('     no `transactions` array found — skipping');
  }

  // ── Step A2: remove activityNote and settings fields ────────────────────────
  for (const field of ['activityNote', 'settings']) {
    log(`\n[A2] removing legacy field \`${field}\``);
    const cnt = await coll.countDocuments({ [field]: { $exists: true } });
    log(`     ${cnt} document(s) have this field`);
    if (cnt > 0) {
      if (DRY_RUN) {
        warn(`     (dry-run) would unset on ${cnt} document(s)`);
      } else {
        const res = await coll.updateMany({ [field]: { $exists: true } }, { $unset: { [field]: '' } });
        ok(`     unset on ${res.modifiedCount} document(s)`);
      }
    } else {
      ok('     field not present — skipping');
    }
  }

  // ── Step A3: activity sub-docs — details → message ───────────────────────────
  log('\n[A3] fixing activity entries: `details` → `message`');
  const a3Filter = { 'activity.details': { $exists: true } };
  const a3Count = await coll.countDocuments(a3Filter);
  log(`     ${a3Count} document(s) have activity entries with old 'details' field`);

  if (a3Count > 0) {
    if (DRY_RUN) {
      warn(`     (dry-run) would update ${a3Count} document(s)`);
    } else {
      // $rename doesn't support dynamic array paths, so use an aggregation pipeline:
      // For each activity entry that has `details`, move the value to `message`
      // (only if `message` isn't already set), then strip `details` from the object.
      const res = await coll.updateMany(a3Filter, [
        {
          $set: {
            activity: {
              $map: {
                input: '$activity',
                as: 'item',
                in: {
                  $mergeObjects: [
                    // Put the rename first so an existing `message` wins
                    {
                      $cond: {
                        if: { $ifNull: ['$$item.details', false] },
                        then: { message: '$$item.details' },
                        else: {},
                      },
                    },
                    // Strip `details` from the entry
                    {
                      $arrayToObject: {
                        $filter: {
                          input: { $objectToArray: '$$item' },
                          cond: { $ne: ['$$this.k', 'details'] },
                        },
                      },
                    },
                  ],
                },
              },
            },
          },
        },
      ]);
      ok(`     updated ${res.modifiedCount} document(s)`);
    }
  } else {
    ok('     no legacy `details` fields found — skipping');
  }

  // ── Step A4: backfill new field defaults ─────────────────────────────────────
  log('\n[A4] backfilling new field defaults');
  const a4Filter = {
    $or: [
      { priority: { $exists: false } },
      { slaStatus: { $exists: false } },
      { isDeleted: { $exists: false } },
      { deletedAt: { $exists: false } },
      { auditLogs: { $exists: false } },
      { statusReason: { $exists: false } },
    ],
  };
  const a4Count = await coll.countDocuments(a4Filter);
  log(`     ${a4Count} document(s) need backfill`);

  if (a4Count > 0) {
    if (DRY_RUN) {
      warn(`     (dry-run) would backfill ${a4Count} document(s)`);
    } else {
      const res = await coll.updateMany(a4Filter, [
        {
          $set: {
            priority: { $ifNull: ['$priority', 'medium'] },
            slaStatus: { $ifNull: ['$slaStatus', 'on_time'] },
            isDeleted: { $ifNull: ['$isDeleted', false] },
            deletedAt: { $ifNull: ['$deletedAt', null] },
            auditLogs: { $ifNull: ['$auditLogs', []] },
            statusReason: { $ifNull: ['$statusReason', null] },
            slaDeadline: { $ifNull: ['$slaDeadline', null] },
            closedAt: { $ifNull: ['$closedAt', null] },
            explanation: { $ifNull: ['$explanation', null] },
            ruleRef: { $ifNull: ['$ruleRef', null] },
          },
        },
      ]);
      ok(`     backfilled ${res.modifiedCount} document(s)`);
    }
  } else {
    ok('     nothing to backfill');
  }

  // ── Step A5: ruleVersion — coerce string → Number ───────────────────────────
  log('\n[A5] ruleVersion: coerce string → Number');
  const a5Filter = { ruleVersion: { $type: 'string' } };
  const a5Count = await coll.countDocuments(a5Filter);
  log(`     ${a5Count} document(s) have string ruleVersion`);

  if (a5Count > 0) {
    if (DRY_RUN) {
      warn(`     (dry-run) would coerce ${a5Count} document(s)`);
    } else {
      const res = await coll.updateMany(a5Filter, [
        {
          $set: {
            ruleVersion: { $toDouble: '$ruleVersion' },
          },
        },
      ]);
      ok(`     coerced ${res.modifiedCount} document(s)`);
    }
  } else {
    ok('     nothing to coerce');
  }

  // ── Step A6: sync indexes ────────────────────────────────────────────────────
  log('\n[A6] syncing indexes via Mongoose model');
  if (DRY_RUN) {
    warn('     (dry-run) skipping syncIndexes');
  } else {
    const Alert = require('../models/Alert');
    const result = await Alert.syncIndexes();
    ok('     syncIndexes result:', result);
  }

  ok('\nALERT migration complete.');
}

// ─────────────────────────────────────────────────────────────────────────────
// CASE MIGRATION
// ─────────────────────────────────────────────────────────────────────────────

async function migrateCases(db) {
  const coll = db.collection('cases');

  log('\n══════════════════════════════════');
  log(' CASES');
  log('══════════════════════════════════');

  // ── Step C1: assignedTo [] → single ObjectId ────────────────────────────────
  log('\n[C1] assignedTo ([ObjectId]) → assignedTo (ObjectId)');

  // Find docs where assignedTo is an array
  const c1Filter = { assignedTo: { $type: 'array' } };
  const c1Count = await coll.countDocuments(c1Filter);
  log(`     ${c1Count} document(s) have array assignedTo`);

  if (c1Count > 0) {
    if (DRY_RUN) {
      warn(`     (dry-run) would migrate ${c1Count} document(s)`);
    } else {
      // Take the first element; null if empty array
      const res = await coll.updateMany(c1Filter, [
        {
          $set: {
            assignedTo: {
              $cond: {
                if: { $gt: [{ $size: '$assignedTo' }, 0] },
                then: { $arrayElemAt: ['$assignedTo', 0] },
                else: null,
              },
            },
          },
        },
      ]);
      ok(`     migrated ${res.modifiedCount} document(s)`);
    }
  } else {
    ok('     already single ObjectId — skipping');
  }

  // ── Step C2: remove relatedEntities ─────────────────────────────────────────
  log('\n[C2] removing legacy field `relatedEntities`');
  const c2Count = await coll.countDocuments({ relatedEntities: { $exists: true } });
  log(`     ${c2Count} document(s) have this field`);
  if (c2Count > 0) {
    if (DRY_RUN) {
      warn(`     (dry-run) would unset on ${c2Count} document(s)`);
    } else {
      const res = await coll.updateMany(
        { relatedEntities: { $exists: true } },
        { $unset: { relatedEntities: '' } }
      );
      ok(`     unset on ${res.modifiedCount} document(s)`);
    }
  } else {
    ok('     field not present — skipping');
  }

  // ── Step C3: flat SAR fields → nested sarReport ──────────────────────────────
  log('\n[C3] migrating flat SAR fields → sarReport object');
  // Docs that still have the old flat fields
  const c3Filter = {
    $or: [
      { sarFiled: { $exists: true } },
      { sarFiledAt: { $exists: true } },
      { sarNotes: { $exists: true } },
    ],
  };
  const c3Count = await coll.countDocuments(c3Filter);
  log(`     ${c3Count} document(s) have legacy SAR fields`);

  if (c3Count > 0) {
    if (DRY_RUN) {
      warn(`     (dry-run) would migrate ${c3Count} document(s)`);
    } else {
      // Build sarReport from existing fields; keep any existing sarReport data
      const res = await coll.updateMany(c3Filter, [
        {
          $set: {
            sarReport: {
              filed: { $ifNull: ['$sarFiled', { $ifNull: ['$sarReport.filed', false] }] },
              filedAt: { $ifNull: ['$sarFiledAt', { $ifNull: ['$sarReport.filedAt', null] }] },
              referenceNumber: { $ifNull: ['$sarReport.referenceNumber', null] },
              notes: { $ifNull: ['$sarNotes', { $ifNull: ['$sarReport.notes', null] }] },
              reportData: { $ifNull: ['$sarReport.reportData', {}] },
            },
          },
        },
        {
          $unset: ['sarFiled', 'sarFiledAt', 'sarNotes'],
        },
      ]);
      ok(`     migrated ${res.modifiedCount} document(s)`);
    }
  } else {
    ok('     no legacy SAR fields found — skipping');
  }

  // Ensure sarReport exists on ALL case docs (backfill default)
  log('\n[C3b] backfilling sarReport default on docs without it');
  const c3bFilter = { sarReport: { $exists: false } };
  const c3bCount = await coll.countDocuments(c3bFilter);
  log(`      ${c3bCount} document(s) are missing sarReport`);
  if (c3bCount > 0 && !DRY_RUN) {
    const res = await coll.updateMany(c3bFilter, {
      $set: {
        sarReport: { filed: false, filedAt: null, referenceNumber: null, notes: null, reportData: {} },
      },
    });
    ok(`      backfilled ${res.modifiedCount} document(s)`);
  } else if (c3bCount > 0 && DRY_RUN) {
    warn(`      (dry-run) would backfill ${c3bCount} document(s)`);
  } else {
    ok('      all docs have sarReport — skipping');
  }

  // ── Step C4: backfill new field defaults ─────────────────────────────────────
  log('\n[C4] backfilling new field defaults');
  const c4Filter = {
    $or: [
      { caseType: { $exists: false } },
      { tags: { $exists: false } },
      { watchers: { $exists: false } },
      { decision: { $exists: false } },
      { decisionNotes: { $exists: false } },
      { decidedAt: { $exists: false } },
      { decidedBy: { $exists: false } },
      { isDeleted: { $exists: false } },
      { deletedAt: { $exists: false } },
    ],
  };
  const c4Count = await coll.countDocuments(c4Filter);
  log(`     ${c4Count} document(s) need backfill`);

  if (c4Count > 0) {
    if (DRY_RUN) {
      warn(`     (dry-run) would backfill ${c4Count} document(s)`);
    } else {
      const res = await coll.updateMany(c4Filter, [
        {
          $set: {
            caseType: { $ifNull: ['$caseType', null] },
            tags: { $ifNull: ['$tags', []] },
            watchers: { $ifNull: ['$watchers', []] },
            decision: { $ifNull: ['$decision', null] },
            decisionNotes: { $ifNull: ['$decisionNotes', null] },
            decidedAt: { $ifNull: ['$decidedAt', null] },
            decidedBy: { $ifNull: ['$decidedBy', null] },
            isDeleted: { $ifNull: ['$isDeleted', false] },
            deletedAt: { $ifNull: ['$deletedAt', null] },
          },
        },
      ]);
      ok(`     backfilled ${res.modifiedCount} document(s)`);
    }
  } else {
    ok('     nothing to backfill');
  }

  // ── Step C5: backfill decision for cases that have sarReport.filed = true ────
  log('\n[C5] backfill decision=sar_filed where SAR already filed');
  const c5Filter = { 'sarReport.filed': true, decision: { $in: [null, undefined] } };
  const c5Count = await coll.countDocuments(c5Filter);
  log(`     ${c5Count} document(s) need decision backfill`);
  if (c5Count > 0) {
    if (DRY_RUN) {
      warn(`     (dry-run) would update ${c5Count} document(s)`);
    } else {
      const res = await coll.updateMany(c5Filter, { $set: { decision: 'sar_filed' } });
      ok(`     updated ${res.modifiedCount} document(s)`);
    }
  } else {
    ok('     no docs need this backfill');
  }

  // ── Step C6: sync indexes ────────────────────────────────────────────────────
  log('\n[C6] syncing indexes via Mongoose model');
  if (DRY_RUN) {
    warn('     (dry-run) skipping syncIndexes');
  } else {
    const Case = require('../models/Case');
    const result = await Case.syncIndexes();
    ok('     syncIndexes result:', result);
  }

  ok('\nCASE migration complete.');
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

async function run() {
  log(`connecting to MongoDB${DRY_RUN ? ' (DRY-RUN — no writes)' : ''}…`);
  await mongoose.connect(process.env.MONGO_URI);
  log('connected\n');

  const db = mongoose.connection.db;

  try {
    await migrateAlerts(db);
    await migrateCases(db);

    log('\n══════════════════════════════════');
    log(` ALL DONE${DRY_RUN ? ' (dry-run — nothing written)' : ''}`);
    log('══════════════════════════════════\n');
  } finally {
    await mongoose.disconnect();
    log('disconnected');
  }
}

run().catch(async (e) => {
  err('migration failed:', e);
  try { await mongoose.disconnect(); } catch (_) { }
  process.exit(1);
});
