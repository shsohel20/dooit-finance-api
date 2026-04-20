# Privacy Module

## Overview

Role-based field-level encryption for sensitive user and customer data.
Sensitive fields are encrypted at rest using **AES-256-GCM** and are automatically
decrypted on read based on the authenticated user's **dynamic privacy permissions**
stored in the `PrivacyPermission` collection. Fields the caller is not allowed to
read are masked as `***`.

Permissions are **tenant-scoped**: each `PrivacyPermission` document is tied to a
`client` and/or `branch`, so granting access to one tenant never bleeds into another.

---

## Architecture

| Layer | File | Responsibility |
|---|---|---|
| Encryption utility | `utils/encryption.js` | AES-256-GCM encrypt/decrypt, field-meta helper |
| Mongoose plugin | `utils/roleEncryptionPlugin.js` | Pre-save encrypt, post-find auto-decrypt, reads permissions from `AsyncLocalStorage` |
| Auth middleware | `middleware/auth.js` | Loads `PrivacyPermission` grants for the request user/role, binds them via `runWithRole()` |
| Privacy Permission model | `models/PrivacyPermission.js` | Stores who (role) can see encrypted fields, scoped to client/branch |
| Privacy Snapshot model | `models/PrivacySnapshot.js` | Captures field values before any encrypt/decrypt for audit and rollback |
| Privacy controller | `controllers/privacyController.js` | Admin API — status, single & bulk encrypt/decrypt, snapshots |
| Permission controller | `controllers/privacyPermissionController.js` | CRUD for `PrivacyPermission` documents |
| Routes | `routes/privacy.js` | Mounts all endpoints under `/api/v1/privacy`, Admin-only |

---

## Model-level: `restrictedProperty`

Each model that participates in the privacy system declares a static array called
`restrictedProperty` — a developer-maintained list of the field paths that are
considered sensitive on that model.

This is **code-level config**, not stored in the database. The developer adds or
removes fields here when the schema changes.

### Pattern

```js
// Defined at the top of the model file
const restrictedProperty = ["name", "email", "phone"];

// Attached as a model static — accessible anywhere as User.restrictedProperty
UserSchema.statics.restrictedProperty = restrictedProperty;
```

### Current model configs

**`models/User.js`**
```js
const restrictedProperty = ["name", "email"];
```

**`models/Customer.js`**
```js
const restrictedProperty = [
  "personalKyc.personal_form.customer_details.given_name",
  "personalKyc.personal_form.customer_details.surname",
  "personalKyc.personal_form.contact_details.email",
  "personalKyc.personal_form.contact_details.phone",
  "personalKyc.personal_form.identificationNo",
];
```

### Adding a new model

1. Define `restrictedProperty` at the top of the model file
2. Attach it: `MySchema.statics.restrictedProperty = restrictedProperty`
3. Apply the plugin: `MySchema.plugin(roleEncryptionPlugin)`
4. Add `isDataEncrypted: { type: Boolean, default: false }` to the schema

No changes needed to `PrivacyPermission` — permissions are model-agnostic.

---

## PrivacyPermission Model

### Purpose

Controls **who** can read the fields listed in each model's `restrictedProperty`.
An admin creates permission documents at runtime — no schema changes needed to
grant or revoke access. Each document is scoped to a **client and/or branch** so
permissions never apply cross-tenant.

### Schema

```
PrivacyPermission
├── client             : ObjectId → Client  (tenant scope — auto-set from req.user)
├── branch             : ObjectId → Branch  (tenant scope — auto-set from req.user)
├── name               : String             (human-readable label, required)
├── roleIds          : [ObjectId → Roles] (roles GRANTED access)
├── restrictedUserIds  : [ObjectId → Users] (users BLOCKED even if their role matches)
├── grantedBy          : ObjectId → Users   (admin who created this permission, required)
├── isActive           : Boolean            (default true)
├── expiresAt          : Date               (null = never expires)
└── timestamps
```

