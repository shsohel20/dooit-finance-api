const nodemailer = require("nodemailer");

const sendEmail = async (options) => {
  const port = Number(process.env.SMTP_PORT) || 465;

  const transporter = await nodemailer.createTransport({
    service: process.env.SMTP_SERVICE,
    host: process.env.SMTP_HOST,
    port,
    // Port 465 uses implicit TLS (secure: true); 587/other use STARTTLS (false).
    secure: port === 465,
    auth: {
      user: process.env.SMTP_EMAIL,
      pass: process.env.SMTP_PASSWORD,
    },
  });

  // send mail with defined transport object
  const message = {
    from: `"${process.env.FROM_NAME}" <${process.env.FROM_EMAIL}>`,
    to: options.email,
    subject: options.subject,
    //text: options.message,
    html: options.message, // html body
  };

  await transporter.sendMail(message);
};

module.exports = sendEmail;
