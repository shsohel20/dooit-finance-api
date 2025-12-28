const Alert = require("./models/Alert");
const seedRfiAlert = require("./rfiAlertSeeder");

const runRfiForAlerts = async () => {
  try {
    const alerts = await Alert.find({
      uid: { $exists: true },
      //riskLabel: "High", // usually RFI only for high-risk
    }).select("uid");

    console.log(`Found ${alerts.length} alerts for RFI`);

    for (const alert of alerts) {
      await seedRfiAlert(alert.uid);
    }

    console.log("✅ All RFI reports generated");
  } catch (err) {
    console.error("❌ RFI Loop Error:", err);
  }
};

module.exports = runRfiForAlerts;
