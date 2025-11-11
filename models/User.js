const mongoose = require("mongoose");
const { default: slugify } = require("slugify");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const AutoIncrement = require("mongoose-sequence")(mongoose);

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
      match: [
        /^(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/,
        "Please use a valid email",
      ],
    },
    phone: {
      type: String,
      trim: true,
      unique: true,
      //required: [true, "Please add a  phone"],
    },
    userType: {
      type: String,
      trim: true,
      // unique: true,
      required: [true, "Please add a  userType"],
      default: "user",
    },

    role: {
      type: String,
      enum: [
        "user",
        "collector",
        "approval",
        "admin",
        "customer",
        "client",
        "client-admin",
      ],
      default: "user",
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
UserSchema.virtual("customers", {
  ref: "Customer", // model name
  localField: "_id", // field on User
  foreignField: "user", // field on Customer
  justOne: true, // field on Customer
});

UserSchema.virtual("clients", {
  ref: "Client", // model name
  localField: "_id", // field on User
  foreignField: "user",
  justOne: true, // field on Customer
});
UserSchema.virtual("branches", {
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
UserSchema.methods.getSignedJwtToken = function () {
  return jwt.sign(
    {
      id: this._id,
      email: this.email,
      userType: this.userType,
      name: this.name,
      role: this.role,
      photoUrl: this.photoUrl,
      isActive: this.isActive,
    },
    process.env.JWT_SECRET,
    {
      expiresIn: process.env.JWT_EXPIRE,
    }
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
UserSchema.post("save", async function (doc, next) {
  if (!doc.uid && doc.sequence) {
    const padded = String(doc.sequence).padStart(3, "0");
    doc.uid = `U_${padded}`;
    await doc.constructor.updateOne({ _id: doc._id }, { uid: doc.uid });
  }

  next();
});
UserSchema.plugin(AutoIncrement, {
  inc_field: "sequence",
  id: "user_sequence", // unique counter id for this schema
  start_seq: 1,
});
module.exports = mongoose.model("Users", UserSchema);
