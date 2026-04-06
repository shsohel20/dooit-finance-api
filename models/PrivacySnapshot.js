const mongoose = require("mongoose");
const { Schema } = mongoose;

/**
 * PrivacySnapshot
 *
 * Captures the raw field values of a document BEFORE an encrypt or decrypt
 * operation is applied, so the state can be restored if needed.
 *
 * operation values:
 *   "pre_encrypt" — snapshot of plaintext values taken before encryption
 *   "pre_decrypt" — snapshot of encrypted values taken before decryption
 *
 * Restore logic:
 *   Restoring a "pre_encrypt" snapshot writes plaintext back → isDataEncrypted: false
 *   Restoring a "pre_decrypt" snapshot writes encrypted values back → isDataEncrypted: true
 */
const PrivacySnapshotSchema = new Schema(
  {
    modelType: {
      type: String,
      enum: ["user", "customer"],
      required: true,
      index: true,
    },

    documentId: {
      type: Schema.Types.ObjectId,
      required: true,
      index: true,
    },

    // "pre_encrypt" | "pre_decrypt"
    operation: {
      type: String,
      enum: ["pre_encrypt", "pre_decrypt"],
      required: true,
    },

    // { "name": "John", "email": "john@example.com" } (or encrypted hex for pre_decrypt)
    fields: {
      type: Schema.Types.Mixed,
      required: true,
    },

    performedBy: {
      type: Schema.Types.ObjectId,
      ref: "Users",
      default: null,
    },

    // Auto-incremented per (modelType, documentId) — version 1 is the first snapshot
    version: {
      type: Number,
      required: true,
      min: 1,
    },

    // Set when this snapshot is used to restore
    restoredAt: { type: Date, default: null },
    restoredBy: { type: Schema.Types.ObjectId, ref: "Users", default: null },
  },
  { timestamps: true }
);

PrivacySnapshotSchema.index({ modelType: 1, documentId: 1, version: 1 }, { unique: true });
PrivacySnapshotSchema.index({ modelType: 1, documentId: 1 });
PrivacySnapshotSchema.index({ createdAt: -1 });

module.exports = mongoose.model("PrivacySnapshot", PrivacySnapshotSchema);
