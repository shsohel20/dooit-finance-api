const path = require("path");
const express = require("express");
const dotenv = require("dotenv");
const colors = require("colors");
const upload = require("express-fileupload");
const errorHandler = require("./middleware/error");
const morgan = require("morgan");
const cloudinary = require("cloudinary").v2;
// const webPush = require("web-push");

dotenv.config({ path: "./config/config.env" });
const bodyParser = require("body-parser");
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
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(cookieParser());
//using cors
app.use(
  cors({
    origin: true, // reflect request origin//origin from where you requesting
    credentials: true,
  })
);

app.use(express.json());
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
app.use(upload({ useTempFiles: true }));
//Make static path to access publicly
app.use(express.static(path.join(__dirname, "public")));

// To Sanitize Data

///use for Secure Header
app.use(helmet());

///secure Http polution
app.use(hpp());
///Mount File Upload Route
app.use("/api/v1", routes);
///Handle Error
app.use(errorHandler);

///Server Port
const PORT = process.env.PORT || 5000;

///Server Run Method
const server = app.listen(
  PORT,
  console.log(
    `Serer running in ${process.env.NODE_ENV} mode on port ${PORT}`.yellow
  )
);

//Handle unhandled promise rejection
process.on("unhandledRejection", (err, promise) => {
  console.log(`Error: ${err.message}`.red);
  //Close server & exit process
  server.close(() => process.exit(1));
});
