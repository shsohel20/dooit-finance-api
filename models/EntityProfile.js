const mongoose = require("mongoose");
const mongoosePaginate = require("mongoose-paginate-v2");

const EntityProfileSchema = new mongoose.Schema(
  {
    uid: { type: String, index: true },                           // "ENT_<timestamp>"

    entityName: { type: String, required: true, trim: true },
    entityType: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EntityType",
      required: true,
    },
    abn: { type: String, trim: true },                            // Australian Business Number
    licenses: [{ type: String, trim: true }],                     // license codes e.g. ['AFSL', 'ADI']
    designatedServices: [{ type: String, trim: true }],           // service codes e.g. ['CUSTODY']
    hasRetailClients: { type: Boolean, default: false },
    annualTurnoverRange: {
      type: String,
      enum: ["<1M", "1-10M", "10-50M", "50-200M", "200M+", ""],
      default: "",
    },
    jurisdictions: [{ type: String, trim: true }],                // ISO country codes

    status: {
      type: String,
      enum: ["Active", "Draft", "Archived"],
      default: "Active",
    },

    // Multi-tenancy
    client: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Client",
      required: true,
      index: true,
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "Users" },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Users" },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

EntityProfileSchema.pre("save", function (next) {
  if (this.isNew && !this.uid) {
    this.uid = `ENT_${Date.now()}`;
  }
  next();
});

EntityProfileSchema.plugin(mongoosePaginate);

module.exports = mongoose.model("EntityProfile", EntityProfileSchema);
