const express = require("express");
const cookieParser = require("cookie-parser");

const errorHandler = require("../../middleware/error");
const productRoutes = require("../../routes/product");

const app = express();
app.use(express.json());
// Required: middleware/auth.js reads `req.cookies.token` as a fallback when no
// Bearer header is present. Without cookie-parser that throws a TypeError and
// every unauthenticated request 401s for the wrong reason. server.js:36 does
// the same, so this keeps the test app faithful to production.
app.use(cookieParser());

app.use("/api/v1/product", productRoutes);
app.use(errorHandler);

module.exports = app;
