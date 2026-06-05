const mongoose = require("mongoose");
const mongoosePaginate = require("mongoose-paginate-v2");

const { Schema } = mongoose;

const metadataSchema = new Schema(
  {
    company: { type: String, default: "" },
    industry: { type: String, default: "" },
    documentType: { type: String, default: "" },
    complianceOfficer: { type: String, default: "" },
    version: { type: Number, default: 1 },
    model: { type: String, default: "" },
    generatedAt: { type: Date, default: null },
  },
  { _id: false }
);

const AfcDocumentSchema = new Schema(
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
    filePath: { type: String, default: "", index: true },
    contentMd: { type: String, default: "" },
    contentB64: { type: String, default: "" },
    metadata: { type: metadataSchema, default: () => ({}) },
    status: {
      type: String,
      enum: ["pending", "completed", "failed"],
      default: "completed",
    },
    createdBy: { type: Schema.Types.ObjectId, ref: "Users", default: null },
  },
  {
    collection: "afc-documents",
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

AfcDocumentSchema.plugin(mongoosePaginate);

module.exports = mongoose.model("AfcDocument", AfcDocumentSchema);
