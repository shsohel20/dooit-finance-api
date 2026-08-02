// utils/sequence.js
//
// Atomic document numbering, following the pattern already proven in
// models/Alert.js (Counter + $inc + upsert).
//
// WHY NOT mongoose-sequence: its pre('save') hook is registered as a PARALLEL
// middleware (`function (next, done)`), which calls next() immediately and
// assigns `sequence` later via done(). Any hook registered after it therefore
// runs while `this.sequence` is still undefined — so the common
// "derive uid from sequence in a following pre('save')" pattern silently
// produces `uid: undefined` even though `sequence` lands correctly in the DB.
//
// Doing the increment ourselves keeps sequence and uid assignment in the same
// synchronous step, so both are guaranteed set before the document is written.

const mongoose = require("mongoose");

// ─────────────────────────────────────────────────────────────────────────────
// WHY A SEPARATE COLLECTION, and not models/Counter.js
//
// models/Counter.js maps to the `counters` collection — and so does
// mongoose-sequence, which several existing models use (Case.js, Client.js).
// The two shapes are incompatible:
//
//   mongoose-sequence : { id, reference_value, seq }  + UNIQUE (id, reference_value)
//   models/Counter    : { _id: String, sequence }     — has neither field
//
// Once mongoose-sequence builds its unique index, every Counter document looks
// like { id: null, reference_value: null } to it. The first insert succeeds; the
// second distinct counter fails with
//   E11000 duplicate key ... dup key: { id: null, reference_value: null }
//
// That is a live collision in this codebase (models/Alert.js uses Counter the
// same way), surfaced by the billing test suite. Billing sidesteps it entirely
// by owning its own collection.
// ─────────────────────────────────────────────────────────────────────────────

const BillingCounterSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    sequence: { type: Number, default: 0 },
  },
  { collection: "billingCounters", versionKey: false }
);

const BillingCounter =
  mongoose.models.BillingCounter ||
  mongoose.model("BillingCounter", BillingCounterSchema);

/**
 * Atomically increment and return the next value for a named counter.
 * Creates the counter on first use.
 *
 * @param {String} counterId  e.g. 'product_sequence'
 * @returns {Promise<Number>} the new sequence value (first call returns 1)
 */
async function nextSequence(counterId) {
  const counter = await BillingCounter.findByIdAndUpdate(
    counterId,
    { $inc: { sequence: 1 } },
    { new: true, upsert: true }
  );
  return counter.sequence;
}

/**
 * Format a sequence as a prefixed uid: uidFrom('PRD', 1) -> 'PRD-0000001'
 */
const uidFrom = (prefix, seq, pad = 7) =>
  `${prefix}-${String(seq).padStart(pad, "0")}`;

/**
 * Mongoose pre('save') hook factory: assigns `uid` on insert.
 *
 * The raw counter value is intentionally NOT stored on the document — `uid`
 * already carries it, and a second field would only be another thing to keep
 * in sync. Sort by `createdAt` (or `_id`) rather than by a numeric sequence.
 *
 * Usage:
 *   MySchema.pre('save', assignSequence('product_sequence', 'PRD'));
 */
const assignSequence = (counterId, prefix, pad = 7) =>
  async function assignSequenceHook(next) {
    if (!this.isNew || this.uid) return next();
    try {
      this.uid = uidFrom(prefix, await nextSequence(counterId), pad);
      return next();
    } catch (err) {
      return next(err);
    }
  };

module.exports = { nextSequence, uidFrom, assignSequence };
