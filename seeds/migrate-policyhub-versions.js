// scripts/migrate-policyhub-versions.js

require("dotenv").config();
const mongoose = require("mongoose");

const PolicyHub = require("../models/PolicyHub");
const PolicyHubVersion = require("../models/PolicyHubVersion");

async function migrate() {
  try {
    console.log("Connecting to MongoDB...");
    await mongoose.connect(process.env.MONGO_URI);
    console.log("MongoDB connected");

    const cursor = PolicyHub.find({}).cursor();

    let totalDocs = 0;
    let totalVersionsCreated = 0;
    let totalVersionsSkipped = 0;

    for (
      let doc = await cursor.next();
      doc != null;
      doc = await cursor.next()
    ) {
      totalDocs++;

      const embeddedVersions = Array.isArray(doc.versions) ? doc.versions : [];

      // Skip if already using ref-style versions (ObjectIds instead of objects)
      if (
        embeddedVersions.length > 0 &&
        typeof embeddedVersions[0] === "object" &&
        embeddedVersions[0]?._id &&
        embeddedVersions[0]?.policyHub // already migrated doc mistakenly stored
      ) {
        console.log(`Skip ${doc._id} — looks already migrated`);
        continue;
      }

      // Only process embedded object versions (old schema)
      const objectVersions = embeddedVersions.filter(
        (v) => v && typeof v === "object" && v.versionNumber,
      );

      if (objectVersions.length === 0) {
        console.log(`No embedded versions for ${doc._id}`);
        continue;
      }

      console.log(
        `Migrating ${objectVersions.length} versions for PolicyHub ${doc._id}`,
      );

      const createdVersionIds = [];

      for (const v of objectVersions) {
        const versionNumber = v.versionNumber || 1;

        // check if already exists (idempotent safe)
        const existing = await PolicyHubVersion.findOne({
          policyHub: doc._id,
          versionNumber,
        }).select("_id");

        if (existing) {
          totalVersionsSkipped++;
          console.log(`  ↳ skip existing version ${versionNumber}`);
          createdVersionIds.push(existing._id);
          continue;
        }

        const ver = await PolicyHubVersion.create({
          policyHub: doc._id,
          versionNumber,
          docs: v.docs || "",
          filePath: v.filePath || "",
          metadata: v.metadata || {},
          isActive: v.isActive || false,
          createdAt: v.createdAt || new Date(),
          editedBy: v.editedBy || null,
          editReason: v.editReason || "migration",
        });

        totalVersionsCreated++;
        createdVersionIds.push(ver._id);

        console.log(`  ✔ created version ${versionNumber}`);
      }

      // merge with existing refs (avoid duplicates)
      const existingRefs = (doc.versions || [])
        .filter((x) => mongoose.isValidObjectId(x))
        .map((x) => String(x));

      const merged = new Set([
        ...existingRefs,
        ...createdVersionIds.map((x) => String(x)),
      ]);

      doc.versions = [...merged];

      await doc.save();

      console.log(`✔ PolicyHub ${doc._id} migrated`);
    }

    console.log("\n========== MIGRATION COMPLETE ==========");
    console.log("PolicyHub docs scanned:", totalDocs);
    console.log("Versions created:", totalVersionsCreated);
    console.log("Versions skipped:", totalVersionsSkipped);
    console.log("=======================================\n");

    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error("Migration failed ❌");
    console.error(err);
    process.exit(1);
  }
}

migrate();
