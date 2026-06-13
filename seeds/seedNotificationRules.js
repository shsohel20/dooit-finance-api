/**
 * Seed notification rules from /seed/notification_rules.json
 * Run: node api/seeds/seedNotificationRules.js
 */
require("dotenv").config({
  path: require("path").resolve(__dirname, "../config/config.env"),
});
const mongoose = require("mongoose");
const NotificationRule = require("../models/NotificationRule");
const rules = require("../../seed/notification_rules.json");

/**
 * The datasheet uses display labels ("Action Required", "Overdue",
 * "Critical — immediate", "Informational") that violate the schema enum
 * (Routine/Urgent/Critical) — bulkWrite bypasses Mongoose validation, so
 * normalise here. The raw label is preserved in `urgencyLabel`.
 */
function normaliseUrgency(raw) {
  const s = String(raw || "").toLowerCase();
  if (s.startsWith("critical") || s === "overdue") return "Critical";
  if (s === "urgent" || s === "action required") return "Urgent";
  return "Routine"; // "Informational", blanks, unknowns
}

/**
 * Datasheet channel strings ("In-app + Email", "In-app + Email (daily)") →
 * schema enum values in_app / email / sms.
 */
function normaliseChannels(raw) {
  const s = String(raw || "").toLowerCase();
  const out = [];
  if (s.includes("in-app") || s.includes("in_app") || s.includes("app")) out.push("in_app");
  if (s.includes("email")) out.push("email");
  if (s.includes("sms")) out.push("sms");
  return out.length ? out : ["in_app"];
}

async function seed() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("Connected to MongoDB");

  const ops = rules.map((r) => ({
    updateOne: {
      filter: { notifId: r.notif_id || r.notifId },
      update: {
        $set: {
          notifId:           r.notif_id || r.notifId,
          notifName:         r.notif_name || r.notifName,
          // JSON uses trigger_condition (datasheet column name)
          triggerEvent:      r.trigger_event || r.triggerEvent || r.trigger_condition || "",
          urgency:           normaliseUrgency(r.urgency),
          urgencyLabel:      r.urgency || "",
          // JSON uses recipients ("CO, Senior Manager")
          audience:          (r.audience || r.recipients || "")
            .split(",").map((s) => s.trim()).filter(Boolean),
          notifCategory:     r.notif_category || r.notifCategory || r.category || "",
          bodyTemplate:      r.body_template || r.bodyTemplate || "",
          actionButtonLabel: r.action_button_label || r.actionButtonLabel || "",
          actionDestination: r.action_destination || r.actionDestination || "",
          // JSON uses channel ("In-app + Email (daily)")
          deliveryChannels:  normaliseChannels(r.delivery_channels || r.channel),
          active:            true,
          repeating:         r.repeating === true || r.repeating === "true" || false,
          repeatIntervalDays:r.repeat_interval_days ? parseInt(r.repeat_interval_days) : null,
        },
      },
      upsert: true,
    },
  }));

  const result = await NotificationRule.bulkWrite(ops, { ordered: false });
  console.log(`Notification rules seeded: ${result.upsertedCount} inserted, ${result.modifiedCount} updated`);
  await mongoose.disconnect();
}

seed().catch((err) => { console.error(err); process.exit(1); });
