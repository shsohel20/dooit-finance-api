const express = require("express");

const {
  subscribeNotification,
  sendToNotification,
} = require("../controllers/notificationController");

const router = express.Router();

// router
//   .route("/")
//   .post(advancedResults(Keyword, [], filterKeywordSection), getKeywords)
//   .get(advancedResults(Keyword), getKeywords);

router.route("/subscribe-notification").post(subscribeNotification);
router.route("/send-notification").post(sendToNotification);

module.exports = router;