**Grant vs Restrict logic:**
- `roleIds` → who is **allowed** (role-level grant)
- `restrictedUserIds` → who is **explicitly blocked** even if their role is in `roleIds`

### Field rules

| Field | Meaning |
|---|---|
| `client` / `branch` | Tenant scope — permission only applies within this client/branch |
| `roleIds: ['<role-id-1>', '<role-id-2>']` | Everyone whose role matches one of these ObjectIds can read restricted fields |
| `restrictedUserIds: [<id>]` | That specific user is blocked regardless of their role |
| `isActive: false` | Permission suspended — no one currently granted via this document |
| `expiresAt: <date>` | Permission auto-expires (checked at request time) |

### Example documents

```json
// Analysts and approval officers at a specific branch can read restricted fields,
// except one suspended analyst
{
  "client": "<client-id>",
  "branch": "<branch-id>",
  "name": "Analyst read access",
  "roleIds": ["<analyst-role-id>", "<approval-role-id>"],
  "restrictedUserIds": ["<suspended-analyst-id>"],
  "grantedBy": "<admin-id>",
  "isActive": true,
  "expiresAt": null
}

// Temporary access for client-admin — expires end of year
{
  "client": "<client-id>",
  "branch": null,
  "name": "Client admin temporary access",
  "roleIds": ["<client-admin-role-id>"],
  "restrictedUserIds": [],
  "grantedBy": "<admin-id>",
  "isActive": true,
  "expiresAt": "2026-12-31T00:00:00Z"
}
```

---

## PrivacySnapshot Model

### Purpose

Captures raw field values **before** any encrypt or decrypt operation is applied,
so the document state can be restored if needed. Every bulk or single-document
encryption/decryption call automatically creates a versioned snapshot before writing.

### Schema

```
PrivacySnapshot
├── modelType    : String ('user' | 'customer')  (which model this snapshot belongs to)
├── documentId   : ObjectId                       (the document snapshotted)
├── operation    : String ('pre_encrypt' | 'pre_decrypt')
├── version      : Number (≥ 1)                   (auto-incremented per documentId — v1 is the first)
├── fields       : Mixed                          (field path → raw value before the operation)
├── performedBy  : ObjectId → Users               (admin who triggered the operation)
├── restoredAt   : Date                           (null until this snapshot is used for restore)
├── restoredBy   : ObjectId → Users               (null until restored)
└── timestamps
```

**Indexes:**
- Unique compound: `{ modelType, documentId, version }` — prevents duplicate versions at DB level
- `{ modelType, documentId }` — fast lookup of all versions for a document
- `{ createdAt: -1 }` — fast list queries

### Versioning

`version` is auto-incremented per `(modelType, documentId)` pair inside `takeSnapshot()`:
```
first encrypt  → version 1  (pre_encrypt)
first decrypt  → version 2  (pre_decrypt)
second encrypt → version 3  (pre_encrypt)
…
```

This means every document has its own independent version counter. To view the full
version timeline for a document use `GET /snapshots/versions?modelType=user&documentId=<id>`.

### Restore behaviour

| `operation` | What was captured | Restoring writes | `isDataEncrypted` after |
|---|---|---|---|
| `pre_encrypt` | plaintext values | plaintext back | `false` |
| `pre_decrypt` | encrypted values | ciphertext back | `true` |

A snapshot can only be restored **once** — subsequent attempts return `400`.

---

## How It Works

### Request lifecycle

```
Request arrives
  │
  ▼
protect middleware
  ├─ verifies JWT, loads user (includes client._id, branch._id)
  ├─ Role.findOne({ name: u.role }) → roleDoc._id
  ├─ PrivacyPermission.isGranted(userId, roleDoc._id, { clientId, branchId })
  │    ├─ finds active, non-expired permission where:
  │    │    roleIds includes roleDoc._id
  │    │    client matches req.user.client._id  (when present)
  │    │    branch matches req.user.branch._id  (when present)
  │    ├─ checks restrictedUserIds — if user is listed → false
  │    └─ returns true | false
  └─ runWithRole(role, canReadDecrypted, next)
            │
            ▼  AsyncLocalStorage — canReadDecrypted available
               to all DB reads in this async chain
Controller / Service
  │
  ▼
Model.find() / .findById()
  └─ post('find') / post('init') hook fires
       ├─ reads canReadDecrypted from AsyncLocalStorage
       ├─ reads Model.restrictedProperty to know which fields to check
       ├─ canReadDecrypted = true  → decrypt restricted fields → plaintext
       └─ canReadDecrypted = false → mask restricted fields → "***"
```

