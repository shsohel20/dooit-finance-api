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
const htmlTemplates = {
  followup: `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Compliance Follow-up Required</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Segoe UI', Arial, sans-serif; line-height: 1.6; color: #333; background-color: #f6f6f6; padding: 20px; }
        .email-container { max-width: 600px; margin: 0 auto; background: #ffffff; border: 1px solid #e0e0e0; border-radius: 8px; overflow: hidden; }
        .header { background: linear-gradient(135deg, #1e3c72, #2a5298); color: white; padding: 30px; text-align: center; }
        .header h1 { font-size: 24px; margin-bottom: 8px; font-weight: 600; }
        .header .subtitle { font-size: 16px; opacity: 0.9; }
        .content { padding: 30px; }
        .urgency-banner { background: #fff3cd; border: 1px solid #ffeaa7; border-radius: 6px; padding: 15px; margin-bottom: 25px; display: flex; align-items: center; gap: 12px; }
        .urgency-banner .icon { font-size: 20px; color: #e74c3c; }
        .deadline-section { background: #f8f9fa; border-left: 4px solid #e74c3c; padding: 20px; margin: 25px 0; border-radius: 0 4px 4px 0; }
        .deadline-label { font-weight: 600; color: #e74c3c; margin-bottom: 8px; }
        .deadline-date { font-size: 18px; font-weight: 700; color: #2c3e50; }
        .requested-items { background: #f8f9fa; border-radius: 6px; padding: 20px; margin: 25px 0; }
        .requested-items h3 { color: #2c3e50; margin-bottom: 15px; font-size: 16px; }
        .items-list { list-style: none; }
        .items-list li { padding: 10px 0; border-bottom: 1px solid #e9ecef; display: flex; align-items: flex-start; gap: 10px; }
        .items-list li:last-child { border-bottom: none; }
        .item-bullet { color: #3498db; font-weight: bold; min-width: 20px; }
        .consequences { background: #ffeaa7; border-radius: 6px; padding: 20px; margin: 25px 0; }
        .consequences h3 { color: #e74c3c; margin-bottom: 15px; font-size: 16px; }
        .action-buttons { text-align: center; margin: 30px 0; }
        .btn { display: inline-block; padding: 12px 30px; background: #3498db; color: white; text-decoration: none; border-radius: 6px; font-weight: 600; margin: 0 10px; transition: background 0.3s ease; }
        .btn-primary { background: #3498db; }
        .btn-primary:hover { background: #2980b9; }
        .btn-secondary { background: #95a5a6; }
        .btn-secondary:hover { background: #7f8c8d; }
        .footer { background: #2c3e50; color: white; padding: 30px; text-align: center; }
        .footer a { color: #3498db; text-decoration: none; }
        .case-details { background: #ecf0f1; padding: 15px; border-radius: 6px; margin: 20px 0; font-size: 14px; }
        .detail-row { display: flex; justify-content: space-between; margin-bottom: 8px; }
        .detail-label { font-weight: 600; color: #7f8c8d; }
        @media (max-width: 600px) {
            .content { padding: 20px; }
            .header { padding: 20px; }
            .header h1 { font-size: 20px; }
            .action-buttons { text-align: left; }
            .btn { display: block; margin: 10px 0; text-align: center; }
            .detail-row { flex-direction: column; }
        }
    </style>
</head>
<body>
    <div class="email-container">
        <div class="header">
            <h1>COMPLIANCE FOLLOW-UP REQUIRED</h1>
            <div class="subtitle">Case: {{Case_Number}} - {{Customer_Name}}</div>
        </div>
        
        <div class="content">
            <div class="urgency-banner">
                <div class="icon">⚠️</div>
                <div>
                    <strong>URGENT ATTENTION REQUIRED</strong><br>
                    Second request for outstanding compliance information
                </div>
            </div>
            
            <p>Dear {{Primary_Contact_Name}},</p>
            
            <p>We note that the following requested items remain outstanding from our initial communication dated {{Initial_Request_Date}}.</p>
            
            <div class="case-details">
                <div class="detail-row">
                    <span class="detail-label">Customer:</span>
                    <span>{{Customer_Name}}</span>
                </div>
                <div class="detail-row">
                    <span class="detail-label">Case Number:</span>
                    <span>{{Case_Number}}</span>
                </div>
                <div class="detail-row">
                    <span class="detail-label">UID:</span>
                    <span>{{UID}}</span>
                </div>
            </div>
            
            <div class="requested-items">
                <h3>OUTSTANDING ITEMS REQUIRED:</h3>
                <ul class="items-list">
                    {{Requested_Items_HTML}}
                </ul>
            </div>
            
            <div class="deadline-section">
                <div class="deadline-label">FINAL SUBMISSION DEADLINE</div>
                <div class="deadline-date">{{Followup_Deadline}}</div>
            </div>
            
            <div class="consequences">
                <h3>IMPORTANT: FAILURE TO PROVIDE REQUESTED INFORMATION MAY RESULT IN:</h3>
                <ul class="items-list">
                    <li><span class="item-bullet">•</span><span>Temporary restrictions on account activities</span></li>
                    <li><span class="item-bullet">•</span><span>Compliance holds on transactions</span></li>
                    <li><span class="item-bullet">•</span><span>Escalation to senior management</span></li>
                </ul>
            </div>
            
            <p><strong>Please prioritize this request</strong> and provide the outstanding items by the deadline above.</p>
            
            <p>We are available to discuss any challenges you may be facing in gathering this information.</p>
            
            <div class="action-buttons">
                <a href="mailto:{{Reply_To_Email}}?subject=Compliance Response - {{Case_Number}}&body=Dear Compliance Team,%0A%0APlease find attached the requested documents for case {{Case_Number}}." class="btn btn-primary">📎 Submit Documents</a>
                <a href="mailto:{{Reply_To_Email}}?subject=Discussion Required - {{Case_Number}}&body=Dear Compliance Team,%0A%0AI would like to schedule a call to discuss the requested items for case {{Case_Number}}." class="btn btn-secondary">📞 Request Discussion</a>
            </div>
            
            <p>Regards,</p>
            <p><strong>Compliance Department</strong><br>{{Client_Name}}</p>
        </div>
        
        <div class="footer">
            <p><strong>Contact Information</strong><br>Email: <a href="mailto:{{Reply_To_Email}}">{{Reply_To_Email}}</a><br>Case Reference: {{Case_Number}}</p>
            <p style="margin-top: 20px; font-size: 12px; opacity: 0.8;">This email contains confidential information and is intended only for the addressed recipient.<br>If you are not the intended recipient, please notify us immediately and delete this email.</p>
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

  // Special handling for requested items in HTML
  const items = context.requestedItems || [];
  const itemsHtml = items
    .slice(0, 8)
    .map(
      (item) =>
        `<li>
        <span class="item-bullet">•</span>
        <span>${escapeHtml(
          typeof item === "string" ? item : item.text || ""
        )}</span>
      </li>`
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
    "professional.initial":
      "Professional initial request with clear instructions",
    "professional.followup": "Urgent follow-up with consequence warnings",
    "professional.final": "Final notice with immediate action required",
    "html.followup": "Responsive HTML email template for follow-ups",
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
