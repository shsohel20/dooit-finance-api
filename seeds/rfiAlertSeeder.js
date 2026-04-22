const axios = require("axios");
const Alert = require("../models/Alert");

const BASE_URL = "http://4.227.188.44:8000";

const seedRfiAlert = async (alertUid) => {
  try {
    // 1️⃣ Prevent duplicate RFI
    const alreadyDone = await Alert.findOne({
      uid: alertUid,
      "metadata.rfiReport": { $exists: true },
    });

    if (alreadyDone) {
      console.log(`⏭ RFI skipped (already exists): ${alertUid}`);
      return alreadyDone;
    }

    // 2️⃣ Call RFI API
    const { data } = await axios.post(`${BASE_URL}/rfi_report`, {
      uid: alertUid,
    });

    // 3️⃣ Update Alert
    const alert = await Alert.findOneAndUpdate(
      { uid: alertUid },
      {
        status: "Active",

        activity: [
          {
            title: "RFI Generated",
            details:
              data.summary ||
              "Request for Information (RFI) generated for this alert.",
          },
        ],

        activityNote: [
          {
            note:
              data.request_details ||
              data.recommendation ||
              "RFI issued. Awaiting customer response.",
          },
        ],

        metadata: {
          ...((await Alert.findOne({ uid: alertUid }))?.metadata || {}),
          rfiReport: data,
          rfiGeneratedAt: new Date(),
        },
      },
      { new: true }
    );

    console.log("✅ RFI stored:", alert.uid);
    return alert;
  } catch (error) {
    console.error(
      `❌ RFI Error (${alertUid}):`,
      error.response?.data || error.message
    );
    throw error;
  }
};

module.exports = seedRfiAlert;
