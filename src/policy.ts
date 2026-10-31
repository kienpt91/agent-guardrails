import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { SIDE_EFFECTS, type SideEffect } from "./types.js";
import { isRecord } from "./util.js";

const oneOrMany = <T extends z.ZodType>(schema: T) => z.union([schema, z.array(schema).min(1)]);

export const CONDITION_OPS = [
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "not_in",
  "contains",
  "exists",
  "matches",
  "not_matches",
  "any_matches",
  "any_not_matches",
  "count_eq",
  "count_gt",
  "count_gte",
  "count_lt",
] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];

const ConditionSchema = z
  .object({
    /** Dotted path into the validated tool arguments, e.g. `recipients` or `options.mode`. */
    path: z.string().min(1),
    op: z.enum(CONDITION_OPS),
    value: z.unknown().optional(),
  })
  .strict()
  .superRefine((cond, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: "custom", message, path: ["value"] });
    switch (cond.op) {
      case "exists":
        if (cond.value !== undefined && typeof cond.value !== "boolean") fail("exists takes a boolean");
        break;
      case "in":
      case "not_in":
        if (!Array.isArray(cond.value)) fail(`${cond.op} takes an array`);
        break;
      case "matches":
      case "not_matches":
      case "any_matches":
      case "any_not_matches":
        if (typeof cond.value !== "string") {
          fail(`${cond.op} takes a regular expression string`);
          break;
        }
        try {
          new RegExp(cond.value);
        } catch {
          fail(`${cond.op}: invalid regular expression`);
        }
        break;
      case "count_eq":
      case "count_gt":
      case "count_gte":
      case "count_lt":
        if (!Number.isInteger(cond.value) || (cond.value as number) < 0) fail(`${cond.op} takes a non-negative integer`);
        break;
      case "gt":
      case "gte":
      case "lt":
      case "lte":
        if (typeof cond.value !== "number") fail(`${cond.op} takes a number`);
        break;
      default:
        if (cond.value === undefined) fail(`${cond.op} requires a value`);
    }
  });

const MatchSchema = z
  .object({
    /** Tool name or glob (`*` wildcard), or a list of them. */
    tool: oneOrMany(z.string().min(1)).optional(),
    sideEffect: oneOrMany(z.enum(SIDE_EFFECTS)).optional(),
    environment: oneOrMany(z.string().min(1)).optional(),
    /** The run has already read output from an `untrusted` tool. */
    tainted: z.boolean().optional(),
    /** A tool result in this run matched a prompt-injection heuristic. */
    suspectedInjection: z.boolean().optional(),
  })
  .strict();

const RuleSchema = z
  .object({
    id: z.string().min(1),
    effect: z.enum(["allow", "deny", "require_approval"]),
    match: MatchSchema.default({}),
    /** All conditions must hold (AND). Write a second rule for OR. */
    when: z.array(ConditionSchema).default([]),
    reason: z.string().optional(),
    /** For `require_approval`: how long a reviewer has before the request expires and counts as denied. */
    approvalTimeoutMs: z.number().int().positive().optional(),
  })
  .strict();

const BudgetsSchema = z
  .object({
    maxSteps: z.number().int().positive().optional(),
    maxToolCalls: z.number().int().positive().optional(),
    maxSpendUnits: z.number().positive().optional(),
    maxWallClockMs: z.number().int().positive().optional(),
    maxDenials: z.number().int().positive().optional(),
  })
  .strict();

export const PolicySchema = z
  .object({
    version: z.literal(1),
    /** What happens when no rule matches. There is deliberately no default `allow`. */
    default: z.enum(["deny", "require_approval"]).default("deny"),
    budgets: BudgetsSchema.default({}),
    rules: z.array(RuleSchema).default([]),
  })
  .strict()
  .superRefine((policy, ctx) => {
    const seen = new Set<string>();
    policy.rules.forEach((rule, index) => {
      if (seen.has(rule.id)) {
        ctx.addIssue({ code: "custom", message: `duplicate rule id: ${rule.id}`, path: ["rules", index, "id"] });
      }
      seen.add(rule.id);
    });
  });

export type Policy = z.output<typeof PolicySchema>;
export type PolicyRule = Policy["rules"][number];
export type Budgets = Policy["budgets"];
export type Condition = z.output<typeof ConditionSchema>;

export function parsePolicy(text: string, format: "json" | "yaml"): Policy {
  const data: unknown = format === "json" ? JSON.parse(text) : parseYaml(text);
  const result = PolicySchema.safeParse(data);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`invalid policy: ${detail}`);
  }
  return result.data;
}

