// routes/index.js
const express = require("express");
const router = express.Router();

// Import individual route files
const fileUpload = require("./fileupload");
const otp = require("./otp");
const user = require("./user");
const auth = require("./auth");
const role = require("./role");
const location = require("./location");
// const notification = require("./notification");
const client = require("./client");
const branch = require("./branch");
const customer = require("./customer");
const transaction = require("./transaction");
const demo = require("./demoData");
const ecddReport = require("./ecdd-report");
const smrReport = require("./smr-report");
const gfsReport = require("./gfs-report");
const iftiReport = require("./ifti-report");
const ttrReport = require("./ttr-report");
const alert = require("./alert");
const rfi = require("./rfi");
const notify = require("./notify");
const leads = require("./leads");
const clientRule = require("./clientRules");
const policyHub = require("./policyHub");
const riskassessment = require("./riskassessment");
const privacy = require("./privacy");
const rolePermission = require("./rolePermission");
const trainingModule = require("./trainingModule");
const assignmentRoutes = require("./trainingAssignment");
const progressRoutes = require("./trainingProgress");
const reportRoutes = require("./trainingReport");

// ── Phase 1: EWRA / GRC ───────────────────────────────────────────────────────
const entityType = require("./entity-type");
const entityProfile = require("./entity-profile");
const obligationLibrary = require("./obligation-library");
const entityObligation = require("./entity-obligation");

// ── Phase 2: Controls Library ─────────────────────────────────────────────────
const control = require("./control");

// ── Phase 3: EWRA Risk Assessment ─────────────────────────────────────────────
const ewra = require("./ewra");
const countryRisk = require("./country-risk");

// ── Phase 5: Testing Module ───────────────────────────────────────────────────
const testTemplate = require("./test-template");
const testSchedule = require("./test-schedule");

// ── Phase 6: Issues & Remediation ────────────────────────────────────────────
const issue = require("./issue");

// ── Phase 7: Executive Dashboard ─────────────────────────────────────────────
const grcDashboard  = require("./grc-dashboard");
const ewraDashboard = require("./ewra-dashboard");

// ── Phase 8: RG Obligation Mapper ─────────────────────────────────────────────
const rgMapper = require("./rg-mapper");

// Mount routes
router.use("/fileupload", fileUpload);
router.use("/auth", auth);
router.use("/otp", otp);
router.use("/user", user);
router.use("/role", role);
router.use("/location", location);
// router.use("/notify", notification);
router.use("/branch", branch);
router.use("/transaction", transaction);
router.use("/demo", demo);
router.use("/customer", customer);
router.use("/client", client);
router.use("/smr-report", smrReport);
router.use("/ecdd-report", ecddReport);
router.use("/alert", alert);
router.use("/rfi", rfi);
router.use("/gfs-report", gfsReport);
router.use("/ifti-report", iftiReport);
router.use("/ttr-report", ttrReport);
router.use("/report-notify", notify);
router.use("/email", leads);
router.use("/client-rule", clientRule);
router.use("/policy-hub", policyHub);
router.use("/risk-assessment", riskassessment);
router.use("/privacy", privacy);
router.use("/role-permissions", rolePermission);

//Training module CRUD + quiz management + video progress
router.use("/training-modules", trainingModule);
// Standalone assignment endpoints  (assign, list-mine, list-by-me, detail, delete, status)
router.use("/training-assignments", assignmentRoutes);

// Learner progress + quiz submission + video watch + complete + retake
router.use("/training-progress", progressRoutes);

// Manager/admin reports
router.use("/training-reports", reportRoutes);

// ── Phase 1: EWRA / GRC ───────────────────────────────────────────────────────
router.use("/entity-type",        entityType);
router.use("/entity-profile",     entityProfile);
router.use("/obligation-library", obligationLibrary);
router.use("/entity-obligation",  entityObligation);

// ── Phase 2: Controls Library ─────────────────────────────────────────────────
router.use("/control",            control);

// ── Phase 3: EWRA Risk Assessment ─────────────────────────────────────────────
router.use("/ewra",               ewra);
router.use("/country-risk",       countryRisk);

// ── Phase 5: Testing Module ───────────────────────────────────────────────────
router.use("/test-template",      testTemplate);
router.use("/test-schedule",      testSchedule);

// ── Phase 6: Issues & Remediation ────────────────────────────────────────────
router.use("/issue",              issue);

// ── Phase 7: Executive Dashboard ─────────────────────────────────────────────
router.use("/grc-dashboard",      grcDashboard);
router.use("/ewra-dashboard",     ewraDashboard);

// ── Phase 8: RG Obligation Mapper ─────────────────────────────────────────────
router.use("/rg-mapper",          rgMapper);

module.exports = router;