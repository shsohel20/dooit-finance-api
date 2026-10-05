# Xero App Store — readiness checklist

Legend: ✅ implemented & covered · 🟡 implemented, needs verification against a real Xero org · ⬜ outside this repo / manual

## Technical
- ✅ OAuth 2.0 authorisation-code flow, `offline_access`, single-use state
- ✅ Refresh-token rotation handled safely (serialised, CAS), expiry tracked
- ✅ Tokens encrypted at rest (AES-256-GCM), never returned by the API or logged
- ✅ Disconnect revokes the connection at Xero (`DELETE /connections/{id}`) and wipes local tokens
- ✅ `xero-tenant-id` sent on every call; multi-org handled by picking the newly authorised org
- ✅ Rate-limit (429 / `Retry-After`) and 5xx/network back-off
- ✅ Webhook HMAC verification, 401 on failure, 200 + empty body on success, async processing
- ✅ Idempotent sync, no duplicate contacts/invoices/payments
- ✅ Audit log of connect/disconnect/sync/webhook events
- 🟡 Scope set — confirm which scopes the Xero app is issued (granular vs `accounting.transactions`) and request the minimum needed
- 🟡 Contact/Invoice/Payment payload acceptance (tax types, account codes) — run against a Xero demo company
- 🟡 Only use Xero data for the stated purpose; document data retention (sync-log TTL is 1 year)

## Certification-process items
- ⬜ Connect/disconnect UI in the Next.js Settings page (contract in README §7) with the official "Connect to Xero" button + Xero branding rules
- ⬜ Connection shown with org name; **disconnect** clearly available
- ⬜ App Store listing: description, screenshots, support contact, privacy policy and terms URLs
- ⬜ Security self-assessment (Xero's questionnaire: encryption, access control, logging, vuln management)
- ⬜ Demo video/walkthrough of connect → sync → disconnect using a Xero demo company
- ⬜ Production Xero app credentials; HTTPS-only redirect + webhook URLs
- ⬜ Pen-test / vulnerability-management evidence if requested for the partner tier

## Known limitations
- Single Xero organisation per Dooit company.
- Refunds (credit notes), inbound voids and deletions are not auto-applied.
- Customer sync covers individual-KYC customers; company-type KYC records sync via the owning company contact.
- Worker/queue are in-process (Mongo-backed); scale-out safe but no external broker.
