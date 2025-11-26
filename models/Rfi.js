// models/RFI.js
const mongoose = require("mongoose");
const uniqueValidator = require("mongoose-unique-validator");
const mongoosePaginate = require("mongoose-paginate-v2");
const AutoIncrement = require("mongoose-sequence")(mongoose);

const { Schema } = mongoose;

const RequestedItemSchema = new Schema(
  {
    text: { type: String, trim: true },
    // optional link to transactions or internal TX id
    txRef: { type: String },
  },
  { _id: false }
);

const ActivityNoteSchema = new Schema(
  {
    note: { type: String, trim: true },
    uploadedAt: { type: Date, default: Date.now },
    by: { type: mongoose.Schema.Types.ObjectId, ref: "Users" },
  },
  { _id: false }
);

const RFISchema = new Schema(
  {
    uid: { type: String, index: true }, // eg: RFI_163...
    sequence: { type: Number, index: true },

    // Links
    case: { type: mongoose.Schema.ObjectId, ref: "Alert" }, // or "Case" if you have one
    client: { type: mongoose.Schema.ObjectId, ref: "Client" },
    branch: { type: mongoose.Schema.ObjectId, ref: "Branch" },
    customer: { type: mongoose.Schema.ObjectId, ref: "Customer" },

    primaryContactName: { type: String, trim: true },
    replyToEmail: { type: String, trim: true },

    requestedItems: { type: [RequestedItemSchema], default: [] },

    // deadlines
    responseDeadline: { type: Date },
    followupDeadline: { type: Date },
    finalDeadline: { type: Date },

    // metadata & activity
    activityNote: { type: [ActivityNoteSchema], default: [] },
    sentAt: { type: Date },
    sentBy: { type: mongoose.Schema.ObjectId, ref: "Users" },

    status: {
      type: String,
      enum: [
        "Draft",
        "Pending",
        "Sent",
        "Pending FollowUp",
        "Final Notice",
        "Closed",
      ],
      default: "Draft",
    },

    settings: { type: Schema.Types.Mixed, default: {} },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// pre-save uid
RFISchema.pre("save", function (next) {
  if (this.isNew && !this.uid) {
    this.uid = `RFI_${Date.now()}`;
  }
  next();
});

RFISchema.plugin(uniqueValidator, { message: "{PATH} must be unique." });
RFISchema.plugin(mongoosePaginate);

RFISchema.plugin(AutoIncrement, {
  inc_field: "sequence",
  id: "rfi_sequence",
  start_seq: 1,
});

const RFI = mongoose.model("RFI", RFISchema);
module.exports = RFI;
