const express = require("express");
const {
  listNotifications, markRead, markAllRead, dismiss,
  listRules, updateRule,
} = require("../controllers/appNotificationController");
const { protect } = require("../middleware/auth");

const router = express.Router();
router.use(protect);

router.get("/",           listNotifications);
router.put("/read-all",   markAllRead);
router.put("/:id/read",   markRead);
router.delete("/:id",     dismiss);

router.get("/rules",      listRules);
router.put("/rules/:id",  updateRule);

module.exports = router;
