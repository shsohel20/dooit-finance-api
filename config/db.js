const mongoose = require("mongoose");

// const mysql = require("mysql");
// const db = mysql.createConnection({
//   host: "localhost",
//   user: "ziggasa",
//   password: "123456",
//   database: "ziggasa",
// });

// const mysqlConnect = () => {
//   db.connect(function (err) {
//     if (err) {
//       console.error("error connecting: " + err.stack);
//       return;
//     }

//     console.log(`"connected as id " + ${db.threadId}`.bgBlue);
//   });
// };

const connectDB = async () => {
  //r  mongoose.set("debug", true);
  mongoose.set("strictQuery", true);
  const conn = await mongoose.connect(process.env.MONGO_URI);
  //console.log(`MongoDB connected :${conn.connection.host}`.underline.bgRed);
  console.log(`MongoDB connected: Welcome to Programmer Sohel`.bgRed.underline);
};

module.exports = { connectDB };