### Encryption on save

`pre('save')` hook encrypts all fields listed in `restrictedProperty` and sets
`isDataEncrypted = true`. If already `true`, the hook is skipped (no double-encrypt).

> `updateOne` / `findOneAndUpdate` bypass the pre-save hook — call `encrypt()`
> manually or use the privacy controller bulk endpoints.

---

## Encryption Spec

| Property | Value |
|---|---|
| Algorithm | AES-256-GCM |
| Key source | `ENCRYPTION_KEY` env var (hex, 32 bytes) |
| Stored format | `<iv_hex>:<authTag_hex>:<encrypted_hex>` |
| Auth tag | 16 bytes, prevents tampering |

```env
ENCRYPTION_KEY=<64-char hex string>
SEARCH_HASH_SECRET=<any secret string>
```

---

## Privacy Permission API

All routes require `Authorization: Bearer <token>` and role **admin**.

Base path: `/api/v1/privacy/permissions`

| Method | Route | Description |
|---|---|---|
| `POST` | `/` | Create a permission (client/branch auto-set from token) |
| `GET` | `/` | List all permissions (`?isActive=true&roleId=<role-id>`) |
| `GET` | `/:id` | Get a single permission |
| `PUT` | `/:id` | Update / toggle fields |
| `DELETE` | `/:id` | Delete a permission |

**Create body** — `client` and `branch` are **not required in the body**; they are
automatically taken from the requesting admin's token.

```json
{
  "name": "Analyst read access",
  "roleIds": ["<analyst-role-id>", "<approval-role-id>"],
  "restrictedUserIds": ["<blocked-user-id>"],
  "expiresAt": null
}
```

**Updatable fields via `PUT /:id`**

`name` · `roleIds` · `restrictedUserIds` · `isActive` · `expiresAt` · `client` · `branch`

---

## Encryption Management API

All routes require role **admin**. Bulk endpoints are scoped to the admin's own
`client` and `branch` automatically.

Base path: `/api/v1/privacy`

| Method | Route | Description |
|---|---|---|
| `GET` | `/user/:id` | User encryption status + restricted field list |
| `PUT` | `/user/:id` | Encrypt / decrypt a single user |
| `PUT` | `/users/bulk` | Bulk encrypt / decrypt users in admin's tenant |
| `GET` | `/customer/:id` | Customer encryption status + restricted field list |
| `PUT` | `/customer/:id` | Encrypt / decrypt a single customer |
| `PUT` | `/customers/bulk` | Bulk encrypt / decrypt customers in admin's tenant |
| `PUT` | `/all/bulk` | Bulk encrypt / decrypt users AND customers in one call |

**Body for all encrypt/decrypt endpoints:**
```json
{ "encrypted": true }
```

**Status response** (`GET /user/:id`, `GET /customer/:id`)
```json
{
  "success": true,
  "data": {
    "_id": "...",
    "uid": "...",
    "isDataEncrypted": true,
    "flagInDb": true,
    "flagMismatch": false,
    "encryptedFields": ["name", "email"]
  }
}
```
`flagMismatch: true` means `isDataEncrypted` in the DB does not match the actual
stored value — the controller detects and repairs this automatically.

---

## Snapshot API

Base path: `/api/v1/privacy`

> Static sub-paths (`/versions`, `/bulk-restore`) are registered **before** `/:id`
> in the router so Express does not treat them as snapshot IDs.

