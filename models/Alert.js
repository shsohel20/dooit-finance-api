const mongoose = require("mongoose");

const uniqueValidator = require("mongoose-unique-validator");
const mongoosePaginate = require("mongoose-paginate-v2");
const AutoIncrement = require("mongoose-sequence")(mongoose);
const slugify = require("slugify");

const { Schema } = mongoose;

const ActivitySchema = new Schema(
  {
    title: { type: String, trim: true },
    details: { type: String, trim: true },
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);
const ActivityNoteSchema = new Schema(
  {
    note: { type: String, trim: true },
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

/**
 * Main Client schema
 */
const AlertSchema = new Schema(
  {
    uid: String, //Case Id
    sequence: { type: Number, index: true }, // auto incremented
    customer: {
      type: mongoose.Schema.ObjectId,
      ref: "Customer",
    },
    analyst: {
      type: mongoose.Schema.ObjectId,
      ref: "Users",
    },
    transaction: {
      type: mongoose.Schema.ObjectId,
      ref: "Transaction",
    },
    caseType: String,

    riskScore: Number,
    riskLabel: String,
    activity: { type: [ActivitySchema], default: [] },
    activityNote: { type: [ActivityNoteSchema], default: [] },

    // operational
    status: {
      type: String,
      enum: ["Pending", "Active", "Inactive", "Blocked"],
      default: "Pending",
    },

    // flexible fields
    settings: { type: Schema.Types.Mixed, default: {} },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

/**
 * Indexes
 */
AlertSchema.index({ user: 1 });

/**
 * Virtuals
 */

// AlertSchema.post("save", async function (doc, next) {
//   if (!doc.uid && doc.sequence) {
//     const padded = String(doc.sequence).padStart(3, "0");
//     doc.uid = `#CA_${padded}`;
//     await doc.constructor.updateOne({ _id: doc._id }, { uid: doc.uid });
//   }
//   next();
// });
AlertSchema.pre("save", async function (next) {
  if (this.isNew && !this.uid) {
    this.uid = `CA_${Date.now()}`;
  }
  next();
});

/**
 * Plugins
 */
AlertSchema.plugin(uniqueValidator, { message: "{PATH} must be unique." });
AlertSchema.plugin(mongoosePaginate);

AlertSchema.plugin(AutoIncrement, {
  inc_field: "sequence",
  id: "alert_sequence", // unique counter id for this schema
  start_seq: 1,
});

const Alert = mongoose.model("Alert", AlertSchema);

module.exports = Alert;
