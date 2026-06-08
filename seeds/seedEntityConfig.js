require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const mongoose = require("mongoose");
const data = require("../../seed/entity_config.json");

async function seed() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("Connected to MongoDB");

  const col = mongoose.connection.collection("entity_config");

  const ops = data.map((doc) => ({
    updateOne: {
      filter: { config_field: doc.config_field },
      update: { $set: doc },
      upsert: true,
    },
  }));

  const result = await col.bulkWrite(ops, { ordered: false });
  console.log(`Entity config seeded: ${result.upsertedCount} inserted, ${result.modifiedCount} updated`);
  await mongoose.disconnect();
}

seed().catch((err) => { console.error(err); process.exit(1); });
