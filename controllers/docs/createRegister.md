# `createRegister` — Developer Reference

**File:** `api/controllers/riskRegisterController.js:316`  
**Route:** `POST /risk-register`  
**Auth:** Required (`req.user`)

---

## Purpose

Generates a scored ML/TF risk register from a set of questionnaire `answers` and control-effectiveness scores, persists it to MongoDB, and returns the created document.

---

## Abbreviations Used

| Abbr | Full Term |
|------|-----------|
| **AML** | Anti-Money Laundering |
| **CTF** | Counter-Terrorism Financing |
| **ML/TF** | Money Laundering / Terrorism Financing |
| **AUSTRAC** | Australian Transaction Reports and Analysis Centre |
| **GRC** | Governance, Risk & Compliance |
| **ABN** | Australian Business Number |
| **CO** | Compliance Officer |
| **SM** | Senior Manager |
| **CDD** | Customer Due Diligence |
| **TM** | Transaction Monitoring |
| **SCR** | Sanctions & PEP Screening |
| **GEO** | Geographic / Jurisdiction Risk |
| **GOV** | Governance & Compliance Program |
| **PF** | Proliferation Financing |
| **ctrlEff** | Control Effectiveness (1 = Weak → 5 = Strong) |
| **L** | Likelihood score |
| **C** | Consequence score |
| **inh / inherent** | Inherent Risk (before controls) |
| **res / residual** | Residual Risk (after controls) |
| **VL / L / M / H / E** | Risk bands: Very Low / Low / Medium / High / Extreme |
| **ref** | Risk item reference code (e.g. `EW_C_001`) |
| **sec** | Section number within the register |
| **ch** | Delivery Channel code (F = Face-to-Face, D = Digital/Email, T = Telephone) |
| **DB** | MongoDB database |

---

## Request Body

```json
{
  "answers": {
    "entity_type": "MSB",        // required — entity category used to filter risk pool rows
    "name":        "Acme Pty",   // required — legal entity name
    "abn":         "12 345 678", // optional — ABN
    "assessDate":  "2026-06-18", // optional — ISO date; defaults to today
    "co_name":     "Jane Smith", // optional — CO full name
    "co_email":    "jane@co.au", // optional — CO email
    "co_phone":    "+61 4xx",    // optional — CO phone
    "sm_name":     "Bob Lee",    // optional — SM full name
    "sm_email":    "bob@co.au",  // optional — SM email
    // ... any other questionnaire keys used by condition evaluator
  },
  "ctrlEff": {
    "cdd": 4,   // 1–5; defaults to 3 if omitted or out of range
    "tm":  3,
    "scr": 4,
    "geo": 2,
    "gov": 5
  },
  "notes": "Optional free-text notes"
}
```

---

## Processing Pipeline

```
req.body
   │
   ├─ Validate: answers.entity_type + answers.name (required)
   │
   ├─ parseCtrlEff(ctrlEffRaw)
   │     Normalises each bucket (cdd/tm/scr/geo/gov) to int 1–5.
   │     Out-of-range values → default 3.
   │
   ├─ buildFromDB(answers, ctrlEff, req.user.client)
   │     1. Load active RiskPoolItems from DB
   │        (global items + client-specific overrides for req.user.client)
   │     2. Auto-seed DB on first use if collection is empty (RISK_POOL_SEED)
   │     3. Deduplicate: client-specific items shadow globals with same ref
   │     4. Filter rows by entity_type + evaluateCondition(row.condition, answers)
   │     5. For each row:
   │           L  = applyLMods(row.lMods, answers, row.L)
   │           C  = row.C  (fixed)
   │           inh = inherentBand(L, C)        → VL/L/M/H/E
   │           cat = CTRL_CATEGORY[ctrlFactor] → cdd/tm/scr/geo/gov bucket
   │           ceV = ctrlEff[cat]
   │           res = residualBand(inh, ceV)    → VL/L/M/H/E
   │     6. Returns array of scored row objects
   │     ⚠ Falls back to static buildRiskRegister() if DB throws
   │
   ├─ buildSummary(rows)  →  summarize(rows)
   │     Aggregates counts of inherent/residual bands across all rows.
   │
   └─ RiskRegister.create({ ...fields, rows, ...summary, client, createdBy })
         Persists and returns the new document.
```

---

## Response

**201 Created**
```json
{
  "success": true,
  "data": { /* full RiskRegister document including rows */ }
}
```

**400 Bad Request** (missing required fields)
```json
{ "success": false, "error": "answers.entity_type is required" }
```

**500 Internal Server Error**
```json
{ "success": false, "error": "<exception message>" }
```

---

## Stored Document Fields

| Field | Source |
|-------|--------|
| `entityName` | `answers.name` |
| `entityType` | `answers.entity_type` |
| `abn` | `answers.abn` |
| `assessDate` | `answers.assessDate` or `new Date()` |
| `coName/coEmail/coPhone` | `answers.co_name/co_email/co_phone` |
| `smName/smEmail` | `answers.sm_name/sm_email` |
| `answers` | raw answers object |
| `ctrlEff` | normalised 1–5 scores per bucket |
| `rows` | scored risk row array from `buildFromDB` |
| `client` | `req.user.client` (tenant isolation) |
| `createdBy` | `req.user._id` |
| `...summary` | band-count aggregates from `buildSummary` |

---

## CTRL_CATEGORY Mapping

`ctrlFactor` is a field on each **`RiskPoolItem`** document — it is **dynamic** (set per risk item in the DB, not hardcoded in the controller).

At scoring time the controller resolves the `ctrlEff` bucket like this:

```js
const cat = CTRL_CATEGORY[row.ctrlFactor] || "gov";   // "gov" is the fallback
const ceV = ctrlEff[cat];                              // 1–5 from request body
```

The `CTRL_CATEGORY` constant (in the controller) holds the **current default mapping** for the seeded global items:

| ctrlEff Bucket | `ctrlFactor` values (as seeded) |
|----------------|---------------------------------|
| **cdd** | EW_C_001, EW_C_002, EW_CH_001, EW_CH_002 |
| **tm** | EW_CH_003, EW_CH_004, EW_P_001, EW_P_003 |
| **scr** | EW_P_002, EW_G_001, EW_G_002 |
| **geo** | EW_G_003 |
| **gov** | EW_P_004, EW_E_001, EW_E_003, EW_E_004 |
| **gov** _(fallback)_ | any `ctrlFactor` not listed above |

> **Note:** Client-specific `RiskPoolItem` records can carry any `ctrlFactor` value. If that value is not present in `CTRL_CATEGORY`, it automatically scores against the `gov` (Governance) control-effectiveness bucket.

---

## Key Dependencies

| Import | Role |
|--------|------|
| `RiskRegister` (model) | Mongoose model — persists the register |
| `RiskPoolItem` (model) | Source of risk items (global + client-specific) |
| `EntityConfig` (model) | Entity configuration; seeded alongside risk pool |
| `inherentBand` | Converts L×C → VL/L/M/H/E |
| `residualBand` | Downgrades inherent band based on control effectiveness |
| `evaluateCondition` | Boolean filter — applies conditional logic from `row.condition` |
| `applyLMods` | Adjusts raw `L` score based on answer-driven modifiers |
| `buildRiskRegister` | Static fallback engine if DB is unavailable |
| `summarize` | Produces band-count summary from rows |
