"use strict";

const mongoose = require("mongoose");
const { Schema } = mongoose;

const DeviceSchema = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "Users",
      index: true,
      default: null,
    },
    customer: {
      type: Schema.Types.ObjectId,
      ref: "Customer",
      index: true,
      default: null,
    },
    client: {
      type: Schema.Types.ObjectId,
      ref: "Client",
      index: true,
      default: null,
    },
    branch: {
      type: Schema.Types.ObjectId,
      ref: "Branch",
      index: true,
      default: null,
    },

    deviceId: { type: String, required: true, index: true },
    deviceType: {
      type: String,
      enum: ["desktop", "mobile", "tablet", "server", "unknown"],
      default: "unknown",
      index: true,
    },
    os: { type: String, trim: true },
    osVersion: { type: String, trim: true },
    browser: { type: String, trim: true },
    browserVersion: { type: String, trim: true },
    appVersion: { type: String, trim: true },

    ipAddress: { type: String, index: true },
    country: { type: String, trim: true },
    city: { type: String, trim: true },
    timezone: { type: String, trim: true },

    geo: {
      lat: { type: Number },
      lon: { type: Number },
      accuracy: { type: Number },
      default: {},
    },

    lastLoginAt: { type: Date },
    lastTransactionAt: { type: Date },
    loginCount: { type: Number, default: 0 },
    transactionCount: { type: Number, default: 0 },

    isTrusted: { type: Boolean, default: false },
    riskFlags: [{ type: String, trim: true, index: true }],

    metadata: { type: Schema.Types.Mixed, default: {} },

    /**
     * PURPOSE: why this device entry exists
     * e.g. "registration", "login", "transaction", "verification"
     */
    purpose: {
      type: String,
      enum: [
        "registration",
        "login",
        "transaction",
        "device_verification",
        "two_factor_challenge",
        "password_reset",
        "suspicious_activity",
        "api_access",
        "logout",
        "admin_action",
        "other",
      ],
      required: true,
      index: true,
    },

    details: { type: Schema.Types.Mixed, default: {} }, // optional metadata about that purpose
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Unique per user + deviceId
DeviceSchema.index({ deviceId: 1, user: 1 }, { unique: true, sparse: true });

// Pre-save cleanup
DeviceSchema.pre("save", function (next) {
  if (this.ipAddress) this.ipAddress = this.ipAddress.trim();
  if (this.country) this.country = this.country.toUpperCase();
  next();
});

module.exports = mongoose.model("Device", DeviceSchema);
