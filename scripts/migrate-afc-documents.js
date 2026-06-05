/**
 * Migration: afc-documents
 *
 * Handles two classes of legacy documents:
 *
 *  1. String _id  →  re-insert with ObjectId _id, old string moved to filePath
 *     (created when _id was temporarily a String type)
 *
 *  2. Snake_case fields  →  rename to camelCase in-place
 *     (created by the AI service writing directly to MongoDB, bypassing our API)
 *     content_md  → contentMd
 *     content_b64 → contentB64
 *     file_path   → filePath  (if filePath is missing)
 *     metadata.document_type      → metadata.documentType
 *     metadata.compliance_officer → metadata.complianceOfficer
 *     metadata.generated_at       → metadata.generatedAt
 *
 * Safe to run multiple times — already-migrated docs are skipped.
 *
 * Usage:
 *   node scripts/migrate-afc-documents.js
 */

const mongoose = require("mongoose");
const dotenv = require("dotenv");
const path = require("path");

dotenv.config({ path: path.join(__dirname, "../config/config.env") });

const COLLECTION = "afc-documents";

const isObjectId = (value) =>
  mongoose.Types.ObjectId.isValid(value) &&
  String(new mongoose.Types.ObjectId(value)) === String(value);

const run = async () => {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    console.error("No MONGO_URI found in config.env");
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log("Connected to MongoDB\n");

  const collection = mongoose.connection.db.collection(COLLECTION);
  const all = await collection.find({}).toArray();

  // ── Pass 1: string _id → ObjectId _id ──────────────────────────────────────
  const stringIdDocs = all.filter(
    (doc) => typeof doc._id === "string" && !isObjectId(doc._id)
  );

  console.log(`Pass 1 — string _id docs : ${stringIdDocs.length}`);

  let p1Migrated = 0, p1Skipped = 0, p1Failed = 0;

  for (const doc of stringIdDocs) {
    const oldId = doc._id;

    const existing = await collection.findOne({
      filePath: oldId,
      _id: { $type: "objectId" },
    });
    if (existing) {
      console.log(`  SKIP  already migrated: "${oldId}"`);
      p1Skipped++;
      continue;
    }

    const { _id, filePath, ...rest } = doc;
    const newDoc = {
      _id: new mongoose.Types.ObjectId(),
      filePath: oldId,
      ...rest,
    };

    try {
      await collection.insertOne(newDoc);
      await collection.deleteOne({ _id: oldId });
      p1Migrated++;
      console.log(`  OK    "${oldId}" → ${newDoc._id}`);
    } catch (err) {
      p1Failed++;
      console.error(`  FAIL  "${oldId}": ${err.message}`);
    }
  }

  // ── Pass 2: snake_case fields → camelCase ───────────────────────────────────
  // Re-fetch after pass 1 so we operate on fresh data
  const refreshed = await collection.find({}).toArray();

  const snakeDocs = refreshed.filter(
    (doc) =>
      "content_md" in doc ||
      "content_b64" in doc ||
      "file_path" in doc ||
      (doc.metadata &&
        ("document_type" in doc.metadata ||
          "compliance_officer" in doc.metadata ||
          "generated_at" in doc.metadata))
  );

  console.log(`\nPass 2 — snake_case field docs : ${snakeDocs.length}`);

  let p2Migrated = 0, p2Failed = 0;

  for (const doc of snakeDocs) {
    const $set = {};
    const $unset = {};

    if ("content_md" in doc) {
      if (!doc.contentMd) $set.contentMd = doc.content_md;
      $unset.content_md = "";
    }
    if ("content_b64" in doc) {
      if (!doc.contentB64) $set.contentB64 = doc.content_b64;
      $unset.content_b64 = "";
    }
    if ("file_path" in doc) {
      if (!doc.filePath) $set.filePath = doc.file_path;
      $unset.file_path = "";
    }

    // Normalize nested metadata snake_case keys
    if (doc.metadata) {
      const meta = { ...(doc.metadata) };
      let metaChanged = false;

      if ("document_type" in meta && !meta.documentType) {
        meta.documentType = meta.document_type;
        delete meta.document_type;
        metaChanged = true;
      }
      if ("compliance_officer" in meta && !meta.complianceOfficer) {
        meta.complianceOfficer = meta.compliance_officer;
        delete meta.compliance_officer;
        metaChanged = true;
      }
      if ("generated_at" in meta && !meta.generatedAt) {
        meta.generatedAt = meta.generated_at;
        delete meta.generated_at;
        metaChanged = true;
      }

      if (metaChanged) $set.metadata = meta;
    }

    if (Object.keys($set).length === 0 && Object.keys($unset).length === 0) {
      continue;
    }

    const ops = {};
    if (Object.keys($set).length) ops.$set = $set;
    if (Object.keys($unset).length) ops.$unset = $unset;

    try {
      await collection.updateOne({ _id: doc._id }, ops);
      p2Migrated++;
      console.log(`  OK    ${doc._id}  (${Object.keys($set).concat(Object.keys($unset)).join(", ")})`);
    } catch (err) {
      p2Failed++;
      console.error(`  FAIL  ${doc._id}: ${err.message}`);
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log("\n─────────────────────────────────────────");
  console.log(`Pass 1 (string _id)  migrated: ${p1Migrated}  skipped: ${p1Skipped}  failed: ${p1Failed}`);
  console.log(`Pass 2 (snake_case)  migrated: ${p2Migrated}  failed: ${p2Failed}`);
  console.log("─────────────────────────────────────────");

  await mongoose.disconnect();
  console.log("Disconnected. Done.");
};

run().catch((err) => {
  console.error("Migration error:", err);
  process.exit(1);
});
