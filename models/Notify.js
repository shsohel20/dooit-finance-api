// models/Notify.js
const mongoose = require("mongoose");
const AutoIncrement = require("mongoose-sequence")(mongoose);

const { Schema } = mongoose;
const DocumentMetaSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    url: { type: String, required: true, trim: true },
    mimeType: { type: String, trim: true },
    type: { type: String, trim: true }, // e.g., "invoice","id","report"
    docType: { type: String, trim: true }, // business doc type if needed
    uploadedAt: { type: Date, default: Date.now },
    uploadedBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { _id: false }
);

const NotifySchema = new Schema(
  {
    uid: { type: String, index: true, unique: true },
    sequence: { type: Number, index: true },
    client: { type: Schema.Types.ObjectId, ref: "Client", index: true, default: null, },
    branch: { type: Schema.Types.ObjectId, ref: "Branch", index: true, default: null },
    notifyFor: {
      type: String, // Transaction, ECDD, SMR, Customer, etc.
      index: true,
      required: [true, "notifyFor is required"],
      trim: true,
      enum: ["Transaction", "ECDD", "SMR", "Customer", "Other"],
    },

    notes: {
      type: String,
      index: true,
      required: [true, "notes is required"],
      trim: true,
    },

    // optional link to the resource being notified about
    resourceType: { type: String, trim: true, index: true }, // e.g., "Transaction", "Customer", "Report"
    resourceId: {
      type: Schema.Types.ObjectId,
      index: true,
      refPath: "resourceType",
    },

    documents: { type: [DocumentMetaSchema], default: [] },

    isActive: { type: Boolean, default: false, index: true },

    // generic metadata - may include transactionId, smrId, ecddId, customerId etc.
    metadata: { type: Schema.Types.Mixed, default: {} },

    createdBy: { type: Schema.Types.ObjectId, ref: "Users", index: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: "Users", index: true },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

/* uid generation & normalization */
NotifySchema.pre("save", function (next) {
  if (this.isNew && !this.uid) {
    this.uid = `NOTIFY_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  }
  if (this.notifyFor) this.notifyFor = String(this.notifyFor).trim();
  next();
});

NotifySchema.plugin(AutoIncrement, {
  inc_field: "sequence",
  id: "notify_sequence",
  start_seq: 1,
});

// text index to enable quick search on notes & document names
NotifySchema.index({
  notes: "text",
  "documents.name": "text",
  uid: 1,
  sequence: 1,
});

module.exports = mongoose.model("Notify", NotifySchema);
