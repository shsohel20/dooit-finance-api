// utils/rfiTemplates.js
/**
 * Placeholder list used in templates:
 * {{Client_Name}}  {{Customer_Name}}  {{Case_Number}}  {{UID}}  {{Requested_Items_Bulleted}}
 * {{Primary_Contact_Name}}  {{Reply_To_Email}}  {{Response_Deadline}}  {{Followup_Deadline}}  {{Final_Deadline}}
 *
 * These templates follow the PDF you uploaded (initial, follow-up, final).
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
  
  If we don’t receive the information by the deadline, we may suspend related activity and/or take further action in line with our obligations.
  
  Regards,
  
  Compliance Team
  
  {{Client_Name}}`,
  },
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

function replacePlaceholders(text, context) {
  let out = text;
  // simple replacements for values
  const map = {
    "{{Client_Name}}": context.clientName || "",
    "{{Customer_Name}}": context.customerName || "",
    "{{Case_Number}}": context.caseNumber || "",
    "{{UID}}": context.uid || "",
    "{{Primary_Contact_Name}}": context.primaryContactName || "",
    "{{Reply_To_Email}}": context.replyToEmail || context.replyTo || "",
    "{{Response_Deadline}}": formatDate(context.responseDeadline) || "",
    "{{Followup_Deadline}}": formatDate(context.followupDeadline) || "",
    "{{Final_Deadline}}": formatDate(context.finalDeadline) || "",
  };

  Object.keys(map).forEach((k) => {
    out = out.split(k).join(map[k]);
  });

  // Requested items bullet list — expects an array or prebuilt string
  const items = context.requestedItems || [];
  const bullets = Array.isArray(items)
    ? items
        .slice(0, 8)
        .map((it, idx) => `- ${typeof it === "string" ? it : it.text || ""}`)
        .join("\n")
    : String(items);

  out = out.split("{{Requested_Items_Bulleted}}").join(bullets);

  return out;
}

function formatDate(d) {
  if (!d) return "";
  const dt = new Date(d);
  return dt.toISOString().split("T")[0]; // YYYY-MM-DD
}

module.exports = {
  templates,
  fillTemplate,
};
