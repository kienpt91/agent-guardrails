import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BudgetGuard,
  PolicyEngine,
  evaluateCondition,
  getPath,
  loadPolicyFile,
  parsePolicy,
  type Condition,
  type PolicyContext,
} from "../src/index.js";
import { policyOf } from "./helpers.js";

const ctx = (overrides: Partial<PolicyContext> = {}): PolicyContext => ({
  tool: "send_message",
  sideEffect: "external-send",
  args: { to: ["a@x.example"] },
  environment: "production",
  tainted: false,
  suspectedInjection: false,
  ...overrides,
});

const engine = (rules: unknown[], extra: Record<string, unknown> = {}) => new PolicyEngine(policyOf({ rules, ...extra }));

describe("policy parsing", () => {
  it("parses YAML", () => {
    const policy = parsePolicy(
      `version: 1
default: deny
budgets: { maxSteps: 3 }
rules:
  - id: r1
    effect: allow
    match: { sideEffect: read }
`,
      "yaml",
    );
    expect(policy.rules[0]!.id).toBe("r1");
    expect(policy.budgets.maxSteps).toBe(3);
  });

  it("parses JSON and gives the same result as YAML", () => {
    const json = parsePolicy('{"version":1,"rules":[{"id":"r1","effect":"allow","match":{"sideEffect":"read"}}]}', "json");
    const yaml = parsePolicy("version: 1\nrules:\n  - {id: r1, effect: allow, match: {sideEffect: read}}\n", "yaml");
    expect(json).toEqual(yaml);
  });

  it("defaults to deny and fills in empty match and conditions", () => {
    const policy = policyOf({ rules: [{ id: "r", effect: "allow" }] });
    expect(policy.default).toBe("deny");
    expect(policy.rules[0]!.match).toEqual({});
    expect(policy.rules[0]!.when).toEqual([]);
  });

  it("does not allow a default of allow", () => {
    expect(() => policyOf({ default: "allow" })).toThrow(/invalid/i);
  });

  it("rejects duplicate rule ids", () => {
    expect(() => policyOf({ rules: [{ id: "a", effect: "allow" }, { id: "a", effect: "deny" }] })).toThrow(/duplicate rule id/);
  });

  it("rejects unknown keys so typos do not silently weaken a policy", () => {
    expect(() => parsePolicy('{"version":1,"rules":[{"id":"a","effect":"deny","mach":{}}]}', "json")).toThrow(/invalid policy/);
    expect(() => parsePolicy('{"version":1,"budget":{}}', "json")).toThrow(/invalid policy/);
  });

  it("rejects an invalid regular expression and wrongly typed condition values", () => {
    const rule = (when: unknown) => ({ id: "a", effect: "deny", when: [when] });
    expect(() => policyOf({ rules: [rule({ path: "x", op: "matches", value: "(" })] })).toThrow(/regular expression/);
    expect(() => policyOf({ rules: [rule({ path: "x", op: "in", value: "a" })] })).toThrow(/array/);
    expect(() => policyOf({ rules: [rule({ path: "x", op: "count_gt", value: -1 })] })).toThrow(/non-negative/);
    expect(() => policyOf({ rules: [rule({ path: "x", op: "gt", value: "5" })] })).toThrow(/number/);
    expect(() => policyOf({ rules: [rule({ path: "x", op: "eq" })] })).toThrow(/requires a value/);
  });

  it("rejects non-positive budgets", () => {
    expect(() => policyOf({ budgets: { maxSteps: 0 } })).toThrow();
    expect(() => policyOf({ budgets: { maxSpendUnits: -1 } })).toThrow();
  });
});

describe("loadPolicyFile", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("loads .yaml, .yml and .json files and rejects other extensions", () => {
    dir = mkdtempSync(join(tmpdir(), "policy-"));
    writeFileSync(join(dir, "p.yaml"), "version: 1\n");
    writeFileSync(join(dir, "p.yml"), "version: 1\n");
    writeFileSync(join(dir, "p.json"), '{"version":1}');
    writeFileSync(join(dir, "p.txt"), "version: 1\n");
    expect(loadPolicyFile(join(dir, "p.yaml")).version).toBe(1);
    expect(loadPolicyFile(join(dir, "p.yml")).version).toBe(1);
    expect(loadPolicyFile(join(dir, "p.json")).version).toBe(1);
    expect(() => loadPolicyFile(join(dir!, "p.txt"))).toThrow(/must end in/);
  });
});

