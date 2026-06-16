const mongoose = require('mongoose')
const AutoIncrement = require('mongoose-sequence')(mongoose)
const mongoosePaginate = require('mongoose-paginate-v2')
const { Schema } = mongoose

// ─── Enum constants ───────────────────────────────────────────────────────────

const OnboardingStatus = {
  DRAFT: 'draft',
  SUBMITTED: 'submitted',
  UNDER_REVIEW: 'under_review',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  PENDING_DOCS: 'pending_docs',
}

const ScreeningStatus = {
  PENDING: 'pending',
  CLEAR: 'clear',
  FLAGGED: 'flagged',
  YELLOW: 'yellow',         // matches Customer amlStatus "yellow"
  FAILED: 'failed',
  REVIEW_REQUIRED: 'review_required',
}

const Department = {
  COMPLIANCE: 'compliance',
  LEGAL: 'legal',
  OPERATIONS: 'operations',
  RISK: 'risk',
  AUDIT: 'audit',
  FINANCE: 'finance',
  IT: 'it',
  HR: 'hr',
}

const EmploymentType = {
  FULL_TIME: 'full_time',
  PART_TIME: 'part_time',
  CONTRACT: 'contract',
  CONSULTANT: 'consultant',
}

const JobTitle = {
  AML_ANALYST: 'aml_analyst',
  COMPLIANCE_OFFICER: 'compliance_officer',
  MLRO: 'mlro',
  COMPLIANCE_MANAGER: 'compliance_manager',
  RISK_ANALYST: 'risk_analyst',
  KYC_ANALYST: 'kyc_analyst',
  SENIOR_AML_ANALYST: 'senior_aml_analyst',
  DEPUTY_MLRO: 'deputy_mlro',
  COMPLIANCE_DIRECTOR: 'compliance_director',
}

const DocumentType = {
  NATIONAL_ID: 'national_id',
  PASSPORT: 'passport',
  DRIVERS_LICENSE: 'drivers_license',
  CV: 'cv',
  OFFER_LETTER: 'offer_letter',
  EMPLOYMENT_CONTRACT: 'employment_contract',
  CLEARANCE_CERT: 'clearance_cert',
  TAX_DOCUMENT: 'tax_document',
  BACKGROUND_CHECK: 'background_check',
  OTHER: 'other',
}

const TrainingFormat = {
  ONLINE: 'online',
  IN_PERSON: 'in_person',
  HYBRID: 'hybrid',
  SELF_PACED: 'self_paced',
}

const TrainingModule = {
  AML_BASICS: 'aml_basics',
  KYC_PROCEDURES: 'kyc_procedures',
  SAR_FILING: 'sar_filing',
  PEP_SCREENING: 'pep_screening',
  SANCTIONS_COMPLIANCE: 'sanctions_compliance',
  ADVERSE_MEDIA: 'adverse_media',
  TRANSACTION_MONITORING: 'transaction_monitoring',
  DATA_PROTECTION: 'data_protection',
}

// ─── Sub-schemas ──────────────────────────────────────────────────────────────

const PersonalInfoSchema = new Schema(
  {
    firstName: { type: String, required: true, trim: true, maxlength: 100 },
    lastName: { type: String, required: true, trim: true, maxlength: 100 },
    dateOfBirth: {
      type: Date, required: true,
      validate: {
        validator: function (v) {
          const age = (Date.now() - v.getTime()) / (365.25 * 24 * 60 * 60 * 1000)
          return age >= 18 && age <= 80
        },
        message: 'Staff member must be between 18 and 80 years old',
      },
    },
    nationality: {
      type: String, required: true, uppercase: true,
      match: [/^[A-Z]{3}$/, 'Use ISO 3166-1 alpha-3 country code (e.g. BGD, GBR)'],
    },
    nationalId: { type: String, trim: true, maxlength: 50 },
    passportNo: { type: String, trim: true, maxlength: 50 },
    tin: { type: String, trim: true, maxlength: 50 },
  },
  { _id: false }
)

const ContactInfoSchema = new Schema(
  {
    workEmail: {
      type: String, required: true, lowercase: true, trim: true,
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Invalid email address'],
    },
    personalEmail: {
      type: String, lowercase: true, trim: true,
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Invalid email address'],
    },
    phone: {
      type: String, required: true,
      match: [/^\+[1-9]\d{6,14}$/, 'Phone must be in E.164 format (+8801XXXXXXXXX)'],
    },
    emergencyPhone: {
      type: String,
      match: [/^\+[1-9]\d{6,14}$/, 'Phone must be in E.164 format'],
    },
    residentialAddress: { type: String, required: true, trim: true, maxlength: 500 },
  },
  { _id: false }
)

const EmploymentInfoSchema = new Schema(
  {
    startDate: { type: Date, required: true },
    department: { type: String, required: true, enum: Object.values(Department) },
    jobTitle: { type: String, required: true, enum: Object.values(JobTitle) },
    reportsTo: { type: String, trim: true, default: "" },
    employmentType: { type: String, required: true, enum: Object.values(EmploymentType), default: EmploymentType.FULL_TIME },
  },
  { _id: false }
)

