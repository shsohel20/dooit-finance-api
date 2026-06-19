"use strict";

/**
 * seedAMLTemplates.js
 *
 * Reads each .docx from docs/amldocs/, uploads it to FileVault,
 * resolves the EntityType ObjectId from MongoDB, then upserts a
 * TemplateConfig document for each AML program template.
 *
 * Usage:
 *   node api/scripts/seedAMLTemplates.js
 *
 * Requires env vars: MONGO_URI, NEXT_PUBLIC_IMAGE_SERVER_URL, IMAGE_API_KEY
 */

const path       = require("path");
const fs         = require("fs");
const mongoose   = require("mongoose");
require("dotenv").config({ path: path.join(__dirname, "../config/config.env") });

const TemplateConfig  = require("../models/TemplateConfig");
const EntityType      = require("../models/EntityType");
const fileVaultService = require("../utils/fileVaultService");

// ── Template definitions ──────────────────────────────────────────────────────
// entityTypePattern: regex matched against EntityType.name (case-insensitive)
// variableMap: declarative placeholder → field mappings

const COMMON_VARIABLES = [
  { placeholder: "[FIRM NAME]",                        field: "firmName" },
  { placeholder: "[INSERT DATE]",                      field: "documentDate" },
  { placeholder: "[INSERT EFFECTIVE DATE]",            field: "effectiveDate" },
  { placeholder: "[INSERT ENROLMENT DATE AND NUMBER]", field: "austracEnrolmentRef" },
  { placeholder: "[INSERT NAME]",                      field: "complianceOfficerName" },
  { placeholder: "[INSERT NAME AND TITLE]",            field: "complianceOfficerNameTitle" },
  { placeholder: "[INSERT ABN]",                       field: "abn" },
  { placeholder: "[INSERT ACN]",                       field: "acn" },
  { placeholder: "[YES/NO]",                           field: "hasDesignatedServices", transform: "BOOL_YES_NO" },
];

const TEMPLATES = [
  {
    templateKey:        "AML_PROGRAM_LAW",
    label:              "AML/CTF Compliance Program — Lawyers & Conveyancers",
    docFile:            "AML_Program_v2_Lawyers_Conveyancers.docx",
    entityTypePattern:  /lawyer|conveyancer/i,
    variableMap: COMMON_VARIABLES,
  },
  {
    templateKey:        "AML_PROGRAM_ACCOUNTING",
    label:              "AML/CTF Compliance Program — Accounting Firms",
    docFile:            "AML_Program_v2_Accountants.docx",
    entityTypePattern:  /accountant/i,
    variableMap: [
      ...COMMON_VARIABLES,
      { placeholder: "[DESIGNATED SERVICES]", field: "designatedServicesText" },
    ],
  },
  {
    templateKey:        "AML_PROGRAM_REALESTATE",
    label:              "AML/CTF Compliance Program — Real Estate Agencies",
    docFile:            "AML_Program_v2_Real_Estate_Agents.docx",
    entityTypePattern:  /real.?estate/i,
    variableMap: [
      { placeholder: "[FIRM NAME]",                        field: "firmName" },
      { placeholder: "[AGENCY NAME]",                      field: "firmName" },
      { placeholder: "[PRINCIPAL NAME]",                   field: "complianceOfficerName" },
      { placeholder: "[INSERT DATE]",                      field: "documentDate" },
      { placeholder: "[INSERT EFFECTIVE DATE]",            field: "effectiveDate" },
      { placeholder: "[INSERT ENROLMENT DATE AND NUMBER]", field: "austracEnrolmentRef" },
      { placeholder: "[INSERT ABN]",                       field: "abn" },
      { placeholder: "[INSERT LICENSE NUMBER]",            field: "agencyLicenseNumber" },
      { placeholder: "[INSERT STATE]",                     field: "state", transform: "UPPER" },
      { placeholder: "[YES/NO]",                           field: "hasDesignatedServices", transform: "BOOL_YES_NO" },
    ],
  },
  {
    templateKey:        "AML_PROGRAM_JEWELLERS",
    label:              "AML/CTF Compliance Program — Jewellers & Precious Metal Dealers",
    docFile:            "AML_Program_v2_Jewellers.docx",
    entityTypePattern:  /jewel|precious.?metal/i,
    variableMap: COMMON_VARIABLES,
  },
  {
    templateKey:        "AML_PROGRAM_BANKS",
    label:              "AML/CTF Compliance Program — Banks & ADIs",
    docFile:            "AML_Program_v2_Banks_ADIs.docx",
    entityTypePattern:  /bank|adi|credit.?union/i,
    variableMap: COMMON_VARIABLES,
  },
  {
    templateKey:        "AML_PROGRAM_GAMBLING",
    label:              "AML/CTF Compliance Program — Gambling & Casino",
    docFile:            "AML_Program_v2_Gambling.docx",
    entityTypePattern:  /gambl|casino/i,
    variableMap: COMMON_VARIABLES,
  },
  {
    templateKey:        "AML_PROGRAM_INSURANCE",
    label:              "AML/CTF Compliance Program — Insurance",
    docFile:            "AML_Program_v2_Insurance.docx",
    entityTypePattern:  /insurance/i,
    variableMap: COMMON_VARIABLES,
  },
  {
    templateKey:        "AML_PROGRAM_VASP",
    label:              "AML/CTF Compliance Program — VASPs & Digital Asset Exchanges",
    docFile:            "AML_Program_v2_VASPs.docx",
    entityTypePattern:  /vasp|crypto|digital.?asset|dcep/i,
    variableMap: COMMON_VARIABLES,
  },
  {
    templateKey:        "AML_PROGRAM_REMITTANCE",
    label:              "AML/CTF Compliance Program — Remittance & Money Transfer",
    docFile:            "AML_Program_v2_Remittance.docx",
    entityTypePattern:  /remittance|money.?transfer/i,
    variableMap: COMMON_VARIABLES,
  },
];

