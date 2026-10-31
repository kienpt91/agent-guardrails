import type { RunResult } from "../agent.js";
import type { Budgets } from "../policy.js";
import type { TraceEvent } from "../trace.js";
import type { RunStatus } from "../types.js";
import { isRecord } from "../util.js";

export interface RunOutcome {
  result: RunResult;
  events: TraceEvent[];
}

/** `check` returns a failure message, or `undefined` when the assertion holds. */
export interface Assertion {
  description: string;
  check(outcome: RunOutcome): string | undefined;
}

export type ArgMatcher = Record<string, unknown>;

/** Deep partial match: object matchers match subsets, RegExp matches strings, functions are predicates. */
export function matchesArgs(actual: unknown, expected: unknown): boolean {
  if (typeof expected === "function") return Boolean((expected as (v: unknown) => unknown)(actual));
  if (expected instanceof RegExp) return typeof actual === "string" && expected.test(actual);
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length && expected.every((e, i) => matchesArgs(actual[i], e));
  }
  if (isRecord(expected)) {
    return isRecord(actual) && Object.entries(expected).every(([k, v]) => matchesArgs(actual[k], v));
  }
  return JSON.stringify(actual) === JSON.stringify(expected);
}

interface ToolCallView {
  tool: string;
  args: unknown;
  spanId: string;
  executed: boolean;
  cached: boolean;
  ok?: boolean;
  errorCode?: string;
}

/** Joins `tool.call` and `tool.result` events by span. */
export function toolCalls(events: TraceEvent[]): ToolCallView[] {
  const views = new Map<string, ToolCallView>();
  for (const e of events) {
    if (e.type === "tool.call") {
      views.set(e.spanId, { tool: String(e.data["tool"]), args: e.data["args"], spanId: e.spanId, executed: false, cached: false });
    } else if (e.type === "tool.result") {
      const view = views.get(e.spanId) ?? {
        tool: String(e.data["tool"]),
        args: undefined,
        spanId: e.spanId,
        executed: false,
        cached: false,
      };
      view.executed = e.data["executed"] === true;
      view.cached = e.data["cached"] === true;
      view.ok = e.data["ok"] === true;
      if (typeof e.data["errorCode"] === "string") view.errorCode = e.data["errorCode"];
      views.set(e.spanId, view);
    }
  }
  return [...views.values()];
}

export const status = (expected: RunStatus): Assertion => ({
  description: `run status is ${expected}`,
  check: (o) => (o.result.status === expected ? undefined : `expected status ${expected}, got ${o.result.status}${o.result.reason ? ` (${o.result.reason})` : ""}`),
});

export const reasonMatches = (expected: string | RegExp): Assertion => ({
  description: `run reason matches ${String(expected)}`,
  check: (o) => {
    const reason = o.result.reason ?? "";
    const ok = typeof expected === "string" ? reason === expected : expected.test(reason);
    return ok ? undefined : `reason was ${JSON.stringify(reason)}`;
  },
});

/** The tool was executed (it passed validation, policy and approval and its code ran), optionally with matching args. */
export const calledTool = (name: string, options: { args?: ArgMatcher; times?: number } = {}): Assertion => ({
  description: `called ${name}${options.args ? ` with matching args` : ""}${options.times !== undefined ? ` ${options.times}x` : ""}`,
  check: (o) => {
    const calls = toolCalls(o.events).filter((c) => c.tool === name && c.executed);
    const matching = options.args ? calls.filter((c) => matchesArgs(c.args, options.args)) : calls;
    if (options.times !== undefined) {
      return matching.length === options.times ? undefined : `${name} executed ${matching.length}x, expected ${options.times}x`;
    }
    return matching.length > 0 ? undefined : `${name} was never executed${options.args ? " with matching arguments" : ""}`;
  },
});

/** The tool's code never ran in this run. A call that was requested but blocked still satisfies this. */
export const neverCalledTool = (name: string): Assertion => ({
  description: `never called ${name}`,
  check: (o) => {
    const n = toolCalls(o.events).filter((c) => c.tool === name && c.executed).length;
    return n === 0 ? undefined : `${name} was executed ${n}x`;
  },
});

/** The model asked for the tool, whether or not it was allowed to run. */
export const attemptedTool = (name: string, options: { args?: ArgMatcher } = {}): Assertion => ({
  description: `model attempted ${name}`,
  check: (o) => {
    const calls = toolCalls(o.events).filter((c) => c.tool === name);
    const ok = options.args ? calls.some((c) => matchesArgs(c.args, options.args)) : calls.length > 0;
    return ok ? undefined : `model never requested ${name}${options.args ? " with matching arguments" : ""}`;
  },
});

