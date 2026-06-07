// utils/rfiTemplates.js
/**
 * Enhanced RFI Templates with HTML email support
 * Placeholder list used in templates:
 * {{Client_Name}}  {{Customer_Name}}  {{Case_Number}}  {{UID}}  {{Requested_Items_Bulleted}}
 * {{Primary_Contact_Name}}  {{Reply_To_Email}}  {{Response_Deadline}}  {{Followup_Deadline}}  {{Final_Deadline}}
 * {{Initial_Request_Date}}  {{Current_Date}}
 */

const templates = {
  initial: {
    subject: "Request for information – {{Case_Number}} ({{Customer_Name}})",
    body: `Hi {{Primary_Contact_Name}},
  
As part of our standard review for {{Customer_Name}} (UID {{UID}}, case {{Case_Number}}), please provide the information below within 14 calendar days (by {{Response_Deadline}}):

{{Requested_Items_Bulleted}}

You can reply to {{Reply_To_Email}} with documents or clarifications. If an item is unavailable, please note the reason and an expected date.

Kind regards,

Compliance Team

{{Client_Name}}`,
  },

  followup: {
    subject:
      "Follow-up: outstanding information – {{Case_Number}} ({{Customer_Name}})",
    body: `Hi {{Primary_Contact_Name}},
  
This is a reminder for {{Customer_Name}} (UID {{UID}}, case {{Case_Number}}). The items below remain outstanding. Please provide them within 7 calendar days (by {{Followup_Deadline}}):

{{Requested_Items_Bulleted}}

Absent a response, we may apply temporary limits or defer activity in line with our policy.

Thanks,

Compliance Team

{{Client_Name}}`,
  },

  final: {
    subject:
      "Final notice: action required – {{Case_Number}} ({{Customer_Name}})",
    body: `Hi {{Primary_Contact_Name}},
  
Final notice for {{Customer_Name}} (UID {{UID}}, case {{Case_Number}}). Please provide the items below within 7 calendar days (by {{Final_Deadline}}):

{{Requested_Items_Bulleted}}

If we don't receive the information by the deadline, we may suspend related activity and/or take further action in line with our obligations.

Regards,

Compliance Team

{{Client_Name}}`,
  },
};

// Professional templates with enhanced content
const professionalTemplates = {
  initial: {
    subject:
      "Compliance Information Request - Case {{Case_Number}} - {{Customer_Name}}",
    body: `Dear {{Primary_Contact_Name}},

RE: Compliance Review for {{Customer_Name}} (Case: {{Case_Number}}, UID: {{UID}})

As part of our ongoing compliance monitoring program, we require additional information to complete our review of {{Customer_Name}}.

Please provide the following documents/information by {{Response_Deadline}}:

{{Requested_Items_Bulleted}}

Submission Instructions:
• Email response to: {{Reply_To_Email}}
• Format: PDF or clear scanned copies
• For unavailable items: Please provide explanation and expected availability date

This information is required to maintain compliance with regulatory requirements and our internal policies.

Should you have any questions or require clarification, please contact us at your earliest convenience.

Sincerely,

Compliance Department
{{Client_Name}}`,
  },

  followup: {
    subject:
      "URGENT: Outstanding Compliance Requirements - Case {{Case_Number}} - {{Customer_Name}}",
    body: `Dear {{Primary_Contact_Name}},

RE: SECOND REQUEST - Compliance Information for {{Customer_Name}} (Case: {{Case_Number}})

We note that the following requested items remain outstanding from our initial communication dated {{Initial_Request_Date}}:

{{Requested_Items_Bulleted}}

Final Submission Deadline: {{Followup_Deadline}}

Important: Failure to provide the requested information may result in:
• Temporary restrictions on account activities
• Compliance holds on transactions
• Escalation to senior management

Please prioritize this request and provide the outstanding items by the deadline above.

We are available to discuss any challenges you may be facing in gathering this information.

Regards,

Compliance Department  
{{Client_Name}}`,
  },

  final: {
    subject:
      "FINAL NOTICE: Compliance Action Required - Case {{Case_Number}} - {{Customer_Name}}",
    body: `Dear {{Primary_Contact_Name}},

RE: FINAL NOTICE - Compliance Requirements for {{Customer_Name}} (Case: {{Case_Number}}, UID: {{UID}})

This constitutes our final request for the following outstanding compliance items:

{{Requested_Items_Bulleted}}

Absolute Deadline: {{Final_Deadline}}

IMMEDIATE ACTION REQUIRED

Failure to comply by the specified deadline will result in:
• Immediate suspension of related business activities
• Formal escalation to regulatory compliance committee
• Potential account restrictions as per our compliance framework

This is your final opportunity to resolve this matter before enforcement actions are implemented.

To avoid these consequences, please provide all outstanding information by {{Final_Deadline}}.

Sincerely,

Compliance Department
{{Client_Name}}

cc: Senior Compliance Officer`,
  },
};

