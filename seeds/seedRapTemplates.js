require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const mongoose = require("mongoose");
const templates = require("../../seed/rap_templates.json");

async function seed() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("Connected to MongoDB");

  const col = mongoose.connection.collection("rap_templates");

  const ops = templates.map((t) => ({
    updateOne: {
      filter: { rap_id: t.rap_id },
      update: { $set: t },
      upsert: true,
    },
  }));

  const result = await col.bulkWrite(ops, { ordered: false });
  console.log(`RAP templates seeded: ${result.upsertedCount} inserted, ${result.modifiedCount} updated`);
  await mongoose.disconnect();
}

seed().catch((err) => { console.error(err); process.exit(1); });
