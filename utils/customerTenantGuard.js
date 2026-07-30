// utils/customerTenantGuard.js
// Shared tenant guard for per-customer endpoints: a client/branch user may
// only act on customers related to them (admins — no client scope — pass).

const idStr = (ref) => (ref && ref._id ? String(ref._id) : ref ? String(ref) : null);

/**
 * @param {Object} customer — Customer doc (needs .relations)
 * @param {*} client — req.user.client?._id (null for admins)
 * @param {*} branch — req.user.branch?._id (optional narrower scope)
 * @returns {boolean} true when the caller is allowed to act on this customer
 */
const customerRelatedToTenant = (customer, client, branch) => {
  if (!client) return true;
  return (customer?.relations || []).some(
    (r) =>
      idStr(r.client) === String(client) &&
      (branch ? idStr(r.branch) === String(branch) : true),
  );
};

module.exports = { customerRelatedToTenant, idStr };
