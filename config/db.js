const mongoose = require("mongoose");

const connectDB = async () => {
  mongoose.set("debug", true);
  mongoose.set("strictQuery", true);
  const conn = await mongoose.connect(process.env.MONGO_URI);
  //console.log(`MongoDB connected :${conn.connection.host}`.underline.bgRed);
  console.log(`MongoDB connected: Welcome to Programmer Sohel`.bgRed.underline);
};

module.exports = { connectDB };
