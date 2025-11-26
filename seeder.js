const fs = require("fs");
const mongoose = require("mongoose");
const colors = require("colors");
const dotenv = require("dotenv");
// Load env vars
dotenv.config({ path: "./config/config.env" });

const User = require("./models/User");
const Role = require("./models/Role");
const Counter = require("./models/Counter");
const Customer = require("./models/Customer");
const Client = require("./models/Client");

// Connect to DB
mongoose.connect(process.env.MONGO_URI);

// Read JSON files
// const bootcamps = JSON.parse(
//   fs.readFileSync(`${__dirname}/_data/bootcamps.json`, 'utf-8')
// );
// const courses = JSON.parse(
//   fs.readFileSync(`${__dirname}/_data/courses.json`, 'utf-8')
// );

const users = JSON.parse(
  fs.readFileSync(`${__dirname}/_data/users.json`, "utf-8")
);
// const permissions = JSON.parse(
//   fs.readFileSync(`${__dirname}/_data/permissions.json`, "utf-8"),
// );
// const roles = JSON.parse(
//   fs.readFileSync(`${__dirname}/_data/roles.json`, "utf-8"),
// );

// Import into DB
const importData = async () => {
  try {
    await User.create(users);
    // await Permission.create(permissions);
    // await Role.create(roles);
    // await Course.create(courses);

    console.log("Data Imported...".green.inverse);
    process.exit();
  } catch (err) {
    console.error(err);
  }
};

// Delete data
const deleteData = async () => {
  try {
    // await Bootcamp.deleteMany();
    // await Course.deleteMany();
    // await ProductCategory.deleteMany();
    // await ProductSubCategory.deleteMany();
    // await Attribute.deleteMany();
    //await Permission.deleteMany();
    // await User.deleteMany();
    // await Role.deleteMany();
    // const resetSequence = async () => {
    //   await Counter.findOneAndUpdate(
    //     { _id: "transaction_sequence" },
    //     { $set: { sequence: 1000 } }, // Start from 1000 or your desired number
    //     { upsert: true }
    //   );
    // };
    // await resetSequence();

    // const customers = await Customer.find().select("_id").lean();

    // let counter = 1;

    // // Helper sleep function
    // const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    // for (const c of customers) {
    //   const uid = `CUS_${Date.now()}`;

    //   await Customer.updateOne({ _id: c._id }, { $set: { uid } });

    //   console.log(`Updated: ${c._id} -> ${uid}`);

    //   counter++;

    //   // Wait 1 second before next update
    //   await sleep(1000);
    // }

    var docs = await Client.find({}).sort({ _id: 1 }).limit(100).lean();

    // 2. If less than 100 docs exist, nothing to delete
    if (docs.length < 100) {
      console.log("Collection has fewer than 100 documents — nothing deleted.");
    } else {
      // 3. Get the last ID you want to keep
      var keepId = docs[99]._id;

      // 4. Delete all documents except the first 100
      var result = await Client.deleteMany({ _id: { $gt: keepId } });

      console.log("Deleted docs:", result.deletedCount);
    }
    console.log("Data Destroyed...".red.inverse);
    process.exit();
  } catch (err) {
    console.error(err);
  }
};

if (process.argv[2] === "-i") {
  importData();
} else if (process.argv[2] === "-d") {
  deleteData();
}
