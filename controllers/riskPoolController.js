"use strict";

const RiskPoolItem  = require("../models/RiskPoolItem");
const EntityConfig  = require("../models/EntityConfig");
const { RISK_POOL_SEED, ENTITY_CONFIG_SEED } = require("../data/riskPoolSeed");

const ok  = (res, data, code = 200) => res.status(code).json({ success: true,  data });
const err = (res, msg, code = 400)  => res.status(code).json({ success: false, error: msg });

// ── helpers ───────────────────────────────────────────────────────────────────

/** Returns the authenticated client ObjectId (or null for super-admins). */
const clientId = (req) => req.user?.client || null;

/**
 * Build a filter that returns:
 *   - All global items (client === null)
 *   - All items owned by this client
 * Used for list/get operations so clients see globals + their own customs.
 */
const scopeFilter = (req) => ({
  $or: [
    { client: null },
    { client: clientId(req) },
  ],
});

// ── Risk Pool ─────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/risk-pool
 * Returns global items + client's own custom items.
 * Query: ?sec=S1&entityType=X&isActive=true&scope=global|custom&search=cash
 */
exports.listItems = async (req, res) => {
  try {
    const filter = { ...scopeFilter(req) };

    if (req.query.sec)      filter.sec      = req.query.sec;
    if (req.query.riskType) filter.riskType = req.query.riskType;
    if (req.query.isActive !== undefined) filter.isActive = req.query.isActive !== "false";

    // ?scope=global → only null-client rows; ?scope=custom → only client rows
    if (req.query.scope === "global") {
      delete filter.$or;
      filter.client = null;
    } else if (req.query.scope === "custom") {
      delete filter.$or;
      filter.client = clientId(req);
    }

    if (req.query.entityType) {
      // Merge entity filter with existing $or via $and
      const entityFilter = { $or: [{ entities: "ALL" }, { entities: req.query.entityType }] };
      filter.$and = [entityFilter];
    }

    if (req.query.search) {
      const q = { $regex: req.query.search, $options: "i" };
      const searchFilter = { $or: [{ riskName: q }, { ref: q }] };
      filter.$and = [...(filter.$and || []), searchFilter];
    }

    const items = await RiskPoolItem
      .find(filter)
      .sort({ client: 1, sortOrder: 1, sec: 1, ref: 1 }) // globals first (client=null sorts before ObjectId)
      .lean();

    return ok(res, { items, total: items.length });
  } catch (e) {
    return err(res, e.message, 500);
  }
};

/**
 * GET /api/v1/risk-pool/:ref
 * Looks up client-specific item first; falls back to global.
 */
exports.getItem = async (req, res) => {
  try {
    const ref = req.params.ref.toUpperCase();
    // Prefer client-specific; fall back to global
    const item = await RiskPoolItem.findOne({
      ref,
      $or: [{ client: clientId(req) }, { client: null }],
    }).sort({ client: -1 }).lean(); // client-specific sorts after null → comes first in desc
    if (!item) return err(res, "Risk pool item not found", 404);
    return ok(res, item);
  } catch (e) {
    return err(res, e.message, 500);
  }
};

/**
 * POST /api/v1/risk-pool
 * Always creates as a client-scoped item (never global from the API).
 * Global items are seeded via /seed only.
 */
exports.createItem = async (req, res) => {
  try {
    const item = await RiskPoolItem.create({
      ...req.body,
      client: clientId(req), // always scoped to this client
    });
    return ok(res, item, 201);
  } catch (e) {
    if (e.code === 11000) return err(res, `Ref '${req.body.ref}' already exists for this client`, 409);
    return err(res, e.message, 400);
  }
};

/**
 * PUT /api/v1/risk-pool/:ref
 * Clients can only update their own items.
 * Attempting to update a global item creates a client-specific copy (fork).
 */
exports.updateItem = async (req, res) => {
  try {
    const ref = req.params.ref.toUpperCase();
    const cid = clientId(req);

    // Try updating client-owned item first
    let item = await RiskPoolItem.findOneAndUpdate(
      { ref, client: cid },
      { $set: { ...req.body, client: cid } },
      { new: true, runValidators: true }
    ).lean();

    if (!item) {
      // Client doesn't own this ref — check if global exists
      const global = await RiskPoolItem.findOne({ ref, client: null }).lean();
      if (!global) return err(res, "Risk pool item not found", 404);

      // Fork: create a client-specific copy with the requested changes
      const { _id, createdAt, updatedAt, __v, ...base } = global;
      item = await RiskPoolItem.create({ ...base, ...req.body, client: cid });
    }

    return ok(res, item);
  } catch (e) {
    if (e.code === 11000) return err(res, `A custom version of ref '${req.params.ref}' already exists`, 409);
    return err(res, e.message, 400);
  }
};

/**
 * DELETE /api/v1/risk-pool/:ref
 * Clients can only delete their own items (not globals).
 */
exports.deleteItem = async (req, res) => {
  try {
    const ref = req.params.ref.toUpperCase();
    const item = await RiskPoolItem.findOneAndDelete({ ref, client: clientId(req) });
    if (!item) return err(res, "Item not found or is a global item (cannot delete)", 404);
    return ok(res, { deleted: true, ref });
  } catch (e) {
    return err(res, e.message, 500);
  }
};

/**
 * POST /api/v1/risk-pool/seed
 * Seeds GLOBAL items (client = null). Safe — only inserts missing refs.
 * ?force=true wipes all global items first.
 */
exports.seedItems = async (req, res) => {
  try {
    const { force = false } = req.body || {};

    if (force) {
      await RiskPoolItem.deleteMany({ client: null });
      await EntityConfig.deleteMany({});
    }

    // Upsert global risk pool items (client = null)
    const riskOps = RISK_POOL_SEED.map(row => ({
      updateOne: {
        filter: { ref: row.ref, client: null },
        update: { $setOnInsert: { ...row, client: null } },
        upsert: true,
      },
    }));
    const riskResult = await RiskPoolItem.bulkWrite(riskOps, { ordered: false });

    // Upsert entity configs
    const entityOps = ENTITY_CONFIG_SEED.map(cfg => ({
      updateOne: {
        filter: { entityType: cfg.entityType },
        update: { $setOnInsert: cfg },
        upsert: true,
      },
    }));
    const entityResult = await EntityConfig.bulkWrite(entityOps, { ordered: false });

    return ok(res, {
      riskPool:     { upserted: riskResult.upsertedCount,   total: RISK_POOL_SEED.length },
      entityConfig: { upserted: entityResult.upsertedCount, total: ENTITY_CONFIG_SEED.length },
    });
  } catch (e) {
    return err(res, e.message, 500);
  }
};

// ── Entity Config ─────────────────────────────────────────────────────────────

exports.listEntityConfigs = async (req, res) => {
  try {
    const configs = await EntityConfig.find({}).sort({ tranche: 1, entityType: 1 }).lean();
    return ok(res, configs);
  } catch (e) {
    return err(res, e.message, 500);
  }
};

exports.updateEntityConfig = async (req, res) => {
  try {
    const entityType = decodeURIComponent(req.params.entityType);
    const cfg = await EntityConfig.findOneAndUpdate(
      { entityType },
      { $set: req.body },
      { new: true, runValidators: true }
    ).lean();
    if (!cfg) return err(res, "Entity config not found", 404);
    return ok(res, cfg);
  } catch (e) {
    return err(res, e.message, 400);
  }
};
