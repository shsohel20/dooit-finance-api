"use strict";

const express = require("express");
const rateLimit = require("express-rate-limit");

const {
  startAuth,
  callback,
  refresh,
  disconnect,
  status,
  syncNow,
  logs,
  webhook,
  requireEnabled,
} = require("../controllers/xeroController");
const { protect, authorize, authorizeUserType } = require("../middleware/auth");

const router = express.Router();

// Connection state and tokens must never be cached by a browser or proxy.
router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

// ── Webhook — raw body REQUIRED for the HMAC (mounted before json()) ─────────
router.post("/webhook", express.raw({ type: "*/*", limit: "1mb" }), webhook);

// ── OAuth callback — public (Xero's browser redirect); state-authenticated ───
const oauthLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false });
router.get("/callback", oauthLimiter, requireEnabled, callback);

// ── Everything below: authenticated, admin of a client/branch (or dooit) ─────
router.use(express.json({ limit: "100kb" }));
router.use((req, _res, next) => {
  if (req.body == null) req.body = {};
  next();
});
router.use(protect);
router.use(authorizeUserType("client", "branch", "dooit"), authorize("admin"));

router.get("/auth", oauthLimiter, requireEnabled, startAuth);
router.post("/refresh", requireEnabled, refresh);
router.post("/disconnect", disconnect);
router.get("/status", status);
router.post("/sync", requireEnabled, syncNow);
router.get("/logs", logs);

module.exports = router;
