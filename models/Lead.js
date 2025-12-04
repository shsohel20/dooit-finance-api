// models/Lead.js
const mongoose = require("mongoose");
const uniqueValidator = require("mongoose-unique-validator");
const mongoosePaginate = require("mongoose-paginate-v2");

const { Schema } = mongoose;

const LeadSchema = new Schema(
  {
    firstName: { type: String, trim: true, index: true },
    lastName: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true, index: true },
    zipCode: { type: String, trim: true },
    phoneNumber: { type: String, trim: true },
    businessName: { type: String, trim: true },
    industry: { type: String, trim: true },
    annualRevenue: { type: String, trim: true }, // keep string (select values)
    consent: { type: Boolean, default: false },
    utm: { type: Schema.Types.Mixed, default: {} }, // optional tracking/campaign metadata
    notes: { type: String, default: "" }, // optional admin notes
    source: { type: String, default: "web-form" }, // optional source label
    metadata: { type: Schema.Types.Mixed, default: {} }, // createdBy, assignedTo, etc.

    // admin fields
    status: {
      type: String,
      enum: ["new", "contacted", "qualified", "closed"],
      default: "new",
    },
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

LeadSchema.plugin(uniqueValidator, { message: "{PATH} must be unique." });
LeadSchema.plugin(mongoosePaginate);

module.exports = mongoose.model("Lead", LeadSchema);
