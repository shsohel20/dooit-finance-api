/**
 * Graph validation — the authoritative publish gate.
 *
 * Errors block publish. Warnings never block anything: a draft is legitimately
 * half-built, and a builder that refuses to save work-in-progress is a builder
 * nobody uses.
 */
const { validateGraph } = require("../../services/workflowValidation");

const node = (id, over = {}) => ({
  id, num: "01", type: "level", title: `Step ${id}`,
  position: { x: 0, y: 0 }, branches: [], endOfFlow: false, ...over,
});

const cond = (id, branches) => node(id, { type: "cond", branches });
const br = (key, label, conditions, logic = "AND") => ({ key, label, logic, conditions });
const elseBranch = { key: "bz", label: "Else", logic: "AND", conditions: [] };

const codes = (list) => list.map((e) => e.code);

describe("validateGraph — errors", () => {
  test("a graph with one start node and one edge is clean", () => {
    const r = validateGraph({
      startNodeId: "n1",
      // n2 must be terminal, or it is legitimately a dead end and warns.
      nodes: [node("n1"), node("n2", { endOfFlow: true })],
      edges: [{ from: "n1", to: "n2", sourcePort: "" }],
    });
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  test("a missing start node is an error", () => {
    const r = validateGraph({ startNodeId: "", nodes: [node("n1")], edges: [] });
    expect(codes(r.errors)).toContain("NO_START_NODE");
  });

  test("a start node id that resolves to nothing is an error", () => {
    const r = validateGraph({ startNodeId: "nope", nodes: [node("n1")], edges: [] });
    expect(codes(r.errors)).toContain("NO_START_NODE");
  });

  test("a note cannot be the start node", () => {
    const r = validateGraph({
      startNodeId: "n1",
      nodes: [node("n1", { type: "note" })],
      edges: [],
    });
    expect(codes(r.errors)).toContain("START_NODE_IS_NOTE");
  });

  test("a dangling edge endpoint is an error", () => {
    const r = validateGraph({
      startNodeId: "n1",
      nodes: [node("n1")],
      edges: [{ from: "n1", to: "ghost", sourcePort: "" }],
    });
    expect(codes(r.errors)).toContain("EDGE_TARGET_MISSING");
  });

  test("an outgoing edge from a terminal node is an error", () => {
    const r = validateGraph({
      startNodeId: "n1",
      nodes: [node("n1", { endOfFlow: true }), node("n2")],
      edges: [{ from: "n1", to: "n2", sourcePort: "" }],
    });
    expect(codes(r.errors)).toContain("EDGE_FROM_TERMINAL");
  });

  test("a condition node with no branches is an error", () => {
    const r = validateGraph({
      startNodeId: "n1", nodes: [cond("n1", [])], edges: [],
    });
    expect(codes(r.errors)).toContain("COND_NO_BRANCHES");
  });

  test("a condition node whose branches do not end with Else is an error", () => {
    const r = validateGraph({
      startNodeId: "n1",
      nodes: [cond("n1", [{ key: "b1", label: "Branch 1", logic: "AND", conditions: [] }])],
      edges: [],
    });
    expect(codes(r.errors)).toContain("COND_NO_ELSE");
  });

  test("a non-last branch with no conditions shadows everything after it", () => {
    const r = validateGraph({
      startNodeId: "n1",
      nodes: [
        cond("n1", [
          { key: "b1", label: "Branch 1", logic: "AND", conditions: [] },
          br("b2", "Branch 2", [{ field: "applicant.type", operator: "eq", value: "company" }]),
          elseBranch,
        ]),
      ],
      edges: [],
    });
    expect(codes(r.errors)).toContain("BRANCH_EMPTY_NOT_LAST");
  });

  test("an edge naming a branch that does not exist is an error", () => {
    const r = validateGraph({
      startNodeId: "n1",
      nodes: [cond("n1", [elseBranch]), node("n2")],
      edges: [{ from: "n1", to: "n2", sourcePort: "ghost" }],
    });
    expect(codes(r.errors)).toContain("SOURCE_PORT_MISSING");
  });

  test("duplicate node ids are an error", () => {
    const r = validateGraph({
      startNodeId: "n1", nodes: [node("n1"), node("n1")], edges: [],
    });
    expect(codes(r.errors)).toContain("DUPLICATE_NODE_ID");
  });

  test("an edge starting from a node that does not exist is an error", () => {
    const r = validateGraph({
      startNodeId: "n1",
      nodes: [node("n1", { endOfFlow: true })],
      edges: [{ from: "ghost", to: "n1", sourcePort: "" }],
    });
    expect(codes(r.errors)).toContain("EDGE_SOURCE_MISSING");
  });

  test("a well-formed condition node produces no errors", () => {
    const r = validateGraph({
      startNodeId: "c1",
      nodes: [
        cond("c1", [
          br("b1", "Branch 1", [{ field: "applicant.type", operator: "eq", value: "individual" }]),
          elseBranch,
        ]),
        node("n2", { endOfFlow: true }),
        node("n3", { endOfFlow: true }),
      ],
      edges: [
        { from: "c1", to: "n2", sourcePort: "b1" },
        { from: "c1", to: "n3", sourcePort: "bz" },
      ],
    });
    // toEqual, not toContain — this test exists to catch rules that over-fire.
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });
});

describe("validateGraph — warnings", () => {
  test("an unreachable node warns, it does not error", () => {
    const r = validateGraph({
      startNodeId: "n1",
      nodes: [node("n1", { endOfFlow: true }), node("orphan", { endOfFlow: true })],
      edges: [],
    });
    expect(r.errors).toEqual([]);
    expect(codes(r.warnings)).toContain("UNREACHABLE_NODE");
  });

  test("a non-terminal node with no outgoing edge warns", () => {
    const r = validateGraph({
      startNodeId: "n1", nodes: [node("n1")], edges: [],
    });
    expect(r.errors).toEqual([]);
    expect(codes(r.warnings)).toContain("DEAD_END");
  });

  test("notes are exempt from reachability and dead-end warnings", () => {
    const r = validateGraph({
      startNodeId: "n1",
      nodes: [node("n1", { endOfFlow: true }), node("note1", { type: "note" })],
      edges: [],
    });
    expect(r.warnings).toEqual([]);
  });

  test("a cycle is legal — ongoing due diligence genuinely loops", () => {
    const r = validateGraph({
      startNodeId: "n1",
      nodes: [node("n1"), node("n2")],
      edges: [
        { from: "n1", to: "n2", sourcePort: "" },
        { from: "n2", to: "n1", sourcePort: "" },
      ],
    });
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });
});