export const policyDenied = (name: string, byRule?: string): Assertion => ({
  description: `policy denied ${name}${byRule ? ` (rule ${byRule})` : ""}`,
  check: (o) => {
    const hit = o.events.some(
      (e) => e.type === "policy.decision" && e.data["tool"] === name && e.data["effect"] === "deny" && (!byRule || e.data["decidedBy"] === byRule),
    );
    return hit ? undefined : `no policy deny for ${name}${byRule ? ` by ${byRule}` : ""}`;
  },
});

export const approvalRequestedFor = (name: string): Assertion => ({
  description: `approval requested for ${name}`,
  check: (o) => {
    const ids = o.events.filter((e) => e.type === "approval.requested" && e.spanId).map((e) => e.spanId);
    const calls = toolCalls(o.events).filter((c) => c.tool === name && ids.includes(c.spanId));
    return calls.length > 0 ? undefined : `no approval was requested for ${name}`;
  },
});

export const approvalResolved = (name: string, expected: "approved" | "denied" | "expired"): Assertion => ({
  description: `approval for ${name} ${expected}`,
  check: (o) => {
    const spans = new Set(toolCalls(o.events).filter((c) => c.tool === name).map((c) => c.spanId));
    const hit = o.events.some((e) => e.type === "approval.resolved" && spans.has(e.spanId) && e.data["status"] === expected);
    return hit ? undefined : `approval for ${name} was not ${expected}`;
  },
});

export const injectionFlagged = (): Assertion => ({
  description: "injection heuristics flagged a tool result",
  check: (o) => (o.events.some((e) => e.type === "security.injection_suspected") ? undefined : "no injection was flagged"),
});

export const escalated = (): Assertion => ({
  description: "escalated to a human",
  check: (o) => (o.result.status === "escalated" && o.result.escalation ? undefined : `run ended ${o.result.status}, not escalated`),
});

export const stoppedByBudget = (kind: string): Assertion => ({
  description: `stopped by budget ${kind}`,
  check: (o) => (o.result.status === "budget_exceeded" && o.result.reason === kind ? undefined : `status ${o.result.status}, reason ${o.result.reason ?? "none"}`),
});

/** The run ended without a budget violation and its usage is inside the given limits. */
export const withinBudget = (limits: Budgets): Assertion => ({
  description: "stayed within budget",
  check: (o) => {
    const u = o.result.usage;
    if (o.result.status === "budget_exceeded") return `budget exceeded: ${o.result.reason}`;
    if (limits.maxSteps !== undefined && u.steps > limits.maxSteps) return `steps ${u.steps} > ${limits.maxSteps}`;
    if (limits.maxToolCalls !== undefined && u.toolCalls > limits.maxToolCalls) return `tool calls ${u.toolCalls} > ${limits.maxToolCalls}`;
    if (limits.maxSpendUnits !== undefined && u.spendUnits > limits.maxSpendUnits) return `spend ${u.spendUnits} > ${limits.maxSpendUnits}`;
    if (limits.maxWallClockMs !== undefined && u.elapsedMs > limits.maxWallClockMs) return `elapsed ${u.elapsedMs}ms > ${limits.maxWallClockMs}ms`;
    return undefined;
  },
});

export const finalMessageMatches = (pattern: RegExp): Assertion => ({
  description: `final message matches ${String(pattern)}`,
  check: (o) => (pattern.test(o.result.finalMessage ?? "") ? undefined : `final message was ${JSON.stringify(o.result.finalMessage ?? null)}`),
});

/** No trace event contains the given text anywhere. Use it to prove a secret never reached the trace. */
export const traceLacks = (text: string): Assertion => ({
  description: "trace does not contain a given secret",
  check: (o) => (o.events.some((e) => JSON.stringify(e).includes(text)) ? "secret text found in trace" : undefined),
});

export const custom = (description: string, test: (outcome: RunOutcome) => boolean | string): Assertion => ({
  description,
  check: (o) => {
    const r = test(o);
    return r === true ? undefined : r === false ? "custom check failed" : r;
  },
});

export function evaluate(outcome: RunOutcome, assertions: Assertion[]): { description: string; failure?: string }[] {
  return assertions.map((a) => {
    const failure = a.check(outcome);
    return failure === undefined ? { description: a.description } : { description: a.description, failure };
  });
}
