

const asyncHandler = require("../middleware/async");
const ErrorResponse = require("../utils/errorResponse");
const Staff = require("../models/Staff");
const User = require("../models/User");
const Role = require("../models/Role");
const sendEmail = require("../utils/sendEmail");
const { getRawEmail } = require("../utils/rawUserFields");
const { generatePassword } = require("../utils/passwordUtils");
const { staffWelcomeHtml } = require("../utils/email-template/staffEmailTemplate");
const { toAlpha3 } = require("../utils/countryUtils");
const {
  ensureStaffApplicant,
  submitStaffDocuments,
  syncStaffApplicantStatus,
  triggerStaffAmlCheck,
} = require("../services/staffSumsubService");

// ─────────────────────────────────────────────────────────────────────────────
// @desc    Create a staff member — derives User from personal + contact fields,
//          emails credentials, then creates and links the Staff record
// @route   POST /api/v1/staff
// @access  Protected (admin / client / branch / manager)
//
// Request body:

//   client?    – ObjectId
//   branch?    – ObjectId
//   personal   – {role, firstName, lastName, dateOfBirth, nationality, ... }
//   contact    – { workEmail, phone, residentialAddress, ... }
//   employment – { startDate, department, jobTitle, employmentType }
//   + any other Staff fields
// ─────────────────────────────────────────────────────────────────────────────
exports.createStaff = asyncHandler(async (req, res, next) => {
  const {
    personal,
    contact,
    employment,
    ...rest
  } = req.body || {};



  const client = req?.user?.client?._id || null;
  const branch = req?.user?.branch?._id || null;

  // ── validate required fields ──────────────────────────────────────────────
  if (!personal?.role) {
    return next(
      new ErrorResponse("Must have to role are required", 400),
    );
  }
  if (!personal?.firstName || !personal?.lastName) {
    return next(
      new ErrorResponse("personal.firstName and personal.lastName are required", 400),
    );
  }
  if (!contact?.workEmail) {
    return next(new ErrorResponse("contact.workEmail is required", 400));
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(contact.workEmail)) {
    return next(new ErrorResponse("Invalid contact.workEmail address", 400));
  }

  // ── resolve nationality: accept full name, alpha-2, or alpha-3 ───────────
  // if (personal?.nationality) {
  //   const alpha3 = toAlpha3(personal.nationality);
  //   if (!alpha3) {
  //     return next(
  //       new ErrorResponse(`Unrecognized nationality: "${personal.nationality}"`, 400),
  //     );
  //   }
  //   personal.nationality = alpha3;
  // }

  // ── resolve country (residence): accept full name, alpha-2, or alpha-3 ─────
  if (personal?.country) {
    const alpha3 = toAlpha3(personal.country);
    if (!alpha3) {
      return next(
        new ErrorResponse(`Unrecognized country: "${personal.country}"`, 400),
      );
    }
    personal.country = alpha3;
  }

  // ── derive user fields from staff payload ─────────────────────────────────
  const fullName = `${personal.firstName} ${personal.lastName}`;

  // ── check for duplicate email ─────────────────────────────────────────────
  const existingEmail = await User.findOne({ email: contact.workEmail });
  if (existingEmail) {
    return next(
      new ErrorResponse("A user with that work email already exists", 409),
    );
  }

  //TODO
  // ── generate random password ──────────────────────────────────────────────
  // const plainPassword = generatePassword();
  const plainPassword = 'DooiT@123456';

  // ── create user ───────────────────────────────────────────────────────────
  const user = await User.create({
    name: fullName,
    userName: contact.workEmail,
    email: contact.workEmail,
    phone: contact.phone || undefined,
    role: personal?.role,
    userType: "client",
    password: plainPassword,
    isActive: true,
    clientBelongs: client || null,
    branchBelongs: branch || null,
  });

  // ── send welcome email with credentials ───────────────────────────────────
  try {
    const rawEmail = await getRawEmail(user._id);
    await sendEmail({
      email: rawEmail,
      subject: "Your Dooit Staff Account Credentials",
      message: staffWelcomeHtml(fullName, contact.workEmail, plainPassword),
    });
  } catch (_emailErr) {
    console.error("[createStaff] welcome email failed:", _emailErr.message);
  }

  // ── create staff record ───────────────────────────────────────────────────
  const staff = await Staff.create({
    user: user._id,
    client: client || null,
    branch: branch || null,
    createdBy: req.user?._id || null,
    personal,
    contact,
    employment,
    ...rest,
  });

  return res.status(201).json({
    success: true,
    message: "Staff member created and welcome email sent",
    data: {
      staff,
      user: {
        _id: user._id,
        name: user.name,
        userName: user.userName,
        email: contact.workEmail,
        role: user.role,
        isActive: user.isActive,
      },
    },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// @desc    Update a staff member's profile
// @route   PUT /api/v1/staff/:staffId
// @access  Protected (admin / client / branch / manager)
//
// Accepts any subset of staff fields. Nested objects (personal, contact,
// employment, declarations) are merged — only provided keys are overwritten.
// nationality accepts full name, alpha-2, or alpha-3.
// ─────────────────────────────────────────────────────────────────────────────
exports.updateStaff = asyncHandler(async (req, res, next) => {
  const { staffId } = req.params;
  const { personal, contact, employment, declarations, ...rest } = req.body || {};

  const staff = await Staff.findById(staffId);
  if (!staff) {
    return next(new ErrorResponse("Staff member not found", 404));
  }

  // ── resolve nationality if provided ───────────────────────────────────────
  if (personal?.nationality) {
    const alpha3 = toAlpha3(personal.nationality);
    if (!alpha3) {
      return next(
        new ErrorResponse(`Unrecognized nationality: "${personal.nationality}"`, 400),
      );
    }
    personal.nationality = alpha3;
  }

  // ── resolve country (residence) if provided ───────────────────────────────
  if (personal?.country) {
    const alpha3 = toAlpha3(personal.country);
    if (!alpha3) {
      return next(
        new ErrorResponse(`Unrecognized country: "${personal.country}"`, 400),
      );
    }
    personal.country = alpha3;
  }

  // ── merge nested sub-documents ────────────────────────────────────────────
  if (personal) Object.assign(staff.personal, personal);
  if (contact) Object.assign(staff.contact, contact);
  if (employment) Object.assign(staff.employment, employment);
  if (declarations) Object.assign(staff.declarations, declarations);

  // ── apply top-level scalar fields ─────────────────────────────────────────
  const allowed = [
    "status", "isActive", "riskScore", "riskLabel",
    "additionalNotes", "yearsInCompliance", "previousEmployer",
    "professionalCertifications", "regulatoryRegistrations",
    "signatureData", "signedAt", "client", "branch",
  ];
  for (const key of allowed) {
    if (key in rest) staff[key] = rest[key];
  }

  await staff.save();

  // ── sync relevant changes to the linked User ──────────────────────────────
  if (staff.user) {
    const userUpdates = {};

    const newFirstName = personal?.firstName ?? staff.personal.firstName;
    const newLastName = personal?.lastName ?? staff.personal.lastName;
    if (personal?.firstName || personal?.lastName) {
      userUpdates.name = `${newFirstName} ${newLastName}`;
    }

    if (contact?.workEmail) {
      const taken = await User.findOne({
        email: contact.workEmail,
        _id: { $ne: staff.user },
      });
      if (taken) {
        return next(
          new ErrorResponse("A user with that work email already exists", 409),
        );
      }
      userUpdates.email = contact.workEmail;
      userUpdates.userName = contact.workEmail;
    }

    if (contact?.phone) userUpdates.phone = contact.phone;
    if (personal?.role) userUpdates.role = personal.role;

    if (Object.keys(userUpdates).length) {
      await User.findByIdAndUpdate(staff.user, userUpdates);
    }
  }

  return res.status(200).json({
    success: true,
    message: "Staff member updated successfully",
    data: { staff },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// @desc    Get a single staff member by ID
// @route   GET /api/v1/staff/:staffId
// @access  Protected
// ─────────────────────────────────────────────────────────────────────────────
exports.getStaff = asyncHandler(async (req, res, next) => {
  const staff = await Staff.findById(req.params.staffId)
    .populate("user", "name userName email role isActive")
    .populate("client", "name")
    .populate("branch", "name")
    .populate("createdBy", "name email")
    .populate("reviewedBy", "name email");

  if (!staff) return next(new ErrorResponse("Staff member not found", 404));

  return res.status(200).json({ success: true, data: staff });
});

// ─────────────────────────────────────────────────────────────────────────────
// @desc    List staff — query/filter/sort/paginate via advancedStaffResults middleware
// @route   GET /api/v1/staff
// @access  Protected
// ─────────────────────────────────────────────────────────────────────────────
exports.getStaffs = asyncHandler(async (req, res) => {
  res.status(200).json(res.advancedResults);
});

// ─────────────────────────────────────────────────────────────────────────────
// @desc    Review a staff member — approve, reject, or request docs
// @route   PATCH /api/v1/staff/:staffId/review
// @access  Protected (admin / client / branch / manager)
//
// Body:
//   status          – approved | rejected | under_review | pending_docs
//   note            – reviewer comment (optional)
//   rejectionReason – required when status = rejected
// ─────────────────────────────────────────────────────────────────────────────
exports.reviewStaff = asyncHandler(async (req, res, next) => {
  const { status, note, rejectionReason } = req.body || {};

  const ALLOWED = ["approved", "rejected", "under_review", "pending_docs"];
  if (!status || !ALLOWED.includes(status)) {
    return next(
      new ErrorResponse(`status must be one of: ${ALLOWED.join(", ")}`, 400),
    );
  }
  if (status === "rejected" && !rejectionReason) {
    return next(new ErrorResponse("rejectionReason is required when rejecting", 400));
  }

  const staff = await Staff.findById(req.params.staffId);
  if (!staff) return next(new ErrorResponse("Staff member not found", 404));

  const prev = staff.status;
  staff.status = status;
  staff.reviewedBy = req.user._id;
  staff.reviewedAt = new Date();

  if (status === "approved") {
    staff.kycStatus = "verified";
    staff.kycVerifiedAt = new Date();
    staff.kycHistory.push({
      status: "verified",
      note: note || "Approved by reviewer",
      changedBy: req.user._id,
      changedAt: new Date(),
    });
  }

  if (status === "rejected") {
    staff.kycRejectReason = rejectionReason;
    staff.kycHistory.push({
      status: "rejected",
      note: rejectionReason,
      changedBy: req.user._id,
      changedAt: new Date(),
    });
  }

  await staff.save();

  return res.status(200).json({
    success: true,
    message: `Staff onboarding ${status}`,
    data: {
      staffId: staff._id,
      prevStatus: prev,
      status: staff.status,
      kycStatus: staff.kycStatus,
      reviewedBy: req.user._id,
      reviewedAt: staff.reviewedAt,
    },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// @desc    Get staff members filtered by Role document ID
// @route   GET /api/v1/staff/role/:roleId
// @access  Protected (admin / client / branch / manager)
// ─────────────────────────────────────────────────────────────────────────────
exports.getStaffByRoleId = asyncHandler(async (req, res, next) => {
  const { roleId } = req.params;

  const role = await Role.findById(roleId);
  if (!role) return next(new ErrorResponse("Role not found", 404));

  const users = await User.find({ role: role.name }).select("_id");
  const userIds = users.map((u) => u._id);

  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 10;
  const skip = (page - 1) * limit;

  const [staff, total] = await Promise.all([
    Staff.find({ user: { $in: userIds } })
      .populate("user", "name userName email role isActive")
      .populate("client", "name")
      .populate("branch", "name")
      .skip(skip)
      .limit(limit)
      .sort("-createdAt"),
    Staff.countDocuments({ user: { $in: userIds } }),
  ]);

  return res.status(200).json({
    success: true,
    role: { _id: role._id, name: role.name },
    count: staff.length,
    total,
    pagination: { page, limit, totalPages: Math.ceil(total / limit) },
    data: staff,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// @desc    Create (or fetch existing) Sumsub applicant for a staff member
// @route   POST /api/v1/staff/:staffId/sumsub/applicant
// @access  Protected (admin / client / branch / manager)
// ─────────────────────────────────────────────────────────────────────────────
exports.initStaffApplicant = asyncHandler(async (req, res, next) => {
  const staff = await Staff.findById(req.params.staffId);
  if (!staff) return next(new ErrorResponse("Staff member not found", 404));

  let result;
  try {
    result = await ensureStaffApplicant(staff);
  } catch (err) {
    return next(new ErrorResponse(err.message, 502));
  }

  return res.status(result.created ? 201 : 200).json({
    success: true,
    message: result.created ? "Sumsub applicant created" : "Sumsub applicant already exists",
    data: {
      applicantId: result.applicantId,
      inspectionId: result.inspectionId,
      reviewStatus: result.reviewStatus,
      requiredDocSets: result.requiredDocSets,
      kycStatus: staff.kycStatus,
    },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// @desc    Fetch Sumsub applicant status and sync KYC/AML fields into Staff
// @route   GET /api/v1/staff/:staffId/sumsub/status
// @access  Protected (admin / client / branch / manager)
// ─────────────────────────────────────────────────────────────────────────────
exports.syncStaffStatus = asyncHandler(async (req, res, next) => {
  const staff = await Staff.findById(req.params.staffId);
  if (!staff) return next(new ErrorResponse("Staff member not found", 404));

  if (!staff.sumsubApplicantId) {
    return next(
      new ErrorResponse(
        "No Sumsub applicant linked to this staff member. Call POST /sumsub/applicant first.",
        400,
      ),
    );
  }

  let result;
  try {
    result = await syncStaffApplicantStatus(staff);
  } catch (err) {
    return next(new ErrorResponse(err.message, 502));
  }

  return res.status(200).json({
    success: true,
    message: "Staff Sumsub status synced",
    data: {
      applicantId: staff.sumsubApplicantId,
      kycStatus: result.kycStatus,
      kycVerifiedAt: staff.kycVerifiedAt,
      kycRejectReason: staff.kycRejectReason,
      amlStatus: result.amlStatus,
      amlRiskLabels: staff.amlRiskLabels,
      isPep: staff.isPep,
      sanction: staff.sanction,
      screening: {
        status: staff.screening.status,
        pepMatch: staff.screening.pepMatch,
        sanctionsMatch: staff.screening.sanctionsMatch,
        adverseMedia: staff.screening.adverseMedia,
        riskLabels: staff.screening.riskLabels,
        checkedAt: staff.screening.checkedAt,
      },
    },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// @desc    Ensure Sumsub applicant exists (create if missing), then fetch and
//          sync the full KYC + AML status into Staff in one call
// @route   POST /api/v1/staff/:staffId/sumsub/run-aml
// @access  Protected (admin / client / branch / manager)
// ─────────────────────────────────────────────────────────────────────────────
exports.runAmlApplicant = asyncHandler(async (req, res, next) => {
  const staff = await Staff.findById(req.params.staffId);
  if (!staff) return next(new ErrorResponse("Staff member not found", 404));

  // ── Step 1: ensure screening profile exists (idempotent) ──────────────────
  let applicantResult;
  try {
    applicantResult = await ensureStaffApplicant(staff);
  } catch (err) {
    return next(new ErrorResponse(`Screening engine rejected the profile request: ${err.message}`, 502));
  }

  // ── Step 2: submit identity documents (non-fatal) ─────────────────────────
  let docSubmission = { submitted: 0, skipped: 0, results: [] };
  try {
    docSubmission = await submitStaffDocuments(staff);
  } catch (err) {
    console.error("[runAmlApplicant] doc submission error:", err.message);
  }

  // ── Step 3: fetch live status and sync into Staff ─────────────────────────
  let statusResult;
  try {
    statusResult = await syncStaffApplicantStatus(staff);
  } catch (err) {
    return next(new ErrorResponse(`Could not retrieve screening intelligence: ${err.message}`, 502));
  }

  return res.status(200).json({
    success: true,
    message: applicantResult.created
      ? "Identity profile registered — AML intelligence loaded"
      : "Identity profile located — AML intelligence refreshed",
    data: {
      applicantCreated: applicantResult.created,
      applicantId: staff.sumsubApplicantId,
      inspectionId: staff.sumsubInspectionId,
      documents: docSubmission,
      kycStatus: statusResult.kycStatus,
      kycVerifiedAt: staff.kycVerifiedAt,
      kycRejectReason: staff.kycRejectReason,
      amlStatus: statusResult.amlStatus,
      amlRiskLabels: staff.amlRiskLabels,
      isPep: staff.isPep,
      sanction: staff.sanction,
      screening: {
        status: staff.screening.status,
        pepMatch: staff.screening.pepMatch,
        sanctionsMatch: staff.screening.sanctionsMatch,
        adverseMedia: staff.screening.adverseMedia,
        riskLabels: staff.screening.riskLabels,
        checkedAt: staff.screening.checkedAt,
      },
    },
  });
});
