const mongoose = require("mongoose");
const mongoosePaginate = require("mongoose-paginate-v2");

const { Schema } = mongoose;

// Declarative placeholder → field mapping.
// The doc-gen service reads this; no per-template if/else in code.
const VariableMappingSchema = new Schema(
  {
    placeholder: { type: String, required: true },  // "[FIRM NAME]"
    field:       { type: String, required: true },  // "firmName" (dot-notation into render payload)
    transform:   { type: String, enum: ["BOOL_YES_NO", "UPPER", "DATE_AU"] },
  },
  { _id: false }
);

const TemplateConfigSchema = new Schema(
  {
    // Unique key used in API calls — e.g. "AML_PROGRAM_LAW"
    templateKey: { type: String, required: true, unique: true, trim: true, index: true },

    label: { type: String, required: true, trim: true },

    // Which EntityType documents this template applies to.
    // References EntityType._id — no hardcoded enum; new entity types added to
    // the EntityType collection are immediately available here.
    eligibleTypes: [
      {
        type: Schema.Types.ObjectId,
        ref: "EntityType",
      },
    ],

    // Direct URL to the .docx template stored in FileVault.
    // Used for both download/preview (UI) and fetching the buffer at generation time.
    fileVaultUrl: { type: String, required: true, trim: true },

    // Declarative variable map — drives generic doc-gen; no hardcoded per-template logic
    variableMap: { type: [VariableMappingSchema], default: [] },

    isActive: { type: Boolean, default: true, index: true },

    // Audit
    createdBy: { type: Schema.Types.ObjectId, ref: "Users", default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: "Users", default: null },
  },
  {
    timestamps: true,
    toJSON:   { virtuals: true },
    toObject: { virtuals: true },
  }
);

TemplateConfigSchema.plugin(mongoosePaginate);

module.exports = mongoose.model("TemplateConfig", TemplateConfigSchema);
