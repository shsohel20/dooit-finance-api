/**
 * Minimal express app for training integration tests.
 * Auth middleware is mocked in training.test.js via jest.mock().
 */
const express = require("express");
const errorHandler = require("../../middleware/error");

const trainingModuleRoutes   = require("../../routes/trainingModule");
const trainingAssignRoutes   = require("../../routes/trainingAssignment");
const trainingProgressRoutes = require("../../routes/trainingProgress");
const trainingReportRoutes   = require("../../routes/trainingReport");

const app = express();
app.use(express.json());

app.use("/api/v1/training-modules",      trainingModuleRoutes);
app.use("/api/v1/training-assignments",  trainingAssignRoutes);
app.use("/api/v1/training-progress",     trainingProgressRoutes);
app.use("/api/v1/training-reports",      trainingReportRoutes);

app.use(errorHandler);

module.exports = app;
