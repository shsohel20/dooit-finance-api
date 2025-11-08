// const { isObjEmpty } = require("../utils");

// const advancedResults =
//   (model, populate, filterSection) => async (req, res, next) => {
//     let query;
//     ///Copy req.query
//     const reqQuery = { ...req.query };

//     // Field to exclude
//     const removeFields = ["select", "sort", "orderBy"];

//     //Loop over removeFields and Delete them from  reqQuery
//     removeFields.forEach((param) => delete reqQuery[param]);

//     ///Create Query String
//     let queryStr = JSON.stringify(req.query);
//     //Create operators ($gt, $gte etc.)
//     queryStr = queryStr.replace(
//       /\b(gt|gte|lt|lte|in)\b/g,
//       (match) => `$${match}`,
//     );

//     ///Finding resource
//     query = model.find(JSON.parse(queryStr));

//     ///Select Fields
//     if (req.query.select) {
//       const fields = req.query.select.split(",").join(" ");
//       query = query.select(fields);
//     }
//     ///Sort
//     if (req.query.sort) {
//       ///Default Order By Ascending
//       const orderBy = req.query?.orderBy ?? "asc";

//       const sortBy = req.query.sort.split(",").join(" ");

//       query = query.sort(orderBy === "desc" ? `-${sortBy}` : sortBy);
//     } else {
//       query = query.sort("-createdAt");
//     }

//     ///Pagination
//     const page = parseInt(req.query.page, 10) || 1;
//     const limit = parseInt(req.query.limit, 10) || 25;
//     const startIndex = (page - 1) * limit;
//     const endIndex = page * limit;
//     const total = await model.countDocuments();

//     query = query.skip(startIndex).limit(limit);

//     ///Populated
//     if (populate) {
//       query = query.populate(populate);
//     }

//     // Executing Query
//     let queryData = await query;
//     if (!isObjEmpty(req.body) && filterSection) {
//       const queryFilter = [...queryData];
//       queryData = queryFilter.filter((f) => filterSection(f, req.body));
//       // s.name.toLowerCase().trim().includes(req.body.name.toLowerCase().trim())
//     }

//     //Pagination Result
//     const pagination = {};

//     if (endIndex < total) {
//       pagination.next = {
//         page: page + 1,
//         limit,
//       };
//     }
//     if (startIndex > 0) {
//       pagination.prev = {
//         page: page - 1,
//         limit,
//       };
//     }

//     res.advancedResults = {
//       total: queryData.length,
//       success: true,
//       totalRecords: total,
//       pagination,
//       data: queryData,
//     };
//     next();
//   };

// module.exports = advancedResults;

const { isObjEmpty } = require("../utils");

const advancedResults = (model, populate) => async (req, res, next) => {
  try {
    let query;

    // Copy req.query
    const reqQuery = { ...req.query };

    // Fields to exclude
    const removeFields = [
      "select",
      "sort",
      "orderBy",
      "regex",
      "page",
      "limit",
    ];

    // Remove excluded fields from reqQuery
    removeFields.forEach((param) => delete reqQuery[param]);

    // Create Query String
    let queryStr = JSON.stringify(reqQuery);

    // Create operators ($gt, $gte, etc.)
    // Adjust the regular expression pattern to include case insensitivity
    queryStr = queryStr.replace(
      /\b(gt|gte|lt|lte|in|text|search|regex|options)\b/gi,
      (match) => `$${match}`
    );

    // Finding resources
    query = model.find(JSON.parse(queryStr));

    // Search by title if title parameter exists
    if (req.query.title && req.query.title.trim() !== "") {
      const regexPattern = req.query.title
        .replace(/-/g, " ") // Replace hyphens with spaces
        .split(" ")
        .map((term) => `(?=.*${term})`)
        .join("");

      // query = { title: { $regex: new RegExp(regexPattern, "i") } };
      // const regex = new RegExp(req.query.title, "i");
      query = query.find({ title: { $regex: new RegExp(regexPattern, "i") } });
    }
    // Search by Blog Id if is exiting in query
    if (req.query.blogId && req.query.blogId.trim() !== "") {
      const blogId = req.query.blogId;
      query = query.find({ blog: blogId });
    }
    // Search by Job Id if is exiting in query
    if (req.query.jobId && req.query.jobId.trim() !== "") {
      const jobId = req.query.jobId;
      query = query.find({ job: jobId });
    }

    // Select Fields
    if (req.query.select) {
      const fields = req.query.select.split(",").join(" ");
      query = query.select(fields);
    }

    // Sort
    if (req.query.sort) {
      const orderBy = req.query?.orderBy || "asc";
      const sortBy = req.query.sort.split(",").join(" ");
      query = query.sort(orderBy === "desc" ? `-${sortBy}` : sortBy);
    } else {
      query = query.sort("-createdAt");
    }

    // Pagination
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 25;

    let total = 0;

    // Search by title if title parameter exists
    if (req.query.title && req.query.title.trim() !== "") {
      const regexPattern = req.query.title
        .replace(/-/g, " ") // Replace hyphens with spaces
        .split(" ")
        .map((term) => `(?=.*${term})`)
        .join("");

      // query = { title: { $regex: new RegExp(regexPattern, "i") } };
      // const regex = new RegExp(req.query.title, "i");
      total = await model.countDocuments({
        title: { $regex: new RegExp(regexPattern, "i") },
      });
    } else {
      total = await model.countDocuments();
    }

    // Count total documents after filtering

    const startIndex = (page - 1) * limit;
    const endIndex = page * limit;

    query = query.skip(startIndex).limit(limit);

    // Populate
    if (populate) {
      query = query.populate(populate);
    }

    // Execute Query
    const results = await query;
    const queryTotal = results.length;

    // Pagination Result
    const pagination = {};

    if (endIndex < total) {
      pagination.next = {
        page: page + 1,
        limit,
      };
    }
    if (startIndex > 0) {
      pagination.prev = {
        page: page - 1,
        limit,
      };
    }

    res.advancedResults = {
      da: JSON.parse(queryStr),
      success: true,
      totalRecords: total,
      pagination,
      data: results,
    };
    next();
  } catch (error) {
    next(error);
  }
};

module.exports = advancedResults;