export function loadPolicyFile(path: string): Policy {
  const ext = extname(path).toLowerCase();
  const format = ext === ".json" ? "json" : ext === ".yaml" || ext === ".yml" ? "yaml" : undefined;
  if (!format) throw new Error(`policy file must end in .json, .yaml or .yml: ${path}`);
  return parsePolicy(readFileSync(path, "utf8"), format);
}

export type PolicyEffect = "allow" | "deny" | "require_approval";

export interface PolicyContext {
  tool: string;
  sideEffect: SideEffect;
  /** Arguments after schema validation (defaults applied). */
  args: unknown;
  environment: string;
  tainted: boolean;
  suspectedInjection: boolean;
}

export interface PolicyDecision {
  effect: PolicyEffect;
  /** Rule that determined the outcome, or `default`. */
  decidedBy: string;
  reason: string;
  /** Every rule that matched, in file order, with the effect it asked for. */
  matched: { id: string; effect: PolicyEffect }[];
  approvalTimeoutMs?: number;
}

const STRICTNESS: Record<PolicyEffect, number> = { allow: 0, require_approval: 1, deny: 2 };

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function toList<T>(value: T | T[] | undefined): T[] | undefined {
  return value === undefined ? undefined : Array.isArray(value) ? value : [value];
}

export function getPath(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const part of path.split(".")) {
    if (Array.isArray(current)) {
      const index = Number(part);
      current = Number.isInteger(index) ? current[index] : undefined;
    } else if (isRecord(current) && Object.hasOwn(current, part)) {
      current = current[part];
    } else {
      return undefined;
    }
  }
  return current;
}

function count(value: unknown): number | undefined {
  if (Array.isArray(value)) return value.length;
  if (typeof value === "string") return value.length;
  if (isRecord(value)) return Object.keys(value).length;
  return undefined;
}

function strings(value: unknown): string[] | undefined {
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value as string[];
  return undefined;
}

/**
 * Evaluates one condition. A missing path never satisfies a positive test, so an absent
 * argument cannot make a `deny` rule skip; negative tests (`neq`, `not_in`, `not_matches`,
 * `any_not_matches`) on an absent path are true.
 */
export function evaluateCondition(cond: Condition, args: unknown): boolean {
  const actual = getPath(args, cond.path);
  const expected = cond.value;
  switch (cond.op) {
    case "exists":
      return (actual !== undefined && actual !== null) === (expected ?? true);
    case "eq":
      return JSON.stringify(actual) === JSON.stringify(expected);
    case "neq":
      return JSON.stringify(actual) !== JSON.stringify(expected);
    case "gt":
      return typeof actual === "number" && actual > (expected as number);
    case "gte":
      return typeof actual === "number" && actual >= (expected as number);
    case "lt":
      return typeof actual === "number" && actual < (expected as number);
    case "lte":
      return typeof actual === "number" && actual <= (expected as number);
    case "in":
      return (expected as unknown[]).some((e) => JSON.stringify(e) === JSON.stringify(actual));
    case "not_in":
      return !(expected as unknown[]).some((e) => JSON.stringify(e) === JSON.stringify(actual));
    case "contains":
      if (typeof actual === "string") return typeof expected === "string" && actual.includes(expected);
      return Array.isArray(actual) && actual.some((e) => JSON.stringify(e) === JSON.stringify(expected));
    case "matches":
      return typeof actual === "string" && new RegExp(expected as string).test(actual);
    case "not_matches":
      return !(typeof actual === "string" && new RegExp(expected as string).test(actual));
    case "any_matches": {
      const list = strings(actual);
      return list !== undefined && list.some((s) => new RegExp(expected as string).test(s));
    }
    case "any_not_matches": {
      const list = strings(actual);
      if (list === undefined) return true;
      return list.some((s) => !new RegExp(expected as string).test(s));
    }
    case "count_eq":
      return count(actual) === expected;
    case "count_gt":
      return (count(actual) ?? -1) > (expected as number);
    case "count_gte":
      return (count(actual) ?? -1) >= (expected as number);
    case "count_lt": {
      const n = count(actual);
      return n !== undefined && n < (expected as number);
    }
  }
}

interface CompiledRule {
  rule: PolicyRule;
  tools?: RegExp[];
  sideEffects?: SideEffect[];
  environments?: string[];
}

/**
 * Evaluates a declarative policy.
 *
 * Conflict resolution is deny-overrides: every rule that matches is collected, and the most
 * restrictive effect wins (`deny` > `require_approval` > `allow`). Rule order never changes the
 * effect, it only picks which of several equally strict rules is reported as `decidedBy`.
 * If nothing matches, `policy.default` applies.
 */
export class PolicyEngine {
  private readonly compiled: CompiledRule[];

  constructor(readonly policy: Policy) {
    this.compiled = policy.rules.map((rule) => {
      const tools = toList(rule.match.tool)?.map(globToRegExp);
      const sideEffects = toList(rule.match.sideEffect);
      const environments = toList(rule.match.environment);
      return {
        rule,
        ...(tools ? { tools } : {}),
        ...(sideEffects ? { sideEffects } : {}),
        ...(environments ? { environments } : {}),
      };
    });
  }

