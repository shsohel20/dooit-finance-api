// controllers/customerDocumentsController.js
// Reviewer-side management of a customer's uploaded documents
// (Customer.documents — DocumentMetaSchema): add via the Documents tab and
// remove by URL. Persisted with updateOne ($push/$pull) so the Customer
// pre-save encryption hooks don't re-process untouched PII fields.

const asyncHandler = require("../middleware/async");
const ErrorResponse = require("../utils/errorResponse");
const Customer = require("../models/Customer");
const { customerRelatedToTenant } = require("../utils/customerTenantGuard");

// Keep only the DocumentMetaSchema fields — never trust arbitrary keys.
const sanitizeDoc = (doc = {}) => ({
  name: String(doc.name || "").slice(0, 200),
  url: String(doc.url || ""),
  mimeType: String(doc.mimeType || "application/octet-stream"),
  type: String(doc.type || "manual_upload"),
  docType: String(doc.docType || "other"),
  uploadedAt: new Date(),
});

const loadGuardedCustomer = async (req, next) => {
  const customer = await Customer.findById(req.params.id).select("documents relations");
  if (!customer) {
    next(new ErrorResponse(`Customer not found with id of ${req.params.id}`, 404));
    return null;
  }
  const client = req?.user?.client?._id || null;
  const branch = req?.user?.branch?._id || null;
  if (!customerRelatedToTenant(customer, client, branch)) {
    next(new ErrorResponse(`Customer not found with id of ${req.params.id}`, 404));
    return null;
  }
  return customer;
};

// @desc   Add one or more documents to a customer
// @route  POST /api/v1/customer/:id/documents
// @access Private (admin, client, branch, manager, officer)
exports.addCustomerDocuments = asyncHandler(async (req, res, next) => {
  const raw = Array.isArray(req.body?.documents)
    ? req.body.documents
    : req.body?.document
      ? [req.body.document]
      : [];

  const docs = raw.map(sanitizeDoc).filter((d) => d.url);
  if (docs.length === 0) {
    return next(new ErrorResponse("At least one document with a url is required", 400));
  }

  const customer = await loadGuardedCustomer(req, next);
  if (!customer) return;

  // No duplicate URLs — documents have no _id, URL is the identity.
  const existing = new Set((customer.documents || []).map((d) => d.url));
  const fresh = docs.filter((d) => !existing.has(d.url));
  if (fresh.length === 0) {
    return next(new ErrorResponse("Document(s) already attached to this customer", 400));
  }

  await Customer.updateOne(
    { _id: customer._id },
    { $push: { documents: { $each: fresh } } },
  );

  const updated = await Customer.findById(customer._id).select("documents").lean();
  res.status(200).json({
    success: true,
    message: `${fresh.length} document(s) added`,
    data: updated.documents,
  });
});

// @desc   Remove a customer document by its URL
// @route  DELETE /api/v1/customer/:id/documents?url=...
// @access Private (admin, client, branch, manager, officer)
exports.removeCustomerDocument = asyncHandler(async (req, res, next) => {
  const url = req.query.url || req.body?.url;
  if (!url) {
    return next(new ErrorResponse("url (query or body) is required", 400));
  }

  const customer = await loadGuardedCustomer(req, next);
  if (!customer) return;

  const exists = (customer.documents || []).some((d) => d.url === url);
  if (!exists) {
    return next(new ErrorResponse("Document not found on this customer", 404));
  }

  await Customer.updateOne({ _id: customer._id }, { $pull: { documents: { url } } });

  const updated = await Customer.findById(customer._id).select("documents").lean();
  res.status(200).json({
    success: true,
    message: "Document removed",
    data: updated.documents,
  });
});
