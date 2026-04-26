const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/auth");
const {
  getTemplates, getTemplate, createTemplate, updateTemplate, deleteTemplate,
} = require("../controllers/testTemplateController");
router.use(express.json({ limit: "100kb" }));
router.use(protect);
router.route("/").get(getTemplates).post(createTemplate);
router.route("/:id").get(getTemplate).put(updateTemplate).delete(deleteTemplate);

module.exports = router;
