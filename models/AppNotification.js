const mongoose = require("mongoose");

const AppNotificationSchema = new mongoose.Schema(
  {
    ruleId:          { type: String, trim: true, default: "" },
    client:          { type: mongoose.Schema.ObjectId, ref: "Client", index: true, default: null },
    recipient:       { type: mongoose.Schema.ObjectId, ref: "Users", default: null },
    title:           { type: String, required: true, trim: true },
    body:            { type: String, default: "" },
    urgency:         { type: String, enum: ["Routine","Urgent","Critical"], default: "Routine" },
    actionLabel:     { type: String, default: "" },
    actionUrl:       { type: String, default: "" },
    linkedRecord:    { type: mongoose.Schema.ObjectId, default: null },
    linkedRecordType:{ type: String, default: "" },
    read:            { type: Boolean, default: false },
    readAt:          { type: Date, default: null },
    dismissed:       { type: Boolean, default: false },
  },
  { timestamps: true }
);

AppNotificationSchema.index({ client: 1, recipient: 1, read: 1, createdAt: -1 });

module.exports = mongoose.model("AppNotification", AppNotificationSchema);
