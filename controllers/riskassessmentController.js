const asyncHandler = require("../middleware/async");
const CountryRisk = require("../models/CountryRisk");
const Customer = require("../models/Customer");
const IndividualRiskAssessment = require("../models/IndividualRiskAssessment");
const RiskFactorOption = require("../models/RiskFactorOption");
const { Parser } = require("json2csv");
const { Readable } = require("stream");



const csv = require("csv-parser");
const fs = require("fs");



function bufferToStream(buffer) {
  const stream = new Readable();
  stream.push(buffer);
  stream.push(null);
  return stream;
}
const {
  FACTORS,
  UHRC,
  HRC,
  MRC,
  LRC,
  buildRiskAssessmentFromCustomer,
  buildRiskAssessmentPerRelation,
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

async function buildCountryRiskListFromDB() {
  const rows = await CountryRisk.find({})
    .select("country band score")
    .lean();

  return rows
    .map(r => ({
      country: titleCase(r.country),
      band: r.band,
      score: r.score,
    }))
    .sort((a, b) => a.country.localeCompare(b.country));
}


// exports.getRiskFactors = asyncHandler(async (req, res, next) => {
//   // send FACTORS as-is (client uses value/score lists for dropdowns)
//   const data = buildCountryRiskList();

//   return res.json({ success: true, data: { ...FACTORS, countries: data } });
// });

exports.getRiskFactors = asyncHandler(async (req, res) => {
  const rows = await RiskFactorOption.find({})
    .select("factor value score risk industry")
    .lean();

  // group by factor
  const grouped = {};

  for (const r of rows) {
    if (!grouped[r.factor]) grouped[r.factor] = [];
    grouped[r.factor].push({
      value: r.value,
      score: r.score,
      risk: r.risk || null,
      industry: r.industry || null,
    });
  }

  const countries = await buildCountryRiskListFromDB();

  res.json({
    success: true,
    data: {
      ...grouped,
      countries,
    },
  });
});


exports.getJurisdictions = asyncHandler(async (req, res, next) => {
  const data = await buildCountryRiskListFromDB();

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
    const tokens = q.trim().split(/\s+/);

    filter.$and = tokens.map((word) => ({
      $or: [
        { uid: new RegExp(word, "i") },
        {
          "personalKyc.personal_form.customer_details.given_name":
            new RegExp(word, "i"),
        },
        {
          "personalKyc.personal_form.customer_details.surname":
            new RegExp(word, "i"),
        },
        {
          "personalKyc.personal_form.contact_details.email":
            new RegExp(word, "i"),
        },
      ],
    }));
  }

  const customers = await Customer.find(filter)


    .limit(Number(limit))
    .sort({ createdAt: -1 });
  // IMPORTANT → enables your risk virtuals

  // console.log(customers[0])

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
  const { summary } = buildRiskAssessmentPerRelation(payload);
  // const { relationRisks } = buildRiskAssessmentPerRelation(payload);

  // 5️⃣ return saved doc
  res.json({
    success: true,
    data: {
      ...result,
      summary,
      // relationRisks
    },

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

exports.getIndividualRiskAssessment = asyncHandler(async (req, res) => {
  const doc = await IndividualRiskAssessment.findById(req.params.id)
    .populate("customer", "uid personalKyc")
    .populate("assessedBy", "name email")
    .lean();
  if (!doc) return res.status(404).json({ success: false, message: "Assessment not found" });
  res.json({ success: true, data: doc });
});

exports.updateIndividualRiskAssessment = asyncHandler(async (req, res) => {
  const allowed = { notes: req.body.notes };
  const doc = await IndividualRiskAssessment.findByIdAndUpdate(req.params.id, allowed, { new: true });
  if (!doc) return res.status(404).json({ success: false, message: "Assessment not found" });
  res.json({ success: true, data: doc });
});


//// Risk dynamic model manipulation 

// GET /risk/countries
// exports.getCountryRisks = asyncHandler(async (req, res) => {
//   const { q, band } = req.query;

//   const filter = {};

//   if (band) {
//     filter.band = band.toUpperCase();
//   }

//   if (q) {
//     filter.country = new RegExp(q, "i");
//   }

//   const rows = await CountryRisk.find(filter)
//     .sort({ country: 1 })
//     .lean();

//   res.json({
//     success: true,
//     count: rows.length,
//     data: rows,
//   });
// });

exports.getCountryRisks = asyncHandler(async (req, res, next) => {
  // assumes advancedResults middleware populates res.advancedResults
  res.status(200).json(res.advancedResults);
});


// POST /risk/countries
exports.createCountryRisk = asyncHandler(async (req, res) => {
  const payload = req.body;

  const createOne = (row) => {
    const band = row.band.toUpperCase();

    return {
      country: titleCase(row.country),
      band,
      score: row.score ?? bandScoreMap[band] ?? 0,
    };
  };

  let docs;

  if (Array.isArray(payload)) {
    docs = payload.map(createOne);
    docs = await CountryRisk.insertMany(docs);
  } else {
    docs = await CountryRisk.create(createOne(payload));
  }

  res.status(201).json({
    success: true,
    data: docs,
  });
});

// PUT /risk/countries/:id
exports.updateCountryRisk = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const update = { ...req.body };

  if (update.country) {
    update.country = titleCase(update.country);
  }

  if (update.band) {
    update.band = update.band.toUpperCase();
    if (update.score == null) {
      update.score = bandScoreMap[update.band] ?? 0;
    }
  }

  const doc = await CountryRisk.findByIdAndUpdate(id, update, {
    new: true,
    runValidators: true,
  });

  if (!doc) {
    return res.status(404).json({
      success: false,
      message: "Country risk not found",
    });
  }

  res.json({
    success: true,
    data: doc,
  });
});

exports.deleteCountryRisk = asyncHandler(async (req, res) => {


  const countryRisk = await CountryRisk.findById(req.params.id);
  if (!countryRisk) {
    return next(
      new ErrorResponse(`countryRisk not found with id of ${req.params.id}`, 404),
    );
  }

  user.deleteOne();

  res.status(200).json({
    success: true,
    data: req.params.id,
  });

  res.status(201).json({
    success: true,
    data: docs,
  });
});




// GET /risk/factors
// exports.getRiskFactorOptions = asyncHandler(async (req, res) => {
//   const { factor } = req.query;

//   const filter = {};
//   if (factor) filter.factor = factor;

//   const rows = await RiskFactorOption.find(filter)
//     .sort({ factor: 1, score: -1 })
//     .lean();

//   // if factor specified → return flat
//   if (factor) {
//     return res.json({
//       success: true,
//       count: rows.length,
//       data: rows,
//     });
//   }

//   // else group by factor
//   const grouped = {};

//   for (const r of rows) {
//     if (!grouped[r.factor]) grouped[r.factor] = [];

//     grouped[r.factor].push({
//       id: r._id,
//       value: r.value,
//       score: r.score,
//       risk: r.risk,
//       industry: r.industry,
//     });
//   }

//   res.json({
//     success: true,
//     data: grouped,
//   });
// });

exports.getRiskFactorOptions = asyncHandler(async (req, res, next) => {
  // assumes advancedResults middleware populates res.advancedResults
  res.status(200).json(res.advancedResults);
});



// POST /risk/factors
exports.createRiskFactorOption = asyncHandler(async (req, res) => {
  const payload = req.body;

  const normalize = (r) => ({
    factor: r.factor.toLowerCase(),
    value: r.value,
    score: r.score,
    risk: r.risk || null,
    industry: r.industry || null,
  });

  let docs;

  if (Array.isArray(payload)) {
    docs = await RiskFactorOption.insertMany(payload.map(normalize));
  } else {
    docs = await RiskFactorOption.create(normalize(payload));
  }

  res.status(201).json({
    success: true,
    data: docs,
  });
});


// PUT /risk/factors/:id
exports.updateRiskFactorOption = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const update = { ...req.body };

  if (update.factor) {
    update.factor = update.factor.toLowerCase();
  }

  const doc = await RiskFactorOption.findByIdAndUpdate(
    id,
    update,
    {
      new: true,
      runValidators: true,
    }
  );

  if (!doc) {
    return res.status(404).json({
      success: false,
      message: "Risk factor option not found",
    });
  }

  res.json({
    success: true,
    data: doc,
  });
});


