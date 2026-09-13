/**
 * The shipped template must be publishable. If the reference flow does not
 * pass the validator, either the template or the validator is wrong — and
 * shipping a template a user cannot publish is the worse of the two.
 */
const { validateGraph } = require("../../services/workflowValidation");
const { DOOIT_FULL_FLOW } = require("../../seeds/workflowTemplates");

test("the seeded Dooit flow has no validation errors", () => {
  const { errors } = validateGraph(DOOIT_FULL_FLOW);
  expect(errors).toEqual([]);
});

test("the seeded flow has 31 steps and a start node", () => {
  expect(DOOIT_FULL_FLOW.startNodeId).toBe("n1");
  expect(DOOIT_FULL_FLOW.nodes.filter((n) => n.type !== "note")).toHaveLength(31);
});

test("every edge resolves to a real node", () => {
  const ids = new Set(DOOIT_FULL_FLOW.nodes.map((n) => n.id));
  for (const e of DOOIT_FULL_FLOW.edges) {
    expect(ids.has(e.from)).toBe(true);
    expect(ids.has(e.to)).toBe(true);
  }
});

test("every jurisdictional figure is marked pending validation", () => {
  // The suffix exists so a compliance user never mistakes an unverified
  // figure for settled law — that risk is the same whether the figure sits
  // in a config field, a card chip/inset the canvas renders as plain fact,
  // or an outcome's cond/then text. So this walks all of them, not just
  // config.fields. The regex covers every figure named in this task's
  // constraints (not just the subset the first draft happened to check) so
  // a future edit can't quietly unsuffix one without the suite noticing.
  const figures = /\b(10,?000|25 percent|50 percent|0\.95|0\.90|0\.70|24 hours|3 business days|10 business days|30 days|seven years?|seven year)/i;
  const check = (value) => {
    if (typeof value === "string" && figures.test(value)) {
      expect(value).toMatch(/\(pending validation\)$/);
    }
  };
  for (const n of DOOIT_FULL_FLOW.nodes) {
    check(n.card?.inset);
    check(n.card?.reason);
    for (const chip of n.card?.chips || []) check(chip);
    for (const tag of n.card?.tags || []) check(tag.text);
    for (const f of n.config?.fields || []) check(f.value);
    for (const o of n.config?.outcomes || []) {
      check(o.cond);
      check(o.then);
    }
  }
});
