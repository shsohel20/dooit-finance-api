"use strict";

const ControlAssignment = require("../models/ControlAssignment");
const { CONTROL_ASSIGNMENT_SEED } = require("../data/controlAssignmentSeed");

const ok  = (res, data, code = 200) => res.status(code).json({ success: true,  data });
const err = (res, msg, code = 400)  => res.status(code).json({ success: false, error: msg });

const clientId = (req) => req.user?.client || null;

/**
 * GET /api/v1/control-assignments
 * Returns applicable assignments.
 * Client sees global defaults merged with their own overrides.
 * Query: ?entityType=X&domain=Y&isActive=true
 */
exports.list = async (req, res) => {
  try {
    const cid = clientId(req);
    const filter = {
      $or: [{ client: null }, ...(cid ? [{ client: cid }] : [])],
    };
    if (req.query.entityType) filter.entityType = req.query.entityType;
    if (req.query.domain)     filter.domain     = req.query.domain;
    if (req.query.isActive !== undefined) filter.isActive = req.query.isActive !== "false";

    const assignments = await ControlAssignment
      .find(filter)
      .sort({ domain: 1, controlId: 1 })
      .lean();

    // Client-specific overrides take precedence over globals for same (controlId, entityType)
    if (cid) {
      const seen = new Set();
      const deduped = [];
      const clientAssignments = assignments.filter(a => a.client != null);
      const globalAssignments = assignments.filter(a => a.client == null);
      clientAssignments.forEach(a => { seen.add(`${a.controlId}::${a.entityType}`); deduped.push(a); });
      globalAssignments.forEach(a => {
        if (!seen.has(`${a.controlId}::${a.entityType}`)) deduped.push(a);
      });
      deduped.sort((a, b) => a.domain.localeCompare(b.domain) || a.controlId.localeCompare(b.controlId));
      return ok(res, deduped);
    }

    return ok(res, assignments);
  } catch (e) {
    return err(res, e.message, 500);
  }
};

/**
 * GET /api/v1/control-assignments/matrix
 * Returns a summary matrix: { entityType → count of applicable controls }.
 */
exports.matrix = async (req, res) => {
  try {
    const cid = clientId(req);
    const filter = { $or: [{ client: null }, ...(cid ? [{ client: cid }] : [])], isActive: true };

    const assignments = await ControlAssignment.find(filter).lean();

    const matrix = {};
    assignments.forEach(a => {
      if (!matrix[a.entityType]) matrix[a.entityType] = { total: 0, byDomain: {} };
      matrix[a.entityType].total++;
      matrix[a.entityType].byDomain[a.domain] = (matrix[a.entityType].byDomain[a.domain] || 0) + 1;
    });

    return ok(res, matrix);
  } catch (e) {
    return err(res, e.message, 500);
  }
};

/**
 * POST /api/v1/control-assignments/seed
 * Upsert global defaults from Controls_Entity_Map.md.
 * Existing global records are not overwritten (setOnInsert).
 * Client-specific overrides are untouched.
 */
exports.seed = async (req, res) => {
  try {
    const ops = CONTROL_ASSIGNMENT_SEED.map(row => ({
      updateOne: {
        filter: { controlId: row.controlId, entityType: row.entityType, client: null },
        update: { $setOnInsert: row },
        upsert: true,
      },
    }));

    const result = await ControlAssignment.bulkWrite(ops, { ordered: false });
    return ok(res, {
      upserted: result.upsertedCount,
      matched:  result.matchedCount,
      total:    CONTROL_ASSIGNMENT_SEED.length,
    });
  } catch (e) {
    return err(res, e.message, 500);
  }
};

/**
 * PUT /api/v1/control-assignments/:controlId/:entityType
 * Toggle isActive for a specific (controlId, entityType) pair.
 * Creates a client-level override if one doesn't exist yet.
 * Body: { isActive: boolean }
 */
exports.toggle = async (req, res) => {
  try {
    const cid = clientId(req);
    if (!cid) return err(res, "Super-admin cannot create client-level overrides", 403);

    const { isActive } = req.body;
    if (typeof isActive !== "boolean") return err(res, "isActive (boolean) is required");

    const controlId  = req.params.controlId.toUpperCase();
    const entityType = decodeURIComponent(req.params.entityType);

    const assignment = await ControlAssignment.findOneAndUpdate(
      { controlId, entityType, client: cid },
      { $set: { isActive, domain: req.body.domain || "GOV" } },
      { upsert: true, new: true, runValidators: true }
    ).lean();

    return ok(res, assignment);
  } catch (e) {
    return err(res, e.message, 400);
  }
};
