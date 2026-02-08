// models/PolicyHubVersion.js
const mongoose = require("mongoose");
const { Schema } = mongoose;

const PolicyHubVersionSchema = new Schema(
  {
    policyHub: {
      type: Schema.Types.ObjectId,
      ref: "PolicyHub",
      required: true,
      index: true,
    },
    versionNumber: { type: Number, required: true, index: true },
    docs: { type: String, default: "" },
    filePath: { type: String, default: "" },
    metadata: { type: Schema.Types.Mixed, default: {} },
    isActive: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now },
    editedBy: { type: Schema.Types.ObjectId, ref: "Users", default: null },
    editReason: { type: String, default: "" },
  },
  {
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

// Ensure unique per policyHub + versionNumber
PolicyHubVersionSchema.index(
  { policyHub: 1, versionNumber: 1 },
  { unique: true },
);

module.exports = mongoose.model("PolicyHubVersion", PolicyHubVersionSchema);
