// models/DemoData.js
const mongoose = require("mongoose");
const { Schema } = mongoose;

const NameValueSchema = new Schema(
  {
    name: String,
    value: Schema.Types.Mixed,
  },
  { _id: false }
);

const BinaryRefSchema = new Schema(
  {
    data: Buffer,
    subType: String, // optional metadata if you want to keep it
  },
  { _id: false }
);

const TypingRhythmSchema = new Schema(
  {
    averageKeyDurationMs: { type: Number },
    averageKeyLatencyMs: { type: Number },
    errorRatePercent: { type: Number },
  },
  { _id: false }
);

const MouseMovementSchema = new Schema(
  {
    averageSpeedPxPerS: { type: Number },
    averageClicksPerMin: { type: Number },
    jerkinessScore: { type: Number },
  },
  { _id: false }
);

const ContactSchema = new Schema(
  {
    phone: String,
    email: String,
    residentialAddress: String,
    mailingAddress: String,
  },
  { _id: false }
);

const KycDocSchema = new Schema(
  {
    kycDocId: BinaryRefSchema,
    docType: String,
    docSubtype: String,
    docNumber: String,
    issuer: String,
    countryIssued: String,
    issueDate: Date,
    expiryDate: Date,
    filePath: String,
    idDocumentImage: String,
    faceMatchScore: Number,
    livenessScore: Number,
    verificationProviderRef: String,
  },
  { _id: false }
);

const UboSchema = new Schema(
  {
    uboId: BinaryRefSchema,
    name: String,
    dob: Date,
    ownershipPercent: Number,
    residentialAddress: String,
  },
  { _id: false }
);

const BizSchema = new Schema(
  {
    bizId: BinaryRefSchema,
    legalName: String,
    tradingName: String,
    structure: String,
    registrationNumber: String,
    countryOfIncorporation: String,
    businessAddress: String,
    phone: String,
    uboName: String,
    uboDob: Date,
    uboOwnershipPercent: Number,
    uboResidentialAddress: String,
    directorName: String,
    directorRole: String,
    authorisationDoc: String,
    nomineeDirectorDetails: String,
    corporateStructureChart: Schema.Types.Mixed,
  },
  { _id: false }
);

const TravelRuleSchema = new Schema(
  {
    trvMsgId: BinaryRefSchema,
    travelRuleMessageId: BinaryRefSchema,
    travelRuleProtocol: String,
    travelRuleVersion: String,
    messageTtlHours: Number,
    ivms101MessageHash: String,
    messageStatus: String,
  },
  { _id: false }
);

const DeviceSchema = new Schema(
  {
    deviceId: BinaryRefSchema,
    deviceFingerprint: String,
    ipAddress: String,
    ipGeolocation: String,
    ipRiskCategory: String,
    userAgent: String,
    sessionId: BinaryRefSchema,
    capturedAt: Date,
    netId: BinaryRefSchema,
    commonDeviceUsers: {
      sharedDevicesWithTxs: [String],
    },
    ipAssociationCluster: String,
    deviceInteractionPatterns: String,
    deviceIpTrustScore: Number,
  },
  { _id: false }
);

const BehavioralSchema = new Schema(
  {
    typingRhythmPattern: TypingRhythmSchema,
    mouseMovementsPattern: MouseMovementSchema,
    behavioralClusterAffiliation: String,
    behavioralBaseline: {
      avgTxnValue: Number,
      txnVelocity7d: Number,
      commonCountries: [String],
    },
    suddenBehavioralChange: Boolean,
    behaviorAnalysisDate: Date,
  },
  { _id: false }
);

const RiskSchema = new Schema(
  {
    riskId: BinaryRefSchema,
    customerRiskRating: String,
    transactionRiskScore: Number,
    typologyMatchScore: Number,
    structureRiskScore: Number,
    downstreamExposurePercent: Number,
    pepFlag: Boolean,
    sanctionsMatchFlag: Boolean,
    adverseMediaFlag: Boolean,
    transactionRiskDetails: Schema.Types.Mixed,
  },
  { _id: false }
);

const TransferSchema = new Schema(
  {
    transferRecordId: BinaryRefSchema,
    transferMechanism: String,
    destinationCountry: String,
    safeguardsInPlace: String,
    transferImpactAssessment: String,
  },
  { _id: false }
);

