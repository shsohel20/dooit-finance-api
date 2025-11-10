const mongoose = require("mongoose");

const uniqueValidator = require("mongoose-unique-validator");
const mongoosePaginate = require("mongoose-paginate-v2");
const AutoIncrement = require("mongoose-sequence")(mongoose);
const slugify = require("slugify");

const { Schema } = mongoose;

/**
 * Sub-schemas
 */

// Contact subdocument
const ContactSchema = new Schema(
  {
    name: { type: String, trim: true },
    title: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    phone: { type: String, trim: true },
    primary: { type: Boolean, default: false },
  },
  { _id: false }
);

// Address subdocument (with geo for 2dsphere queries)
const AddressSchema = new Schema(
  {
    street: { type: String, trim: true },
    city: { type: String, trim: true },
    state: { type: String, trim: true },
    country: { type: String, trim: true, default: "Bangladesh" },
    zipcode: { type: String, trim: true },
    geo: {
      type: {
        type: String,
        enum: ["Point"],
        default: "Point",
      },
      coordinates: {
        type: [Number], // [lng, lat]
        default: [0, 0],
      },
    },
  },
  { _id: false }
);

// Document / file metadata subdocument
const DocumentSchema = new Schema(
  {
    name: { type: String, trim: true },
    url: { type: String, trim: true },
    mimeType: { type: String, trim: true },
    type: { type: String, trim: true }, // e.g., 'license', 'agreement'
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

/**
 * Main Client schema
 */
const ClientSchema = new Schema(
  {
    uid: String,
    user: {
      type: mongoose.Schema.ObjectId,
      ref: "Users",
    },
    sequence: { type: Number, index: true }, // auto incremented
    name: { type: String, required: true, trim: true },
    slug: { type: String, unique: true, sparse: true, index: true },
    clientType: {
      type: String,
      // enum: ["Real Estate", "Bank", "Financial", "Insurance", "Other"],
      required: true,
    },

    // official identifiers
    registrationNumber: { type: String, trim: true, index: true, sparse: true },
    taxId: { type: String, trim: true, index: true, sparse: true },

    // contact info
    email: {
      type: String,
      trim: true,
      lowercase: true,
      index: true,
      sparse: true,
    },
    phone: { type: String, trim: true },
    website: { type: String, trim: true },

    // nested / relational
    contacts: { type: [ContactSchema], default: [] },
    address: { type: AddressSchema, default: {} },

    legalRepresentative: {
      name: { type: String, trim: true },
      email: { type: String, trim: true, lowercase: true },
      phone: { type: String, trim: true },
      designation: { type: String, trim: true },
    },

    // documents stored as metadata (store files in S3 / static storage)
    documents: { type: [DocumentSchema], default: [] },

    // operational
    status: {
      type: String,
      enum: ["Pending", "Active", "Inactive", "Blocked"],
      default: "Pending",
    },

    // flexible fields
    settings: { type: Schema.Types.Mixed, default: {} },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

/**
 * Indexes
 */
ClientSchema.index({ "address.geo": "2dsphere" }); // for geo queries
ClientSchema.index({ user: 1 });

/**
 * Virtuals
 */

ClientSchema.virtual("fullAddress").get(function () {
  const a = this.address || {};
  return [a.street, a.city, a.state, a.zipcode, a.country]
    .filter(Boolean)
    .join(", ");
});

/**
 * Pre-save hooks
 */
ClientSchema.pre("save", function (next) {
  // generate slug automatically from name if not provided
  if (!this.slug && this.name) {
    // use strict to remove special chars
    this.slug = slugify(this.name, { lower: true, strict: true });
  }
  next();
});

ClientSchema.post("save", async function (doc, next) {
  if (!doc.uid && doc.sequence) {
    const padded = String(doc.sequence).padStart(3, "0");
    doc.uid = `GRP_${padded}`;
    await doc.constructor.updateOne({ _id: doc._id }, { uid: doc.uid });
  }
  next();
});

/**
 * Plugins
 */
ClientSchema.plugin(uniqueValidator, { message: "{PATH} must be unique." });
ClientSchema.plugin(mongoosePaginate);

ClientSchema.plugin(AutoIncrement, {
  inc_field: "sequence",
  id: "client_sequence", // unique counter id for this schema
  start_seq: 1,
});

const Client = mongoose.model("Client", ClientSchema);

module.exports = Client;