const DeclarationSchema = new Schema(
  {
    pepDeclaration:            { type: Boolean, default: false },
    sanctionsDeclaration:      { type: Boolean, default: false },
    criminalRecordDeclaration: { type: Boolean, default: false },
    conflictOfInterestDecl:    { type: Boolean, default: false },
    ongoingMonitoringConsent:  { type: Boolean, default: false },
    backgroundCheckAuth:       { type: Boolean, default: false },
    amlPolicyAgreement:        { type: Boolean, default: false },
    accuracyDeclaration:       { type: Boolean, default: false },
    sarObligationAcknowledged: { type: Boolean, default: false },
    declaredAt:                { type: Date },
  },
  { _id: false }
)

const EmployeeScreeningSchema = new Schema(
  {
    status:         { type: String, enum: Object.values(ScreeningStatus), default: ScreeningStatus.PENDING },
    pepMatch:       { type: Boolean, default: false },
    sanctionsMatch: { type: Boolean, default: false },
    adverseMedia:   { type: Boolean, default: false },
    provider:       { type: String,  default: 'sumsub' },
    referenceId: { type: String },
    checkedAt: { type: Date },
    nextReviewAt: { type: Date },
    notes: { type: String, maxlength: 2000 },
    // aligned with Customer amlRiskLabels / amlHits / kycRawResult
    riskLabels: { type: [String], default: [] },     // e.g. ["pep", "sanctions", "adverseMedia"]
    hits: { type: [Schema.Types.Mixed], default: [] }, // raw provider hit objects
    kycRawResult: { type: Schema.Types.Mixed, default: null }, // immutable KYC audit copy
  },
  { _id: false }
)

const DocumentSchema = new Schema(
  {
    name:              { type: String },
    url:               { type: String },
    mimeType:          { type: String },
    type:              { type: String },
    docType:           { type: String },
    uploadedAt:        { type: Date, default: Date.now },
    sumsubImageId:     { type: String, default: null },
    sumsubStatus:      { type: String, enum: ['pending', 'submitted', 'failed'], default: 'pending' },
    sumsubSubmittedAt: { type: Date, default: null },
  },
  { _id: false },
)

const TrainingRecordSchema = new Schema(
  {
    module: { type: String, required: true, enum: Object.values(TrainingModule) },
    completed: { type: Boolean, required: true, default: false },
    completedAt: { type: Date },
    format: { type: String, required: true, enum: Object.values(TrainingFormat), default: TrainingFormat.ONLINE },
    targetDate: { type: Date },
    certificateUrl: { type: String },
  },
  { _id: true }
)

// ─── Root schema ──────────────────────────────────────────────────────────────

const StaffSchema = new Schema(
  {
    uid: { type: String },
    sequence: { type: Number, index: true },

    user: {
      type: Schema.Types.ObjectId,
      ref: 'Users',
      default: null,
      index: true,
    },

    client: {
      type: Schema.Types.ObjectId,
      ref: 'Client',
      default: null,
      index: true,
    },

    branch: {
      type: Schema.Types.ObjectId,
      ref: 'Branch',
      default: null,
      index: true,
    },

    createdBy: { type: Schema.Types.ObjectId, ref: 'Users', default: null },

    isActive: { type: Boolean, default: true },

    // ── Sumsub integration ────────────────────────────────────────────────────
    sumsubApplicantId: { type: String, default: null },
    sumsubInspectionId: { type: String, default: null },

    // ── KYC lifecycle (mirrors Customer pattern) ──────────────────────────────
    kycStatus: {
      type: String,
      enum: ['pending', 'in_review', 'verified', 'rejected'],
      default: 'pending',
      index: true,
    },
    kycHistory: [
      {
        status: String,
        note: String,
        changedBy: { type: Schema.Types.ObjectId, ref: 'Users' },
        changedAt: { type: Date, default: Date.now },
      },
    ],
    kycVerifiedAt: { type: Date, default: null },
    kycRejectReason: { type: String, default: null },
    kycRawResult: { type: Schema.Types.Mixed, default: null },

    // ── AML screening summary (mirrors Customer pattern) ──────────────────────
    amlStatus: {
      type: String,
      enum: ['pending', 'clear', 'flagged', 'yellow'],
      default: null,
    },
    amlRiskLabels: { type: [String], default: [] },      // e.g. ["pep", "sanctions", "adverseMedia"]
    amlHits: { type: [Schema.Types.Mixed], default: [] }, // raw Sumsub hit objects
    amlCheckedAt: { type: Date, default: null },
    amlVendor: { type: String, default: null },      // e.g. "Powered by ComplyAdvantage CSOM"

    isPep: { type: Boolean, default: false },
    sanction: { type: Boolean, default: false },
    consentToScreen: { type: Boolean, default: false },   // ongoing monitoring consent

    riskScore: { type: Number, default: null },
    riskLabel: { type: String, default: null },

    metadata: { type: Schema.Types.Mixed, default: {} },

    referenceCode: {
      type: String, unique: true, sparse: true, uppercase: true, trim: true,
      match: [/^DOO-AML-[A-Z0-9]{4,8}$/, 'Invalid reference code format'],
    },
    status: {
      type: String,
      required: true,
      enum: Object.values(OnboardingStatus),
      default: OnboardingStatus.DRAFT,
    },
    submittedAt: { type: Date },
    reviewedAt: { type: Date },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'Users' },

    personal: { type: PersonalInfoSchema, required: true },
    contact: { type: ContactInfoSchema, required: true },
    employment: { type: EmploymentInfoSchema, required: true },
    declarations: { type: DeclarationSchema,      default: () => ({}) },
    screening:    { type: EmployeeScreeningSchema, default: () => ({}) },

    professionalCertifications: [{ type: String, trim: true, maxlength: 100 }],
    regulatoryRegistrations: [{ type: String, trim: true, maxlength: 100 }],
    yearsInCompliance: { type: String },
    previousEmployer: { type: String, trim: true, maxlength: 200 },

    sumsubHistory: [
      {
        event:       { type: String }, // applicant_created | applicant_found | docs_submitted | status_synced
        applicantId: { type: String },
        note:        { type: String },
        meta:        { type: Schema.Types.Mixed },
        at:          { type: Date, default: Date.now },
      },
    ],

    documents: [DocumentSchema],
    training: [TrainingRecordSchema],
    auditLog: [{ type: Schema.Types.ObjectId, ref: 'AuditLog' }],

    additionalNotes: { type: String, maxlength: 5000 },
    signatureData: { type: String },
    signedAt: { type: Date },
  },
  {
    timestamps: true,
    collection: 'staffs',
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
)