const DataProtectionSchema = new Schema(
  {
    dataAssetId: BinaryRefSchema,
    dataAssetName: String,
    lawfulBasisGDPR: String,
    lawfulBasisAPP: String,
    dataPointsMapped: Schema.Types.Mixed,
    retentionPeriod: String,
    automatedDeletionFlag: Boolean,
    breachId: BinaryRefSchema,
    piiRecordsExposed: Number,
    jurisdictionsAffected: String,
    supervisoryAuthNotified: String,
    notificationDate: Date,
    individualsNotified: Boolean,
  },
  { _id: false }
);

const GroupSchema = new Schema(
  {
    grpId: String,
    globalGroupUid: String,
    parentCompanyEntity: String,
    subsidiaryEntities: String,
    ownershipChartRef: String,
    groupRiskRating: String,
    commonBeneficialOwners: String,
    sharedServiceCenters: String,
    interCompanyLoanRegister: String,
    relatedPartyTxnFlag: String,
  },
  { _id: false }
);

const ForensicSchema = new Schema(
  {
    forensicId: BinaryRefSchema,
    walletClusterAffiliation: String,
    firstDegreeNetworkMap: Schema.Types.Mixed,
    commonLinkAnalysis: Schema.Types.Mixed,
  },
  { _id: false }
);

