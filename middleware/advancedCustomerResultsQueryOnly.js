const mongoose = require("mongoose");

const isEmpty = (v) =>
    v === undefined || v === null || v === "" || v === "null";

const toBool = (v) => v === "true" || v === true;

module.exports =
    ({ populate = null, searchFields = [] } = {}) =>
        async (req, res, next) => {
            try {
                const Customer = mongoose.model("Customer");

                console.log(req?.user?.client?._id)
                console.log(req?.user?.branch?._id)
                const client = req?.user?.client?._id || null;
                const branch = req?.user?.branch?._id || null;

                // -----------------------------
                // 1. DB-level filters
                // -----------------------------
                const dbQuery = {};

                // tenant isolation
                if (client) dbQuery["relations.client"] = client;
                if (branch) dbQuery["relations.branch"] = branch;

                // simple indexed filters
                [
                    "kycStatus",
                    "country",
                    "isActive",
                    "isPep",
                    "sanction",
                ].forEach((field) => {
                    if (!isEmpty(req.query[field])) {
                        dbQuery[field] =
                            field === "isActive" ||
                                field === "isPep" ||
                                field === "sanction"
                                ? toBool(req.query[field])
                                : req.query[field];
                    }
                });

                // relation filters
                if (!isEmpty(req.query.relationType)) {
                    dbQuery["relations.type"] = req.query.relationType;
                }

                if (!isEmpty(req.query.clientId)) {
                    dbQuery["relations.client"] = req.query.clientId;
                }

                if (!isEmpty(req.query.branchId)) {
                    dbQuery["relations.branch"] = req.query.branchId;
                }

                // -----------------------------
                // 2. Deep text search
                // -----------------------------
                if (!isEmpty(req.query.q) && searchFields.length) {
                    const regex = new RegExp(req.query.q, "i");
                    dbQuery.$or = searchFields.map((path) => ({
                        [path]: regex,
                    }));
                }

                // -----------------------------
                // 3. Base mongoose query
                // -----------------------------
                let baseQuery = Customer.find(dbQuery);

                if (populate) baseQuery = baseQuery.populate(populate);

                // -----------------------------
                // 4. Sorting
                // -----------------------------
                const sort = req.query.sort || "-createdAt";
                baseQuery = baseQuery.sort(sort);

                // -----------------------------
                // 5. Pagination
                // -----------------------------
                const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
                const limit = Math.min(parseInt(req.query.limit, 10) || 25, 100);
                const skip = (page - 1) * limit;

                // -----------------------------
                // 6. In-memory filters (virtuals)
                // -----------------------------
                const needsMemoryFilter =
                    !isEmpty(req.query.minRiskScore) ||
                    !isEmpty(req.query.maxRiskScore) ||
                    !isEmpty(req.query.riskLabel);

                let totalRecords = 0;
                let results = [];

                if (needsMemoryFilter) {
                    // fetch all (DB-filtered)
                    const docs = await baseQuery
                        .lean({ virtuals: true })
                        .exec();

                    const filtered = docs.filter((doc) => {
                        if (
                            !isEmpty(req.query.minRiskScore) &&
                            doc.riskScore < Number(req.query.minRiskScore)
                        )
                            return false;

                        if (
                            !isEmpty(req.query.maxRiskScore) &&
                            doc.riskScore > Number(req.query.maxRiskScore)
                        )
                            return false;

                        if (
                            !isEmpty(req.query.riskLabel) &&
                            doc.riskLabel !== req.query.riskLabel
                        )
                            return false;

                        return true;
                    });

                    totalRecords = filtered.length;
                    results = filtered.slice(skip, skip + limit);

                    if (populate) {
                        results = await Customer.populate(results, populate);
                    }
                } else {
                    // DB-level pagination
                    totalRecords = await Customer.countDocuments(dbQuery);
                    results = await baseQuery.skip(skip).limit(limit);
                }

                // -----------------------------
                // 7. Pagination meta
                // -----------------------------
                const pagination = {};
                if (skip + limit < totalRecords) {
                    pagination.next = { page: page + 1, limit };
                }
                if (skip > 0) {
                    pagination.prev = { page: page - 1, limit };
                }

                // -----------------------------
                // 8. Attach response
                // -----------------------------
                res.advancedResults = {
                    success: true,
                    totalRecords,
                    count: results.length,
                    pagination,
                    data: results,
                };

                next();
            } catch (err) {
                next(err);
            }
        };
