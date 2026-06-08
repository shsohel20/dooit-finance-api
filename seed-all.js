/**
 * Master seed runner — runs all core data seeders in sequence.
 *
 * Usage:
 *   node api/seed-all.js            — run all, compact output
 *   node api/seed-all.js --verbose  — run all, full output per seeder
 */

const { spawnSync } = require("child_process");
const path = require("path");

const VERBOSE = process.argv.includes("--verbose") || process.argv.includes("-v");
const API_DIR = __dirname;
const COL = 38;

// ── Core data seeders, in dependency order ────────────────────────────────
const SEEDS = [
  { name: "Entity Types & Services",  file: "seeds/seedEntityTypes.js" },
  { name: "Entity Config",            file: "seeds/seedEntityConfig.js" },
  { name: "EWRA Risk Factors",        file: "seeds/seedEwraFactors.js" },
  { name: "Country Risk",             file: "seeds/seedCountryRisk.js" },
  { name: "Controls",                 file: "seeds/seedControls.js" },
  { name: "Risk Data",                file: "seeds/seedRiskData.js" },
  { name: "Risk Factors",             file: "seeds/seedRiskFactors.js" },
  { name: "Obligations",              file: "seeds/seedObligations.js" },
  { name: "Notification Rules",       file: "seeds/seedNotificationRules.js" },
  { name: "Monitoring Rules",         file: "seeds/seedMonitoringRules.js" },
  { name: "RAP Templates",            file: "seeds/seedRapTemplates.js" },
  { name: "Onboarding Questions",     file: "seeds/seedOnboardingQuestions.js" },
  { name: "CRA Stage 1/2 Questions",  file: "seeds/seedCraStage2Questions.js" },
];

// ─────────────────────────────────────────────────────────────────────────────

const hr = "─".repeat(52);

console.log(`\n${hr}`);
console.log("  dooit.ai — master seed runner");
console.log(`  ${SEEDS.length} seeders · cwd: api/`);
console.log(`${hr}\n`);

let passed = 0;
let failed = 0;
const failures = [];

for (const { name, file } of SEEDS) {
  if (!VERBOSE) process.stdout.write(`  ▸ ${name.padEnd(COL)}`);

  const t0 = Date.now();
  const result = spawnSync("node", [file], {
    cwd: API_DIR,
    stdio: VERBOSE ? "inherit" : ["inherit", "pipe", "pipe"],
    encoding: "utf8",
  });
  const ms = Date.now() - t0;

  if (result.status === 0) {
    passed++;
    if (VERBOSE) {
      console.log(`\n  ✓ ${name} (${ms}ms)\n`);
    } else {
      console.log(`✓  ${ms}ms`);
    }
  } else {
    failed++;
    if (VERBOSE) {
      console.error(`\n  ✗ ${name} FAILED (${ms}ms)\n`);
    } else {
      console.log(`✗  FAILED`);
    }
    failures.push({
      name,
      output: (result.stdout || "") + (result.stderr || ""),
    });
  }
}

// ── Summary ───────────────────────────────────────────────────────────────
console.log(`\n${hr}`);
console.log(`  ${passed} passed   ${failed} failed`);
console.log(`${hr}\n`);

if (failures.length) {
  failures.forEach(({ name, output }) => {
    console.error(`\n[FAILED] ${name}`);
    if (output.trim()) console.error(output.trim());
  });
  process.exit(1);
}
