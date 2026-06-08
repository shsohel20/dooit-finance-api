const mongoose = require("mongoose");

const NotificationRuleSchema = new mongoose.Schema(
  {
    notifId:           { type: String, required: true, unique: true, trim: true },
    notifName:         { type: String, required: true, trim: true },
    triggerEvent:      { type: String, required: true, trim: true },
    urgency:           { type: String, enum: ["Routine","Urgent","Critical"], default: "Routine" },
    audience:          [{ type: String }],
    notifCategory:     { type: String, trim: true, default: "" },
    bodyTemplate:      { type: String, default: "" },
    actionButtonLabel: { type: String, default: "" },
    actionDestination: { type: String, default: "" },
    deliveryChannels:  [{ type: String, enum: ["in_app","email","sms"] }],
    active:            { type: Boolean, default: true },
    repeating:         { type: Boolean, default: false },
    repeatIntervalDays:{ type: Number, default: null },
    // T1/T2 applicability
    entityTypes:       [{ type: String }],
  },
  { timestamps: true }
);

module.exports = mongoose.model("NotificationRule", NotificationRuleSchema);
