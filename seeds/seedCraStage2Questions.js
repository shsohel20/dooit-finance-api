/**
 * Seed CRA Model B stage question collections.
 * Run: node api/seeds/seedCraStage2Questions.js
 * Seeds: cra_stage1_questions, cra_stage2_questions
 */

require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const mongoose = require("mongoose");

const stage1Data = require("../../seed/cra_stage1_questions.json");
const stage2Data = require("../../seed/cra_stage2_questions.json");

async function seed() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("Connected to MongoDB");

  const db = mongoose.connection;

  await db.collection("cra_stage1_questions").deleteMany({});
  await db.collection("cra_stage1_questions").insertMany(stage1Data);
  console.log(`Seeded ${stage1Data.length} Stage 1 questions`);

  await db.collection("cra_stage2_questions").deleteMany({});
  await db.collection("cra_stage2_questions").insertMany(stage2Data);
  console.log(`Seeded ${stage2Data.length} Stage 2 questions`);

  await mongoose.disconnect();
  console.log("Done.");
}

seed().catch((err) => {
  console.error("Seed error:", err);
  process.exit(1);
});