/**
 * HTML Email Templates with responsive design
 */
const sharedEmailStyles = `
    *{margin:0;padding:0;box-sizing:border-box}
    body{background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:#0f172a}
    .wrap{padding:40px 16px}
    .card{max-width:600px;margin:0 auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08)}
    .hdr{padding:32px 40px;text-align:center}
    .hdr .overline{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:rgba(255,255,255,.7);margin-bottom:10px}
    .hdr h1{color:#fff;font-size:20px;font-weight:700;letter-spacing:-.3px;margin-bottom:6px}
    .hdr .sub{color:rgba(255,255,255,.75);font-size:13px}
    .body{padding:36px 40px}
    .greeting{font-size:15px;color:#1e293b;margin-bottom:20px;line-height:1.6}
    .text{font-size:14px;color:#475569;line-height:1.7;margin-bottom:16px}
    .divider{border:none;border-top:1px solid #f1f5f9;margin:24px 0}
    .section-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#94a3b8;margin-bottom:12px}
    .case-grid{display:flex;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;margin:20px 0}
    .case-cell{flex:1;padding:14px 18px;background:#f8fafc;border-right:1px solid #e2e8f0}
    .case-cell:last-child{border-right:none}
    .cell-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:#94a3b8;margin-bottom:4px}
    .cell-value{font-size:13px;color:#1e293b;font-weight:600}
    .items-box{background:#f8fafc;border-radius:8px;padding:20px;margin:20px 0;border:1px solid #e2e8f0}
    .items-box h3{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:#64748b;margin-bottom:14px}
    .items-list{list-style:none}
    .items-list li{display:flex;align-items:flex-start;gap:10px;padding:10px 0;border-bottom:1px solid #f1f5f9;font-size:14px;color:#374151;line-height:1.5}
    .items-list li:last-child{border-bottom:none}
    .item-dot{flex-shrink:0;width:20px;height:20px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;line-height:1}
    .deadline-box{border-left:4px solid;border-radius:0 8px 8px 0;padding:18px 20px;margin:20px 0}
    .deadline-label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;margin-bottom:6px}
    .deadline-date{font-size:20px;font-weight:800;color:#0f172a}
    .consequence-box{border-radius:8px;padding:20px;margin:20px 0}
    .consequence-box h3{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;margin-bottom:12px}
    .action-row{text-align:center;margin:28px 0;display:flex;gap:12px;justify-content:center;flex-wrap:wrap}
    .btn{display:inline-block;padding:12px 24px;border-radius:7px;font-size:14px;font-weight:600;text-decoration:none;letter-spacing:-.1px}
    .btn-primary{background:#2563eb;color:#fff}
    .btn-secondary{background:#64748b;color:#fff}
    .signature{margin-top:24px;font-size:14px;color:#374151;line-height:1.7}
    .ftr{padding:20px 40px;text-align:center;border-top:1px solid #e2e8f0}
    .ftr p{color:#94a3b8;font-size:12px;line-height:1.6}
    .ftr a{color:#64748b;text-decoration:none}
    @media(max-width:600px){
      .hdr,.body{padding:24px 20px}
      .ftr{padding:16px 20px}
      .case-grid{flex-direction:column}
      .case-cell{border-right:none;border-bottom:1px solid #e2e8f0}
      .case-cell:last-child{border-bottom:none}
      .action-row{flex-direction:column;align-items:center}
      .btn{width:100%;max-width:260px;text-align:center}
    }`;

