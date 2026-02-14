const asyncHandler = require("../middleware/async");
const Customer = require("../models/Customer");
const IndividualRiskAssessment = require("../models/IndividualRiskAssessment");
const {
  FACTORS,
  UHRC,
  HRC,
  MRC,
  LRC,
  buildRiskAssessmentFromCustomer,
} = require("../utils/riskAssessment");

// build score map from FACTORS.jurisdiction
const bandScoreMap = FACTORS.jurisdiction.reduce((acc, cur) => {
  acc[cur.value] = cur.score;
  return acc;
}, {});

function titleCase(s) {
  return s.replace(
    /\w\S*/g,
    (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(),
  );
}

function buildCountryRiskList() {
  const list = [];

  const pushSet = (set, band) => {
    const score = bandScoreMap[band] || 0;
    for (const c of set) {
      list.push({
        country: titleCase(c),
        band,
        score,
      });
    }
  };

  pushSet(UHRC, "UHRC");
  pushSet(HRC, "HRC");
  pushSet(MRC, "MRC");
  pushSet(LRC, "LRC");

  // dedupe (in case any country appears twice with variants)
  const map = new Map();
  for (const item of list) {
    const key = item.country.toLowerCase();
    if (!map.has(key)) map.set(key, item);
  }

  // sort by country name for dropdown UX
  return Array.from(map.values()).sort((a, b) =>
    a.country.localeCompare(b.country),
  );
}

exports.getRiskFactors = asyncHandler(async (req, res, next) => {
  // send FACTORS as-is (client uses value/score lists for dropdowns)
  const data = buildCountryRiskList();

  return res.json({ success: true, data: { ...FACTORS, countries: data } });
});

exports.getJurisdictions = asyncHandler(async (req, res, next) => {
  const data = buildCountryRiskList();

  res.json({
    success: true,
    count: data.length,
    data,
  });
});

/**
 * Build display name safely
 */
function buildCustomerName(c) {
  const d = c.personalKyc?.personal_form?.customer_details;

  if (!d) return c.uid || "Unnamed";

  const parts = [d.given_name, d.middle_name, d.surname].filter(Boolean);

  if (parts.length) return parts.join(" ");

  return c.uid || "Unnamed";
}

/**
 * GET /api/customers/dropdown
 * Query:
 *   ?q=search
 *   ?limit=50
 *   ?client=clientId (optional filter by relation.client)
 */
exports.getCustomerDropdown = asyncHandler(async (req, res) => {
  const { q = "", limit = 50, client } = req.query;

  const filter = {
    isActive: true,
  };

  // filter by client relation if provided
  if (client) {
    filter["relations.client"] = client;
  }

  // basic search
  if (q) {
    filter.$or = [
      { uid: new RegExp(q, "i") },
      {
        "personalKyc.personal_form.customer_details.given_name": new RegExp(
          q,
          "i",
        ),
      },
      {
        "personalKyc.personal_form.customer_details.surname": new RegExp(
          q,
          "i",
        ),
      },
      {
        "personalKyc.personal_form.contact_details.email": new RegExp(q, "i"),
      },
    ];
  }

  const customers = await Customer.find(filter)

    .limit(Number(limit))
    .sort({ createdAt: -1 });
  // IMPORTANT → enables your risk virtuals

  const data = customers.map((c) => {
    const rel = c.relations?.[0];

    return {
      id: c._id,
      uid: c.uid,
      // sequence: c.sequence,

      name: buildCustomerName(c),
      type: rel?.type || "individual",

      kycStatus: c.kycStatus,
      country: c.country,

      riskAssessment: c.riskAssessment,

      createdAt: c.createdAt,
    };
  });

  res.json({
    success: true,
    count: data.length,
    data,
  });
});

/**
 * POST /api/risk/assess
 * Request body: { customer: {...} } OR full customer object body
 * Returns: { riskAssessment, riskScore, riskLabel } from buildRiskAssessmentFromCustomer
 */

exports.assessFromBody = asyncHandler(async (req, res) => {
  const payload = req.body;

  if (!payload || Object.keys(payload).length === 0) {
    return res.status(400).json({
      success: false,
      message: "Missing customer payload",
    });
  }

  // 1️⃣ compute
  const result = buildRiskAssessmentFromCustomer(payload);

  // 5️⃣ return saved doc
  res.json({
    success: true,
    data: result,
  });
});

exports.assessFromBodySave = asyncHandler(async (req, res) => {
  const payload = req.body;
  const client = req?.user?.client?._id || null;
  const branch = req?.user?.branch?._id || null;
  if (!payload || Object.keys(payload).length === 0) {
    return res.status(400).json({
      success: false,
      message: "Missing customer payload",
    });
  }

  // 1️⃣ compute
  const result = buildRiskAssessmentFromCustomer(payload);

  // 2️⃣ optional — try link real customer
  let customerDoc = null;

  if (payload.customerId) {
    customerDoc = await Customer.findById(payload.customerId)
      .select("uid personalKyc.personal_form.customer_details")
      .lean();
  }

  // 3️⃣ build display name
  const name =
    payload.name ||
    customerDoc?.personalKyc?.personal_form?.customer_details?.given_name ||
    "Unknown";

  // 4️⃣ store snapshot
  const saved = await IndividualRiskAssessment.create({
    client,
    branch,
    customer: customerDoc?._id,
    customerUid: customerDoc?.uid,

    customerName: name,

    inputSnapshot: payload,
    assessment: result.riskAssessment,
    riskScore: result.riskScore,
    riskLabel: result.riskLabel,

    assessedBy: req.user?._id || null,
    source: "api",
  });

  // 5️⃣ return saved doc
  res.json({
    success: true,
    data: saved,
  });
});

/**
 * GET /api/customers/:id/risk?scope=relation|overall
 * Fetches customer from DB and runs assessment.
 * - scope=relation (default): run buildRiskAssessmentPerRelation -> returns relationRisks + summary
 * - scope=overall: run buildRiskAssessmentFromCustomer -> returns single overall
 */
exports.assessCustomerById = asyncHandler(async (req, res) => {
  const id = req.params.id;
  const scope = (req.query.scope || "relation").toLowerCase();

  if (!id)
    return res.status(400).json({ success: false, message: "Missing id" });

  const customer = await Customer.findById(id).lean();
  if (!customer)
    return res
      .status(404)
      .json({ success: false, message: "Customer not found" });

  if (scope === "overall") {
    const result = buildRiskAssessmentFromCustomer(customer);
    return res.json({ success: true, data: result });
  } else {
    const result = buildRiskAssessmentPerRelation(customer);
    return res.json({ success: true, data: result });
  }
});

exports.getIndividualRiskAssessments = asyncHandler(async (req, res, next) => {
  // assumes advancedResults middleware populates res.advancedResults
  res.status(200).json(res.advancedResults);
});
