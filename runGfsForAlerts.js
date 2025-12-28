const Alert = require("./models/Alert");
const seedGfsAlert = require("./gfsAlertSeeder");

const runGfsForAlerts = async () => {
  try {
    const alerts = await Alert.find({
      uid: { $exists: true },
      status: { $in: ["Pending", "Active"] },
    }).select("uid");

    console.log(`Found ${alerts.length} alerts for GFS`);

    for (const alert of alerts) {
      await seedGfsAlert(alert.uid);
    }

    console.log("✅ All GFS reports generated");
  } catch (err) {
    console.error("❌ GFS Loop Error:", err);
  }
};

module.exports = runGfsForAlerts;
