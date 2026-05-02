// models/Contact.js
const mongoose = require("mongoose");
const uniqueValidator = require("mongoose-unique-validator");
const mongoosePaginate = require("mongoose-paginate-v2");

const { Schema } = mongoose;

const ContactSchema = new Schema(
  {
    name: { type: String, trim: true, index: true },
    email: { type: String, trim: true, lowercase: true, index: true },
    subject: { type: String, trim: true },
    message: { type: String, trim: true },
    utm: { type: Schema.Types.Mixed, default: {} },
    metadata: { type: Schema.Types.Mixed, default: {} }, // ip, userAgent, referer
    notes: { type: String, default: "" },
    status: {
      type: String,
      enum: ["new", "read", "replied", "closed"],
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

ContactSchema.plugin(uniqueValidator, { message: "{PATH} must be unique." });
ContactSchema.plugin(mongoosePaginate);

module.exports = mongoose.model("Contact", ContactSchema);
