// seeds/migrate-transaction-case-link.js
//
// Phase 5 of docs/43-CORE-ENTITY-LINKING-ROADMAP.md.
// Backfills Transaction.investigation.{case,caseId,flagged} from existing
// Case.linkedTransactions[]. Idempotent — re-sets the same values on re-run.
//
// Usage:
//   node seeds/migrate-transaction-case-link.js
//   node seeds/migrate-transaction-case-link.js --dry-run

require('dotenv').config({ path: './config/config.env' });
const mongoose = require('mongoose');

const DRY_RUN = process.argv.includes('--dry-run');
const log = (...a) => console.log('[migrate]', ...a);
const warn = (...a) => console.warn('[migrate] ⚠ ', ...a);
const ok = (...a) => console.log('[migrate] ✓', ...a);
const err = (...a) => console.error('[migrate] ✗', ...a);

async function run() {
  log(`connecting to MongoDB${DRY_RUN ? ' (DRY-RUN — no writes)' : ''}…`);
  await mongoose.connect(process.env.MONGO_URI);
  log('connected');

  const Case = require('../models/Case');
  const Transaction = require('../models/Transaction');
  const { linkTransactionsToCase } = require('../utils/transactionCaseLink');

  try {
    log('\n── Backfill Transaction.investigation.case from Case.linkedTransactions[] ──');
    const cases = await Case.find({
      isDeleted: { $ne: true },
      linkedTransactions: { $exists: true, $ne: [] },
    })
      .select('_id uid linkedTransactions')
      .lean();

    log(`   ${cases.length} case(s) with linked transactions`);

    let totalTxns = 0;
    let updated = 0;
    for (const c of cases) {
      const ids = (c.linkedTransactions || []).filter(Boolean);
      totalTxns += ids.length;
      if (DRY_RUN) continue;
      updated += await linkTransactionsToCase(ids, c);
    }

    if (DRY_RUN) {
      warn(`   (dry-run) would touch up to ${totalTxns} transaction link(s)`);
    } else {
      ok(`   updated ${updated} transaction(s) across ${cases.length} case(s)`);
    }

    log('\n── syncing Transaction indexes (builds investigation.case) ──');
    if (DRY_RUN) {
      warn('   (dry-run) skipping syncIndexes');
    } else {
      const r = await Transaction.syncIndexes();
      ok('   Transaction.syncIndexes:', JSON.stringify(r));
    }

    const linked = await Transaction.countDocuments({
      'investigation.case': { $exists: true, $ne: null },
    });
    const flagged = await Transaction.countDocuments({ 'investigation.flagged': true });
    log('\n══════════════ RECONCILIATION ══════════════');
    log(`   transactions with investigation.case set : ${linked}`);
    log(`   transactions flagged                     : ${flagged}`);
    log('═════════════════════════════════════════════');

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
