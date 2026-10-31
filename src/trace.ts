import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Clock } from "./clock.js";
import { Redactor } from "./redact.js";
import { assertSafeId, isRecord } from "./util.js";

export const TRACE_EVENT_TYPES = [
  "run.start",
  "run.resume",
  "run.paused",
  "run.end",
  "step.start",
  "model.request",
  "model.response",
  "tool.call",
  "tool.invalid_arguments",
  "tool.unknown",
  "policy.decision",
  "security.injection_suspected",
  "approval.requested",
  "approval.notify",
  "approval.resolved",
  "tool.retry",
  "tool.result",
  "tool.simulated",
  "budget.exceeded",
] as const;
export type TraceEventType = (typeof TRACE_EVENT_TYPES)[number];

export interface TraceEvent {
  v: 1;
  runId: string;
  /** Position in the run; strictly increasing across pauses and resumes. */
  seq: number;
  /** Milliseconds since the epoch, from the run's clock. */
  ts: number;
  spanId: string;
  parentSpanId?: string;
  type: TraceEventType;
  data: Record<string, unknown>;
}

export interface TraceSink {
  write(event: TraceEvent): void;
}

export class MemoryTraceSink implements TraceSink {
  readonly events: TraceEvent[] = [];
  write(event: TraceEvent): void {
    this.events.push(event);
  }
}

/** Appends one JSON object per line to `<dir>/<runId>.jsonl`. */
export class FileTraceSink implements TraceSink {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  pathFor(runId: string): string {
    assertSafeId("run", runId);
    return join(this.dir, `${runId}.jsonl`);
  }

  write(event: TraceEvent): void {
    const file = this.pathFor(event.runId);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
  }
}

export class MultiTraceSink implements TraceSink {
  constructor(private readonly sinks: TraceSink[]) {}
  write(event: TraceEvent): void {
    for (const sink of this.sinks) sink.write(event);
  }
}

export interface TraceCounters {
  seq: number;
  spans: number;
}

/** Creates spans and events for one run. Ids derive from counters stored in the run state, so they are deterministic. */
export class Tracer {
  constructor(
    private readonly runId: string,
    private readonly sink: TraceSink,
    private readonly clock: Clock,
    private readonly redactor: Redactor,
    private readonly counters: TraceCounters,
  ) {}

  startSpan(): string {
    this.counters.spans += 1;
    return `${this.runId}.${this.counters.spans}`;
  }

  emit(type: TraceEventType, spanId: string, parentSpanId: string | undefined, data: Record<string, unknown>): void {
    this.counters.seq += 1;
    this.sink.write({
      v: 1,
      runId: this.runId,
      seq: this.counters.seq,
      ts: this.clock.now(),
      spanId,
      ...(parentSpanId ? { parentSpanId } : {}),
      type,
      data: this.redactor.redact(data),
    });
  }
}

export function parseTraceLines(text: string): TraceEvent[] {
  const events: TraceEvent[] = [];
  text.split("\n").forEach((line, index) => {
    if (line.trim() === "") return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`trace line ${index + 1} is not valid JSON`);
    }
    if (!isRecord(value) || value["v"] !== 1 || typeof value["type"] !== "string" || typeof value["seq"] !== "number") {
      throw new Error(`trace line ${index + 1} is not a trace event`);
    }
    events.push(value as unknown as TraceEvent);
  });
  return events.sort((a, b) => a.seq - b.seq);
}

export function readTraceFile(path: string): TraceEvent[] {
  return parseTraceLines(readFileSync(path, "utf8"));
}

const str = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));

