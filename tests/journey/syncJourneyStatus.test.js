// Unit tests for journeyService.syncJourneyStatus — pure function, no DB.
const { syncJourneyStatus } = require("../../services/journeyService");

const journey = (status, steps) => ({ status, steps });

describe("syncJourneyStatus", () => {
  it("clears a stale 'rejected' once no step is rejected any more (mid-flow → in_progress)", () => {
    // Reviewer approved the previously-rejected id_document + selfie, but other
    // required steps are still in progress — must move off "rejected".
    const j = journey("rejected", [
      { required: false, status: "in_progress" },
      { required: true, status: "approved" }, // liveness
      { required: true, status: "approved" }, // id_document (manually approved)
      { required: true, status: "approved" }, // selfie (manually approved)
      { required: true, status: "in_progress" }, // funds_wealth still pending
    ]);
    syncJourneyStatus(j);
    expect(j.status).toBe("in_progress");
  });

  it("stays 'rejected' while any step is still rejected", () => {
    const j = journey("submitted", [
      { required: true, status: "approved" },
      { required: true, status: "rejected" },
    ]);
    syncJourneyStatus(j);
    expect(j.status).toBe("rejected");
  });

  it("becomes 'approved' when all required steps are approved", () => {
    const j = journey("rejected", [
      { required: true, status: "approved" },
      { required: true, status: "approved" },
      { required: false, status: "in_progress" },
    ]);
    syncJourneyStatus(j);
    expect(j.status).toBe("approved");
  });

  it("becomes 'submitted' when all required steps are submitted/approved", () => {
    const j = journey("rejected", [
      { required: true, status: "submitted" },
      { required: true, status: "approved" },
    ]);
    syncJourneyStatus(j);
    expect(j.status).toBe("submitted");
  });

  it("honours an explicit fallbackStatus for the mid-flow case", () => {
    const j = journey("rejected", [{ required: true, status: "pending" }]);
    syncJourneyStatus(j, { fallbackStatus: "in_progress" });
    expect(j.status).toBe("in_progress");
  });
});
