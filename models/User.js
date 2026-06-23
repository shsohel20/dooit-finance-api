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
      unique: true,
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
    userType: {
      type: String,
      trim: true,
      // unique: true,
      required: [true, "Please add a  userType"],
      default: "user", // user, customer, client, branch, dooit 
    },

    role: {
      type: String,
      // enum: [
      //   "user",
      //   "collector",
      //   "approval",
      //   "admin",
      //   "customer",
      //   "analyst",
      //   "client",
      //   "client-admin",
      // ],
      default: "user",
    },

    clientBelongs: {
      type: Schema.Types.ObjectId,
      ref: "Client",
      //  required: true,
      index: true,
      default: null,
      // autopopulate: true,
    },
    branchBelongs: {
      type: Schema.Types.ObjectId,
      ref: "Branch",
      default: null,
      index: true,
      // autopopulate: true,

    },


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


UserSchema.methods.getSignedJwtToken = function () {
  // name/email may be AES-256-GCM encrypted at rest — only after the Privacy
  // module encrypts them (data is plaintext on create by default). When encrypted,
  // public routes (login/register/reset) have no decrypt context so autoDecryptDoc
  // masks them to "***". Force-decrypt here so the issued JWT always carries the
  // real plaintext values. decryptForRole() falls back to the pre-mask ciphertext
  // snapshot, raw ciphertext, or plaintext as needed (plaintext passes through).
  const decrypted =
    typeof this.decryptForRole === "function" ? this.decryptForRole() : this;

  return jwt.sign(
    {
      id: this._id,
      email: decrypted.email,
      userType: this.userType,
      name: decrypted.name,
      role: this.role,
      photoUrl: this.photoUrl,
      isActive: this.isActive,
      clientType: this.branch?.client?.clientType ?? this.client?.clientType,
      isClient: this.client ? true : false,
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
