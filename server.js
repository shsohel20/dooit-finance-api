const path = require("path");
const express = require("express");
const dotenv = require("dotenv");
const colors = require("colors");
// const upload = require("express-fileupload");
const errorHandler = require("./middleware/error");
const morgan = require("morgan");
const cloudinary = require("cloudinary").v2;
// const webPush = require("web-push");
const swaggerUi = require("swagger-ui-express");
const swaggerDocument = require("./swagger-output.json");

dotenv.config({ path: "./config/config.env" });
// const bodyParser = require("body-parser");
const cookieParser = require("cookie-parser");

const routes = require("./routes");

const cors = require("cors");
const { connectDB } = require("./config/db");

// const mongoSanitize = require("express-mongo-sanitize");
const helmet = require("helmet");
// const xss = require("xss-filters");
// const rateLimit = require("express-rate-limit");
const hpp = require("hpp");
const { CLOUDINARY_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } =
  process.env;
//Custom Environment File Run
///Database Connection Run
connectDB();
// mysqlConnect();
const app = express();
// Behind a reverse proxy / load balancer: trust the first hop so req.ip
// resolves to the real client address (device & audit telemetry rely on it).
app.set("trust proxy", 1);
// app.use(bodyParser.urlencoded({ extended: true }));
// app.use(bodyParser.json());
app.use(cookieParser());
//using cors
app.use(
  cors({
    origin: true, // reflect request origin//origin from where you requesting
    credentials: true,
  }),
);

// app.use(express.json({ limit: "10mb" })); no need at moment, we are using inside route level
app.use(express.urlencoded({ extended: true }));
// app.use(mongoSanitize());

///Middle Run when Development State
if (process.env.NODE_ENV === "development") {
  app.use(morgan("dev"));
}

cloudinary.config({
  cloud_name: CLOUDINARY_NAME,
  api_key: CLOUDINARY_API_KEY,
  api_secret: CLOUDINARY_API_SECRET,
  secure: true,
});
///File Upload
// app.use(upload({ useTempFiles: true }));
//Make static path to access publicly
app.use(express.static(path.join(__dirname, "public")));

// To Sanitize Data

///use for Secure Header
app.use(helmet());

///secure Http polution
app.use(hpp());
///Mount File Upload Route
app.use("/api/v1", routes);

//SwaggerUI Docs

app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerDocument));

///Handle Error
app.use(errorHandler);
///Server Port
const PORT = process.env.PORT || 5000;

///Server Run Method
const server = app.listen(
  PORT,
  console.log(
    `Serer running in ${process.env.NODE_ENV} mode on port ${PORT}`.yellow,
  ),
);

// CRA periodic-review reminders (N_020 due-soon / N_021 overdue daily)
const { startCraReviewNotificationJob } = require("./utils/craReviewNotifications");
startCraReviewNotificationJob();

// Billing cycle — closes ended periods into draft invoices, rolls subscriptions
// forward, expires cancel-at-period-end ones and flags overdue invoices.
// Produces DRAFTS only unless BILLING_AUTO_ISSUE=true.
const { startBillingCycleJob } = require("./services/billing/billingCycleJob");
startBillingCycleJob();

//Handle unhandled promise rejection
process.on("unhandledRejection", (err, promise) => {
  console.log(`Error: ${err.message}`.red);
  //Close server & exit process
  server.close(() => process.exit(1));
});
