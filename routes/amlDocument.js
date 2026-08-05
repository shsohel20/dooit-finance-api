"use strict";

const express                    = require("express");
const { protect, authorizePermission } = require("../middleware/auth");
const { listTemplates, generateDoc, regenerateDocs } = require("../controllers/amlDocumentController");

const router = express.Router();
router.use(express.json({ limit: "100kb" }));
router.use(protect);

// GET  /api/v1/aml-document/templates?entityTypeName=Lawyers%2FConveyancers
router.route("/templates").get(authorizePermission("AML_DOC.GET"), listTemplates);

// POST /api/v1/aml-document/generate  { client, templateKey }
router.route("/generate").post(authorizePermission("AML_DOC.GENERATE"), generateDoc);

// POST /api/v1/aml-document/regenerate  { client? }  — regenerate all eligible docs
router.route("/regenerate").post(authorizePermission("AML_DOC.GENERATE"), regenerateDocs);

module.exports = router;
