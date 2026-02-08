// models/PolicyHub.js
const mongoose = require("mongoose");
const uniqueValidator = require("mongoose-unique-validator");
const mongoosePaginate = require("mongoose-paginate-v2");

const { Schema } = mongoose;

// models/PolicyHub.js (modified parts)
const PolicyHubSchema = new Schema(
  {
    client: {
      type: Schema.Types.ObjectId,
      ref: "Client",
      required: false,
      index: true,
    },
    branch: {
      type: Schema.Types.ObjectId,
      ref: "Branch",
      required: false,
      index: true,
    },

    // current content
    docs: { type: String, default: "" }, // rich Text (HTML)
    filePath: { type: String, default: "" },
    generatedBy: { type: Schema.Types.ObjectId, ref: "Users", default: null },
    assignee: { type: Schema.Types.ObjectId, ref: "Users", default: null },
    metadata: { type: Schema.Types.Mixed, default: {} },
    isActive: { type: Boolean, default: false },

    // version control
    versionNumber: { type: Number, default: 1 }, // current version number
    versions: [{ type: Schema.Types.ObjectId, ref: "PolicyHubVersion" }],
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

PolicyHubSchema.plugin(uniqueValidator, { message: "{PATH} must be unique." });
PolicyHubSchema.plugin(mongoosePaginate);

module.exports = mongoose.model("PolicyHub", PolicyHubSchema);
