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

module.exports = router;
