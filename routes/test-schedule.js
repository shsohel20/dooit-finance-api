const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/auth");
router.use(express.json({ limit: "100kb" }));
const {
  getSchedules, getSummary, getSchedule,
  createSchedule, updateSchedule, deleteSchedule,
} = require("../controllers/testScheduleController");

router.use(protect);
router.get("/summary", getSummary);
router.route("/").get(getSchedules).post(createSchedule);
router.route("/:id").get(getSchedule).put(updateSchedule).delete(deleteSchedule);

module.exports = router;
