require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const mongoose = require("mongoose");
const questions = require("../../seed/onboarding_questions.json");

async function seed() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("Connected to MongoDB");

  const col = mongoose.connection.collection("onboarding_questions");

  const ops = questions.map((q) => ({
    updateOne: {
      filter: { step_id: q.step_id },
      update: { $set: q },
      upsert: true,
    },
  }));

  const result = await col.bulkWrite(ops, { ordered: false });
  console.log(`Onboarding questions seeded: ${result.upsertedCount} inserted, ${result.modifiedCount} updated`);
  await mongoose.disconnect();
}

seed().catch((err) => { console.error(err); process.exit(1); });
