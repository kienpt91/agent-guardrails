import { z } from "zod";
import type { Clock } from "./clock.js";
import type { DiffEntry } from "./diff.js";
import { canonicalJson, sha256Hex } from "./util.js";
import type { SideEffect, ToolSpec } from "./types.js";
import { SIDE_EFFECTS } from "./types.js";

/** Failure raised by tool code. `retryable` is honoured only for tools that are safe to retry. */
export class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly options: { retryable?: boolean; details?: unknown } = {},
  ) {
    super(message);
    this.name = "ToolError";
  }
  get retryable(): boolean {
    return this.options.retryable ?? false;
  }
  get details(): unknown {
    return this.options.details;
  }
}

export interface ToolContext {
  runId: string;
  toolCallId: string;
  /** Stable key for this logical call. Pass it to the backend so a retry cannot repeat the effect. */
  idempotencyKey: string;
  /** 1-based attempt number. */
  attempt: number;
  /** Aborted when the tool timeout elapses. */
  signal: AbortSignal;
  clock: Clock;
}

export interface Simulation {
  /** Placeholder output handed back to the model; validated against the output schema when given. */
  result?: unknown;
  /** One-line description of what would have happened. */
  summary: string;
  /** Recorded diff of the intended change. */
  diff?: DiffEntry[];
}

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly sideEffect: SideEffect;
  readonly input: z.ZodType;
  readonly output: z.ZodType;
  readonly timeoutMs: number;
  /** `key`: the backend honours `ctx.idempotencyKey`, so the runtime may dedupe and retry. */
  readonly idempotency: "key" | "none";
  readonly retry: { maxAttempts: number; backoffMs: number };
  /** `untrusted`: output can contain text written by third parties (notes, web pages, inbound mail). */
  readonly trust: "trusted" | "untrusted";
  readonly safeExit: boolean;
  readonly endsRun?: "escalated";
  idempotencyKeyFor(runId: string, input: unknown): string;
  costUnits(input: unknown): number;
  execute(input: unknown, ctx: ToolContext): Promise<unknown>;
  simulate?(input: unknown, ctx: ToolContext): Promise<Simulation> | Simulation;
  describe?(input: unknown): string;
}

export interface ToolDefinition<I extends z.ZodType, O extends z.ZodType> {
  name: string;
  description: string;
  sideEffect: SideEffect;
  input: I;
  output: O;
  execute(input: z.output<I>, ctx: ToolContext): Promise<z.input<O>> | z.input<O>;
  /** Default 10 000 ms. */
  timeoutMs?: number;
  /** Declare `key` only if the backend really dedupes on `ctx.idempotencyKey`. Default `none`. */
  idempotency?: "key" | "none";
  /** Custom business key (for example campaign + recipient) instead of a hash of the arguments. */
  idempotencyKey?: (input: z.output<I>) => string;
  /** Total attempts including the first. Values above 1 need a read tool or `idempotency: "key"`. */
  retry?: { maxAttempts: number; backoffMs?: number };
  trust?: "trusted" | "untrusted";
  costUnits?: number | ((input: z.output<I>) => number);
  /** Bypasses policy and approval. Only for tools that end the run (`endsRun`) and are not destructive or external-send. */
  safeExit?: boolean;
  endsRun?: "escalated";
  simulate?(input: z.output<I>, ctx: ToolContext): Promise<Simulation> | Simulation;
  describe?(input: z.output<I>): string;
}

