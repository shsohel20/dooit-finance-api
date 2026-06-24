const mongoose = require("mongoose");
const { default: slugify } = require("slugify");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const AutoIncrement = require("mongoose-sequence")(mongoose);
const { Schema } = mongoose;
const autopopulate = require("mongoose-autopopulate");
const { roleEncryptionPlugin } = require("../utils/roleEncryptionPlugin");
const { hashForSearch } = require("../utils/encryption");

const rescriptProperty = ["name", "email", "phone", "userName"]

const UserSchema = new mongoose.Schema(
  {
    uid: String,
    sequence: { type: Number, index: true }, // auto incremented

    name: {
      type: String,
      trim: true,
      // unique: true, //Never Need Unique
      required: [true, "Please add a  name"],
    },
    userName: {
      type: String,
      trim: true,
      unique: true,
      required: [true, "Please add a  userName"],
    },
    slug: String,
    email: {
      type: String,
      unique: true,
      required: [true, "Please add a  email"],
      // match validator intentionally removed — the stored value is AES-256-GCM
      // ciphertext when encrypted, which would fail any email regex. Validate
      // email format at the controller/input layer instead.
    },
    // HMAC-SHA256 hash of the email — stays constant whether data is
    // encrypted or not, so login lookup always works.
    emailHash: { type: String, index: true, select: false },
    phone: {
      type: String,
      trim: true,
      unique: true,
      sparse: true,
    },
    isDataEncrypted: { type: Boolean, default: false },
   


    password: {
      type: String,
      required: [true, "Please add a password"],
      minLength: 6,
      select: false,
    },
    resetPasswordToken: String,
    resetPasswordExpire: Date,

    photoUrl: {
      type: String,
      required: true,
      default:
        "https://res.cloudinary.com/dxczhch36/image/upload/v1711183818/default-user_toualj.png",
    },

    isActive: {
      type: Boolean,
      default: false,
    },

    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
    timestamps: true,
  }
);

// UserSchema.virtual("photoUrl").get(function (req) {
//   const rootUrl = req.protocol + "://" + req.get("host");
//   return `${rootUrl}/uploads/${this.photoUrl}`;
// });

//Reverse Populate with virtual
// UserSchema.virtual("blogs", {
//   ref: "Blogs",
//   localField: "_id",
//   foreignField: "author",
//   justOne: false,
// });


UserSchema.virtual("memberships",
   { ref: "UserType", 
    localField: "_id", 
    foreignField: "user" 
  });

// 🔥 Virtual populate for customers linked to this user
UserSchema.virtual("customer", {
  ref: "Customer", // model name
  localField: "_id", // field on User
  foreignField: "user", // field on Customer
  justOne: true, // field on Customer
});

UserSchema.virtual("client", {
  ref: "Client", // model name
  localField: "_id", // field on User
  foreignField: "user",
  justOne: true, // field on Customer
});
UserSchema.virtual("branch", {
  ref: "Branch", // model name
  localField: "_id", // field on User
  foreignField: "user",
  justOne: true, // field on Customer
});

UserSchema.pre("save", function (next) {
  this.slug = slugify(this.name, { lower: true });
  next();
});

///Encrypt password using bcrypt
UserSchema.pre("save", async function (next) {
  if (!this.isModified("password")) {
    next();
  }
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

///SIgn Jwt and Return
// UserSchema.methods.getSignedJwtToken = function () {
//   return jwt.sign(
//     {
//       id: this._id,
//       email: this.email,
//       userType: this.userType,
//       name: this.name,
//       role: this.role,
//       photoUrl: this.photoUrl,
//       isActive: this.isActive,
//     },
//     process.env.JWT_SECRET,
//     {
//       expiresIn: process.env.JWT_EXPIRE,
//     }
//   );
// };


// Accepts the resolved UserType membership row (chosen at login / switch-context).
// Users is now identity-only — userType/role/tenant live in UserType, not User.
// Caller is responsible for passing the right membership; see resolveMembership.js.
UserSchema.methods.getSignedJwtToken = function (m = {}) {
  // name/email may be AES-256-GCM encrypted at rest. Force-decrypt so the JWT
  // always carries real plaintext values.
  const decrypted =
    typeof this.decryptForRole === "function" ? this.decryptForRole() : this;

  return jwt.sign(
    {
      id: this._id,
      email: decrypted.email,
      name: decrypted.name,
      photoUrl: this.photoUrl,
      isActive: this.isActive,
      // active context — from the membership chosen at login
      userTypeId: m._id ?? null,
      userType: m.userType ?? "user",
      role: m.role ?? "user",
      clientBelongs: m.clientBelongs ?? null,
      branchBelongs: m.branchBelongs ?? null,
    },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRE }
  );
};


// UserSchema.index({ email: 1 });
// UserSchema.index({ phone: 1 });

///Generate and hash password token
UserSchema.methods.getResetPasswordToken = function () {
  ///Generate Token
  const resetToken = crypto.randomBytes(20).toString("hex");

  ///Hash Token and set resetPasswordToken field
  this.resetPasswordToken = crypto
    .createHash("sha256")
    .update(resetToken)
    .digest("hex");

  ///Set Expires
  this.resetPasswordExpire = Date.now() + 10 * 60 * 1000;
  return resetToken;
};

///Math user entered password to hashed password in database
UserSchema.methods.mathPassword = async function (enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};
// UserSchema.post("save", async function (doc, next) {
//   if (!doc.uid && doc.sequence) {
//     const padded = String(doc.sequence).padStart(3, "0");
//     doc.uid = `U_${padded}`;
//     await doc.constructor.updateOne({ _id: doc._id }, { uid: doc.uid });
//   }

//   next();
// });

UserSchema.pre("save", async function (next) {
  if (this.isNew && !this.uid) {
    this.uid = `U_${Date.now()}`;
  }
  next();
});

// UserSchema.plugin(AutoIncrement, {
//   inc_field: "sequence",
//   id: "user_sequence", // unique counter id for this schema
//   start_seq: 1,
// });

// Compute emailHash from plaintext email BEFORE the encryption plugin runs.
// This hook must stay above plugin(roleEncryptionPlugin).
UserSchema.pre("save", function (next) {
  if (this.isModified("email") && this.email) {
    this.emailHash = hashForSearch(this.email);
  }
  next();
});

// UserSchema.plugin(autopopulate);
UserSchema.plugin(roleEncryptionPlugin, { paths: rescriptProperty });
UserSchema.statics.restrictedProperty = rescriptProperty;

module.exports = mongoose.model("Users", UserSchema);
