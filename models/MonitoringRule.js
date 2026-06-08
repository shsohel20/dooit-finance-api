const mongoose = require("mongoose");
const mongoosePaginate = require("mongoose-paginate-v2");

const MonitoringRuleSchema = new mongoose.Schema(
  {
    ruleId:        { type: String, required: true, unique: true, trim: true },
    ruleName:      { type: String, required: true, trim: true },
    ruleCategory:  { type: String, trim: true, default: "" },
    triggerLogic:  { type: String, trim: true, default: "" },
    threshold:     { type: String, default: "" },
    lookbackDays:  { type: Number, default: null },
    entityTypes:   [{ type: String }],
    riskType:      {
      type: String,
      enum: ["AML","CTF","SANCTIONS","FRAUD","ABAC","MODERN_SLAVERY","PROLIFERATION",""],
      default: "",
    },
    severity:      {
      type: String,
      enum: ["Critical","High","Medium","Low",""],
      default: "",
    },
    actionRequired: { type: String, default: "" },
    regulatoryRef:  { type: String, default: "" },
    active:         { type: Boolean, default: true, index: true },
    client:         { type: mongoose.Schema.ObjectId, ref: "Client", default: null },
  },
  { timestamps: true }
);

MonitoringRuleSchema.index({ ruleCategory: 1, active: 1 });
MonitoringRuleSchema.plugin(mongoosePaginate);

module.exports = mongoose.model("MonitoringRule", MonitoringRuleSchema);
