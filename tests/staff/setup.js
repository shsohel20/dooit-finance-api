// Set env vars BEFORE any module that uses them is loaded
process.env.ENCRYPTION_KEY     = "a".repeat(64); // 32-byte hex key for AES-256-GCM
process.env.SEARCH_HASH_SECRET = "test-search-hash-secret";
process.env.JWT_SECRET         = "test-jwt-secret";
process.env.NODE_ENV           = "development";

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

function registerModels() {
  // Stub models referenced by populate() but not owned by this module
  const stubs = {
    Client:   { name: String },
    Branch:   { name: String },
    AuditLog: { action: String },
  };
  for (const [modelName, shape] of Object.entries(stubs)) {
    if (!mongoose.modelNames().includes(modelName)) {
      mongoose.model(modelName, new mongoose.Schema(shape));
    }
  }
  require("../../models/User");
  require("../../models/Staff");
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
