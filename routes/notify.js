// routes/notifies.js
const express = require("express");
const router = express.Router();

const {
  getNotifies,
  getNotifiesPost,
  createNotify,
  createDummyNotify,
  getNotify,
  getNotifyByUid,
  updateNotify,
  deleteNotify,
  toggleNotifyActive,
  addDocument,
  removeDocument,
  filterNotifySection,
} = require("../controllers/notifyController");

const Notify = require("../models/Notify");
const advancedResults = require("../middleware/advancedResults");
const { protect, authorize } = require("../middleware/auth");

// protect routes
router.use(protect);

// list (GET query / POST body filter)
router
  .route("/")
  .get(
    advancedResults(Notify, ["resourceId"], null),
    //  authorize("admin", "operator"),
    getNotifies
  )
  .post(
    advancedResults(Notify, ["resourceId"], filterNotifySection),
    // authorize("admin", "operator"),
    getNotifiesPost
  );

// create
router.route("/new").post(
  // authorize("admin", "operator"),
  createNotify
);

// create dummy
router.route("/dummy").post(
  // authorize("admin", "operator"),
  createDummyNotify
);

// get by uid
router.route("/uid/:uid").get(
  // authorize("admin", "operator"),
  getNotifyByUid
);

// CRUD
router
  .route("/:id")
  .get(
    // authorize("admin", "operator"),
    getNotify
  )
  .put(
    // authorize("admin", "operator"),
    updateNotify
  )
  .delete(
    // authorize("admin"),
    deleteNotify
  );

// toggle active
router.route("/:id/active").put(
  // authorize("admin", "operator"),
  toggleNotifyActive
);

// documents
router.route("/:id/documents").post(
  // authorize("admin", "operator"),
  addDocument
);
router.route("/:id/documents/:docIndex").delete(
  // authorize("admin", "operator"),
  removeDocument
);

module.exports = router;
