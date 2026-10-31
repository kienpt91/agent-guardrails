import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { ApprovalRequest } from "./approvals.js";
import type { DiffEntry } from "./diff.js";
import type { ChatMessage, RunStatus, SideEffect, ToolCallRequest } from "./types.js";
import { assertSafeId, sha256Hex } from "./util.js";

export interface PlanEntry {
  step: number;
  tool: string;
  sideEffect: SideEffect;
  args: unknown;
  summary: string;
  diff: DiffEntry[];
  policy: { effect: "allow" | "deny" | "require_approval"; decidedBy: string };
  /** True when a real run would stop for human approval before this call. */
  wouldRequireApproval: boolean;
}

export interface LedgerEntry {
  tool: string;
  /** The tool's validated output, exactly as it was returned to the model. */
  result: unknown;
}

export interface Awaiting {
  callId: string;
  tool: string;
  args: unknown;
  idempotencyKey: string;
  spanId: string;
  approval: ApprovalRequest;
}

export interface RunState {
  version: 1;
  runId: string;
  agent: string;
  task: string;
  environment: string;
  dryRun: boolean;
  status: RunStatus;
  reason?: string;
  messages: ChatMessage[];
  /** Tool calls from the latest model turn that have not produced a result yet. */
  pending: ToolCallRequest[];
  awaiting?: Awaiting;
  usage: { steps: number; toolCalls: number; spendUnits: number; denials: number; elapsedMs: number };
  ledger: Record<string, LedgerEntry>;
  /** Consecutive invalid-argument responses per tool. */
  repair: Record<string, number>;
  flags: { tainted: boolean; suspectedInjection: boolean };
  counters: { seq: number; spans: number };
  spans: { run: string; step?: string };
  plan: PlanEntry[];
  escalation?: { reason: string; summary: string };
  finalMessage?: string;
}

/** Deterministic run id from the agent name, the task text and an optional salt. */
export function deriveRunId(agent: string, task: string, salt = ""): string {
  return `run_${sha256Hex(`${agent}\n${task}\n${salt}`).slice(0, 12)}`;
}

export interface RunStore {
  load(runId: string): Promise<RunState | undefined>;
  save(state: RunState): Promise<void>;
}

export class MemoryRunStore implements RunStore {
  private readonly states = new Map<string, string>();
  async load(runId: string): Promise<RunState | undefined> {
    const raw = this.states.get(runId);
    return raw === undefined ? undefined : (JSON.parse(raw) as RunState);
  }
  async save(state: RunState): Promise<void> {
    this.states.set(state.runId, JSON.stringify(state));
  }
}

const MessageSchema = z.union([
  z.object({ role: z.literal("system"), content: z.string() }),
  z.object({ role: z.literal("user"), content: z.string() }),
  z.object({
    role: z.literal("assistant"),
    content: z.string().nullable(),
    toolCalls: z.array(z.object({ id: z.string(), name: z.string(), arguments: z.string() })).optional(),
  }),
  z.object({ role: z.literal("tool"), toolCallId: z.string(), name: z.string(), content: z.string() }),
]);

const StateSchema = z.object({
  version: z.literal(1),
  runId: z.string(),
  agent: z.string(),
  task: z.string(),
  environment: z.string(),
  dryRun: z.boolean(),
  status: z.enum(["running", "paused", "completed", "escalated", "budget_exceeded", "failed"]),
  reason: z.string().optional(),
  messages: z.array(MessageSchema),
  pending: z.array(z.object({ id: z.string(), name: z.string(), arguments: z.string() })),
  awaiting: z.custom<Awaiting>((v) => typeof v === "object" && v !== null).optional(),
  usage: z.object({
    steps: z.number(),
    toolCalls: z.number(),
    spendUnits: z.number(),
    denials: z.number(),
    elapsedMs: z.number(),
  }),
  ledger: z.record(z.string(), z.object({ tool: z.string(), result: z.unknown() })),
  repair: z.record(z.string(), z.number()),
  flags: z.object({ tainted: z.boolean(), suspectedInjection: z.boolean() }),
  counters: z.object({ seq: z.number(), spans: z.number() }),
  spans: z.object({ run: z.string(), step: z.string().optional() }),
  plan: z.array(z.custom<PlanEntry>((v) => typeof v === "object" && v !== null)),
  escalation: z.object({ reason: z.string(), summary: z.string() }).optional(),
  finalMessage: z.string().optional(),
});

/**
 * One JSON file per run. The checkpoint holds the full conversation, including tool results,
 * unredacted (it has to, to resume), so keep the directory private.
 */
export class FileRunStore implements RunStore {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private pathFor(runId: string): string {
    assertSafeId("run", runId);
    return join(this.dir, `${runId}.json`);
  }

  async load(runId: string): Promise<RunState | undefined> {
    let text: string;
    try {
      text = readFileSync(this.pathFor(runId), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
    const parsed = StateSchema.safeParse(JSON.parse(text));
    if (!parsed.success) throw new Error(`run state ${runId} is corrupt: ${parsed.error.issues[0]?.message ?? "invalid"}`);
    if (parsed.data.runId !== runId) throw new Error(`run state ${runId} belongs to a different run`);
    return parsed.data as RunState;
  }

  async save(state: RunState): Promise<void> {
    const file = this.pathFor(state.runId);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, file);
  }
}