const DemoDataSchema = new Schema(
  {
    // Transaction / identifiers
    txId: BinaryRefSchema, // original TX_ID binary
    reference: String,
    messageDirection: {
      type: String,
      enum: ["Inbound", "Outbound", "Unknown"],
      default: "Inbound",
    },
    trvMsgId: BinaryRefSchema,
    travelRuleMessageId: BinaryRefSchema,
    alertId: BinaryRefSchema,
    ivms101MessageHash: String,
    auditTrailHash: String,
    forensicId: BinaryRefSchema,

    // Timing
    timestamp: Date,
    createdAtTravel: Date,
    createdAtDemoData: Date,
    createdAt: Date,
    updatedAt: Date,
    createdAtX: Date,
    updatedAtX: Date,
    createdAtY: Date,
    updatedAtY: Date,

    // Transaction details
    type: String,
    subtype: String,
    amount: Number,
    currency: String,
    totalAud: Number,
    status: String,
    channel: String,
    senderName: String,
    senderAccount: String,
    senderInstitution: String,
    senderCountry: String,
    beneficiaryName: String,
    beneficiaryAccount: String,
    beneficiaryInstitution: String,
    beneficiaryCountry: String,
    intermediary: String,
    sendingBankBic: String,
    receivingBankBic: String,
    intermediaryBic: String,
    narrative: String,
    remittanceCode: String,

    // Gambling fields (domain-specific)
    gamblingBetId: String,
    gamblingGameType: String,
    gamblingOutcome: String,
    gameBetType: String,
    playerId: String,

    // Aggregates / analytics
    agg24hTxnValue: Number,
    velocity7dChange: Number,
    newHighRiskCounterparty: Boolean,
    relatedPartyTxnAmount: Number,
    suddenBehavioralChange: Boolean,
    adverseMediaMatch: Boolean,
    ruleId: String,
    alertStatus: { type: String, default: "Open" },

    // Parties (VASP / originator / beneficiary)
    originatorVaspId: BinaryRefSchema,
    beneficiaryVaspId: BinaryRefSchema,
    originatorVaspName: String,
    originatorVaspLicenseNum: String,
    originatorName: String,
    originatorAccountId: String,
    originatorPhysicalAddress: String,
    originatorDob: Date,

    beneficiaryVaspName: String,
    beneficiaryVaspLicenseNum: String,
    beneficiaryNameMsg: String,
    beneficiaryAccountId: String,

    // IDs & hashes
    entId: String,
    fiatForId: BinaryRefSchema,

    // Device & session
    device: DeviceSchema,
    deviceFingerprint: String,

    // Behavioral / biometrics
    biometricId: BinaryRefSchema,
    typingRhythmPattern: TypingRhythmSchema,
    mouseMovementsPattern: MouseMovementSchema,
    deviceInteractionPatterns: String,
    timestampActivity: Date,
    capturedAt: Date,

    // Network / clusters
    ipAssociationCluster: String,
    behavioralClusterAffiliation: String,
    walletClusterAffiliation: String,

    // KYC / Entity / Person fields
    entityProfile: {
      entityType: String, // ENT_002
      dob: Date, // ENT_003
      countryOfCitizenship: String,
      residentialAddress: String,
      mailingAddress: String,
      contactPhone: String,
      email: String,
      occupation: String,
      employerName: String,
      industrySector: String,
      countryOfTaxResidence: String,
      sourceOfFunds: String,
      sourceOfWealth: String,
      expectedAnnualActivity: String,
      purposeOfAccount: String,
      onboardingChannel: String,
      introducerReferrer: String,
      consentToScreen: Boolean,
      grpIdFk: String,
    },

    // KYC doc
    kycDoc: KycDocSchema,

    // Business details
    biz: BizSchema,

    // UBO(s)
    ubos: [UboSchema],

    // UBO & ownership
    uboId: BinaryRefSchema,
    uboName: String,
    uboDob: Date,
    uboOwnershipPercent: Number,
    uboResidentialAddress: String,

    // Names & persons (director etc.)
    directorName: String,
    directorRole: String,
    name: String,
    dob: Date,
    ownershipPercent: Number,
    residentialAddress: String,

    // Legal / matters / trust account
    legalKycId: BinaryRefSchema,
    matterType: String,
    clientRole: String,
    trustAccountDetails: String,
    legalPracticeNumber: String,
    trustAccountDetailsIfti: String,

    // Financial statements (if provided)
    clientFinancialStatements: {
      revenue: Number,
      expenses: Number,
      netProfit: Number,
    },

    taxAgentNumber: String,
    clientAtoPortalAccess: Boolean,
    structuringRationale: String,

    // Metals / dealers / serialization
    metalTypePurity: String,
    serialNumbers: String,
    origin: String,
    dealerLicenceNumber: String,
    kimberleyProcessCertificate: String,
    assayCertificationDetails: String,
    storageLocation: String,

    // TCSP
    tcspKycId: BinaryRefSchema,
    tcspLicenceNumber: String,

    // Gambling KYC
    gambKycId: BinaryRefSchema,
    playerId: String,
    gameBetType: String,

    // Transfer / data protection
    transfer: TransferSchema,
    dataProtection: DataProtectionSchema,

    // Risk / forensic / analytics
    risk: RiskSchema,
    forensic: ForensicSchema,
    group: GroupSchema,
    behavior: BehavioralSchema,

    // Analysis fields
    analysisDateX: Date,
    analysisDateY: Date,
    analysisId: BinaryRefSchema,
    typologyMatchScore: Number,
    structureType: String,
    effectiveControlIndicator: Boolean,

    // Relationship maps and graphs
    firstDegreeNetworkMap: Schema.Types.Mixed,
    commonLinkAnalysis: Schema.Types.Mixed,
    relationshipToOtherEntities: Schema.Types.Mixed,
    commonLinkAnalysisSharedCounterparties: [String],

    // Operational / workflow
    totalRequests: Number,
    completedRequests: Number,
    lastRequestDate: Date,
    activeConsents: Number,
    withdrawnConsents: Number,
    lastConsentTimestamp: Date,

    // Misc / freeform
    highRiskFlags: Schema.Types.Mixed,
    mitigationMeasures: String,
    approvalStatus: String,
    legalHoldFlag: Boolean,
    cryptographicShreddingDate: Date,
    anonymizationStatus: String,
    createdAtTravelRaw: String,
    updatedAtRaw: String,
    // keep raw JSON if needed
    raw: Schema.Types.Mixed,
  },
  {
    timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" },
  }
);

// Indexes (customize as needed)
DemoDataSchema.index({ "txId.data": 1 });
DemoDataSchema.index({ "alertId.data": 1 });
DemoDataSchema.index({ reference: 1 });
DemoDataSchema.index({ originatorName: 1 });
DemoDataSchema.index({ beneficiaryName: 1 });
DemoDataSchema.index({ createdAt: -1 });
DemoDataSchema.index({ "risk.transactionRiskScore": -1 });

// Model export
module.exports = mongoose.model("DemoData", DemoDataSchema);
