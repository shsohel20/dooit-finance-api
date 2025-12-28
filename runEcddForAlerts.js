const mongoose = require("mongoose");

const seedEcddAlert = require("./ecddAlertSeeder");
const Alert = require("./models/Alert");

// optional: connect if this is a standalone script
// await mongoose.connect(process.env.MONGO_URI);

const runEcddForAlerts = async () => {
  try {
    // 🔹 get alerts that need ECDD (filter as needed)
    const alerts = await Alert.find({
      uid: { $exists: true },
    }).select("uid");

    console.log(`Found ${alerts.length} alerts`);

    for (const alert of alerts) {
      if (!alert.uid) continue;

      console.log(`Processing alert: ${alert.uid}`);

      await seedEcddAlert(alert.uid);
    }

    console.log("✅ All alerts processed");
  } catch (error) {
    console.error("❌ Loop Error:", error);
  }
};

module.exports = runEcddForAlerts;
