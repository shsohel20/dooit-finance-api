const mongoose = require("mongoose");
const mongoosePaginate = require("mongoose-paginate-v2");

const { Schema } = mongoose;

const PolicyHubTemplateSchema = new Schema(
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
    name: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    docs: { type: String, default: "" }, // rich text HTML
    metadata: { type: Schema.Types.Mixed, default: {} },
    tags: { type: [String], default: [] },
    // reference to the source PolicyHub (optional — null if created directly)
    sourcePolicyHub: {
      type: Schema.Types.ObjectId,
      ref: "PolicyHub",
      default: null,
    },
    createdBy: { type: Schema.Types.ObjectId, ref: "Users", default: null },
    isGlobal: { type: Boolean, default: false }, // admin-only: share across all clients
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

PolicyHubTemplateSchema.plugin(mongoosePaginate);

module.exports = mongoose.model("PolicyHubTemplate", PolicyHubTemplateSchema);
