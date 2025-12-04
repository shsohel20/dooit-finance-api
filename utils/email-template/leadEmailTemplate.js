// utils/leadEmailTemplate.js
function escapeHtml(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function leadAdminHtml(lead) {
  return `
    <div style="font-family: Arial, sans-serif; color:#111">
      <h2>New lead received</h2>
      <p><strong>Name:</strong> ${escapeHtml(lead.firstName)} ${escapeHtml(
    lead.lastName
  )}</p>
      <p><strong>Email:</strong> ${escapeHtml(lead.email)}</p>
      <p><strong>Phone:</strong> ${escapeHtml(lead.phoneNumber)}</p>
      <p><strong>Business:</strong> ${escapeHtml(
        lead.businessName
      )} (${escapeHtml(lead.industry)})</p>
      <p><strong>Zip:</strong> ${escapeHtml(
        lead.zipCode
      )} | <strong>Revenue:</strong> ${escapeHtml(lead.annualRevenue)}</p>
      <p><strong>Consent:</strong> ${lead.consent ? "Yes" : "No"}</p>
      <hr/>
      <p>Submitted: ${new Date(
        lead.createdAt || Date.now()
      ).toLocaleString()}</p>
      <p>Source: ${escapeHtml(lead.source || "web-form")}</p>
    </div>
    `;
}

function leadUserHtml(lead) {
  return `
    <div style="font-family: Arial, sans-serif; color:#111">
      <h2>Thanks — we received your enquiry</h2>
      <p>Hi ${escapeHtml(lead.firstName)},</p>
      <p>Thanks for contacting us about <strong>${escapeHtml(
        lead.businessName || "your enquiry"
      )}</strong>. We’ve received your submission and someone from the team will contact you shortly.</p>
      <p>Summary:</p>
      <ul>
        <li>Email: ${escapeHtml(lead.email)}</li>
        <li>Phone: ${escapeHtml(lead.phoneNumber)}</li>
        <li>Industry: ${escapeHtml(lead.industry)}</li>
        <li>Annual revenue: ${escapeHtml(lead.annualRevenue)}</li>
      </ul>
      <p>If you need urgent help, reply to this email.</p>
      <p>Regards,<br/>The Team</p>
    </div>
    `;
}

function leadText(lead) {
  return `New lead: ${lead.firstName} ${lead.lastName} — ${lead.email} — ${
    lead.phoneNumber
  }. Business: ${lead.businessName} (${lead.industry}). Revenue: ${
    lead.annualRevenue
  }. Consent: ${lead.consent ? "Yes" : "No"}.`;
}

module.exports = { leadAdminHtml, leadUserHtml, leadText };
