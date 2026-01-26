// scripts/migrate-policyhub-versions.js
const mongoose = require("mongoose");
const PolicyHub = require("./models/PolicyHub");
require("dotenv").config();

async function migrate() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log("MongoDB connected");

        const cursor = PolicyHub.find().cursor();

        for (
            let doc = await cursor.next();
            doc != null;
            doc = await cursor.next()
        ) {
            if (doc.versions && doc.versions.length > 0) {
                continue;
            }

            doc.versions = [
                {
                    versionNumber: doc.versionNumber || 1,
                    docs: doc.docs,
                    filePath: doc.filePath,
                    metadata: doc.metadata,
                    isActive: doc.isActive,
                    createdAt: doc.createdAt || new Date(),
                    editedBy: doc.generatedBy || null,
                    editReason: "initial-migration",
                },
            ];

            doc.versionNumber = doc.versionNumber || 1;
            await doc.save();

            console.log("Migrated:", doc._id.toString());
        }

        console.log("✅ Migration complete");
        process.exit(0);
    } catch (err) {
        console.error("❌ Migration failed", err);
        process.exit(1);
    }
}

migrate();