describe("precedence and conflict resolution", () => {
  it("falls back to the default when no rule matches", () => {
    const d = engine([{ id: "r", effect: "allow", match: { tool: "other" } }]).evaluate(ctx());
    expect(d).toMatchObject({ effect: "deny", decidedBy: "default" });
    expect(d.matched).toEqual([]);
  });

  it("can default to require_approval", () => {
    const d = engine([], { default: "require_approval" }).evaluate(ctx());
    expect(d).toMatchObject({ effect: "require_approval", decidedBy: "default" });
  });

  it("allows when only allow rules match", () => {
    const d = engine([{ id: "a", effect: "allow", match: { tool: "send_message" } }]).evaluate(ctx());
    expect(d).toMatchObject({ effect: "allow", decidedBy: "a" });
  });

  it("require_approval beats allow", () => {
    const d = engine([
      { id: "a", effect: "allow", match: { tool: "send_message" } },
      { id: "b", effect: "require_approval", match: { sideEffect: "external-send" } },
    ]).evaluate(ctx());
    expect(d).toMatchObject({ effect: "require_approval", decidedBy: "b" });
  });

  it("deny beats require_approval and allow regardless of rule order", () => {
    const rules = [
      { id: "allow", effect: "allow", match: { tool: "send_message" } },
      { id: "approve", effect: "require_approval", match: { tool: "send_message" } },
      { id: "deny", effect: "deny", match: { tool: "send_message" } },
    ];
    for (const ordered of [rules, [...rules].reverse(), [rules[1], rules[2], rules[0]]]) {
      expect(engine(ordered as unknown[]).evaluate(ctx())).toMatchObject({ effect: "deny", decidedBy: "deny" });
    }
  });

  it("reports the first of several equally strict rules as the decider and lists all matches", () => {
    const d = engine([
      { id: "d1", effect: "deny", match: { tool: "send_message" }, reason: "first" },
      { id: "d2", effect: "deny", match: { sideEffect: "external-send" }, reason: "second" },
    ]).evaluate(ctx());
    expect(d.decidedBy).toBe("d1");
    expect(d.reason).toBe("first");
    expect(d.matched.map((m) => m.id)).toEqual(["d1", "d2"]);
  });

  it("uses the stricter (smaller) approval timeout when several approval rules match", () => {
    const d = engine([
      { id: "a", effect: "require_approval", match: { tool: "send_message" }, approvalTimeoutMs: 5000 },
      { id: "b", effect: "require_approval", match: { sideEffect: "external-send" }, approvalTimeoutMs: 1000 },
    ]).evaluate(ctx());
    expect(d.approvalTimeoutMs).toBe(1000);
  });

  it("does not carry an approval timeout onto a deny decision", () => {
    const d = engine([
      { id: "a", effect: "require_approval", match: { tool: "send_message" }, approvalTimeoutMs: 5000 },
      { id: "b", effect: "deny", match: { tool: "send_message" } },
    ]).evaluate(ctx());
    expect(d.approvalTimeoutMs).toBeUndefined();
  });

  it("uses a default reason when a rule has none", () => {
    expect(engine([{ id: "r", effect: "deny" }]).evaluate(ctx()).reason).toBe("matched rule r");
  });
});

