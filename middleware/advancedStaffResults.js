"use strict";

const { attachUserRoleId } = require("../utils/attachUserRoleId");

const isEmpty = (v) => v === undefined || v === null || v === "" || v === "null";
const toBool  = (v) => v === "true" || v === true;

/**
 * advancedStaffResults — query/filter/sort/paginate middleware for Staff.
 *
 * Query params:
 *   q              – text search (firstName, lastName, workEmail, referenceCode)
 *   status         – draft | submitted | under_review | approved | rejected | pending_docs
 *   kycStatus      – pending | in_review | verified | rejected
 *   amlStatus      – pending | clear | flagged | yellow
 *   department     – compliance | risk | hr | ...
 *   jobTitle       – aml_analyst | kyc_analyst | ...
 *   employmentType – full_time | part_time | contract | consultant
 *   client         – ObjectId
 *   branch         – ObjectId
 *   isActive       – true | false
 *   isPep          – true | false
 *   sanction       – true | false
 *   sort           – field or -field  (default: -createdAt)
 *   page           – default 1
 *   limit          – default 25, max 100
 */
module.exports = (Staff) => async (req, res, next) => {
  try {
    const {
      q, status, kycStatus, amlStatus,
      department, jobTitle, employmentType,
      client, branch, isActive, isPep, sanction,
      sort  = "-createdAt",
      page  = 1,
      limit = 25,
    } = req.query;

    const dbQuery = {};

    // ── tenant scoping ──────────────────────────────────────────────────────
    const scopeClient = req.user?.client?._id || null;
    const scopeBranch = req.user?.branch?._id || null;
    if (scopeClient) dbQuery.client = scopeClient;
    if (scopeBranch) dbQuery.branch = scopeBranch;

    // ── indexed field filters ───────────────────────────────────────────────
    if (!isEmpty(status))         dbQuery.status                       = status;
    if (!isEmpty(kycStatus))      dbQuery.kycStatus                    = kycStatus;
    if (!isEmpty(amlStatus))      dbQuery.amlStatus                    = amlStatus;
    if (!isEmpty(department))     dbQuery["employment.department"]     = department;
    if (!isEmpty(jobTitle))       dbQuery["employment.jobTitle"]       = jobTitle;
    if (!isEmpty(employmentType)) dbQuery["employment.employmentType"] = employmentType;
    if (!isEmpty(isActive))       dbQuery.isActive                     = toBool(isActive);
    if (!isEmpty(isPep))          dbQuery.isPep                        = toBool(isPep);
    if (!isEmpty(sanction))       dbQuery.sanction                     = toBool(sanction);

    // explicit client/branch overrides (admin use — ignores scope)
    if (!isEmpty(client)) dbQuery.client = client;
    if (!isEmpty(branch)) dbQuery.branch = branch;

    // ── text search ─────────────────────────────────────────────────────────
    if (!isEmpty(q)) {
      const regex = new RegExp(q, "i");
      dbQuery.$or = [
        { "personal.firstName": regex },
        { "personal.lastName":  regex },
        { "contact.workEmail":  regex },
        { referenceCode:        regex },
      ];
    }

    // ── pagination ───────────────────────────────────────────────────────────
    const pageNum  = Math.max(parseInt(page,  10) || 1,   1);
    const limitNum = Math.min(parseInt(limit, 10) || 25, 100);
    const skip     = (pageNum - 1) * limitNum;

    const populate = [
      { path: "user",   select: "name userName email role isActive" },
      { path: "client", select: "name" },
      { path: "branch", select: "name" },
    ];

    const [total, results] = await Promise.all([
      Staff.countDocuments(dbQuery),
      Staff.find(dbQuery)
        .populate(populate)
        .sort(sort)
        .skip(skip)
        .limit(limitNum)
        .lean({ virtuals: true }),
    ]);

    const pagination = {};
    if (skip + limitNum < total) pagination.next = { page: pageNum + 1, limit: limitNum };
    if (skip > 0)                pagination.prev = { page: pageNum - 1, limit: limitNum };

    res.advancedResults = {
      success: true,
      totalRecords: total,
      count: results.length,
      pagination,
      data: await attachUserRoleId(results),
    };

    next();
  } catch (err) {
    next(err);
  }
};
