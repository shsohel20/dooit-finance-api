const Alert = require("./models/Alert");
const seedDismissalAlert = require("./dismissalAlertSeeder");
const dismissalTypes = require("./dismissalTypes");

const runDismissalForAlerts = async () => {
  try {
    const alerts = await Alert.find({
      uid: { $exists: true },
      status: { $ne: "Blocked" },
    }).select("uid");

    console.log(`Found ${alerts.length} alerts`);

    for (const alert of alerts) {
      for (const category of Object.keys(dismissalTypes)) {
        for (const type of dismissalTypes[category]) {
          await seedDismissalAlert(alert.uid, type);
        }
      }
    }

    console.log("✅ All dismissal reports generated");
  } catch (err) {
    console.error("❌ Dismissal Loop Error:", err);
  }
};

module.exports = runDismissalForAlerts;
