/**
 * Seed notification rules from /seed/notification_rules.json
 * Run: node api/seeds/seedNotificationRules.js
 */
require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const mongoose = require("mongoose");
const NotificationRule = require("../models/NotificationRule");
const rules = require("../../seed/notification_rules.json");

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
          triggerEvent:      r.trigger_event || r.triggerEvent,
          urgency:           r.urgency || "Routine",
          audience:          r.audience ? r.audience.split(",").map((s) => s.trim()) : [],
          notifCategory:     r.notif_category || r.notifCategory || "",
          bodyTemplate:      r.body_template || r.bodyTemplate || "",
          actionButtonLabel: r.action_button_label || r.actionButtonLabel || "",
          actionDestination: r.action_destination || r.actionDestination || "",
          deliveryChannels:  r.delivery_channels
            ? r.delivery_channels.split(",").map((s) => s.trim().toLowerCase())
            : ["in_app"],
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
