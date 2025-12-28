const axios = require("axios");
const Alert = require("./models/Alert");

const BASE_URL = "http://4.227.188.44:8000";

const seedGfsAlert = async (alertUid) => {
  try {
    // 1️⃣ Prevent duplicate GFS
    const alreadyDone = await Alert.findOne({
      uid: alertUid,
      "metadata.gfsReport": { $exists: true },
    });

    if (alreadyDone) {
      console.log(`⏭ GFS skipped (already exists): ${alertUid}`);
      return alreadyDone;
    }

    // 2️⃣ Call GFS API
    const { data } = await axios.post(`${BASE_URL}/gfs_report`, {
      uid: alertUid,
    });

    // 3️⃣ Update Alert
    const alert = await Alert.findOneAndUpdate(
      { uid: alertUid },
      {
        status: "Active",

        activity: [
          {
            title: "GFS Analysis",
            details:
              data.summary ||
              "Global Financial Screening (GFS) report generated",
          },
        ],

        activityNote: [
          {
            note:
              data.recommendation ||
              "GFS screening completed. Review required if matches detected.",
          },
        ],

        metadata: {
          ...((await Alert.findOne({ uid: alertUid }))?.metadata || {}),
          gfsReport: data,
          gfsGeneratedAt: new Date(),
        },
      },
      { new: true }
    );

    console.log("✅ GFS stored:", alert.uid);
    return alert;
  } catch (error) {
    console.error(
      `❌ GFS Error (${alertUid}):`,
      error.response?.data || error.message
    );
    throw error;
  }
};

module.exports = seedGfsAlert;
