const fs = require("fs");
const mongoose = require("mongoose");
const colors = require("colors");
const dotenv = require("dotenv");
// Load env vars
dotenv.config({ path: "./config/config.env" });

const User = require("./models/User");
const Role = require("./models/Role");

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
  fs.readFileSync(`${__dirname}/_data/users.json`, "utf-8"),
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
    await Permission.deleteMany();
    await User.deleteMany();
    await Role.deleteMany();

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