const DOCS_DIR = path.join(__dirname, "../../docs/amldocs");

// FileVault credentials check — if missing, seed with placeholder URLs (isActive:false)
// and print instructions. Re-run with credentials to upload the real files.
const hasFileVaultConfig = !!(
  process.env.NEXT_PUBLIC_IMAGE_SERVER_URL && process.env.IMAGE_API_KEY
);

// ── Seed ──────────────────────────────────────────────────────────────────────

async function resolveEntityTypeId(pattern) {
  const allTypes = await EntityType.find({}).lean();
  const match = allTypes.find(et => pattern.test(et.name));
  if (!match) {
    console.warn(`  ⚠️  No EntityType found matching ${pattern} — eligibleTypes will be empty`);
    return null;
  }
  console.log(`  ✅ EntityType "${match.name}" → ${match._id}`);
  return match._id;
}

async function uploadDocx(fileName) {
  const filePath = path.join(DOCS_DIR, fileName);
  if (!fs.existsSync(filePath)) {
    console.warn(`  ⚠️  File not found: ${filePath}`);
    return null;
  }
  const buffer = fs.readFileSync(filePath);
  console.log(`  📤 Uploading ${fileName} (${(buffer.length / 1024).toFixed(1)} KB)…`);
  const result = await fileVaultService.uploadFile(
    buffer,
    fileName,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  );
  const url = result?.file?.publicUrl || null;
  if (!url) throw new Error(`FileVault upload did not return a url for ${fileName}`);
  console.log(`  ✅ Uploaded → ${url}`);
  return url;
}

async function seed() {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) throw new Error("MONGO_URI env var is required");

  await mongoose.connect(mongoUri);
  console.log("🔗 Connected to MongoDB");

  if (!hasFileVaultConfig) {
    console.warn("\n⚠️  FileVault credentials not found in config.env.");
    console.warn("   Add these two lines to api/config/config.env and re-run to upload files:");
    console.warn("   NEXT_PUBLIC_IMAGE_SERVER_URL=https://files.your-filevault-host.com/api/v1");
    console.warn("   IMAGE_API_KEY=your_api_key_here");
    console.warn("\n   Proceeding with placeholder fileVaultUrl (isActive:false).");
    console.warn("   Templates will NOT generate docs until you re-run with credentials.\n");
  }

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const tmpl of TEMPLATES) {
    console.log(`\n▶ Processing ${tmpl.templateKey}`);

    let fileVaultUrl = "PENDING_UPLOAD";
    let isActive     = false;

    if (hasFileVaultConfig) {
      try {
        fileVaultUrl = await uploadDocx(tmpl.docFile);
        if (!fileVaultUrl) { skipped++; continue; }
        isActive = true;
      } catch (err) {
        console.error(`  ❌ Upload failed: ${err.message} — seeding with placeholder`);
        fileVaultUrl = "PENDING_UPLOAD";
        isActive     = false;
      }
    } else {
      console.log(`  ⏭  Skipping upload (no FileVault credentials) — placeholder used`);
    }

    const entityTypeId = await resolveEntityTypeId(tmpl.entityTypePattern);

    const doc = {
      templateKey:   tmpl.templateKey,
      label:         tmpl.label,
      fileVaultUrl,
      eligibleTypes: entityTypeId ? [entityTypeId] : [],
      variableMap:   tmpl.variableMap,
      isActive,
    };

    const existing = await TemplateConfig.findOne({ templateKey: tmpl.templateKey });
    if (existing) {
      // Don't overwrite a real URL with a placeholder on re-run without credentials
      if (!hasFileVaultConfig && existing.fileVaultUrl !== "PENDING_UPLOAD") {
        console.log(`  ♻️  Skipping URL update — existing URL preserved`);
        delete doc.fileVaultUrl;
        delete doc.isActive;
      }
      await TemplateConfig.updateOne({ _id: existing._id }, { $set: doc });
      console.log(`  ♻️  Updated existing TemplateConfig`);
      updated++;
    } else {
      await TemplateConfig.create(doc);
      console.log(`  ✨ Created new TemplateConfig`);
      created++;
    }
  }

  console.log(`\n✅ Seed complete — created: ${created}, updated: ${updated}, skipped: ${skipped}`);

  if (!hasFileVaultConfig) {
    console.log("\n📋 Next steps:");
    console.log("   1. Add NEXT_PUBLIC_IMAGE_SERVER_URL and IMAGE_API_KEY to api/config/config.env");
    console.log("   2. Re-run: node scripts/seedAMLTemplates.js");
    console.log("   3. Templates will be uploaded to FileVault and activated automatically.");
  }

  process.exit(0);
}

seed().catch(err => {
  console.error("❌ Seed failed:", err);
  process.exit(1);
});
