const mongoose = require("mongoose");
const { loadRiskCache } = require("../utils/riskFactorCache");

const connectDB = async () => {
  // mongoose.set("debug", true);
  mongoose.set("strictQuery", true);
  await mongoose.connect(process.env.MONGO_URI);
  //console.log(conn);
  //console.log(`MongoDB connected :${conn.connection.host}`.underline.bgRed);
  await loadRiskCache();
  console.log(`MongoDB connected: Welcome to Programmer Sohel`.bgRed.underline);
};

module.exports = { connectDB };
