const InvitationEmailTemplate = (companyName, inviteLink) => {
  return `<!DOCTYPE html>
<html lang="en" style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>You're Invited!</title>
    <style>
      body {
        background-color: #f8f9fb;
        margin: 0;
        padding: 0;
        color: #333333;
        font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
      }
      .container {
        max-width: 600px;
        background: #ffffff;
        margin: 30px auto;
        padding: 40px;
        border-radius: 12px;
        box-shadow: 0 4px 10px rgba(0,0,0,0.08);
      }
      .logo {
        text-align: center;
        margin-bottom: 20px;
      }
      .logo h1 {
        color: #4caf50;
        font-size: 28px;
        margin: 0;
      }
      .content {
        line-height: 1.6;
        font-size: 16px;
      }
      .btn {
        display: inline-block;
        background-color: #4caf50;
        color: #ffffff;
        text-decoration: none;
        padding: 12px 24px;
        border-radius: 6px;
        margin-top: 20px;
        font-weight: 600;
      }
      .btn:hover {
        background-color: #43a047;
      }
      .footer {
        text-align: center;
        font-size: 13px;
        color: #999999;
        margin-top: 40px;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="logo">
        <h1>${companyName}</h1>
      </div>

      <div class="content">
        <h2>Hello,</h2>
        <p>
          You've been invited by <strong>${companyName}</strong> to create your account on our platform.
        </p>
        <p>
          Please click the button below to complete your registration and get started.
        </p>

        <p style="text-align: center;">
          <a href="${inviteLink}" class="btn">Accept Invitation</a>
        </p>

        <p>
          If the button doesn’t work, you can copy and paste this link into your browser:<br />
          <a href="${inviteLink}">${inviteLink}</a>
        </p>

        <p>Thank you,<br />The <strong>${companyName}</strong> Team</p>
      </div>

      <div class="footer">
        &copy; 2025 ${companyName}. All rights reserved.
      </div>
    </div>
  </body>
</html>`;
};
module.exports = InvitationEmailTemplate;