describe("rule matching", () => {
  it("matches tool names with exact names, globs and lists", () => {
    const e = engine([{ id: "g", effect: "allow", match: { tool: ["crm_*", "exact_tool"] } }]);
    expect(e.evaluate(ctx({ tool: "crm_get_account" })).effect).toBe("allow");
    expect(e.evaluate(ctx({ tool: "exact_tool" })).effect).toBe("allow");
    expect(e.evaluate(ctx({ tool: "exact_tool_2" })).effect).toBe("deny");
    expect(e.evaluate(ctx({ tool: "cms_get" })).effect).toBe("deny");
  });

  it("treats regex characters in a tool name literally", () => {
    const e = engine([{ id: "g", effect: "allow", match: { tool: "a.b" } }]);
    expect(e.evaluate(ctx({ tool: "a.b" })).effect).toBe("allow");
    expect(e.evaluate(ctx({ tool: "axb" })).effect).toBe("deny");
  });

  it("matches side-effect classes singly or as a list", () => {
    const e = engine([{ id: "g", effect: "allow", match: { sideEffect: ["read", "write"] } }]);
    expect(e.evaluate(ctx({ sideEffect: "write" })).effect).toBe("allow");
    expect(e.evaluate(ctx({ sideEffect: "destructive" })).effect).toBe("deny");
  });

  it("matches the environment", () => {
    const e = engine([{ id: "g", effect: "allow", match: { environment: ["staging", "development"] } }]);
    expect(e.evaluate(ctx({ environment: "staging" })).effect).toBe("allow");
    expect(e.evaluate(ctx({ environment: "production" })).effect).toBe("deny");
  });

  it("matches taint and suspected-injection state", () => {
    const e = engine([
      { id: "t", effect: "require_approval", match: { tainted: true } },
      { id: "ok", effect: "allow", match: { tainted: false } },
      { id: "i", effect: "deny", match: { suspectedInjection: true } },
    ]);
    expect(e.evaluate(ctx()).decidedBy).toBe("ok");
    expect(e.evaluate(ctx({ tainted: true })).decidedBy).toBe("t");
    expect(e.evaluate(ctx({ tainted: true, suspectedInjection: true })).decidedBy).toBe("i");
  });

  it("requires every condition in `when` to hold", () => {
    const e = engine([
      {
        id: "g",
        effect: "deny",
        when: [
          { path: "to", op: "count_gt", value: 1 },
          { path: "body", op: "contains", value: "free" },
        ],
      },
    ]);
    expect(e.evaluate(ctx({ args: { to: ["a", "b"], body: "free stuff" } })).effect).toBe("deny");
    expect(e.evaluate(ctx({ args: { to: ["a", "b"], body: "hello" } })).decidedBy).toBe("default");
  });
});

describe("condition operators", () => {
  const c = (op: Condition["op"], value?: unknown, path = "v"): Condition => ({ path, op, value }) as Condition;
  const holds = (cond: Condition, args: unknown) => evaluateCondition(cond, args);

  it("eq / neq / in / not_in compare structurally", () => {
    expect(holds(c("eq", "a"), { v: "a" })).toBe(true);
    expect(holds(c("eq", { x: 1 }), { v: { x: 1 } })).toBe(true);
    expect(holds(c("neq", "a"), { v: "b" })).toBe(true);
    expect(holds(c("in", ["a", "b"]), { v: "b" })).toBe(true);
    expect(holds(c("not_in", ["a", "b"]), { v: "c" })).toBe(true);
    expect(holds(c("in", ["a"]), { v: "c" })).toBe(false);
  });

  it("numeric comparisons only hold for numbers", () => {
    expect(holds(c("gt", 5), { v: 6 })).toBe(true);
    expect(holds(c("gt", 5), { v: "6" })).toBe(false);
    expect(holds(c("gte", 5), { v: 5 })).toBe(true);
    expect(holds(c("lt", 5), { v: 4 })).toBe(true);
    expect(holds(c("lte", 5), { v: 6 })).toBe(false);
  });

  it("contains works on strings and arrays", () => {
    expect(holds(c("contains", "ell"), { v: "hello" })).toBe(true);
    expect(holds(c("contains", "b"), { v: ["a", "b"] })).toBe(true);
    expect(holds(c("contains", "z"), { v: ["a", "b"] })).toBe(false);
  });

  it("exists distinguishes present from absent and null", () => {
    expect(holds(c("exists"), { v: 0 })).toBe(true);
    expect(holds(c("exists"), { v: null })).toBe(false);
    expect(holds(c("exists"), {})).toBe(false);
    expect(holds(c("exists", false), {})).toBe(true);
  });

  it("matches / not_matches apply to a single string", () => {
    expect(holds(c("matches", "^a+$"), { v: "aaa" })).toBe(true);
    expect(holds(c("not_matches", "^a+$"), { v: "ab" })).toBe(true);
    expect(holds(c("matches", "a"), { v: 5 })).toBe(false);
  });

  it("any_matches / any_not_matches apply to arrays of strings (for example recipient domains)", () => {
    const own = c("any_not_matches", "@corp\\.example$", "to");
    expect(holds(own, { to: ["a@corp.example", "b@corp.example"] })).toBe(false);
    expect(holds(own, { to: ["a@corp.example", "b@other.example"] })).toBe(true);
    expect(holds(c("any_matches", "@evil\\.example$", "to"), { to: ["a@corp.example", "x@evil.example"] })).toBe(true);
  });

  it("count operators handle arrays, strings and objects", () => {
    expect(holds(c("count_gt", 2), { v: [1, 2, 3] })).toBe(true);
    expect(holds(c("count_gte", 3), { v: [1, 2, 3] })).toBe(true);
    expect(holds(c("count_eq", 3), { v: "abc" })).toBe(true);
    expect(holds(c("count_lt", 2), { v: { a: 1 } })).toBe(true);
    expect(holds(c("count_gt", 0), { v: 5 })).toBe(false);
  });

  it("a missing path never satisfies a positive test but does satisfy negative ones", () => {
    expect(holds(c("eq", "a"), {})).toBe(false);
    expect(holds(c("gt", 1), {})).toBe(false);
    expect(holds(c("count_gt", 0), {})).toBe(false);
    expect(holds(c("any_matches", "x"), {})).toBe(false);
    expect(holds(c("neq", "a"), {})).toBe(true);
    expect(holds(c("not_in", ["a"]), {})).toBe(true);
    expect(holds(c("any_not_matches", "x"), {})).toBe(true);
  });

  it("resolves dotted paths through objects and array indexes", () => {
    const args = { options: { targets: [{ id: "t0" }, { id: "t1" }] } };
    expect(getPath(args, "options.targets.1.id")).toBe("t1");
    expect(getPath(args, "options.targets.9.id")).toBeUndefined();
    expect(getPath(args, "options.nope.x")).toBeUndefined();
  });

  it("does not read inherited properties", () => {
    expect(getPath({}, "constructor")).toBeUndefined();
    expect(getPath({}, "__proto__")).toBeUndefined();
  });
});

