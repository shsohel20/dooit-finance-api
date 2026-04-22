# Training Module — Integration Guide

**Base URL:** `{{host}}/api/v1`  
**Auth:** All endpoints require `Authorization: Bearer <JWT>`

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Data Models](#2-data-models)
3. [Role & Access Control](#3-role--access-control)
4. [API Reference](#4-api-reference)
   - [Modules](#41-modules)
   - [Module Access (Scoping)](#42-module-access-scoping)
   - [Parts](#43-parts)
   - [Questions](#44-questions)
   - [Learner Assignments](#45-learner-assignments)
   - [Learner Progress](#46-learner-progress)
   - [Reports](#47-reports)
5. [Integration Flows](#5-integration-flows)
6. [Error Reference](#6-error-reference)

---

## 1. Architecture Overview

The training module is split into four independent concerns:

```
TrainingModule          → content definition (title, parts, questions)
TrainingModuleAccess    → org scoping (which client/branch/roles see the module)
ModuleAssignment        → individual learner assignment (who must take it)
TrainingLearnerProgress → per-learner attempt tracking (watch, answers, score)
```

### Lifecycle

```
[Admin] Create module (draft)
    │
    ├── Add parts  ──► Add questions to each part
    │
    ▼
[Admin] Assign module access (client + branch + roles)
    │
    │   Auto-inserts ModuleAssignment for every matching active user
    │
    ▼
[Manager] Assign module to specific learners  (POST /training-assignments/:moduleId/assign)
    │
    ▼
[Learner] Start module  ──►  Watch videos  ──►  Submit answers  ──►  Complete
    │
    ▼
[Admin/Manager] View reports / grant retakes
```

---

## 2. Data Models

### TrainingModule

| Field | Type | Notes |
|---|---|---|
| `_id` | ObjectId | |
| `uid` | String | Auto: `MOD_<timestamp>` |
| `title` | String | Required |
| `slug` | String | Auto-generated from title |
| `description` | String | |
| `status` | String | `draft` \| `published` \| `archived` |
| `createdBy` | ObjectId → Users | |
| `stats.assignedCount` | Number | Auto-incremented |
| `stats.startedCount` | Number | Auto-incremented |
| `stats.passedCount` | Number | Auto-incremented on complete |
| `stats.failedCount` | Number | Auto-incremented on complete |
| `stats.avgScore` | Number | Running average, updated on complete |
| `metadata` | Mixed | Free-form extra data |

**Virtuals** (populated on `.toJSON()`):

| Virtual | Description |
|---|---|
| `parts` | Array of `TrainingModulePart` docs |
| `partsCount` | Count of parts |
| `questionsCount` | Total questions across all parts |
| `avgQuestionsPerPart` | Derived ratio |
| `isPublished` | Boolean shorthand |
| `access` | Array of `TrainingModuleAccess` docs |

---

### TrainingModuleAccess

One document per org-scope assigned by a Dooit Admin.

| Field | Type | Notes |
|---|---|---|
| `_id` | ObjectId | |
| `module` | ObjectId → TrainingModule | Required |
| `client` | ObjectId → Client | Optional |
| `branch` | ObjectId → Branch | Optional |
| `roles` | ObjectId[] → Roles | `[]` = all roles permitted |
| `assignedBy` | ObjectId → Users | Dooit Admin who created this rule |
| `status` | String | `active` \| `inactive` |

**Unique constraint:** `(module, client, branch)` — one rule per org combination.

**Behaviour when `roles: []`:** No role filter — every active user in that client/branch is permitted.

**Side effect on create:** Every active `User` matching `clientBelongs`, `branchBelongs`, and `role` is automatically inserted into `ModuleAssignment` (skips duplicates).

---

### ModuleAssignment

One document per `(module, learner)` pair.

| Field | Type | Notes |
|---|---|---|
| `_id` | ObjectId | |
| `module` | ObjectId → TrainingModule | |
| `learner` | ObjectId → Users | |
| `assignedBy` | ObjectId → Users | |
| `roleId` | ObjectId → Roles | Snapshot of learner's role at assignment time |
| `dueDate` | Date | Optional |
| `maxAttempts` | Number | `0` = unlimited |
| `retakesGranted` | Number | Incremented on each retake |
| `status` | String | `pending` \| `in-progress` \| `completed` \| `overdue` |
| `finalScore` | Number | Snapshot on completion |
| `isPassed` | Boolean | Snapshot on completion |
| `completedAt` | Date | |

**Unique constraint:** `(module, learner)`

---

### TrainingModulePart

| Field | Type | Notes |
|---|---|---|
| `_id` | ObjectId | |
| `uid` | String | Auto: `PART_<timestamp>` |
| `module` | ObjectId → TrainingModule | |
| `title` | String | Required; unique per module |
| `description` | String | |
| `video.url` | String | YouTube / Vimeo / Cloudinary / AWS S3 |
| `video.provider` | String | Auto-detected: `youtube`, `vimeo`, `cloudinary`, `aws`, `self` |
| `video.durationSec` | Number | Auto-fetched for YouTube/Vimeo |
| `questions` | ObjectId[] → TrainingModuleQuestion | |
| `minWatchPercent` | Number | Default `80` — must watch this % before attempting |
| `passAllRequired` | Boolean | Default `true` |
| `maxRetries` | Number | `0` = unlimited |
| `estimatedTimeMin` | Number | Default `5` |
| `order` | Number | Sort order within module |

**Unique constraint:** `(module, title)` — same title allowed in different modules.

---

### TrainingModuleQuestion

| Field | Type | Notes |
|---|---|---|
| `_id` | ObjectId | |
| `uid` | String | Auto: `Q_<timestamp>` |
| `text` | String | Required |
| `type` | String | `single` \| `multiple` \| `boolean` |
| `options` | Array | `[{ key: "A", text: "..." }, ...]` |
| `correctAnswers` | String[] | Array of `key` values, e.g. `["B"]` |
| `explanation` | String | Shown after attempt |
| `points` | Number | Default `1` |
| `order` | Number | Display order |

> **Important:** Option identifier is `key` (not `label`). `correctAnswers` must reference `key` values.

---

### TrainingLearnerProgress

One document per `(learner, module)` pair.

| Field | Type | Notes |
|---|---|---|
| `_id` | ObjectId | |
| `learner` | ObjectId → Users | |
| `module` | ObjectId → TrainingModule | |
| `assignment` | ObjectId → ModuleAssignment | |
| `attemptRound` | Number | Incremented on each retake, starts at `1` |
| `currentPartIndex` | Number | 0-based, advances as parts are completed |
| `attempts` | AttemptSchema[] | All question attempts across all rounds |
| `watchRecords` | WatchRecordSchema[] | Per-part video watch state |
| `totalPoints` | Number | Current round earned points |
| `maxPoints` | Number | Current round possible points |
| `score` | Number | `0–100` percentage |
| `isPassed` | Boolean | `score >= passThreshold` on complete |
| `passThreshold` | Number | Default `70` |
| `startedAt` | Date | |
| `completedAt` | Date | |
| `passedAt` | Date | |
| `lastActivityAt` | Date | |

**Virtual `status`** (not stored, computed):

| Value | Condition |
|---|---|
| `passed` | `isPassed === true` |
| `failed` | `completedAt` set, not passed |
| `in-progress` | Has attempts, not completed |
| `started` | `startedAt` set, no attempts |
| `not-started` | No activity |

**AttemptSchema sub-document:**

| Field | Notes |
|---|---|
| `part` | ObjectId |
| `question` | ObjectId |
| `selectedAnswer` | Key string e.g. `"B"` |
| `isCorrect` | Boolean |
| `pointsEarned` | `question.points` if correct, else `0` |
| `possiblePoints` | `question.points` |
| `attemptRound` | Which retake round |

---

## 3. Role & Access Control

| Role | Capabilities |
|---|---|
| `admin` | Full access: create/update/delete modules, assign access scopes, assign learners, view all reports, grant retakes |
| `manager` | Create/update modules, assign learners, view their own assignments and progress, grant retakes |
| `learner` | Start assigned modules, watch videos, submit answers, complete modules, view own progress |

### Role-gate on assignment

When a manager assigns a module to learners (`POST /training-assignments/:moduleId/assign`):

1. All active `TrainingModuleAccess` rules for the module are loaded.
2. If **no rules exist** → module is open, all learners are eligible.
3. If rules exist and **any rule has `roles: []`** → all learners are eligible.
4. Otherwise, each learner's `User.role` string is resolved to a `Roles._id`. Only learners whose role appears in at least one access rule are inserted. The rest are counted as `roleBlocked`.

### Role-gate on start

When a learner starts a module (`POST /training-progress/:moduleId/start`), the same role check runs against their current role. If their role has since been removed from the access rules, they receive `403`.

---

## 4. API Reference

### 4.1 Modules

#### `POST /training-modules`
Create a module.

**Roles:** `admin`, `manager`

**Body:**
```json
{
  "title": "Workplace Safety Basics",
  "description": "Intro to safety procedures.",
  "status": "draft"
}
```

**Response `201`:**
```json
{
  "success": true,
  "data": {
    "_id": "...",
    "uid": "MOD_1719000000000",
    "title": "Workplace Safety Basics",
    "status": "draft",
    "stats": { "assignedCount": 0, ... }
  }
}
```

---

#### `GET /training-modules`
List all modules. Supports advancedResults: `filter`, `select`, `sort`, `page`, `limit`.

**Roles:** All authenticated

**Query params:**
```
?status=published&select=title,uid,status&sort=-createdAt&page=1&limit=20
```

---

#### `GET /training-modules/:id`
Get a single module with populated parts and access rules.

---

#### `PUT /training-modules/:id`
Update module fields. **Roles:** `admin`, `manager`

---

#### `DELETE /training-modules/:id`
Delete a module. **Roles:** `admin` only

---

#### `GET /training-modules/assigned-by-me`
Manager's own assigned modules with per-learner progress breakdown.  
**Roles:** `admin`, `manager`

---

### 4.2 Module Access (Scoping)

#### `POST /training-modules/:moduleId/access`
Assign module to one or more org scopes. **Roles:** `admin` only

Accepts a **single object** or **array**:

```json
{
  "client": "<clientId>",
  "branch": "<branchId>",
  "roles": ["<roleId1>", "<roleId2>"]
}
```

```json
[
  { "client": "<clientId>", "branch": "<branchId>", "roles": ["<roleId1>"] },
  { "client": "<clientId>", "roles": [] }
]
```

`roles: []` = all roles permitted for that scope.

**Side effect:** All active users matching the scope are automatically inserted as `ModuleAssignment` records (pending, duplicates skipped).

**Response `201`:**
```json
{
  "success": true,
  "inserted": 2,
  "skipped": 0,
  "autoAssigned": 15
}
```

| Field | Meaning |
|---|---|
| `inserted` | New `TrainingModuleAccess` docs created |
| `skipped` | Duplicate scopes silently ignored |
| `autoAssigned` | `ModuleAssignment` docs auto-created for matching users |

---

#### `GET /training-modules/:moduleId/access`
List all access rules for a module. **Roles:** `admin`, `manager`

---

#### `DELETE /training-modules/access/:accessId`
Remove an access rule. **Roles:** `admin` only

---

### 4.3 Parts

#### `POST /training-modules/:moduleId/parts`
Create a part. **Roles:** `admin`, `manager`

```json
{
  "title": "Part 1 — Introduction",
  "video": { "url": "https://www.youtube.com/watch?v=xxx" },
  "minWatchPercent": 80,
  "order": 1
}
```

`video.provider` and `video.durationSec` are auto-resolved for YouTube and Vimeo URLs.

**Response `201`:** `{ "success": true, "data": { "uid": "PART_...", ... } }`

---

#### `GET /training-modules/:moduleId/parts`
List parts sorted by `order` ascending.

---

#### `GET /training-modules/parts/:partId`
Get a single part with populated questions.

---

#### `PUT /training-modules/parts/:partId`
Update a part. `video.url` triggers a re-fetch of metadata. **Roles:** `admin`, `manager`

---

#### `DELETE /training-modules/parts/:partId`
Delete a part. **Roles:** `admin`, `manager`

---

### 4.4 Questions

#### `POST /training-modules/parts/:partId/questions`
Create a question and attach to the part. **Roles:** `admin`, `manager`

```json
{
  "text": "What is the minimum PPE required?",
  "type": "single",
  "options": [
    { "key": "A", "text": "Hard hat only" },
    { "key": "B", "text": "Hard hat, vest, and steel-capped boots" },
    { "key": "C", "text": "No PPE required" }
  ],
  "correctAnswers": ["B"],
  "explanation": "Full PPE is required on all sites.",
  "points": 2
}
```

> `key` is the option identifier. `correctAnswers` must contain `key` values.  
> `type: "multiple"` — `correctAnswers` can have multiple keys.  
> `type: "boolean"` — options are typically `[{ key: "true" }, { key: "false" }]`.

---

#### `GET /training-modules/questions/:id`
Get a question.

---

#### `PUT /training-modules/questions/:id`
Update a question. **Roles:** `admin`, `manager`

---

#### `DELETE /training-modules/questions/:id`
Delete question and remove from parent part's array. **Roles:** `admin`, `manager`

---

### 4.5 Learner Assignments

#### `POST /training-assignments/:moduleId/assign`
Assign a **published** module to one or more learners. **Roles:** `admin`, `manager`

```json
{
  "learnerIds": ["<userId1>", "<userId2>"],
  "dueDate": "2026-12-31T00:00:00.000Z",
  "maxAttempts": 3
}
```

**Response `201`:**
```json
{
  "success": true,
  "inserted": 1,
  "skipped": 0,
  "roleBlocked": 1,
  "message": "Module assigned to 1 learner(s)."
}
```

| Field | Meaning |
|---|---|
| `inserted` | New assignments created |
| `skipped` | Already assigned (duplicate) |
| `roleBlocked` | Learners rejected — their role not in any access rule |

**Errors:**
- `400` — Module not published
- `400` — `learnerIds` empty
- `403` — All learners blocked by role rules

---

#### `GET /training-assignments/mine`
Learner's own assignments with progress snapshot. **Roles:** `learner`

---

#### `GET /training-assignments/by-me`
Manager's created assignments with per-learner progress. **Roles:** `admin`, `manager`

---

#### `GET /training-assignments`
All assignments (admin) or own (manager). Filters: `moduleId`, `learnerId`, `status`. **Roles:** `admin`, `manager`

---

#### `GET /training-assignments/:id`
Single assignment. Accessible by the learner, assigner, or admin.

---

#### `PATCH /training-assignments/:id/status`
Update status (e.g. cron marks `overdue`). **Roles:** `admin`, `manager`

```json
{ "status": "overdue" }
```

Allowed: `pending` | `in-progress` | `completed` | `overdue`

---

#### `DELETE /training-assignments/:id`
Revoke an assignment. Decrements `stats.assignedCount`. **Roles:** `admin`, `manager`

---

### 4.6 Learner Progress

#### `POST /training-progress/:moduleId/start`
Start or resume a module. Creates the progress document if it doesn't exist.

**Requires:** Active `ModuleAssignment` for this learner + role permitted by access rules.

**Response `200`:** Full `TrainingLearnerProgress` document.

**Errors:**
- `403` — Not assigned to this module
- `403` — Role not permitted by access rules

---

#### `GET /training-progress/:moduleId`
Get learner's own progress for one module. Returns `{ data: null }` if not started.

---

#### `GET /training-progress`
All progress records for the authenticated learner.

---

#### `PUT /training-progress/:moduleId/watch`
Record video watch progress for a part.

```json
{
  "partId": "<partId>",
  "watchedSeconds": 85,
  "durationSec": 100
}
```

- `watchPercent` = `watchedSeconds / durationSec * 100` (clamped 0–100)
- If `watchPercent >= part.minWatchPercent` → `completed: true`
- Watch records are **upserted** — re-sends always keep the highest `watchedSeconds`.

**Response `200`:**
```json
{
  "success": true,
  "data": {
    "part": "<partId>",
    "watchedSeconds": 85,
    "durationSec": 100,
    "watchPercent": 85,
    "completed": true
  }
}
```

---

#### `POST /training-progress/:moduleId/attempts`
Submit answers for one part.

```json
{
  "partId": "<partId>",
  "answers": [
    { "questionId": "<qId1>", "selectedAnswer": "B" },
    { "questionId": "<qId2>", "selectedAnswer": "A" }
  ]
}
```

For `type: "multiple"`, `selectedAnswer` can be a comma-separated string or an array:
```json
{ "questionId": "<qId>", "selectedAnswer": ["A", "C"] }
```

**Response `201`:**
```json
{
  "success": true,
  "data": {
    "results": [
      { "questionId": "...", "selectedAnswer": "B", "isCorrect": true, "pointsEarned": 2 }
    ],
    "partScore": 100,
    "passed": true,
    "overallScore": 100,
    "currentPartIndex": 1
  }
}
```

---

#### `POST /training-progress/:moduleId/complete`
Finalise the module attempt. Calculates score, sets `isPassed`, stamps `completedAt`.

Can only be called **once per attempt round**. Returns `400` if already completed.

**Response `200`:**
```json
{
  "success": true,
  "data": {
    "score": 85,
    "isPassed": true,
    "passThreshold": 70,
    "completedAt": "2026-04-22T10:00:00.000Z"
  }
}
```

---

#### `POST /training-modules/:moduleId/retake`
Grant a learner a retake. Resets their progress for a new attempt round. **Roles:** `admin`, `manager`

```json
{ "learnerId": "<userId>" }
```

Errors:
- `400` — Max attempts reached (`assignment.maxAttempts > 0`)
- `404` — No assignment found

---

#### `GET /training-modules/:moduleId/learners`
Per-learner progress breakdown for a module. **Roles:** `admin`, `manager`

---

#### `GET /training-progress/report`
Aggregated progress report, filterable by `moduleId`, `learnerId`, `status`. **Roles:** `admin`, `manager`

---

### 4.7 Reports

All report endpoints require `admin` or `manager` role.

#### `GET /training-reports/overview`
System-wide KPI snapshot.

```json
{
  "success": true,
  "data": {
    "totalModules": 12,
    "publishedModules": 8,
    "totalAssignments": 200,
    "completionRate": 65.5,
    "passRate": 80.0,
    "avgScore": 74.3
  }
}
```

Managers see only data scoped to their own assignments.

---

#### `GET /training-reports/modules`
Per-module analytics table.

---

#### `GET /training-reports/learners`
Per-learner progress table across all assigned modules.

---

#### `GET /training-reports/module/:moduleId`
Deep-dive for one module.

```json
{
  "success": true,
  "data": {
    "summary": {
      "totalLearners": 20,
      "completed": 15,
      "passed": 12,
      "avgScore": 78
    },
    "questionBreakdown": [
      {
        "questionId": "...",
        "text": "What is the minimum PPE?",
        "correctCount": 14,
        "incorrectCount": 1,
        "difficultyScore": 93
      }
    ]
  }
}
```

---

## 5. Integration Flows

### Flow 1 — Admin sets up a module

```
1. POST /training-modules
   Body: { title, description }
   → Returns: { _id: moduleId, uid: "MOD_..." }

2. POST /training-modules/:moduleId/parts  (repeat per part)
   Body: { title, video: { url }, order, minWatchPercent }
   → Returns: { _id: partId, uid: "PART_..." }

3. POST /training-modules/parts/:partId/questions  (repeat per question)
   Body: { text, type, options: [{ key, text }], correctAnswers, points }
   → Returns: { _id: questionId, uid: "Q_..." }

4. PUT /training-modules/:moduleId
   Body: { status: "published" }

5. POST /training-modules/:moduleId/access
   Body: { client: "<id>", branch: "<id>", roles: ["<roleId>"] }
   → Auto-inserts ModuleAssignment for all matching active users
   → Returns: { inserted: 1, skipped: 0, autoAssigned: 15 }
```

---

### Flow 2 — Manager assigns to specific learners

```
1. POST /training-assignments/:moduleId/assign
   Body: { learnerIds: ["<id1>", "<id2>"], dueDate, maxAttempts }
   → Returns: { inserted: 2, skipped: 0, roleBlocked: 0 }
```

---

### Flow 3 — Learner takes a module

```
1. GET /training-assignments/mine
   → Find the assignment, get moduleId

2. POST /training-progress/:moduleId/start
   → Returns progress doc; check currentPartIndex

3. For each part (in order):
   a. PUT /training-progress/:moduleId/watch
      Body: { partId, watchedSeconds, durationSec }
      → Poll as learner watches; repeat until completed: true

   b. POST /training-progress/:moduleId/attempts
      Body: { partId, answers: [{ questionId, selectedAnswer }] }
      → Get results and partScore

4. POST /training-progress/:moduleId/complete
   → Get final score and isPassed
```

---

### Flow 4 — Admin grants retake

```
1. GET /training-modules/:moduleId/learners
   → Find learner, confirm completedAt is set

2. POST /training-modules/:moduleId/retake
   Body: { learnerId }
   → attemptRound increments; progress resets for new round

3. Learner repeats Flow 3 from step 2
```

---

## 6. Error Reference

| HTTP | Code | Meaning |
|---|---|---|
| `400` | Validation | Missing required field or invalid value |
| `400` | `11000` | Duplicate key (title already exists in this module, etc.) |
| `400` | — | Module not published (cannot assign) |
| `400` | — | Module already completed this round |
| `400` | — | Max attempts reached |
| `401` | — | No token / invalid token |
| `403` | — | Insufficient role |
| `403` | — | Not assigned to this module |
| `403` | — | Role not permitted by access rules |
| `404` | — | Resource not found |
| `409` | `11000` | Duplicate key conflict (returned by error handler) |

### Duplicate key notes

- Inserting the same `(module, learner)` pair → silently skipped via `ordered: false` in bulk operations; `skipped` count returned
- Inserting the same `(module, client, branch)` access scope → silently skipped; `skipped` count returned
- Creating a part with a title that already exists in the same module → `409`

---

*Last updated: 2026-04-22*
