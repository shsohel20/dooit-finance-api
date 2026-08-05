// routes/notifies.js
const express = require("express");
const router = express.Router();
router.use(express.json({ limit: "100kb" }));

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
const { protect, authorizePermission } = require("../middleware/auth");

// protect routes
router.use(protect);
router.use(
  authorizePermission("NOTIFY.GET", "NOTIFY.ADD", "NOTIFY.EDIT", "NOTIFY.DELETE"),
);

// list (GET query / POST body filter)
router
  .route("/")
  .get(
    advancedResults(Notify, ["resourceId"], null),
    authorizePermission("NOTIFY.GET"),
    getNotifies,
  )
  .post(
    advancedResults(Notify, ["resourceId"], filterNotifySection),
    authorizePermission("NOTIFY.GET"),
    getNotifiesPost,
  );

// create
router.route("/new").post(
  authorizePermission("NOTIFY.ADD"),
  createNotify,
);

// create dummy
router.route("/dummy").post(
  authorizePermission("NOTIFY.ADD"),
  createDummyNotify,
);

// get by uid
router.route("/uid/:uid").get(
  authorizePermission("NOTIFY.GET"),
  getNotifyByUid,
);

// CRUD
router
  .route("/:id")
  .get(
    authorizePermission("NOTIFY.GET"),
    getNotify,
  )
  .put(
    authorizePermission("NOTIFY.EDIT"),
    updateNotify,
  )
  .delete(
    authorizePermission("NOTIFY.DELETE"),
    deleteNotify,
  );

// toggle active
router.route("/:id/active").put(
  authorizePermission("NOTIFY.EDIT"),
  toggleNotifyActive,
);

// documents
router.route("/:id/documents").post(
  authorizePermission("NOTIFY.EDIT"),
  addDocument,
);
router.route("/:id/documents/:docIndex").delete(
  authorizePermission("NOTIFY.EDIT"),
  removeDocument,
);

module.exports = router;
