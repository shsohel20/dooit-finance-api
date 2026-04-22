const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

// Register stub schemas for models referenced by autopopulate but not owned
// by the training module. Without these Mongoose throws MissingSchemaError.
function registerStubs() {
  const stubs = {
    Users:  { name: String, email: String },
    Client: { name: String },
    Branch: { name: String, client: mongoose.Schema.Types.ObjectId },
    Roles:  { name: String, isActive: Boolean },
  };
  for (const [modelName, shape] of Object.entries(stubs)) {
    if (!mongoose.modelNames().includes(modelName)) {
      mongoose.model(modelName, new mongoose.Schema(shape));
    }
  }
  // Require the actual training models so Mongoose registers them
  require("../../models/TrainingModule");
  require("../../models/TrainingModulePart");
  require("../../models/TrainingModuleQuestion");
  require("../../models/TrainingModuleAccess");
  require("../../models/ModuleAssignment");
  require("../../models/TrainingLearnerProgress");
}

let mongod;

async function connect() {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  registerStubs();
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
