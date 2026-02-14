const express = require("express");
const router = express.Router();

const {
  createModule,
  getModules,
  getModule,
  updateModule,
  deleteModule,
  createPart,
  getPartsByModule,
  createQuestion,
  updateQuestion,
  deleteQuestion,
  getPart,
  updatePart,
  getQuestion,
  deletePart,
} = require("../controllers/trainingModuleController");

const TrainingModule = require("../models/TrainingModule");
const advancedResults = require("../middleware/advancedResults");
const { protect } = require("../middleware/auth");
router.use(express.json({ limit: "100kb" }));

router.use(protect);

router
  .route("/")
  .get(advancedResults(TrainingModule), getModules)
  .post(createModule);

router.route("/:id").get(getModule).put(updateModule).delete(deleteModule);

router.route("/:moduleId/parts").post(createPart).get(getPartsByModule);

router.route("/parts/:partId").get(getPart).put(updatePart).delete(deletePart);

router.route("/parts/:partId/questions").post(createQuestion);

router
  .route("/questions/:id")
  .get(getQuestion)
  .put(updateQuestion)
  .delete(deleteQuestion);

module.exports = router;
