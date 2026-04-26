const mongoose = require("mongoose");
const mongoosePaginate = require("mongoose-paginate-v2");

const EntityTypeSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },           // "Tranche 1 - Banks & ADIs"
    category: {
      type: String,
      required: true,
      enum: ["Tranche 1", "Tranche 2"],
    },
    description: { type: String, trim: true },
    riskModelRef: { type: String, trim: true },                   // links to RiskModel.name
    active: { type: Boolean, default: true },
    client: { type: mongoose.Schema.Types.ObjectId, ref: "Client", index: true },
  },
  { timestamps: true }
);

EntityTypeSchema.plugin(mongoosePaginate);

module.exports = mongoose.model("EntityType", EntityTypeSchema);
