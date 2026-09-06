// utils/dismissalTypes.js
//
// The industry-specific dismissal templates the AI reports service supports,
// mirrored from `GET /v2/dismissal_types` (docs/74 §4.5, phase C5).
//
// Mirrored rather than fetched so the API can validate a submitted code without
// a network round trip, and so an outage cannot make every dismissal fail
// validation. `industries` is what the service matches a customer against; we
// use it to suggest a template rather than to force one — the analyst chooses.
//
// Keep in step with the service: a code we send that it does not know comes
// back as a 400.

"use strict";

const DISMISSAL_TYPES = [
    // ── Financial institution ──────────────────────────────────────────────
    { code: 'fi_d1', title: 'Treasury Sweep, Not Layering', templateKey: 'treasury_sweep', group: 'Financial Institution', industries: ['Finance', 'Banking', 'Financial Services'] },
    { code: 'fi_d2', title: 'Trade Cycle Matches Paper', templateKey: 'trade_cycle', group: 'Financial Institution', industries: ['Finance', 'Banking', 'Import/Export', 'Trade'] },
    { code: 'fi_d3', title: 'Sub-10k Cash = Till Float, Not Structuring', templateKey: 'till_float', group: 'Financial Institution', industries: ['Retail', 'Finance'] },

    // ── Virtual asset service provider ─────────────────────────────────────
    { code: 'vasp_d1', title: 'Mixer Proximity is Historical, Not Direct', templateKey: 'mixer_proximity', group: 'VASP', industries: ['Cryptocurrency', 'VASP', 'Digital Assets'] },
    { code: 'vasp_d2', title: 'Arb & Cold-Wallet Rotation', templateKey: 'cold_wallet', group: 'VASP', industries: ['Cryptocurrency', 'VASP', 'Digital Assets'] },
    { code: 'vasp_d3', title: 'Retail Outbound to Licensed VASP', templateKey: 'licensed_vasp', group: 'VASP', industries: ['Cryptocurrency', 'VASP', 'Digital Assets'] },

    // ── Accounting ─────────────────────────────────────────────────────────
    { code: 'acc_d1', title: 'Client Trust Ledger Matches Matter List', templateKey: 'client_trust', group: 'Accounting Firm', industries: ['Accounting', 'Professional Services'] },
    { code: 'acc_d2', title: 'Payroll Float, Not Smurfing', templateKey: 'payroll_float', group: 'Accounting Firm', industries: ['Accounting', 'Payroll Services'] },
    { code: 'acc_d3', title: 'FX for Audit Fees in Client Currency', templateKey: 'fx_audit', group: 'Accounting Firm', industries: ['Accounting', 'Audit', 'Professional Services'] },

    // ── Precious metals ────────────────────────────────────────────────────
    { code: 'pm_d1', title: 'Serials & Assay Check Out', templateKey: 'serials_assay', group: 'Precious Metals Dealer', industries: ['Precious Metals', 'Bullion', 'Commodities'] },
    { code: 'pm_d2', title: 'Buy-Back Program, Not Round-Tripping', templateKey: 'buyback', group: 'Precious Metals Dealer', industries: ['Precious Metals', 'Bullion', 'Retail'] },
    { code: 'pm_d3', title: 'Armoured-Car Cash Cycle', templateKey: 'armoured_car', group: 'Precious Metals Dealer', industries: ['Precious Metals', 'Retail', 'Cash Intensive'] },

    // ── Real estate / legal ────────────────────────────────────────────────
    { code: 're_d1', title: 'Settlement Milestones Reconcile', templateKey: 'settlement_milestones', group: 'Real Estate / Legal', industries: ['Real Estate', 'Legal', 'Conveyancing'] },
    { code: 're_d2', title: 'Foreign Funds with Full Trail', templateKey: 'foreign_funds', group: 'Real Estate / Legal', industries: ['Real Estate', 'Legal', 'Property'] },
    { code: 're_d3', title: "Related-Party With Arm's-Length Evidence", templateKey: 'related_party', group: 'Real Estate / Legal', industries: ['Real Estate', 'Legal'] },

    // ── Gambling ───────────────────────────────────────────────────────────
    { code: 'gam_d1', title: 'Bonus Cycling vs. Laundering', templateKey: 'bonus_cycling', group: 'Gambling Operator', industries: ['Gambling', 'Gaming', 'Wagering'] },
    { code: 'gam_d2', title: 'Syndicate? No—Social Betting Pool', templateKey: 'social_betting', group: 'Gambling Operator', industries: ['Gambling', 'Gaming', 'Wagering'] },
    { code: 'gam_d3', title: 'High-Roller With Documented Bankroll', templateKey: 'high_roller', group: 'Gambling Operator', industries: ['Gambling', 'Gaming', 'Wagering'] },
];

// 'generic' is the service's default when no code is sent — a dismissal that
// leans on the evidence rather than an industry pattern.
const GENERIC = 'generic';

const DISMISSAL_CODES = DISMISSAL_TYPES.map((t) => t.code);

/** True for a code the service will accept (including the generic default). */
const isValidDismissalType = (code) =>
    code === undefined || code === null || code === '' || code === GENERIC || DISMISSAL_CODES.includes(code);

/** The catalogue entry for a code, or null. */
const dismissalTypeByCode = (code) => DISMISSAL_TYPES.find((t) => t.code === code) || null;

/**
 * Templates whose industries match a customer's, best-guess first.
 * Suggestion only — the analyst decides which pattern actually applies.
 */
const suggestDismissalTypes = (industry) => {
    const needle = String(industry || '').trim().toLowerCase();
    if (!needle) return [];
    return DISMISSAL_TYPES.filter((t) =>
        t.industries.some((i) => i.toLowerCase() === needle || needle.includes(i.toLowerCase()))
    );
};

module.exports = {
    DISMISSAL_TYPES,
    DISMISSAL_CODES,
    GENERIC,
    isValidDismissalType,
    dismissalTypeByCode,
    suggestDismissalTypes,
};
