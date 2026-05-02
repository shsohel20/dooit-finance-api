// utils/email-template/contactEmailTemplate.js
function escapeHtml(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function contactAdminHtml(contact) {
  return `
    <div style="font-family: Arial, sans-serif; color:#111">
      <h2>New contact / support message</h2>
      <p><strong>Name:</strong> ${escapeHtml(contact.name)}</p>
      <p><strong>Email:</strong> ${escapeHtml(contact.email)}</p>
      <p><strong>Subject:</strong> ${escapeHtml(contact.subject)}</p>
      <p><strong>Message:</strong></p>
      <blockquote style="border-left:3px solid #ccc;padding-left:12px;color:#444">
        ${escapeHtml(contact.message)}
      </blockquote>
      <hr/>
      <p>Submitted: ${new Date(
        contact.createdAt || Date.now()
      ).toLocaleString()}</p>
      <p>Source: ${escapeHtml(
        (contact.utm && contact.utm.source) || "contact-form"
      )}</p>
    </div>
  `;
}

function contactUserHtml(contact) {
  return `
    <div style="font-family: Arial, sans-serif; color:#111">
      <h2>We received your message</h2>
      <p>Hi ${escapeHtml(contact.name)},</p>
      <p>Thanks for reaching out. We've received your message about <strong>${escapeHtml(
        contact.subject
      )}</strong> and will get back to you as soon as possible.</p>
      <p>Your message:</p>
      <blockquote style="border-left:3px solid #ccc;padding-left:12px;color:#444">
        ${escapeHtml(contact.message)}
      </blockquote>
      <p>If you need urgent assistance, reply directly to this email.</p>
      <p>Regards,<br/>The Team</p>
    </div>
  `;
}

function contactText(contact) {
  return `New contact from ${contact.name} (${contact.email}). Subject: ${contact.subject}. Message: ${contact.message}`;
}

module.exports = { contactAdminHtml, contactUserHtml, contactText };
