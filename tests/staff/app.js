const express     = require("express");
const errorHandler = require("../../middleware/error");
const staffRoutes  = require("../../routes/staff");

const app = express();
app.use(express.json());
app.use("/api/v1/staff", staffRoutes);
app.use(errorHandler);

module.exports = app;
