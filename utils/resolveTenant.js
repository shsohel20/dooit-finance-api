// utils/resolveTenant.js
//
// "Whose alert is this, and whose case does it become?"
//
// Every alert and case must carry a client (and a branch where one applies):
// it decides who sees the case, which rules were evaluated, what the analysis
// is scoped to, and which reporting entity a filing speaks for (docs/74 C15).
//
// There are two ways an alert comes into being, and they answer the question
// differently:
//
//   • A human clicks Report / Review  → there IS a logged-in user, and a client
//     user only ever acts inside their own tenant, so that is the answer.
//   • The rule engine fires automatically → there is NO user at all. The tenant
//     has to come from the subject itself: the transaction was recorded BY a
//     client and branch, and a customer is bound to a reporting entity by their
//     `relations[]`.
//
// A logged-in *admin* is the case that catches people out: they have no client
// of their own, so "take it from the user" would produce a tenant-less alert.
// That is why the sources below are a chain rather than a choice.

const idStr = (ref) => (ref && ref._id ? String(ref._id) : ref ? String(ref) : null);

/**
 * The relation that binds a customer to a reporting entity.
 *
 * A customer can be onboarded by several clients (the condition behind C15), so
 * when there is a hint — the transaction's client, say — the matching relation
 * wins. Otherwise the individual relation is preferred over an entity one, and
 * the earliest is the tie-break: the entity that onboarded them first.
 */
function relationForCustomer(customer, { clientHint = null } = {}) {
    const relations = (customer && customer.relations) || [];
    if (!relations.length) return null;

    if (clientHint) {
        const matching = relations.filter((r) => idStr(r.client) === String(clientHint));
        if (matching.length) {
            return matching.find((r) => !idStr(r.branch)) || matching[0];
        }
    }

    const byAge = [...relations].sort(
        (a, b) => new Date(a.registeredAt || 0) - new Date(b.registeredAt || 0)
    );
    return byAge.find((r) => String(r.type || "").toLowerCase() === "individual") || byAge[0];
}

/** Distinct clients a customer is onboarded under. */
function clientsForCustomer(customer) {
    return [...new Set(((customer && customer.relations) || []).map((r) => idStr(r.client)).filter(Boolean))];
}

/**
 * Resolve the tenant for an alert or case.
 *
 * @param {Object} opts
 * @param {Object} [opts.user]        req.user, when a human triggered this
 * @param {Object} [opts.transaction] the transaction that fired the rule
 * @param {Object} [opts.customer]    the subject customer (needs `relations`)
 * @param {Object} [opts.fallback]    e.g. the Notify's own tenant
 * @returns {{client: string|null, branch: string|null, source: string, ambiguous: boolean}}
 *          `source` names which link in the chain answered, so an alert with a
 *          surprising tenant can be explained later. `ambiguous` is true when
 *          the customer belongs to several clients and nothing else settled it.
 */
function resolveTenant({ user, transaction, customer, fallback } = {}) {
    // 1. The acting user. A client user cannot act outside their own tenant, so
    //    this outranks everything; an admin has none and falls through.
    const userClient = idStr(user?.client?._id ?? user?.client ?? user?.clientBelongs);
    if (userClient) {
        return {
            client: userClient,
            branch: idStr(user?.branch?._id ?? user?.branch ?? user?.branchBelongs),
            source: "user",
            ambiguous: false,
        };
    }

    // 2. The transaction. It was booked by a client and branch — the most
    //    specific statement of tenancy an automatic trigger can have.
    const txnClient = idStr(transaction?.client);
    if (txnClient) {
        return {
            client: txnClient,
            branch: idStr(transaction?.branch),
            source: "transaction",
            ambiguous: false,
        };
    }

    // 3. The customer's relations. The only source for a customer-subject rule.
    const clients = clientsForCustomer(customer);
    if (clients.length) {
        const relation = relationForCustomer(customer, { clientHint: idStr(transaction?.client) });
        return {
            client: idStr(relation?.client),
            branch: idStr(relation?.branch),
            source: "customer",
            // Several reporting entities hold this person, and nothing above
            // said which one this alert is for. The alert is still raised — for
            // the earliest relation — but the caller should record the doubt.
            ambiguous: clients.length > 1,
        };
    }

    // 4. Whatever the caller already knew (the Notify's own tenant).
    const fallbackClient = idStr(fallback?.client);
    if (fallbackClient) {
        return {
            client: fallbackClient,
            branch: idStr(fallback?.branch),
            source: "fallback",
            ambiguous: false,
        };
    }

    return { client: null, branch: null, source: "none", ambiguous: false };
}

module.exports = { resolveTenant, relationForCustomer, clientsForCustomer };
