// Set env vars BEFORE any module that reads them is loaded
process.env.ENCRYPTION_KEY = "a".repeat(64); // 32-byte hex key for AES-256-GCM
process.env.SEARCH_HASH_SECRET = "test-search-hash-secret";
process.env.JWT_SECRET = "test-jwt-secret";
process.env.JWT_EXPIRE = "1h";
process.env.NODE_ENV = "development";

const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const { MongoMemoryServer } = require("mongodb-memory-server");

function registerModels() {
  // Do NOT stub Client/Branch/Role: middleware/auth.js requires the real models,
  // and a stub registered first makes mongoose.model() throw OverwriteModelError
  // as soon as the route pulls auth in. Load the real ones — they are cheap and
  // it keeps the auth path identical to production.
  require("../../models/User");
  require("../../models/UserType");
  require("../../models/Client");
  require("../../models/Branch");
  // protect() does User.findById().populate('customer client branch'); `customer`
  // is a virtual pointing at Customer, so that model must be registered or the
  // populate throws MissingSchemaError and every request 401s.
  require("../../models/Customer");
  require("../../models/Role");
  require("../../models/RolePermission");
  require("../../models/Product");
  require("../../models/BillingPlan");
}

let mongod;

async function connect() {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  registerModels();
}

async function disconnect() {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  await mongod.stop();
}

async function clearAll() {
  const collections = mongoose.connection.collections;
  for (const key of Object.keys(collections)) {
    await collections[key].deleteMany({});
  }
}

/**
 * Create a user plus a UserType membership, and return a signed JWT carrying
 * that membership as the ACTIVE hat — mirroring what auth.js expects.
 */
let userSeq = 0;

async function makeUser({ userType, role = "admin", clientBelongs = null, email }) {
  const User = mongoose.model("Users");
  const UserType = mongoose.model("UserType");

  userSeq += 1;
  const addr = email || `${userType}-${userSeq}@test.local`;

  // name / userName / email / password / photoUrl are all required on Users,
  // and userName + email are unique — hence the per-run counter.
  const user = await User.create({
    name: `${userType} tester`,
    userName: `${userType}_tester_${userSeq}`,
    email: addr,
    password: "Password123!",
    isActive: true,
  });

  const membership = await UserType.create({
    user: user._id,
    userType,
    role,
    clientBelongs,
    isActive: true,
  });

  const token = jwt.sign(
    {
      id: user._id,
      userTypeId: membership._id,
      userType,
      role,
      clientBelongs,
      branchBelongs: null,
    },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRE }
  );

  return { user, membership, token, auth: `Bearer ${token}` };
}

module.exports = { connect, disconnect, clearAll, makeUser };