function describe(event: TraceEvent): string {
  const d = event.data;
  switch (event.type) {
    case "run.start":
      return `run ${event.runId}  agent=${str(d["agent"])}  env=${str(d["environment"])}  dry_run=${str(d["dryRun"])}`;
    case "run.resume":
      return `resumed  (status was ${str(d["previousStatus"])})`;
    case "run.paused":
      return `PAUSED  waiting for approval ${str(d["approvalId"])}`;
    case "run.end":
      return `END  status=${str(d["status"])}${d["reason"] ? `  reason=${str(d["reason"])}` : ""}  steps=${str(d["steps"])} tool_calls=${str(d["toolCalls"])} spend=${str(d["spendUnits"])}`;
    case "step.start":
      return `step ${str(d["step"])}`;
    case "model.request":
      return `model request  messages=${str(d["messages"])} tools=${str(d["tools"])}`;
    case "model.response": {
      const calls = Array.isArray(d["toolCalls"]) ? (d["toolCalls"] as string[]) : [];
      const text = d["contentPreview"] ? `  text=${JSON.stringify(d["contentPreview"])}` : "";
      return `model response  tool_calls=[${calls.join(", ")}]  cost=${str(d["costUnits"])}${text}`;
    }
    case "tool.call":
      return `call ${str(d["tool"])} [${str(d["sideEffect"])}]  args=${str(d["args"])}`;
    case "tool.invalid_arguments":
      return `invalid arguments for ${str(d["tool"])}  repair_attempt=${str(d["repairAttempt"])}  issues=${str(d["issues"])}`;
    case "tool.unknown":
      return `unknown tool ${str(d["tool"])}`;
    case "policy.decision":
      return `policy ${str(d["effect"]).toUpperCase()}  by=${str(d["decidedBy"])}${d["resumed"] ? "  (re-evaluated on resume)" : ""}  ${str(d["reason"])}`;
    case "security.injection_suspected":
      return `SECURITY possible prompt injection in result of ${str(d["tool"])}  matched=${str(d["patterns"])}`;
    case "approval.requested":
      return `approval requested  id=${str(d["approvalId"])}${d["timeoutMs"] ? `  times_out_in=${str(d["timeoutMs"])}ms` : ""}`;
    case "approval.notify":
      return `approval notify  ${str(d["detail"])}`;
    case "approval.resolved":
      return `approval ${str(d["status"]).toUpperCase()}  id=${str(d["approvalId"])}${d["decidedBy"] ? `  by=${str(d["decidedBy"])}` : ""}${d["reason"] ? `  reason=${str(d["reason"])}` : ""}`;
    case "tool.retry":
      return `retry  attempt=${str(d["attempt"])} after ${str(d["errorCode"])}  key=${str(d["idempotencyKey"])}`;
    case "tool.simulated":
      return `SIMULATED  ${str(d["summary"])}`;
    case "tool.result": {
      const base = d["ok"] ? "ok" : `error ${str(d["errorCode"])}`;
      const extras = [
        d["cached"] ? "cached" : "",
        d["attempts"] && d["attempts"] !== 1 ? `attempts=${str(d["attempts"])}` : "",
        d["cost"] ? `cost=${str(d["cost"])}` : "",
        d["executed"] === false && !d["cached"] ? "not executed" : "",
      ].filter(Boolean);
      const preview = d["preview"] ? `  ${str(d["preview"])}` : "";
      return `${str(d["tool"])} -> ${base}${extras.length ? `  (${extras.join(", ")})` : ""}${preview}`;
    }
    case "budget.exceeded":
      return `BUDGET exceeded  ${str(d["message"])}`;
  }
}

function depth(event: TraceEvent, parents: Map<string, string | undefined>): number {
  let level = 0;
  let current = event.parentSpanId;
  while (current) {
    level += 1;
    current = parents.get(current);
  }
  return level;
}

/** Plain-text timeline of a run: one line per event, indented by span depth, with offsets from the first event. */
export function renderTimeline(events: TraceEvent[]): string {
  if (events.length === 0) return "(empty trace)";
  const parents = new Map<string, string | undefined>();
  for (const e of events) if (!parents.has(e.spanId)) parents.set(e.spanId, e.parentSpanId);
  const t0 = events[0]!.ts;
  const lines = events.map((e) => {
    const offset = `+${e.ts - t0}ms`.padEnd(8);
    const indent = "  ".repeat(depth(e, parents));
    return `${offset} ${indent}${describe(e)}`;
  });
  return lines.join("\n");
}
