// controllers/clientRuleController.js
const asyncHandler = require("../middleware/async");
const ErrorResponse = require("../utils/errorResponse");
const ClientRule = require("../models/ClientRule");
const Client = require("../models/Client");
const Branch = require("../models/Branch");

/**
 * Filter helper (used by advancedResults POST search)
 */
exports.filterClientRuleSection = (doc, requestBody, req) => {
    if (requestBody.ruleName) {
        return doc.ruleName
            ?.toLowerCase()
            .includes(requestBody.ruleName.toLowerCase());
    }
    return true;
};

// @desc    Get all rules
// @route   GET /api/v1/client-rules
// @access  Private (Admin)
exports.getClientRules = asyncHandler(async (req, res) => {
    res.status(200).json(res.advancedResults);
});

// @desc    Get all rules (POST filter)
// @route   POST /api/v1/client-rules
// @access  Private (Admin)
exports.getClientRulesPost = asyncHandler(async (req, res) => {
    res.status(200).json(res.advancedResults);
});

// @desc    Create rule
// @route   POST /api/v1/client-rules/new
// @access  Private (Admin)
exports.createClientRule = asyncHandler(async (req, res, next) => {
    const client = req?.user?.client?._id || null;
    const branch = req?.user?.branch?._id || null;

    if (!client) {
        return next(new ErrorResponse("Unauthorized client", 401));
    }

    const {

        ruleId,
        ruleName,
        ruleCondition,
        descriptiveExplanation,
        ruleDomainSubdomain,
        mainDomain,
        caseType,
        riskScore,
        riskLabel,
        isActive = true,
    } = req.body;



    const rule = await ClientRule.create({
        client,
        branch,
        ruleId,
        ruleName,
        ruleCondition,
        descriptiveExplanation,
        ruleDomainSubdomain,
        mainDomain,
        caseType,
        riskScore,
        riskLabel,
        isActive,
    });



    res.status(201).json({
        success: true,
        data: rule,
    });
});

// @desc    Get single rule
// @route   GET /api/v1/client-rules/:id
// @access  Private
exports.getClientRule = asyncHandler(async (req, res, next) => {
    const rule = await ClientRule.findById(req.params.id)
        .populate("client", "name")
        .populate("branch", "name");

    if (!rule) {
        return next(
            new ErrorResponse(`Rule not found with id ${req.params.id}`, 404)
        );
    }

    res.status(200).json({
        success: true,
        data: rule,
    });
});

// @desc    Update rule
// @route   PUT /api/v1/client-rules/:id
// @access  Private (Admin)
exports.updateClientRule = asyncHandler(async (req, res, next) => {
    let rule = await ClientRule.findById(req.params.id);

    if (!rule) {
        return next(
            new ErrorResponse(`Rule not found with id ${req.params.id}`, 404)
        );
    }

    rule = await ClientRule.findByIdAndUpdate(req.params.id, req.body, {
        new: true,
        runValidators: true,
    });

    res.status(200).json({
        success: true,
        data: rule,
    });
});

// @desc    Delete rule
// @route   DELETE /api/v1/client-rules/:id
// @access  Private (Admin)
exports.deleteClientRule = asyncHandler(async (req, res, next) => {
    const rule = await ClientRule.findById(req.params.id);

    if (!rule) {
        return next(
            new ErrorResponse(`Rule not found with id ${req.params.id}`, 404)
        );
    }

    await rule.deleteOne();

    res.status(200).json({
        success: true,
        data: req.params.id,
    });
});
