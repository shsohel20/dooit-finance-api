const OnboardingJourney = require("../models/OnboardingJourney");

const SEED_DOCUMENTS = {
  id_document: [
    {
      name: "passport_sample.jpg",
      url: "https://placehold.co/600x400?text=ID+Document",
      mimeType: "image/jpeg",
      docType: "passport",
      size: 204800,
      uploadedAt: new Date(),
    },
    {
      name: "drivers_licence_sample.jpg",
      url: "https://placehold.co/600x400?text=Drivers+Licence",
      mimeType: "image/jpeg",
      docType: "drivers_licence",
      size: 184320,
      uploadedAt: new Date(),
    },
  ],
  selfie: [
    {
      name: "selfie_sample.jpg",
      url: "https://placehold.co/400x400?text=Selfie",
      mimeType: "image/jpeg",
      docType: "selfie",
      size: 102400,
      uploadedAt: new Date(),
    },
  ],
};

function buildSeedJourney(customer) {
  const rel = customer.relations?.[0];
  const now = new Date();
  return {
    _isSeed: true,
    customer: customer._id,
    client: rel?.client || null,
    branch: rel?.branch || null,
    relationIndex: 0,
    provider: "internal",
    onboardingChannel: rel?.onboardingChannel || "Mobile App",
    status: "not_started",
    steps: OnboardingJourney.STEP_TYPES.map((type, i) => ({
      type,
      status: "pending",
      required: true,
      order: i,
      attempts: 0,
      data: {},
      documents: SEED_DOCUMENTS[type] || [],
    })),
    events: [],
    metadata: {},
    createdAt: now,
    updatedAt: now,
  };
}

module.exports = { buildSeedJourney };
