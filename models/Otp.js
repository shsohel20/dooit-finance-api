const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const OtpSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      minLength: 6,
      maxLength: 6,
      required: true,
    },
    expire: Date,
    user: {
      type: mongoose.Schema.ObjectId,
      ref: "Users",
      required: true,
    },
  },

  {
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
    timestamps: true,
  }
);

///Encrypt code using bcrypt
OtpSchema.pre("save", async function (next) {
  if (!this.isModified("code")) {
    next();
  }
  const salt = await bcrypt.genSalt(10);
  this.code = await bcrypt.hash(this.code, salt);
  this.expire = await (Date.now() + 10 * 60 * 1000);
  next();
});

// UserSchema.pre("save", async function (next) {
//   if (!this.isModified("password")) {
//     next();
//   }
//   const salt = await bcrypt.genSalt(10);
//   this.password = await bcrypt.hash(this.password, salt);
//   next();
// });

///Math user entered code to hashed code in database
OtpSchema.methods.mathCode = async function (enteredCode) {
  return await bcrypt.compare(enteredCode, this.code);
};

module.exports = mongoose.model("Otp", OtpSchema);
