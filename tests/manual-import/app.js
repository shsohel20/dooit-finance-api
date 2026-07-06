const express = require("express");
const errorHandler = require("../../middleware/error");
const customerRoutes = require("../../routes/customer");

const app = express();
// no app-level json parser — the customer router parses its own bodies
app.use("/api/v1/customer", customerRoutes);
app.use(errorHandler);

module.exports = app;
