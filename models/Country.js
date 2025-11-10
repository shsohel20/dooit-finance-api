const mongoose = require("mongoose");
const AutoIncrement = require("mongoose-sequence")(mongoose);

const CountrySchema = new mongoose.Schema({
  uid: String,
  sequence: { type: Number, index: true }, // auto incremented
  name: {
    type: String,
    required: [true, "Please add country name"],
  },
  code: {
    type: String,
    required: [true, "Please add country code"],
  },
  state: [
    {
      name: {
        type: String,
      },
      code: {
        type: String,
      },
    },
  ],

  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});
CountrySchema.plugin(AutoIncrement, {
  inc_field: "sequence",
  id: "country_sequence", // unique counter id for this schema
  start_seq: 1,
});

CountrySchema.post("save", async function (doc, next) {
  if (!doc.uid && doc.sequence) {
    const padded = String(doc.sequence).padStart(3, "0");
    doc.uid = `CT_${padded}`;
    await doc.constructor.updateOne({ _id: doc._id }, { uid: doc.uid });
  }

  next();
});
module.exports = mongoose.model("Country", CountrySchema);
