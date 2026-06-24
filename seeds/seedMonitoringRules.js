require("dotenv").config({ path: "./config/config.env" });

const mongoose = require("mongoose");
const MonitoringRule = require("../models/MonitoringRule");
const rules = require("../../seed/monitoring_rules.json");

// entity_types in JSON may be comma-separated OR pipe-separated
function parseEntityTypes(raw) {
  if (!raw) return [];
  const sep = raw.includes("|") ? "|" : ",";
  return raw.split(sep).map((s) => s.trim()).filter(Boolean);
}

async function seed() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("Connected to MongoDB");

  const ops = rules.map((r) => ({
    updateOne: {
      filter: { ruleId: r.rule_id || r.ruleId },
      update: {
        $set: {
          ruleId:         r.rule_id         || r.ruleId,
          ruleName:       r.rule_name       || r.ruleName,
          ruleCategory:   r.rule_category   || r.ruleCategory   || "",
          triggerLogic:   r.trigger_logic   || r.triggerLogic   || "",
          threshold:      String(r.threshold || ""),
          lookbackDays:   r.lookback_days != null ? parseInt(r.lookback_days) : null,
          entityTypes:    parseEntityTypes(r.entity_types || r.entityTypes),
          riskType:       r.risk_type       || r.riskType       || "",
          severity:       r.severity        || "",
          actionRequired: r.action_on_trigger || r.action_required || r.actionRequired || "",
          regulatoryRef:  r.regulatory_ref  || r.regulatoryRef  || "",
          active:         true,
        },
      },
      upsert: true,
    },
  }));

  const result = await MonitoringRule.bulkWrite(ops, { ordered: false });
  console.log(`Monitoring rules seeded: ${result.upsertedCount} inserted, ${result.modifiedCount} updated`);
  await mongoose.disconnect();
}

seed().catch((err) => { console.error(err); process.exit(1); });