const htmlTemplates = {
  initial: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>Compliance Information Request</title>
  <style>${sharedEmailStyles}</style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="hdr" style="background:linear-gradient(135deg,#1e3a5f 0%,#2563eb 100%)">
        <div class="overline">Compliance Department</div>
        <h1>Information Request</h1>
        <div class="sub">Case: {{Case_Number}} &mdash; {{Customer_Name}}</div>
      </div>
      <div class="body">
        <p class="greeting">Dear {{Primary_Contact_Name}},</p>
        <p class="text">
          As part of our standard compliance review for <strong>{{Customer_Name}}</strong>,
          we require the following information and documentation. Please provide all items
          by the deadline stated below.
        </p>
        <div class="section-title">Case Reference</div>
        <div class="case-grid">
          <div class="case-cell">
            <div class="cell-label">Customer</div>
            <div class="cell-value">{{Customer_Name}}</div>
          </div>
          <div class="case-cell">
            <div class="cell-label">Case Number</div>
            <div class="cell-value">{{Case_Number}}</div>
          </div>
          <div class="case-cell">
            <div class="cell-label">UID</div>
            <div class="cell-value">{{UID}}</div>
          </div>
        </div>
        <hr class="divider"/>
        <div class="section-title">Items Required</div>
        <div class="items-box">
          <ul class="items-list">{{Requested_Items_HTML}}</ul>
        </div>
        <div class="deadline-box" style="background:#eff6ff;border-color:#2563eb">
          <div class="deadline-label" style="color:#2563eb">Response Deadline</div>
          <div class="deadline-date">{{Response_Deadline}}</div>
        </div>
        <div class="section-title">Submission Instructions</div>
        <p class="text">
          Please email your response to <a href="mailto:{{Reply_To_Email}}" style="color:#2563eb;font-weight:600">{{Reply_To_Email}}</a>
          with the case number in the subject line. Documents should be provided as PDF
          or clear scanned copies. If any item is unavailable, please provide a written
          explanation and expected availability date.
        </p>
        <div class="action-row">
          <a href="mailto:{{Reply_To_Email}}?subject=Compliance Response - {{Case_Number}}" class="btn btn-primary">Submit Documents</a>
          <a href="mailto:{{Reply_To_Email}}?subject=Query - {{Case_Number}}" class="btn btn-secondary">Ask a Question</a>
        </div>
        <p class="signature">
          Sincerely,<br/>
          <strong>Compliance Department</strong><br/>
          {{Client_Name}}
        </p>
      </div>
      <div class="ftr" style="background:#f8fafc">
        <p>Contact: <a href="mailto:{{Reply_To_Email}}">{{Reply_To_Email}}</a> &mdash; Case Ref: {{Case_Number}}</p>
        <p style="margin-top:10px">This email contains confidential information intended solely for the addressed recipient.<br/>If you are not the intended recipient, please notify us immediately and delete this message.</p>
      </div>
    </div>
  </div>
</body>
</html>`,

  followup: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>Compliance Follow-up Required</title>
  <style>${sharedEmailStyles}</style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="hdr" style="background:linear-gradient(135deg,#92400e 0%,#d97706 100%)">
        <div class="overline">Second Request &mdash; Compliance Department</div>
        <h1>Follow-Up Required</h1>
        <div class="sub">Case: {{Case_Number}} &mdash; {{Customer_Name}}</div>
      </div>
      <div class="body">
        <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:14px 18px;margin-bottom:24px;display:flex;gap:12px;align-items:flex-start">
          <span style="font-size:18px;flex-shrink:0">&#9888;&#65039;</span>
          <div>
            <strong style="font-size:14px;color:#92400e">Urgent Attention Required</strong><br/>
            <span style="font-size:13px;color:#b45309">Items from our initial request dated {{Initial_Request_Date}} remain outstanding.</span>
          </div>
        </div>
        <p class="greeting">Dear {{Primary_Contact_Name}},</p>
        <p class="text">
          We note that the following items remain outstanding from our initial compliance
          communication. Please provide them by the deadline below to avoid any impact
          on account activities.
        </p>
        <div class="section-title">Case Reference</div>
        <div class="case-grid">
          <div class="case-cell">
            <div class="cell-label">Customer</div>
            <div class="cell-value">{{Customer_Name}}</div>
          </div>
          <div class="case-cell">
            <div class="cell-label">Case Number</div>
            <div class="cell-value">{{Case_Number}}</div>
          </div>
          <div class="case-cell">
            <div class="cell-label">UID</div>
            <div class="cell-value">{{UID}}</div>
          </div>
        </div>
        <hr class="divider"/>
        <div class="section-title">Outstanding Items</div>
        <div class="items-box">
          <ul class="items-list">{{Requested_Items_HTML}}</ul>
        </div>
        <div class="deadline-box" style="background:#fffbeb;border-color:#d97706">
          <div class="deadline-label" style="color:#d97706">Submission Deadline</div>
          <div class="deadline-date">{{Followup_Deadline}}</div>
        </div>
        <div class="consequence-box" style="background:#fef3c7;border:1px solid #fde68a">
          <h3 style="color:#92400e">Non-Compliance May Result In:</h3>
          <ul class="items-list">
            <li><span class="item-dot" style="background:#fde68a;color:#92400e">&#8226;</span><span>Temporary restrictions on account activities</span></li>
            <li><span class="item-dot" style="background:#fde68a;color:#92400e">&#8226;</span><span>Compliance holds on transactions</span></li>
            <li><span class="item-dot" style="background:#fde68a;color:#92400e">&#8226;</span><span>Escalation to senior management</span></li>
          </ul>
        </div>
        <p class="text">We are available to discuss any challenges you face in gathering this information.</p>
        <div class="action-row">
          <a href="mailto:{{Reply_To_Email}}?subject=Compliance Response - {{Case_Number}}" class="btn btn-primary">Submit Documents</a>
          <a href="mailto:{{Reply_To_Email}}?subject=Discussion Required - {{Case_Number}}" class="btn btn-secondary">Request a Discussion</a>
        </div>
        <p class="signature">
          Regards,<br/>
          <strong>Compliance Department</strong><br/>
          {{Client_Name}}
        </p>
      </div>
      <div class="ftr" style="background:#f8fafc">
        <p>Contact: <a href="mailto:{{Reply_To_Email}}">{{Reply_To_Email}}</a> &mdash; Case Ref: {{Case_Number}}</p>
        <p style="margin-top:10px">This email contains confidential information intended solely for the addressed recipient.<br/>If you are not the intended recipient, please notify us immediately and delete this message.</p>
      </div>
    </div>
  </div>
</body>
</html>`,

  final: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>Final Compliance Notice</title>
  <style>${sharedEmailStyles}</style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="hdr" style="background:linear-gradient(135deg,#7f1d1d 0%,#dc2626 100%)">
        <div class="overline">Final Notice &mdash; Compliance Department</div>
        <h1>Immediate Action Required</h1>
        <div class="sub">Case: {{Case_Number}} &mdash; {{Customer_Name}}</div>
      </div>
      <div class="body">
        <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:14px 18px;margin-bottom:24px;display:flex;gap:12px;align-items:flex-start">
          <span style="font-size:18px;flex-shrink:0">&#128721;</span>
          <div>
            <strong style="font-size:14px;color:#991b1b">Final Notice — Immediate Response Required</strong><br/>
            <span style="font-size:13px;color:#b91c1c">This is your final opportunity to provide the requested compliance information before enforcement actions are implemented.</span>
          </div>
        </div>
        <p class="greeting">Dear {{Primary_Contact_Name}},</p>
        <p class="text">
          This constitutes our final request for outstanding compliance documentation for
          <strong>{{Customer_Name}}</strong>. We have not received the required information
          despite previous communications. You must provide all items by the absolute deadline below.
        </p>
        <div class="section-title">Case Reference</div>
        <div class="case-grid">
          <div class="case-cell">
            <div class="cell-label">Customer</div>
            <div class="cell-value">{{Customer_Name}}</div>
          </div>
          <div class="case-cell">
            <div class="cell-label">Case Number</div>
            <div class="cell-value">{{Case_Number}}</div>
          </div>
          <div class="case-cell">
            <div class="cell-label">UID</div>
            <div class="cell-value">{{UID}}</div>
          </div>
        </div>
        <hr class="divider"/>
        <div class="section-title">Outstanding Items</div>
        <div class="items-box">
          <ul class="items-list">{{Requested_Items_HTML}}</ul>
        </div>
        <div class="deadline-box" style="background:#fef2f2;border-color:#dc2626">
          <div class="deadline-label" style="color:#dc2626">Absolute Deadline</div>
          <div class="deadline-date">{{Final_Deadline}}</div>
        </div>
        <div class="consequence-box" style="background:#fef2f2;border:1px solid #fecaca">
          <h3 style="color:#991b1b">Failure to Comply Will Result In:</h3>
          <ul class="items-list">
            <li><span class="item-dot" style="background:#fecaca;color:#991b1b">&#8226;</span><span>Immediate suspension of related business activities</span></li>
            <li><span class="item-dot" style="background:#fecaca;color:#991b1b">&#8226;</span><span>Formal escalation to the regulatory compliance committee</span></li>
            <li><span class="item-dot" style="background:#fecaca;color:#991b1b">&#8226;</span><span>Potential account restrictions per our compliance framework</span></li>
          </ul>
        </div>
        <p class="text">
          To avoid these consequences, please provide all outstanding documentation by
          <strong>{{Final_Deadline}}</strong>. Contact us immediately if you require
          an extension or wish to discuss this matter.
        </p>
        <div class="action-row">
          <a href="mailto:{{Reply_To_Email}}?subject=FINAL RESPONSE - {{Case_Number}}" class="btn btn-primary" style="background:#dc2626">Submit Documents Now</a>
          <a href="mailto:{{Reply_To_Email}}?subject=Urgent Discussion - {{Case_Number}}" class="btn btn-secondary">Contact Compliance Team</a>
        </div>
        <p class="signature">
          Sincerely,<br/>
          <strong>Compliance Department</strong><br/>
          {{Client_Name}}<br/>
          <span style="font-size:12px;color:#64748b">cc: Senior Compliance Officer</span>
        </p>
      </div>
      <div class="ftr" style="background:#f8fafc">
        <p>Contact: <a href="mailto:{{Reply_To_Email}}">{{Reply_To_Email}}</a> &mdash; Case Ref: {{Case_Number}}</p>
        <p style="margin-top:10px">This email contains confidential information intended solely for the addressed recipient.<br/>If you are not the intended recipient, please notify us immediately and delete this message.</p>
      </div>
    </div>
  </div>
</body>
</html>`,
};

/**
 * Fill placeholders simply by string replace.
 * Keep requestedItems as bulleted list (≤ 8 items recommended).
 */
function fillTemplate(type = "initial", context = {}) {
  const tpl = templates[type];
  if (!tpl) throw new Error("Unknown template type");

  const subject = replacePlaceholders(tpl.subject, context);
  const body = replacePlaceholders(tpl.body, context);
  return { subject, body };
}

/**
 * Fill professional templates with enhanced formatting
 */
function fillProfessionalTemplate(type = "initial", context = {}) {
  const tpl = professionalTemplates[type];
  if (!tpl) throw new Error("Unknown professional template type");

  const subject = replacePlaceholders(tpl.subject, context);
  const body = replacePlaceholders(tpl.body, context);

  return {
    subject,
    body,
    metadata: {
      type: type.toUpperCase(),
      caseNumber: context.caseNumber,
      customer: context.customerName,
      sentDate: new Date().toISOString().split("T")[0],
    },
  };
}

/**
 * Generate HTML email template
 */
function fillHtmlTemplate(type = "followup", context = {}) {
  const tpl = htmlTemplates[type];
  if (!tpl) throw new Error(`HTML template not available for type: ${type}`);

  let html = replacePlaceholders(tpl, context, true);

  // Build item list HTML
  const items = context.requestedItems || [];
  const itemsHtml = items
    .slice(0, 8)
    .map(
      (item) =>
        `<li><span class="item-dot" style="background:#dbeafe;color:#1d4ed8">&#8226;</span><span>${escapeHtml(
          typeof item === "string" ? item : item.text || ""
        )}</span></li>`
    )
    .join("\n");

  html = html.split("{{Requested_Items_HTML}}").join(itemsHtml);

  return {
    subject: fillProfessionalTemplate(type, context).subject,
    html,
    metadata: {
      type: `${type.toUpperCase()}_HTML`,
      caseNumber: context.caseNumber,
      customer: context.customerName,
      generated: new Date().toISOString(),
    },
  };
}

/**
 * Enhanced placeholder replacement with HTML support
 */
function replacePlaceholders(text, context, isHtml = false) {
  let out = text;

  const placeholderMap = {
    "{{Client_Name}}": context.clientName || "",
    "{{Customer_Name}}": context.customerName || "",
    "{{Case_Number}}": context.caseNumber || "",
    "{{UID}}": context.uid || "",
    "{{Primary_Contact_Name}}": context.primaryContactName || "",
    "{{Reply_To_Email}}": context.replyToEmail || context.replyTo || "",
    "{{Response_Deadline}}": isHtml
      ? formatLongDate(context.responseDeadline)
      : formatDate(context.responseDeadline),
    "{{Followup_Deadline}}": isHtml
      ? formatLongDate(context.followupDeadline)
      : formatDate(context.followupDeadline),
    "{{Final_Deadline}}": isHtml
      ? formatLongDate(context.finalDeadline)
      : formatDate(context.finalDeadline),
    "{{Initial_Request_Date}}": isHtml
      ? formatLongDate(context.initialRequestDate)
      : formatDate(context.initialRequestDate),
    "{{Current_Date}}": isHtml
      ? formatLongDate(new Date())
      : formatDate(new Date()),
  };

  // Replace basic placeholders
  Object.keys(placeholderMap).forEach((placeholder) => {
    out = out.split(placeholder).join(placeholderMap[placeholder]);
  });

  // Requested items bullet list
  if (!isHtml) {
    const items = context.requestedItems || [];
    const bullets = Array.isArray(items)
      ? items
          .slice(0, 8)
          .map((it, idx) => `- ${typeof it === "string" ? it : it.text || ""}`)
          .join("\n")
      : String(items);

    out = out.split("{{Requested_Items_Bulleted}}").join(bullets);
  }

  return out;
}

/**
 * Utility functions
 */
function formatDate(d) {
  if (!d) return "";
  const dt = new Date(d);
  return dt.toISOString().split("T")[0]; // YYYY-MM-DD
}

function formatLongDate(date) {
  if (!date) return "TBD";
  const d = new Date(date);
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  });
}

function escapeHtml(unsafe) {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Template validation and helper functions
 */
function validateTemplateContext(context, requiredFields = []) {
  const defaultRequired = ["customerName", "caseNumber", "primaryContactName"];
  const fields = requiredFields.length ? requiredFields : defaultRequired;
  const missing = fields.filter((field) => !context[field]);

  if (missing.length > 0) {
    throw new Error(`Missing required fields: ${missing.join(", ")}`);
  }

  return true;
}

function getTemplateSummary(type) {
  const summaries = {
    initial: "Standard initial information request",
    followup: "Follow-up reminder for outstanding items",
    final: "Final notice with consequences warning",
    "professional.initial": "Professional initial request with clear instructions",
    "professional.followup": "Urgent follow-up with consequence warnings",
    "professional.final": "Final notice with immediate action required",
    "html.initial": "Responsive HTML email template for initial requests",
    "html.followup": "Responsive HTML email template for follow-ups",
    "html.final": "Responsive HTML email template for final notices",
  };

  return summaries[type] || "Compliance communication template";
}

function getAllTemplates() {
  return {
    standard: Object.keys(templates),
    professional: Object.keys(professionalTemplates),
    html: Object.keys(htmlTemplates),
  };
}

module.exports = {
  // Original templates
  templates,
  fillTemplate,

  // Enhanced professional templates
  professionalTemplates,
  fillProfessionalTemplate,

  // HTML templates
  htmlTemplates,
  fillHtmlTemplate,

  // Utility functions
  formatDate,
  formatLongDate,
  validateTemplateContext,
  getTemplateSummary,
  getAllTemplates,
};
