const axios = require("axios");
const Alert = require("./models/Alert");

const BASE_URL = "http://4.227.188.44:8000";

const riskScoreFromFlags = ({ pep_flag, sanction_flag }) => {
  if (pep_flag || sanction_flag) return 90;
  return 75; // default high risk for SMR
};

const riskLabelFromScore = (score) => {
  if (score >= 85) return "High";
  if (score >= 60) return "Medium";
  return "Low";
};

const seedEcddAlert = async (alertUid) => {
  try {
    // 1️⃣ Call external API
    const { data } = await axios.post(`${BASE_URL}/ecdd_report`, {
      uid: alertUid,
    });

    // 2️⃣ Calculate risk
    const riskScore = riskScoreFromFlags(data);
    const riskLabel = riskLabelFromScore(riskScore);

    // 3️⃣ Update alert
    const alert = await Alert.findOneAndUpdate(
      { uid: alertUid },
      {
        caseType: data.recommendation_type || "ECDD",
        riskScore,
        riskLabel,

        activity: [
          {
            title: "ECDD Profile Summary",
            details: data.profile_summary,
          },
          {
            title: "Transaction Analysis",
            details: data.transaction_analysis,
          },
        ],

        activityNote: [
          {
            note: data.recommendation,
          },
        ],

        metadata: {
          ecddReport: data, // 🔥 store full response
          source: "ECDD_API",
          fetchedAt: new Date(),
        },

        status: "Active",
      },
      { new: true }
    );

    console.log("✅ ECDD Alert stored:", alert.uid);
    return alert;
  } catch (error) {
    console.error("❌ ECDD Seeder Error:", error.message);
    throw error;
  }
};

module.exports = seedEcddAlert;