  get budgets(): Budgets {
    return this.policy.budgets;
  }

  private matches(c: CompiledRule, ctx: PolicyContext): boolean {
    const { match, when } = c.rule;
    if (c.tools && !c.tools.some((re) => re.test(ctx.tool))) return false;
    if (c.sideEffects && !c.sideEffects.includes(ctx.sideEffect)) return false;
    if (c.environments && !c.environments.includes(ctx.environment)) return false;
    if (match.tainted !== undefined && match.tainted !== ctx.tainted) return false;
    if (match.suspectedInjection !== undefined && match.suspectedInjection !== ctx.suspectedInjection) return false;
    return when.every((cond) => evaluateCondition(cond, ctx.args));
  }

  evaluate(ctx: PolicyContext): PolicyDecision {
    const matched = this.compiled.filter((c) => this.matches(c, ctx));
    const summary = matched.map((c) => ({ id: c.rule.id, effect: c.rule.effect }));
    if (matched.length === 0) {
      return {
        effect: this.policy.default,
        decidedBy: "default",
        reason: `no rule matched; policy default is ${this.policy.default}`,
        matched: summary,
      };
    }
    const top = Math.max(...matched.map((c) => STRICTNESS[c.rule.effect]));
    const winners = matched.filter((c) => STRICTNESS[c.rule.effect] === top);
    const first = winners[0]!;
    const effect = first.rule.effect;
    const timeouts = winners.map((c) => c.rule.approvalTimeoutMs).filter((t): t is number => t !== undefined);
    return {
      effect,
      decidedBy: first.rule.id,
      reason: first.rule.reason ?? `matched rule ${first.rule.id}`,
      matched: summary,
      ...(effect === "require_approval" && timeouts.length > 0
        ? { approvalTimeoutMs: Math.min(...timeouts) }
        : {}),
    };
  }
}

export interface Usage {
  steps: number;
  toolCalls: number;
  spendUnits: number;
  denials: number;
  elapsedMs: number;
}

export type BudgetKind = "max_steps" | "max_tool_calls" | "max_spend_units" | "max_wall_clock_ms" | "max_denials";

export interface BudgetViolation {
  kind: BudgetKind;
  limit: number;
  used: number;
  message: string;
}

function violation(kind: BudgetKind, limit: number, used: number, what: string): BudgetViolation {
  return { kind, limit, used, message: `${what}: ${used} used, limit ${limit}` };
}

/** Per-run budget checks. Pure functions of the budgets and the current usage. */
export class BudgetGuard {
  constructor(private readonly budgets: Budgets) {}

  private shared(usage: Usage, extraSpend = 0): BudgetViolation | undefined {
    const { maxWallClockMs, maxSpendUnits, maxDenials } = this.budgets;
    if (maxWallClockMs !== undefined && usage.elapsedMs >= maxWallClockMs) {
      return violation("max_wall_clock_ms", maxWallClockMs, usage.elapsedMs, "wall-clock time (ms)");
    }
    if (maxSpendUnits !== undefined && usage.spendUnits + extraSpend > maxSpendUnits) {
      return violation("max_spend_units", maxSpendUnits, usage.spendUnits + extraSpend, "spend units");
    }
    if (maxDenials !== undefined && usage.denials >= maxDenials) {
      return violation("max_denials", maxDenials, usage.denials, "policy and approval denials");
    }
    return undefined;
  }

  /** Called before every model request. `steps` counts completed model requests. */
  beforeModelCall(usage: Usage): BudgetViolation | undefined {
    const { maxSteps } = this.budgets;
    if (maxSteps !== undefined && usage.steps >= maxSteps) return violation("max_steps", maxSteps, usage.steps, "model steps");
    return this.shared(usage);
  }

  /** Called before every tool call is handled; `toolCost` is what executing it would add to spend. */
  beforeToolCall(usage: Usage, toolCost = 0): BudgetViolation | undefined {
    const { maxToolCalls } = this.budgets;
    if (maxToolCalls !== undefined && usage.toolCalls >= maxToolCalls) {
      return violation("max_tool_calls", maxToolCalls, usage.toolCalls, "tool calls");
    }
    return this.shared(usage, toolCost);
  }

  /** Called right before a tool executes, with the units that execution will cost. */
  beforeExecute(usage: Usage, toolCost: number): BudgetViolation | undefined {
    return this.shared(usage, toolCost);
  }

  /** Called after a model response is charged, before its tool calls run. */
  afterModelCall(usage: Usage): BudgetViolation | undefined {
    return this.shared(usage);
  }
}
