const mongoose = require("mongoose");

const RoleSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      trim: true,
      unique: true,
      required: [true, "Please add Role name"],
    },

    permissions: {
      type: Array,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    description: {
      type: String,
    },
  },
  {
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
    timestamps: true,
  },
);

module.exports = mongoose.model("Roles", RoleSchema);
