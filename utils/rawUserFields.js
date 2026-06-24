const mongoose = require("mongoose");
const { decrypt } = require("./encryption");

// Bypasses Mongoose hooks (which mask encrypted fields to "***" outside a
// protect-middleware context) by reading directly from the raw collection.

const getRawEmail = async (userId) => {
  const raw = await mongoose.connection.db
    .collection("users")
    .findOne({ _id: userId }, { projection: { email: 1, isDataEncrypted: 1 } });
  if (!raw) return null;
  if (raw.isDataEncrypted) return decrypt(raw.email);
  return raw.email;
};

const getRawName = async (userId) => {
  const raw = await mongoose.connection.db
    .collection("users")
    .findOne({ _id: userId }, { projection: { name: 1, isDataEncrypted: 1 } });
  if (!raw) return null;
  if (raw.isDataEncrypted) return decrypt(raw.name);
  return raw.name;
};

module.exports = { getRawEmail, getRawName };