| Method | Route | Description |
|---|---|---|
| `GET` | `/snapshots` | List snapshots (filterable, max 200) |
| `GET` | `/snapshots/versions` | Version timeline for a single document |
| `POST` | `/snapshots/bulk-restore` | Bulk restore all matching unrestored snapshots |
| `GET` | `/snapshots/:id` | Get a single snapshot |
| `POST` | `/snapshots/:id/restore` | Restore the document to its pre-operation state |

---

### `GET /snapshots` — query params

| Param | Values | Description |
|---|---|---|
| `modelType` | `user` \| `customer` | Filter by model |
| `operation` | `pre_encrypt` \| `pre_decrypt` | Filter by operation type |
| `version` | integer | Filter to an exact version number |
| `documentId` | ObjectId string | Filter to one document's history |
| `isRestored` | `true` \| `false` | Filter by whether snapshot has been used |

---

### `GET /snapshots/versions` — query params (both required)

| Param | Description |
|---|---|
| `modelType` | `user` \| `customer` |
| `documentId` | ObjectId of the document |

Returns the full version timeline sorted oldest → newest. Each entry shows
`version`, `operation`, `performedBy`, `restoredAt`, `restoredBy`, `createdAt`.

---

### `POST /snapshots/bulk-restore` — request body

| Field | Required | Description |
|---|---|---|
| `modelType` | yes | `"user"` \| `"customer"` |
| `operation` | no | `"pre_encrypt"` \| `"pre_decrypt"` — narrows the match |
| `version` | no | Exact version to restore; omit to use the **latest** unrestored snapshot per document |

**Behaviour when `version` is omitted:** uses a MongoDB aggregation to find the
highest-version unrestored snapshot for each document, then restores each one.

**Behaviour when `version` is provided:** restores every unrestored snapshot that
is exactly at that version number across all matching documents.

**Response:**
```json
{
  "success": true,
  "message": "Restored 12 snapshot(s)",
  "restored": 12,
  "failed": 0
}
```
`errors` array is included only when one or more documents failed (e.g. document
was deleted after the snapshot was taken).

---

### `POST /snapshots/:id/restore`

Restores a single document. Can only be called once per snapshot — returns `400`
if `restoredAt` is already set.

---

## Model Static Methods

| Method | Where | Description |
|---|---|---|
| `Model.restrictedProperty` | Any model | Array of sensitive field paths defined by the developer |
| `Model.getEncryptedPaths()` | Plugin | Returns paths currently tracked by the encryption plugin |
| `doc.decryptForRole(role)` | Plugin instance | Returns plain object with restricted fields decrypted for the given role |
| `Model.decryptManyForRole(docs, role)` | Plugin static | Decrypts an array of docs for the given role |
| `PrivacyPermission.isGranted(userId, roleId, { clientId, branchId })` | PrivacyPermission | `true` if the role ObjectId has an active, tenant-matching grant and the user is not in `restrictedUserIds` |

---

## Requirements Status

| # | Requirement | Status |
|---|---|---|
| 1 | Developer-defined sensitive fields per model (`restrictedProperty`) | Done — static array on each model |
| 2 | Dynamic permission model — roles granted/revoked at runtime | Done — `PrivacyPermission` model |
| 3 | Per-user block override within a role grant | Done — `restrictedUserIds` on `PrivacyPermission` |
| 4 | Tenant scoping — permissions isolated to client/branch | Done — `client`/`branch` on `PrivacyPermission`, `isGranted` filters by them |
| 5 | Admin-only bulk encrypt / decrypt | Done — all routes restricted via `authorize('admin')` |
| 6 | Role bound to async request context | Done — `AsyncLocalStorage` in `roleEncryptionPlugin` |
| 7 | Pre-operation snapshots for audit and rollback | Done — `PrivacySnapshot` model with per-document versioning, single + bulk restore endpoints |
| 8 | Auto-decrypt on read based on permissions | Planned — plugin needs to read `canReadDecrypted` from context instead of static `allowedRoles` |