const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export function defineTool<I extends z.ZodType, O extends z.ZodType>(def: ToolDefinition<I, O>): Tool {
  if (!TOOL_NAME.test(def.name)) throw new Error(`invalid tool name: ${JSON.stringify(def.name)}`);
  if (!SIDE_EFFECTS.includes(def.sideEffect)) throw new Error(`${def.name}: unknown side effect`);
  const idempotency = def.idempotency ?? "none";
  const retry = { maxAttempts: def.retry?.maxAttempts ?? 1, backoffMs: def.retry?.backoffMs ?? 0 };
  if (!Number.isInteger(retry.maxAttempts) || retry.maxAttempts < 1) {
    throw new Error(`${def.name}: retry.maxAttempts must be a positive integer`);
  }
  if (retry.maxAttempts > 1 && def.sideEffect !== "read" && idempotency !== "key") {
    throw new Error(
      `${def.name}: retries on a ${def.sideEffect} tool require idempotency: "key" (a retry could repeat the effect)`,
    );
  }
  if (def.idempotencyKey && idempotency !== "key") {
    throw new Error(`${def.name}: idempotencyKey requires idempotency: "key"`);
  }
  if (def.safeExit && !def.endsRun) {
    throw new Error(`${def.name}: a safeExit tool must declare endsRun, because it bypasses policy and exists only to stop the run`);
  }
  if (def.safeExit && (def.sideEffect === "destructive" || def.sideEffect === "external-send")) {
    throw new Error(`${def.name}: safeExit is not allowed on ${def.sideEffect} tools`);
  }
  const timeoutMs = def.timeoutMs ?? 10_000;
  if (!(timeoutMs > 0)) throw new Error(`${def.name}: timeoutMs must be positive`);
  const cost = def.costUnits ?? 0;

  return {
    name: def.name,
    description: def.description,
    sideEffect: def.sideEffect,
    input: def.input,
    output: def.output,
    timeoutMs,
    idempotency,
    retry,
    trust: def.trust ?? "trusted",
    safeExit: def.safeExit ?? false,
    ...(def.endsRun ? { endsRun: def.endsRun } : {}),
    idempotencyKeyFor(runId, input) {
      const custom = def.idempotencyKey?.(input as z.output<I>);
      return custom !== undefined
        ? `ig_${sha256Hex(`${def.name}\n${custom}`).slice(0, 32)}`
        : `ig_${sha256Hex(`${runId}\n${def.name}\n${canonicalJson(input)}`).slice(0, 32)}`;
    },
    costUnits: (input) => (typeof cost === "function" ? cost(input as z.output<I>) : cost),
    execute: async (input, ctx) => def.execute(input as z.output<I>, ctx),
    ...(def.simulate
      ? { simulate: (input: unknown, ctx: ToolContext) => def.simulate!(input as z.output<I>, ctx) }
      : {}),
    ...(def.describe ? { describe: (input: unknown) => def.describe!(input as z.output<I>) } : {}),
  };
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  constructor(tools: Tool[] = []) {
    for (const tool of tools) this.register(tool);
  }

  register(tool: Tool): this {
    if (this.tools.has(tool.name)) throw new Error(`duplicate tool: ${tool.name}`);
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  /** Tool descriptions in the shape a chat-completions API expects. */
  specs(): ToolSpec[] {
    return this.list().map((tool) => ({
      name: tool.name,
      description: `${tool.description} [side effect: ${tool.sideEffect}]`,
      parameters: toJsonSchema(tool.input),
    }));
  }
}

export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  delete json["$schema"];
  return json;
}

export interface ArgumentIssue {
  path: string;
  code: string;
  message: string;
}

export interface ArgumentError {
  code: "invalid_arguments";
  tool: string;
  message: string;
  issues: ArgumentIssue[];
  hint: string;
}

export type ParsedArguments = { ok: true; value: unknown } | { ok: false; error: ArgumentError };

/**
 * Parses and validates model-produced arguments. The error is structured so it can be sent back
 * to the model verbatim; it names the failing fields but never echoes the offending values.
 */
export function parseArguments(tool: Tool, raw: string): ParsedArguments {
  let json: unknown;
  const text = raw.trim() === "" ? "{}" : raw;
  try {
    json = JSON.parse(text);
  } catch {
    return {
      ok: false,
      error: {
        code: "invalid_arguments",
        tool: tool.name,
        message: "Arguments are not valid JSON.",
        issues: [{ path: "", code: "invalid_json", message: "Arguments must be a single JSON object." }],
        hint: `Call ${tool.name} again with a JSON object that matches its parameters.`,
      },
    };
  }
  const parsed = tool.input.safeParse(json);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    error: {
      code: "invalid_arguments",
      tool: tool.name,
      message: `Arguments for ${tool.name} do not match its schema.`,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.map(String).join("."),
        code: issue.code,
        message: issue.message,
      })),
      hint: `Fix the listed fields and call ${tool.name} again.`,
    },
  };
}
