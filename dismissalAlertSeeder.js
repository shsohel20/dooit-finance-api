const axios = require("axios");
const Alert = require("./models/Alert");

const BASE_URL = "http://4.227.188.44:8000";

const seedDismissalAlert = async (alertUid, dismissalType) => {
  try {
    // 🔒 Prevent duplicate dismissal
    const exists = await Alert.findOne({
      uid: alertUid,
      [`metadata.dismissalReports.${dismissalType}`]: { $exists: true },
    });

    if (exists) {
      console.log(`⏭ Skipped ${alertUid} (${dismissalType})`);
      return exists;
    }

    // 📡 Call API
    const { data } = await axios.post(`${BASE_URL}/dismissal_report`, {
      uid: alertUid,
      dismissal_type: dismissalType,
    });

    // 🧠 Store per dismissal type
    const alert = await Alert.findOneAndUpdate(
      { uid: alertUid },
      {
        status: "Inactive",

        activity: [
          {
            title: `Dismissal Report (${dismissalType})`,
            details:
              data.summary ||
              `Dismissal analysis completed for ${dismissalType}`,
          },
        ],

        activityNote: [
          {
            note:
              data.conclusion ||
              data.recommendation ||
              "Alert dismissed based on applicable criteria.",
          },
        ],

        $set: {
          [`metadata.dismissalReports.${dismissalType}`]: {
            ...data,
            generatedAt: new Date(),
          },
        },
      },
      { new: true }
    );

    console.log(`✅ Dismissal stored: ${alertUid} → ${dismissalType}`);
    return alert;
  } catch (error) {
    console.error(
      `❌ Dismissal Error (${alertUid} | ${dismissalType}):`,
      error.response?.data || error.message
    );
    throw error;
  }
};

module.exports = seedDismissalAlert;
