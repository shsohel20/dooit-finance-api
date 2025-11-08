const mongoose = require("mongoose");

const NotificationSchema = new mongoose.Schema(
  {
    endpoint: {
      type: String,
    },
    expirationTime: {
      type: Date, // Use Date type for storing expiration time
      default: null, // Optional: provide a default value or remove if not needed
    },
    keys: {
      type: Object,
      required: true, // Ensure keys are provided
    },
  },
  {
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
    timestamps: true,
  },
);

module.exports = mongoose.model("Notifications", NotificationSchema);
