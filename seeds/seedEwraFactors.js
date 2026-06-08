require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const mongoose = require("mongoose");
const factors = require("../../seed/ewra_factors.json");

async function seed() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("Connected to MongoDB");

  const col = mongoose.connection.collection("ewra_factors");

  const ops = factors.map((f) => ({
    updateOne: {
      filter: { factor_id: f.factor_id },
      update: { $set: f },
      upsert: true,
    },
  }));

  const result = await col.bulkWrite(ops, { ordered: false });
  console.log(`EWRA factors seeded: ${result.upsertedCount} inserted, ${result.modifiedCount} updated`);
  await mongoose.disconnect();
}

seed().catch((err) => { console.error(err); process.exit(1); });
