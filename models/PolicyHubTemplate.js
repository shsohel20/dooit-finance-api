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
    docs: { type: String, default: "" }, // rich text HTML (body)
    headerHtml: { type: String, default: "" }, // page header HTML (round-tripped to DOCX header)
    footerHtml: { type: String, default: "" }, // page footer HTML (round-tripped to DOCX footer)
    metadata: { type: Schema.Types.Mixed, default: {} },
    tags: { type: [String], default: [] },
    // ── Source references ─────────────────────────────────────────────────────
    // Set when created from a PolicyHub master template
    sourcePolicyHub: {
      type: Schema.Types.ObjectId,
      ref: "PolicyHub",
      default: null,
    },
    // Set when generated via docxTemplateService from a TemplateConfig
    sourceTemplateConfig: {
      type: Schema.Types.ObjectId,
      ref: "TemplateConfig",
      default: null,
    },

    // ── Generated .docx file (AML doc-gen output) ─────────────────────────────
    // Populated after docxTemplateService generates the Word document.
    // Null for policy templates created manually (docs field used instead).
    generatedFileVaultId:  { type: String, default: null },
    generatedFileUrl:      { type: String, default: null },
    // Snapshot of the render payload at generation time — AML 7-year retention
    generatedSnapshotData: { type: Schema.Types.Mixed, default: null },

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
