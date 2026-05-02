// models/NewsletterSubscription.js
const mongoose = require("mongoose");
const uniqueValidator = require("mongoose-unique-validator");
const mongoosePaginate = require("mongoose-paginate-v2");

const { Schema } = mongoose;

const NewsletterSubscriptionSchema = new Schema(
  {
    email: {
      type: String,
      trim: true,
      lowercase: true,
      required: [true, "Email is required"],
      unique: true,
      index: true,
    },
    utm: { type: Schema.Types.Mixed, default: {} },
    metadata: { type: Schema.Types.Mixed, default: {} }, // ip, userAgent, referer
    status: {
      type: String,
      enum: ["active", "unsubscribed"],
      default: "active",
    },
    notes: { type: String, default: "" },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

NewsletterSubscriptionSchema.plugin(uniqueValidator, {
  message: "{PATH} must be unique.",
});
NewsletterSubscriptionSchema.plugin(mongoosePaginate);

module.exports = mongoose.model(
  "NewsletterSubscription",
  NewsletterSubscriptionSchema
);
