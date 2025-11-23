const { Schema } = require("mongoose");
const mongoose = require("mongoose");

const CounterSchema = new Schema({
  _id: { type: String, required: true },
  sequence: { type: Number, default: 1 },
});

module.exports = mongoose.model("Counter", CounterSchema);
