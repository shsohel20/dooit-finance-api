const webPush = require("web-push");
const { PUSH_NOTIFICATION_PUBLIC_KEY } = process.env;
const asyncHandler = require("../middleware/async");
const Notification = require("../models/Notification");
const { knockTheDoor } = require("../utils");
// @desc   create a single user
// @route   /api/v1/user
// @access   Public
const subscriptions = [];
const dt = {
  endpoint:
    "https://fcm.googleapis.com/fcm/send/dLP_Lb-iGUY:APA91bGVvz5NHvb0JZcpVqoJvCdSdX6te0TtC59OVZyjT_cOEl-9n4krdYEpQJUJKwEMBK5k-7jjIKK_sYAt7Wp12mhG5PZHHS7a183WqRKYj5uzPFr_EjMhZuJ8-2V9-olNmv8x_JCr",
  expirationTime: null,
  keys: {
    p256dh:
      "BJD2Ffqj9HBwXg0ugaRBRW-nS2cI34uQMMAs-n4jqPkvDtHCnaqaDsiWCDS5ccNjV_1Z2jqFw42Z4TGSuTfwQqQ",
    auth: "qieawE_A6aAeSp5CkodFGA",
  },
};

exports.subscribeNotification = asyncHandler(async (req, res, next) => {
  const subscription = req.body;
  subscriptions.push(subscription);
  const data = await Notification.create(req.body);

  res.status(201).json({
    succeed: true,
    message: "Subscription saved successfully",
    data,
  });
});

exports.sendToNotification = asyncHandler(async (req, res, next) => {
  // const { title, details, imageUrl, url } = req.body;
  // const subscriptions = await Notification.find();

  // const payload = JSON.stringify({
  //   title: title,
  //   body: details,
  //   image: imageUrl, // Additional details
  //   url: url, // Replace with your URL
  // });

  // webPush.sendNotification(dt, payload);
  // res.json({ statue: "Success", message: "Message sent to push service" });
  // Promise.all(
  //   subscriptions.map((subscription) =>
  //     webPush.sendNotification(subscription, payload)
  //   )
  // )
  //   .then(() =>
  //     res.status(200).json({ message: "Notification sent successfully" })
  //   )
  //   .catch((err) => {
  //     console.error("Error sending notification:", err);
  //     res.status(500).json({ error: "Failed to send notification" });
  //   });
  const data = await knockTheDoor(req.body);

  // const { massage } = data;

  res.status(200).json(data);
});
