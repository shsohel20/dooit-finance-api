const mongoose = require("mongoose");
const AutoIncrement = require("mongoose-sequence")(mongoose);
const uniqueValidator = require("mongoose-unique-validator");
const mongoosePaginate = require("mongoose-paginate-v2");
const FileSchema = new mongoose.Schema({
  fileUrl: String,
  publicFileUrl: String,
  couldinaryId: String,
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

FileSchema.plugin(uniqueValidator, { message: "{PATH} must be unique." });
FileSchema.plugin(mongoosePaginate);
FileSchema.plugin(AutoIncrement, {
  inc_field: "sequence",
  id: "files_sequence", // unique counter id for this schema
  start_seq: 1,
});

// FileSchema.post("save", async function (doc, next) {
//   if (!doc.uid && doc.sequence) {
//     const padded = String(doc.sequence).padStart(3, "0");
//     doc.uid = `F_${padded}`;
//     await doc.constructor.updateOne({ _id: doc._id }, { uid: doc.uid });
//   }

//   next();
// });

FileSchema.pre("save", async function (next) {
  if (this.isNew && !this.uid) {
    this.uid = `F_${Date.now()}`;
  }
  next();
});
module.exports = mongoose.model("Files", FileSchema);