// DELETE /risk/factors/:id
exports.deleteRiskFactorOption = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const doc = await RiskFactorOption.findByIdAndDelete(id);

  if (!doc) {
    return res.status(404).json({
      success: false,
      message: "Risk factor option not found",
    });
  }

  res.json({
    success: true,
    message: "Risk factor option deleted",
    data: doc._id,
  });
});

// =========================
// ✅ EXPORT — COUNTRY RISK → CSV
// =========================

exports.exportCountryRiskCsv = asyncHandler(async (req, res) => {
  const rows = await CountryRisk.find({})
    .select("country band score")
    .lean();

  const parser = new Parser({
    fields: ["country", "band", "score", "aliases", "source"],
  });

  const csv = parser.parse(rows);

  res.header("Content-Type", "text/csv");
  res.attachment("country-risk.csv");
  return res.send(csv);
});

// =========================
// ✅ EXPORT — RISK FACTORS → CSV
// =========================
exports.exportRiskFactorsCsv = asyncHandler(async (req, res) => {
  const rows = await RiskFactorOption.find({})
    .select("factor value score risk industry")
    .lean();

  const parser = new Parser({
    fields: ["factor", "value", "score", "risk", "industry"],
  });

  const csv = parser.parse(rows);

  res.header("Content-Type", "text/csv");
  res.attachment("risk-factors.csv");
  res.send(csv);
});