describe("BudgetGuard", () => {
  const usage = (overrides: Partial<Parameters<BudgetGuard["beforeModelCall"]>[0]> = {}) => ({
    steps: 0,
    toolCalls: 0,
    spendUnits: 0,
    denials: 0,
    elapsedMs: 0,
    ...overrides,
  });

  it("allows everything when no budgets are set", () => {
    const guard = new BudgetGuard({});
    expect(guard.beforeModelCall(usage({ steps: 1e6, spendUnits: 1e6 }))).toBeUndefined();
    expect(guard.beforeToolCall(usage({ toolCalls: 1e6 }), 100)).toBeUndefined();
  });

  it("stops model calls once maxSteps have run", () => {
    const guard = new BudgetGuard({ maxSteps: 3 });
    expect(guard.beforeModelCall(usage({ steps: 2 }))).toBeUndefined();
    expect(guard.beforeModelCall(usage({ steps: 3 }))).toMatchObject({ kind: "max_steps", limit: 3, used: 3 });
  });

  it("stops tool calls once maxToolCalls have been made", () => {
    const guard = new BudgetGuard({ maxToolCalls: 2 });
    expect(guard.beforeToolCall(usage({ toolCalls: 1 }))).toBeUndefined();
    expect(guard.beforeToolCall(usage({ toolCalls: 2 }))?.kind).toBe("max_tool_calls");
  });

  it("refuses a tool whose cost would pass the spend limit but allows spending exactly the limit", () => {
    const guard = new BudgetGuard({ maxSpendUnits: 10 });
    expect(guard.beforeExecute(usage({ spendUnits: 5 }), 5)).toBeUndefined();
    expect(guard.beforeExecute(usage({ spendUnits: 5 }), 5.5)?.kind).toBe("max_spend_units");
  });

  it("flags spend already over the limit after a model response", () => {
    const guard = new BudgetGuard({ maxSpendUnits: 10 });
    expect(guard.afterModelCall(usage({ spendUnits: 10 }))).toBeUndefined();
    expect(guard.afterModelCall(usage({ spendUnits: 10.5 }))?.kind).toBe("max_spend_units");
  });

  it("stops when the wall-clock budget is reached", () => {
    const guard = new BudgetGuard({ maxWallClockMs: 1000 });
    expect(guard.beforeModelCall(usage({ elapsedMs: 999 }))).toBeUndefined();
    expect(guard.beforeModelCall(usage({ elapsedMs: 1000 }))?.kind).toBe("max_wall_clock_ms");
  });

  it("stops after too many denials", () => {
    const guard = new BudgetGuard({ maxDenials: 2 });
    expect(guard.beforeToolCall(usage({ denials: 1 }))).toBeUndefined();
    expect(guard.beforeToolCall(usage({ denials: 2 }))?.kind).toBe("max_denials");
  });
});
