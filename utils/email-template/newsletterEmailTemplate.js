// utils/email-template/newsletterEmailTemplate.js
function escapeHtml(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function newsletterAdminHtml(sub) {
  return `
    <div style="font-family: Arial, sans-serif; color:#111">
      <h2>New newsletter subscriber</h2>
      <p><strong>Email:</strong> ${escapeHtml(sub.email)}</p>
      <hr/>
      <p>Subscribed: ${new Date(sub.createdAt || Date.now()).toLocaleString()}</p>
      <p>Source: ${escapeHtml(
        (sub.utm && sub.utm.source) || "footer-form"
      )}</p>
    </div>
  `;
}

function newsletterUserHtml(sub) {
  return `
    <div style="font-family: Arial, sans-serif; color:#111">
      <h2>You're subscribed!</h2>
      <p>Hi there,</p>
      <p>Thanks for subscribing to our newsletter. We'll keep you posted on the latest news, updates, and insights.</p>
      <p>If you ever want to unsubscribe, just reply to this email and we'll take care of it.</p>
      <p>Regards,<br/>The Team</p>
    </div>
  `;
}

function newsletterText(sub) {
  return `New newsletter subscriber: ${sub.email}. Source: ${
    (sub.utm && sub.utm.source) || "footer-form"
  }.`;
}

module.exports = { newsletterAdminHtml, newsletterUserHtml, newsletterText };
