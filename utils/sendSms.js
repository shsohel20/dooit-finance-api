const nodemailer = require("nodemailer");

const sendSMS = async (phone, message) => {
  console.log("Send SMS to", phone);
  console.log("SMS", message);

  return true;
};

module.exports = sendSMS;
