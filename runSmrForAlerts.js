const Alert = require("./models/Alert");
const seedSmrAlert = require("./smrAlertSeeder");

const runSmrForAlerts = async () => {
  try {
    const alerts = await Alert.find({
      uid: { $exists: true },
      //   caseType: "SMR", // or filter by riskLabel: "High"
    }).select("uid");

    console.log(`Found ${alerts.length} SMR alerts`);

    for (const alert of alerts) {
      await seedSmrAlert(alert.uid);
    }

    console.log("✅ All SMR reports generated");
  } catch (err) {
    console.error("❌ SMR Loop Error:", err);
  }
};

module.exports = runSmrForAlerts;