// ─── Virtuals ─────────────────────────────────────────────────────────────────

StaffSchema.virtual('fullName').get(function () {
  return `${this.personal.firstName} ${this.personal.lastName}`
})

StaffSchema.virtual('isScreeningClear').get(function () {
  const { status, pepMatch, sanctionsMatch, adverseMedia } = this.screening
  return status === ScreeningStatus.CLEAR && !pepMatch && !sanctionsMatch && !adverseMedia
})

// ─── Pre-save hooks ───────────────────────────────────────────────────────────

StaffSchema.pre('save', function (next) {
  if (this.isNew && !this.uid) {
    this.uid = `SO_${Date.now()}`
  }
  if (this.isModified('status') && this.status === OnboardingStatus.SUBMITTED) {
    this.submittedAt = this.submittedAt || new Date()
    this.declarations.declaredAt = this.declarations.declaredAt || new Date()
  }
  next()
})

// ─── Indexes ──────────────────────────────────────────────────────────────────

// Primary lookups  (referenceCode index is declared via unique:true on the field)
StaffSchema.index({ 'contact.workEmail': 1 }, { unique: true, sparse: true })

// Multi-tenant scoping
StaffSchema.index({ client: 1, status: 1, createdAt: -1 })
StaffSchema.index({ client: 1, branch: 1 })

// Status queues
StaffSchema.index({ status: 1, createdAt: -1 })
StaffSchema.index({ status: 1, 'employment.department': 1 })

// KYC lifecycle
StaffSchema.index({ kycStatus: 1, createdAt: -1 })
StaffSchema.index({ sumsubApplicantId: 1 }, { sparse: true })

// AML screening
StaffSchema.index({ amlStatus: 1 })
StaffSchema.index({ isPep: 1, amlStatus: 1 })
StaffSchema.index({ sanction: 1, amlStatus: 1 })
StaffSchema.index({ 'screening.status': 1 })
StaffSchema.index({ 'screening.pepMatch': 1, 'screening.status': 1 })
StaffSchema.index({ 'screening.sanctionsMatch': 1, 'screening.status': 1 })
StaffSchema.index({ 'screening.nextReviewAt': 1 }, { sparse: true })

// Access & reviewer
StaffSchema.index({ reviewedBy: 1, reviewedAt: -1 }, { sparse: true })
StaffSchema.index({ submittedAt: -1 }, { sparse: true })
StaffSchema.index({ 'documents.expiresAt': 1 }, { sparse: true })

// Full-text search
StaffSchema.index({
  'personal.firstName': 'text',
  'personal.lastName': 'text',
  referenceCode: 'text',
})

// ─── Plugins ──────────────────────────────────────────────────────────────────

StaffSchema.plugin(mongoosePaginate)
StaffSchema.plugin(AutoIncrement, {
  inc_field: 'sequence',
  id: 'staff_onboarding_sequence',
  start_seq: 1,
})

// ─── Model export ─────────────────────────────────────────────────────────────

const Staff = mongoose.model('Staff', StaffSchema)

module.exports = Staff
module.exports.OnboardingStatus = OnboardingStatus
module.exports.ScreeningStatus = ScreeningStatus
module.exports.Department = Department
module.exports.EmploymentType = EmploymentType
module.exports.JobTitle = JobTitle
module.exports.DocumentType = DocumentType
module.exports.TrainingFormat = TrainingFormat
module.exports.TrainingModule = TrainingModule
