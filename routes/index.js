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
const notification = require("./notification");
const client = require("./client");
const branch = require("./branch");
const customer = require("./customer");
const transaction = require("./transaction");

// Mount routes
router.use("/fileupload", fileUpload);
router.use("/auth", auth);
router.use("/user", user);
router.use("/role", role);
router.use("/location", location);
router.use("/notify", notification);
router.use("/otp", otp);
router.use("/client", client);
router.use("/branch", branch);
router.use("/customer", customer);
router.use("/transaction", transaction);

module.exports = router;
