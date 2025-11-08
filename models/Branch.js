const mongoose = require("mongoose");
const uniqueValidator = require("mongoose-unique-validator");
const mongoosePaginate = require("mongoose-paginate-v2");
const AutoIncrement = require("mongoose-sequence")(mongoose);
const slugify = require("slugify");

const { Schema } = mongoose;

/**
 * Sub-schemas (same style as your Client model)
 */
const ContactSchema = new Schema(
  {
    name: { type: String, trim: true },
    title: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    phone: { type: String, trim: true },
    primary: { type: Boolean, default: false },
  },
  { _id: false },
);

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
        default: [635, 522],
      },
    },
  },
  { _id: false },
);

const DocumentSchema = new Schema(
  {
    name: { type: String, trim: true },
    url: { type: String, trim: true },
    mimeType: { type: String, trim: true },
    type: { type: String, trim: true }, // e.g., 'license', 'agreement'
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

/**
 * Branch schema
 */
const BranchSchema = new Schema(
  {
    client: {
      type: mongoose.Schema.ObjectId,
      ref: "Client",
      required: true,
      index: true,
    },

    user: {
      type: mongoose.Schema.ObjectId,
      ref: "User",
      index: true,
      sparse: true,
    },

    branchSequence: { type: Number, index: true }, // auto incremented

    name: { type: String, required: true, trim: true },
    slug: { type: String, unique: false, sparse: true, index: true },

    // Branch identifier/code (unique per client)
    branchCode: { type: String, trim: true, required: true },

    // e.g., "Main", "ATM", "Corporate", "Retail"
    branchType: {
      type: String,
      enum: ["Main", "ATM", "Corporate", "Retail", "Other"],
      default: "Other",
    },

    // standard identifiers used by banks/financial orgs (optional)
    swiftCode: { type: String, trim: true, index: true, sparse: true },
    ifscCode: { type: String, trim: true, index: true, sparse: true },

    // contact + address
    email: {
      type: String,
      trim: true,
      lowercase: true,
      index: true,
      sparse: true,
    },
    phone: { type: String, trim: true },
    address: { type: AddressSchema, default: {} },
    contacts: { type: [ContactSchema], default: [] },

    // manager / head of branch
    manager: {
      name: { type: String, trim: true },
      email: { type: String, trim: true, lowercase: true },
      phone: { type: String, trim: true },
      employeeId: { type: String, trim: true },
    },

    // services available at this branch (e.g., "Loans", "Deposits", "Forex")
    services: { type: [String], default: [] },

    // ATM related
    hasATM: { type: Boolean, default: false },
    atmDetails: {
      locationDescription: { type: String, trim: true },
      cashAvailability: { type: Boolean, default: false },
    },

    // working hours: allow flexible representation
    workingHours: {
      // Use e.g. { monday: { open: "09:00", close: "17:00", closed: false }, ...}
      type: Schema.Types.Mixed,
      default: {},
    },

    documents: { type: [DocumentSchema], default: [] },

    // operational status
    status: {
      type: String,
      enum: ["Pending", "Active", "Inactive", "Closed", "Blocked"],
      default: "Pending",
    },

    settings: { type: Schema.Types.Mixed, default: {} },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

/**
 * Indexes
 */
// geo index for location-based queries
BranchSchema.index({ "address.geo": "2dsphere" });

BranchSchema.pre("save", function (next) {
  if (
    this.address &&
    this.address.geo &&
    Array.isArray(this.address.geo.coordinates)
  ) {
    const [lngRaw, latRaw] = this.address.geo.coordinates;
    const lng = Number(lngRaw);
    const lat = Number(latRaw);
    const ok =
      lng === lng &&
      lat === lat &&
      lng >= -180 &&
      lng <= 180 &&
      lat >= -90 &&
      lat <= 90;
    if (!ok) {
      // Option A: remove invalid geo so it won't break the index
      this.address.geo = undefined;
      // Option B: set to null coords: this.address.geo.coordinates = undefined;
      // Option C: return next(new Error(...)) to reject
    } else {
      this.address.geo.coordinates = [lng, lat];
      this.address.geo.type = "Point";
    }
  }
  next();
});
// compound unique: branchCode must be unique per client
BranchSchema.index(
  { client: 1, branchCode: 1, user: 1 },
  { unique: true, sparse: true },
);

/**
 * Virtuals
 */
BranchSchema.virtual("fullAddress").get(function () {
  const a = this.address || {};
  return [a.street, a.city, a.state, a.zipcode, a.country]
    .filter(Boolean)
    .join(", ");
});

/**
 * Pre-save hooks
 */
BranchSchema.pre("save", function (next) {
  // slug from name if not provided
  if (!this.slug && this.name) {
    this.slug = slugify(this.name, { lower: true, strict: true });
  }
  next();
});

/**
 * Plugins
 */
BranchSchema.plugin(uniqueValidator, { message: "{PATH} must be unique." });
BranchSchema.plugin(mongoosePaginate);
BranchSchema.plugin(AutoIncrement, { inc_field: "branchSequence" });

/**
 * Export model
 */
const Branch = mongoose.model("Branch", BranchSchema);
module.exports = Branch;