exports.importCountryRiskCsv = asyncHandler(async (req, res) => {

  if (!req.file) {
    return res.status(400).json({
      success: false,
      message: "CSV file required",
    });
  }

  const rows = [];

  await new Promise((resolve, reject) => {
    bufferToStream(req.file.buffer)
      .pipe(csv())
      .on("data", (row) => {
        rows.push({
          country: row.country.toLowerCase().trim(),
          band: row.band.trim(),
          score: Number(row.score),
        });
      })
      .on("end", resolve)
      .on("error", reject);
  });

  await CountryRisk.deleteMany({});
  await CountryRisk.insertMany(rows);

  res.json({
    success: true,
    inserted: rows.length,
  });
});


exports.importRiskFactorsCsv = asyncHandler(async (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      success: false,
      message: "CSV file required",
    });
  }

  const rows = [];

  await new Promise((resolve, reject) => {
    bufferToStream(req.file.buffer)
      .pipe(csv())
      .on("data", (row) => {
        rows.push({
          factor: row.factor.toLowerCase().trim(),
          value: row.value.trim(),
          score: Number(row.score),
          risk: row.risk || null,
          industry: row.industry || null,
        });
      })
      .on("end", resolve)
      .on("error", reject);
  });

  await RiskFactorOption.deleteMany({});
  await RiskFactorOption.insertMany(rows);

  res.json({
    success: true,
    inserted: rows.length,
  });
});

// ── ECDD Gate ──────────────────────────────────────────────────────────────────

// @route POST /api/v1/risk-assessment/:id/ecdd-approve
exports.ecddApprove = asyncHandler(async (req, res, next) => {
  const { ecddDecision = "", ecddReviewDate } = req.body;
  const ErrorResponse = require("../utils/errorResponse");
  const update = {
    ecddStatus: "Approved",
    cddGate: false,
    ecddDecision,
    ecddDecidedBy: req.user?.id || null,
    ecddDecidedAt: new Date(),
    ecddReviewDate: ecddReviewDate ? new Date(ecddReviewDate) : null,
  };
  const doc = await IndividualRiskAssessment.findByIdAndUpdate(req.params.id, update, { new: true });
  if (!doc) return next(new ErrorResponse("CRA record not found", 404));
  res.status(200).json({ success: true, data: doc });
});

// @route POST /api/v1/risk-assessment/:id/ecdd-decline
exports.ecddDecline = asyncHandler(async (req, res, next) => {
  const { ecddDecision = "" } = req.body;
  const ErrorResponse = require("../utils/errorResponse");
  const update = {
    ecddStatus: "Declined",
    cddGate: true,
    ecddDecision,
    ecddDecidedBy: req.user?.id || null,
    ecddDecidedAt: new Date(),
  };
  const doc = await IndividualRiskAssessment.findByIdAndUpdate(req.params.id, update, { new: true });
  if (!doc) return next(new ErrorResponse("CRA record not found", 404));
  res.status(200).json({ success: true, data: doc });
});
