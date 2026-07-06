// Set env vars BEFORE any module that uses them is loaded
process.env.ENCRYPTION_KEY     = "a".repeat(64); // 32-byte hex key for AES-256-GCM
process.env.SEARCH_HASH_SECRET = "test-search-hash-secret";
process.env.JWT_SECRET         = "test-jwt-secret";
process.env.NODE_ENV           = "development";

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

function registerModels() {
  // Stub models referenced by populate()/refs but not owned by this module
  const stubs = {
    Client:   { name: String },
    AuditLog: { action: String },
  };
  for (const [modelName, shape] of Object.entries(stubs)) {
    if (!mongoose.modelNames().includes(modelName)) {
      mongoose.model(modelName, new mongoose.Schema(shape));
    }
  }
  // Branch needs a client ref — the controller verifies branch ownership
  if (!mongoose.modelNames().includes("Branch")) {
    mongoose.model(
      "Branch",
      new mongoose.Schema({
        name: String,
        client: { type: mongoose.Schema.Types.ObjectId, ref: "Client" },
      }),
    );
  }
  require("../../models/User");
  require("../../models/Customer");
  require("../../models/OnboardingJourney");
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

module.exports = { connect, disconnect, clearAll };
