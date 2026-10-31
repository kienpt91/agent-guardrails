import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  Agent,
  FileApprovalGate,
  FileRunStore,
  ManualClock,
  MemoryRunStore,
  ModelError,
  ScriptedModel,
  createEscalationTool,
  type ChatMessage,
  type ModelAdapter,
  type RunResult,
  type TraceEvent,
} from "../src/index.js";
import { ALLOW_READS, call, createBackend, createTestTools, harness, policyOf, turn } from "./helpers.js";

const events = (h: { sink: { events: TraceEvent[] } }, type: TraceEvent["type"]) => h.sink.events.filter((e) => e.type === type);
const toolMessages = (r: RunResult) => r.messages.filter((m): m is Extract<ChatMessage, { role: "tool" }> => m.role === "tool").map((m) => JSON.parse(m.content));

describe("basic loop", () => {
  it("runs tool calls and finishes with the model's final message", async () => {
    const h = harness([turn(call("read_item", { id: "a" })), { content: "All done." }]);
    const result = await h.agent.run({ task: "do it" });
    expect(result.status).toBe("completed");
    expect(result.finalMessage).toBe("All done.");
    expect(h.backend.reads).toEqual(["a"]);
    expect(result.usage).toMatchObject({ steps: 2, toolCalls: 1, spendUnits: 2 });
    expect(toolMessages(result)[0]).toEqual({ ok: true, result: { value: "value-of-a" } });
  });

  it("sends the system prompt, task and tool specs to the model", async () => {
    const h = harness([{ content: "hi" }]);
    await h.agent.run({ task: "the task" });
    const model = h.model as ScriptedModel;
    expect(model.requests[0]!.messages).toEqual([
      { role: "system", content: "You are a test agent." },
      { role: "user", content: "the task" },
    ]);
    expect(model.requests[0]!.tools.map((t) => t.name)).toContain("send_message");
  });

  it("derives the same run id for the same task and refuses to start it twice", async () => {
    const h = harness([{ content: "x" }, { content: "y" }]);
    const first = await h.agent.run({ task: "same" });
    expect(first.runId).toMatch(/^run_[0-9a-f]{12}$/);
    await expect(h.agent.run({ task: "same" })).rejects.toThrow(/already exists/);
    const second = await h.agent.run({ task: "same", salt: "2" });
    expect(second.runId).not.toBe(first.runId);
  });

  it("runs several tool calls from one turn in order", async () => {
    const h = harness([turn(call("read_item", { id: "a" }), call("read_item", { id: "b" })), { content: "ok" }]);
    await h.agent.run({ task: "t" });
    expect(h.backend.reads).toEqual(["a", "b"]);
  });

  it("fails the run when the model throws, and reports why", async () => {
    const failing: ModelAdapter = {
      name: "failing",
      complete: async () => {
        throw new ModelError("HTTP 500");
      },
    };
    const h = harness([], { config: { model: failing } });
    const result = await h.agent.run({ task: "t" });
    expect(result).toMatchObject({ status: "failed", reason: "model_error: HTTP 500" });
  });

  it("fails on an empty model response instead of looping", async () => {
    const h = harness([{ content: null }]);
    expect(await h.agent.run({ task: "t" })).toMatchObject({ status: "failed", reason: "model_error: empty response" });
  });

  it("gives colliding or empty tool call ids unique replacements", async () => {
    const h = harness([
      { toolCalls: [{ id: "dup", name: "read_item", args: { id: "a" } }, { id: "dup", name: "read_item", args: { id: "b" } }, { id: "", name: "read_item", args: { id: "c" } }] },
      { content: "ok" },
    ]);
    const result = await h.agent.run({ task: "t" });
    const ids = result.messages.filter((m) => m.role === "tool").map((m) => (m as { toolCallId: string }).toolCallId);
    expect(new Set(ids).size).toBe(3);
  });
});

describe("argument validation and repair", () => {
  it("returns a structured error to the model and lets it repair the call", async () => {
    const h = harness([turn(call("read_item", { id: 5 })), turn(call("read_item", { id: "a" })), { content: "ok" }]);
    const result = await h.agent.run({ task: "t" });
    expect(result.status).toBe("completed");
    const [first, second] = toolMessages(result);
    expect(first.ok).toBe(false);
    expect(first.error.code).toBe("invalid_arguments");
    expect(first.error.issues[0].path).toBe("id");
    expect(second.ok).toBe(true);
    expect(h.backend.reads).toEqual(["a"]);
  });

  it("stops after more than maxRepairAttempts consecutive invalid calls to the same tool", async () => {
    const bad = turn(call("read_item", { id: 1 }));
    const h = harness([bad, bad, bad, { content: "unreachable" }]);
    const result = await h.agent.run({ task: "t" });
    expect(result).toMatchObject({ status: "failed", reason: "repair_exhausted: read_item" });
    expect(events(h, "tool.invalid_arguments").map((e) => e.data["repairAttempt"])).toEqual([1, 2, 3]);
    expect(h.backend.reads).toEqual([]);
  });

  it("resets the repair counter after a valid call", async () => {
    const bad = turn(call("read_item", { id: 1 }));
    const good = turn(call("read_item", { id: "a" }));
    const h = harness([bad, bad, good, bad, bad, good, { content: "ok" }]);
    expect((await h.agent.run({ task: "t" })).status).toBe("completed");
  });

  it("honours a custom repair limit", async () => {
    const bad = turn(call("read_item", { id: 1 }));
    const h = harness([bad, bad], { config: { maxRepairAttempts: 1 } });
    expect(await h.agent.run({ task: "t" })).toMatchObject({ status: "failed", reason: "repair_exhausted: read_item" });
  });

  it("handles malformed JSON arguments", async () => {
    const h = harness([{ toolCalls: [{ name: "read_item", rawArguments: "{oops" }] }, turn(call("read_item", { id: "a" })), { content: "ok" }]);
    const result = await h.agent.run({ task: "t" });
    expect(toolMessages(result)[0].error.issues[0].code).toBe("invalid_json");
    expect(result.status).toBe("completed");
  });

  it("feeds an unknown tool name back as an error and keeps going", async () => {
    const h = harness([turn(call("does_not_exist")), { content: "ok" }]);
    const result = await h.agent.run({ task: "t" });
    expect(result.status).toBe("completed");
    expect(toolMessages(result)[0]).toMatchObject({ ok: false, error: { code: "unknown_tool" } });
    expect(events(h, "tool.unknown")).toHaveLength(1);
  });

  it("counts invalid and unknown calls against the tool-call budget", async () => {
    const h = harness([turn(call("nope"), call("nope"), call("nope")), { content: "x" }], { policy: policyOf({ rules: [ALLOW_READS], budgets: { maxToolCalls: 2 } }) });
    expect(await h.agent.run({ task: "t" })).toMatchObject({ status: "budget_exceeded", reason: "max_tool_calls" });
  });
});

describe("policy enforcement", () => {
  it("denies by default, never runs the tool and tells the model why", async () => {
    const h = harness([turn(call("wipe", { id: "x" })), { content: "ok" }]);
    const result = await h.agent.run({ task: "t" });
    expect(h.backend.wipes).toEqual([]);
    expect(toolMessages(result)[0]).toMatchObject({ ok: false, error: { code: "policy_denied", rule: "default" } });
    expect(result.usage.denials).toBe(1);
  });

  it("logs a policy decision for every call, including the matched rules", async () => {
    const h = harness([turn(call("read_item", { id: "a" }), call("wipe", { id: "x" })), { content: "ok" }]);
    await h.agent.run({ task: "t" });
    const decisions = events(h, "policy.decision");
    expect(decisions.map((d) => [d.data["tool"], d.data["effect"], d.data["decidedBy"]])).toEqual([
      ["read_item", "allow", "allow-reads"],
      ["wipe", "deny", "default"],
    ]);
  });

  it("evaluates rules against the validated arguments, with defaults applied", async () => {
    const policy = policyOf({
      rules: [{ id: "deny-big", effect: "deny", match: { tool: "send_message" }, when: [{ path: "to", op: "count_gt", value: 1 }] }, ALLOW_READS],
    });
    const h = harness([turn(call("send_message", { to: ["a", "b"], body: "x" })), { content: "ok" }], { policy });
    const result = await h.agent.run({ task: "t" });
    expect(toolMessages(result)[0].error).toMatchObject({ code: "policy_denied", rule: "deny-big" });
  });

  it("stops the run after too many denials", async () => {
    const wipe = turn(call("wipe", { id: "x" }));
    const h = harness([wipe, wipe, wipe, wipe], { policy: policyOf({ rules: [], budgets: { maxDenials: 2 } }) });
    expect(await h.agent.run({ task: "t" })).toMatchObject({ status: "budget_exceeded", reason: "max_denials" });
  });

  it("treats a require_approval rule without an approval gate as a failed run, not a silent allow", async () => {
    const h = harness([turn(call("send_message", { to: ["a"], body: "x" }))], { config: { approvals: undefined as never } });
    const agent = h.make({ approvals: undefined as never });
    const result = await agent.run({ task: "t" });
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("no approval gate");
    expect(h.backend.sends).toEqual([]);
  });

  it("lets a safe-exit tool through even when policy would deny everything", async () => {
    const h = harness([turn(call("escalate_to_human", { reason: "unsure", summary: "please look" }))], {
      policy: policyOf({ rules: [] }),
      config: { tools: [...createTestTools(createBackend()), createEscalationTool()] },
    });
    const result = await h.agent.run({ task: "t" });
    expect(result.status).toBe("escalated");
    expect(result.escalation).toEqual({ reason: "unsure", summary: "please look" });
    expect(events(h, "policy.decision")[0]!.data["decidedBy"]).toBe("safe-exit");
  });
});

describe("approvals", () => {
  it("pauses on a require_approval call, persists the request and runs nothing", async () => {
    const h = harness([turn(call("send_message", { to: ["a@x.example"], body: "hi" })), { content: "done" }]);
    const result = await h.agent.run({ task: "t" });
    expect(result.status).toBe("paused");
    expect(result.pendingApprovals).toHaveLength(1);
    expect(result.pendingApprovals[0]).toMatchObject({ tool: "send_message", sideEffect: "external-send", reasons: ["approve-send"] });
    expect(h.backend.sends).toEqual([]);
    expect(events(h, "run.paused")).toHaveLength(1);
  });

  it("executes once approved and then continues the loop", async () => {
    const h = harness([turn(call("send_message", { to: ["a@x.example"], body: "hi" })), { content: "sent" }]);
    const paused = await h.agent.run({ task: "t" });
    await h.approvals.decide(paused.pendingApprovals[0]!.id, "approved", "alice");
    const done = await h.agent.resume(paused.runId);
    expect(done).toMatchObject({ status: "completed", finalMessage: "sent" });
    expect(h.backend.sends).toHaveLength(1);
    expect(events(h, "approval.resolved")[0]!.data).toMatchObject({ status: "approved", decidedBy: "alice" });
    expect(done.usage.spendUnits).toBe(4); // two model steps + the send's cost of 2
  });

  it("stays paused on resume while nobody has decided", async () => {
    const h = harness([turn(call("send_message", { to: ["a"], body: "hi" })), { content: "sent" }]);
    const paused = await h.agent.run({ task: "t" });
    const again = await h.agent.resume(paused.runId);
    expect(again.status).toBe("paused");
    expect(again.pendingApprovals[0]!.id).toBe(paused.pendingApprovals[0]!.id);
    expect(events(h, "approval.requested")).toHaveLength(1);
  });

  it("reports a denial to the model as an error and does not run the tool", async () => {
    const h = harness([turn(call("send_message", { to: ["a"], body: "hi" })), { content: "not sent" }]);
    const paused = await h.agent.run({ task: "t" });
    await h.approvals.decide(paused.pendingApprovals[0]!.id, "denied", "alice", "wrong audience");
    const done = await h.agent.resume(paused.runId);
    expect(done.status).toBe("completed");
    expect(toolMessages(done)[0]).toMatchObject({ ok: false, error: { code: "approval_denied", reason: "wrong audience" } });
    expect(h.backend.sends).toEqual([]);
    expect(done.usage.denials).toBe(1);
  });

  it("treats an expired approval as a denial", async () => {
    const policy = policyOf({
      rules: [{ id: "approve", effect: "require_approval", match: { sideEffect: "external-send" }, approvalTimeoutMs: 1000 }],
    });
    const h = harness([turn(call("send_message", { to: ["a"], body: "hi" })), { content: "gave up" }], { policy });
    const paused = await h.agent.run({ task: "t" });
    expect(paused.pendingApprovals[0]!.expiresAt).toBeDefined();
    h.clock.advance(1001);
    const done = await h.agent.resume(paused.runId);
    expect(toolMessages(done)[0]).toMatchObject({ ok: false, error: { code: "approval_expired" } });
    expect(events(h, "approval.resolved")[0]!.data["status"]).toBe("expired");
    expect(h.backend.sends).toEqual([]);
  });

  it("never lets an approval for one call authorise another", async () => {
    const h = harness([
      turn(call("send_message", { to: ["a"], body: "one" })),
      turn(call("send_message", { to: ["b"], body: "two" })),
      { content: "done" },
    ]);
    const first = await h.agent.run({ task: "t" });
    await h.approvals.decide(first.pendingApprovals[0]!.id, "approved", "alice");
    const second = await h.agent.resume(first.runId);
    expect(second.status).toBe("paused");
    expect(second.pendingApprovals[0]!.id).not.toBe(first.pendingApprovals[0]!.id);
    expect(h.backend.sends.map((s) => s.to)).toEqual([["a"]]);
  });

  it("shows reviewers redacted arguments and the run's taint state", async () => {
    const h = harness(
      [turn(call("read_untrusted", { id: "a" })), turn(call("send_message", { to: ["a"], body: "x", apiKey: "k-123" })), { content: "x" }],
    );
    const paused = await h.agent.run({ task: "t" });
    expect(paused.pendingApprovals[0]!.context.tainted).toBe(true);
    expect(JSON.stringify(paused.pendingApprovals[0]!.args)).not.toContain("k-123");
  });

  it("re-evaluates policy on resume, so a tightened policy denies a pending call", async () => {
    const h = harness([turn(call("send_message", { to: ["a"], body: "hi" })), { content: "stopped" }]);
    const paused = await h.agent.run({ task: "t" });
    await h.approvals.decide(paused.pendingApprovals[0]!.id, "approved", "alice");
    const stricter = h.make({ policy: policyOf({ rules: [{ id: "freeze", effect: "deny", reason: "change freeze" }] }) });
    const done = await stricter.resume(paused.runId);
    expect(toolMessages(done)[0]).toMatchObject({ ok: false, error: { code: "policy_denied", rule: "freeze" } });
    expect(h.backend.sends).toEqual([]);
  });
});

describe("pause and resume across process restarts", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "resume-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("resumes from disk with entirely new objects", async () => {
    const backend = createBackend();
    const clock = new ManualClock({ tickMs: 1 });
    const script = [turn(call("read_item", { id: "a" })), turn(call("send_message", { to: ["a@x.example"], body: "hi" })), { content: "finished" }];
    const model = new ScriptedModel(script);
    const make = () =>
      new Agent({
        name: "restartable",
        systemPrompt: "p",
        model,
        tools: createTestTools(backend),
        policy: policyOf({ rules: [ALLOW_READS, { id: "approve", effect: "require_approval", match: { sideEffect: "external-send" } }] }),
        approvals: new FileApprovalGate(join(dir, "approvals"), clock),
        store: new FileRunStore(join(dir, "runs")),
        clock,
      });

    const paused = await make().run({ task: "send it" });
    expect(paused.status).toBe("paused");

    // "Restart": nothing from the first agent survives except what is on disk.
    await new FileApprovalGate(join(dir, "approvals"), clock).decide(paused.pendingApprovals[0]!.id, "approved", "ops");
    const done = await make().resume(paused.runId);

    expect(done).toMatchObject({ status: "completed", finalMessage: "finished", runId: paused.runId });
    expect(backend.sends).toHaveLength(1);
    expect(backend.reads).toEqual(["a"]); // the read before the pause was not repeated
    expect(model.turnsUsed).toBe(3);
  });

  it("returns the saved result for a run that already finished, without running anything", async () => {
    const h = harness([{ content: "done" }]);
    const result = await h.agent.run({ task: "t" });
    const eventsBefore = h.sink.events.length;
    expect(await h.agent.resume(result.runId)).toMatchObject({ status: "completed", finalMessage: "done" });
    expect(h.sink.events.length).toBe(eventsBefore);
  });

  it("refuses to resume an unknown run or one that belongs to a different agent", async () => {
    const h = harness([{ content: "done" }]);
    await expect(h.agent.resume("run_missing")).rejects.toThrow(/no saved state/);
    const result = await h.agent.run({ task: "t" });
    await expect(h.make({ name: "someone-else" }).resume(result.runId)).rejects.toThrow(/belongs to agent/);
  });

  it("keeps trace sequence numbers and span ids increasing across the pause", async () => {
    const h = harness([turn(call("send_message", { to: ["a"], body: "hi" })), { content: "ok" }]);
    const paused = await h.agent.run({ task: "t" });
    await h.approvals.decide(paused.pendingApprovals[0]!.id, "approved", "x");
    await h.make().resume(paused.runId);
    const seqs = h.sink.events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    const spans = h.sink.events.filter((e) => e.type === "step.start" || e.type === "tool.call").map((e) => e.spanId);
    expect(new Set(spans).size).toBe(spans.length);
  });

  it("does not count time spent paused against the wall-clock budget", async () => {
    const policy = policyOf({
      rules: [{ id: "approve", effect: "require_approval", match: { sideEffect: "external-send" } }],
      budgets: { maxWallClockMs: 10_000 },
    });
    const h = harness([turn(call("send_message", { to: ["a"], body: "hi" })), { content: "ok" }], { policy });
    const paused = await h.agent.run({ task: "t" });
    h.clock.advance(3_600_000);
    await h.approvals.decide(paused.pendingApprovals[0]!.id, "approved", "x");
    const done = await h.agent.resume(paused.runId);
    expect(done.status).toBe("completed");
    expect(done.usage.elapsedMs).toBeLessThan(1000);
  });
});

describe("budgets", () => {
  it("stops a runaway loop at maxSteps", async () => {
    const loop = turn(call("read_item", { id: "a" }));
    const h = harness([loop, loop, loop, loop], { policy: policyOf({ rules: [ALLOW_READS], budgets: { maxSteps: 3 } }) });
    const result = await h.agent.run({ task: "t" });
    expect(result).toMatchObject({ status: "budget_exceeded", reason: "max_steps" });
    expect(result.usage.steps).toBe(3);
    expect(events(h, "budget.exceeded")).toHaveLength(1);
  });

  it("stops in the middle of a turn at maxToolCalls", async () => {
    const h = harness([turn(...Array.from({ length: 5 }, (_, i) => call("read_item", { id: `r${i}` })))], {
      policy: policyOf({ rules: [ALLOW_READS], budgets: { maxToolCalls: 3 } }),
    });
    const result = await h.agent.run({ task: "t" });
    expect(result).toMatchObject({ status: "budget_exceeded", reason: "max_tool_calls" });
    expect(h.backend.reads).toEqual(["r0", "r1", "r2"]);
  });

  it("refuses a tool whose cost would pass the spend limit and does not ask for approval first", async () => {
    const policy = policyOf({
      rules: [{ id: "approve", effect: "require_approval", match: { sideEffect: "external-send" } }],
      budgets: { maxSpendUnits: 2 },
    });
    const h = harness([turn(call("send_message", { to: ["a"], body: "hi" }))], { policy });
    const result = await h.agent.run({ task: "t" });
    expect(result).toMatchObject({ status: "budget_exceeded", reason: "max_spend_units" });
    expect(events(h, "approval.requested")).toHaveLength(0);
  });

  it("stops when model spend alone passes the limit", async () => {
    const h = harness([{ content: null, toolCalls: [{ name: "read_item", args: { id: "a" } }], costUnits: 50 }], {
      policy: policyOf({ rules: [ALLOW_READS], budgets: { maxSpendUnits: 10 } }),
    });
    expect(await h.agent.run({ task: "t" })).toMatchObject({ status: "budget_exceeded", reason: "max_spend_units" });
    expect(h.backend.reads).toEqual([]);
  });

  it("stops at the wall-clock budget, measured on the injected clock", async () => {
    const h = harness(
      [
        () => {
          h.clock.advance(600);
          return turn(call("read_item", { id: "a" }));
        },
        { content: "unreachable" },
      ],
      { policy: policyOf({ rules: [ALLOW_READS], budgets: { maxWallClockMs: 500 } }) },
    );
    expect(await h.agent.run({ task: "t" })).toMatchObject({ status: "budget_exceeded", reason: "max_wall_clock_ms" });
  });
});

describe("tool execution", () => {
  it("times out a hung read, aborts it and reports a retryable-looking error to the model", async () => {
    const h = harness([turn(call("slow_read")), { content: "ok" }]);
    const result = await h.agent.run({ task: "t" });
    expect(toolMessages(result)[0]).toMatchObject({ ok: false, error: { code: "timeout" } });
  });

  it("warns that a timed-out write may have been applied, and does not retry it", async () => {
    const h = harness([turn(call("slow_write")), { content: "ok" }], {
      policy: policyOf({ rules: [{ id: "w", effect: "allow", match: { tool: "slow_write" } }] }),
    });
    const result = await h.agent.run({ task: "t" });
    const msg = toolMessages(result)[0];
    expect(msg.error.code).toBe("timeout");
    expect(msg.error.message).toContain("may or may not have been applied");
    expect(events(h, "tool.retry")).toHaveLength(0);
  });

  it("retries a retryable failure on a read with backoff and succeeds", async () => {
    const backend = createBackend();
    backend.flakyFailuresLeft = 2;
    const h = harness([turn(call("flaky_read")), { content: "ok" }], { backend });
    const result = await h.agent.run({ task: "t" });
    expect(backend.flakyCalls).toBe(3);
    expect(toolMessages(result)[0]).toEqual({ ok: true, result: { ok: true } });
    expect(events(h, "tool.retry")).toHaveLength(2);
    expect(events(h, "tool.result")[0]!.data["attempts"]).toBe(3);
  });

  it("gives up after maxAttempts and reports the last error", async () => {
    const backend = createBackend();
    backend.flakyFailuresLeft = 10;
    const h = harness([turn(call("flaky_read")), { content: "ok" }], { backend });
    const result = await h.agent.run({ task: "t" });
    expect(backend.flakyCalls).toBe(3);
    expect(toolMessages(result)[0]).toMatchObject({ ok: false, error: { code: "upstream_unavailable" } });
  });

  it("does not retry a non-retryable error", async () => {
    const backend = createBackend();
    const h = harness([turn(call("strict_read")), { content: "ok" }], { backend });
    await h.agent.run({ task: "t" });
    expect(backend.flakyCalls).toBe(1);
  });

  it("reuses one idempotency key across retries, so a retried send lands once", async () => {
    const backend = createBackend();
    backend.flakyFailuresLeft = 1;
    const policy = policyOf({ rules: [{ id: "allow-send", effect: "allow", match: { tool: "send_message" } }] });
    const h = harness([turn(call("send_message", { to: ["a"], body: "hi" })), { content: "ok" }], { backend, policy });
    const result = await h.agent.run({ task: "t" });
    expect(backend.keysSeen).toHaveLength(2);
    expect(new Set(backend.keysSeen).size).toBe(1);
    expect(backend.sends).toHaveLength(1);
    expect(toolMessages(result)[0]).toEqual({ ok: true, result: { sent: 1 } });
  });

  it("answers an identical repeated write from the ledger without running it again", async () => {
    const backend = createBackend();
    const h = harness([turn(call("write_item", { value: "v" })), turn(call("write_item", { value: "v" })), { content: "ok" }], { backend });
    const result = await h.agent.run({ task: "t" });
    expect(backend.keysSeen).toHaveLength(1);
    const [first, second] = toolMessages(result);
    expect(first.deduplicated).toBeUndefined();
    expect(second).toMatchObject({ ok: true, deduplicated: true, result: first.result });
    expect(events(h, "tool.result")[1]!.data["cached"]).toBe(true);
  });

  it("does not dedupe writes with different arguments", async () => {
    const backend = createBackend();
    const h = harness([turn(call("write_item", { value: "1" })), turn(call("write_item", { value: "2" })), { content: "ok" }], { backend });
    await h.agent.run({ task: "t" });
    expect(backend.writes).toHaveLength(2);
  });

  it("evaluates policy for a repeated call before answering it from the ledger", async () => {
    const h = harness([turn(call("write_item", { value: "v" })), turn(call("write_item", { value: "v" })), { content: "ok" }]);
    await h.agent.run({ task: "t" });
    const types = h.sink.events.map((e) => e.type);
    const second = types.lastIndexOf("tool.call");
    expect(types.slice(second, second + 3)).toEqual(["tool.call", "policy.decision", "tool.result"]);
  });

  it("reports output that violates the tool's schema without leaking it", async () => {
    const h = harness([turn(call("bad_output")), { content: "ok" }]);
    const result = await h.agent.run({ task: "t" });
    expect(toolMessages(result)[0]).toMatchObject({ ok: false, error: { code: "invalid_output" } });
    expect(JSON.stringify(toolMessages(result)[0])).not.toContain("many");
  });

  it("turns unexpected exceptions into a generic tool_failed error", async () => {
    const h = harness([turn(call("crashing_read")), { content: "ok" }]);
    const result = await h.agent.run({ task: "t" });
    expect(toolMessages(result)[0]).toMatchObject({ ok: false, error: { code: "tool_failed" } });
  });

  it("truncates oversized tool results before they reach the model", async () => {
    const h = harness([turn(call("big_read")), { content: "ok" }], { config: { maxResultChars: 100 } });
    const result = await h.agent.run({ task: "t" });
    const msg = toolMessages(result)[0];
    expect(msg.truncated).toBe(true);
    expect(JSON.stringify(msg).length).toBeLessThan(300);
  });
});

describe("prompt injection handling", () => {
  it("marks untrusted tool output as untrusted and taints the run", async () => {
    const h = harness([turn(call("read_untrusted", { id: "a" })), { content: "ok" }]);
    const result = await h.agent.run({ task: "t" });
    expect(toolMessages(result)[0]).toMatchObject({ ok: true, untrusted: true });
    const state = await h.store.load(result.runId);
    expect(state!.flags).toEqual({ tainted: true, suspectedInjection: false });
  });

  it("flags an injection phrase in a result, adds a security note and records it in the trace", async () => {
    const h = harness([turn(call("read_poisoned")), { content: "ok" }]);
    const result = await h.agent.run({ task: "t" });
    expect(toolMessages(result)[0].securityNote).toMatch(/third party/);
    expect(events(h, "security.injection_suspected")[0]!.data).toMatchObject({ tool: "read_poisoned" });
  });

  it("lets policy react to the flag: writes are denied after a suspected injection", async () => {
    const policy = policyOf({
      rules: [ALLOW_READS, { id: "allow-write", effect: "allow", match: { tool: "write_item" } }, { id: "no-writes-after-injection", effect: "deny", match: { sideEffect: "write", suspectedInjection: true } }],
    });
    const h = harness([turn(call("read_poisoned")), turn(call("write_item", { value: "x" })), { content: "ok" }], { policy });
    const result = await h.agent.run({ task: "t" });
    expect(toolMessages(result)[1].error).toMatchObject({ code: "policy_denied", rule: "no-writes-after-injection" });
    expect(h.backend.writes).toEqual([]);
  });

  it("can disable the heuristics", async () => {
    const h = harness([turn(call("read_poisoned")), { content: "ok" }], { config: { injectionDetector: false } });
    await h.agent.run({ task: "t" });
    expect(events(h, "security.injection_suspected")).toHaveLength(0);
  });
});

describe("dry run", () => {
  it("executes reads but simulates writes, sends and deletes, and records a plan", async () => {
    const backend = createBackend();
    const policy = policyOf({
      rules: [
        ALLOW_READS,
        { id: "allow-write", effect: "allow", match: { tool: "write_item" } },
        { id: "approve-send", effect: "require_approval", match: { sideEffect: "external-send" } },
        { id: "allow-wipe", effect: "allow", match: { tool: "wipe" } },
      ],
    });
    const h = harness(
      [turn(call("read_item", { id: "a" })), turn(call("write_item", { value: "v" })), turn(call("send_message", { to: ["a"], body: "b" })), turn(call("wipe", { id: "x" })), { content: "planned" }],
      { backend, policy, config: { dryRun: true } },
    );
    const result = await h.agent.run({ task: "t" });
    expect(result.status).toBe("completed");
    expect(backend.reads).toEqual(["a"]);
    expect(backend.writes).toEqual([]);
    expect(backend.sends).toEqual([]);
    expect(backend.wipes).toEqual([]);
    expect(result.plan.map((p) => [p.tool, p.sideEffect, p.wouldRequireApproval])).toEqual([
      ["write_item", "write", false],
      ["send_message", "external-send", true],
      ["wipe", "destructive", false],
    ]);
    expect(result.plan[0]!.diff).toEqual([{ path: "items", before: undefined, after: "v" }]);
    expect(events(h, "approval.requested")).toHaveLength(0);
    expect(events(h, "tool.simulated")).toHaveLength(3);
  });

  it("hands the model a simulated result and tells it that it is simulated", async () => {
    const h = harness([turn(call("write_item", { value: "v" })), { content: "ok" }], { config: { dryRun: true } });
    const result = await h.agent.run({ task: "t" });
    expect(toolMessages(result)[0]).toMatchObject({ ok: true, dryRun: true, simulated: true, result: { id: "item-simulated" } });
  });

  it("still denies what policy denies and does not charge tool cost", async () => {
    const h = harness([turn(call("wipe", { id: "x" })), turn(call("send_message", { to: ["a"], body: "b" })), { content: "ok" }], { config: { dryRun: true } });
    const result = await h.agent.run({ task: "t" });
    expect(toolMessages(result)[0].error.code).toBe("policy_denied");
    expect(result.plan.map((p) => p.tool)).toEqual(["send_message"]);
    expect(result.usage.spendUnits).toBe(3); // model steps only
  });

  it("uses a generic simulation for tools that do not provide one", async () => {
    const h = harness([turn(call("send_message", { to: ["a"], body: "b" })), { content: "ok" }], { config: { dryRun: true } });
    const result = await h.agent.run({ task: "t" });
    expect(toolMessages(result)[0]).toMatchObject({ simulated: true, result: null });
    expect(result.plan[0]!.summary).toContain("no simulation provided");
  });

  it("redacts secret fields in the plan", async () => {
    const h = harness([turn(call("write_item", { value: "v", password: "hunter2" })), { content: "ok" }], { config: { dryRun: true } });
    const result = await h.agent.run({ task: "t" });
    expect(JSON.stringify(result.plan)).not.toContain("hunter2");
  });
});

describe("observability", () => {
  it("emits a span-structured trace for every step, call, decision and result", async () => {
    const h = harness([turn(call("read_item", { id: "a" })), { content: "done" }]);
    const result = await h.agent.run({ task: "t" });
    expect(h.sink.events.map((e) => e.type)).toEqual([
      "run.start",
      "step.start",
      "model.request",
      "model.response",
      "tool.call",
      "policy.decision",
      "tool.result",
      "step.start",
      "model.request",
      "model.response",
      "run.end",
    ]);
    const call1 = h.sink.events.find((e) => e.type === "tool.call")!;
    const step1 = h.sink.events.find((e) => e.type === "step.start")!;
    expect(call1.parentSpanId).toBe(step1.spanId);
    expect(step1.parentSpanId).toBe(h.sink.events[0]!.spanId);
    expect(h.sink.events.every((e) => e.runId === result.runId)).toBe(true);
  });

  it("is deterministic: the same run twice gives byte-identical traces", async () => {
    const run = async () => {
      const h = harness([turn(call("read_item", { id: "a" })), { content: "done" }]);
      await h.agent.run({ task: "t" });
      return JSON.stringify(h.sink.events);
    };
    expect(await run()).toBe(await run());
  });

  it("redacts secret fields in logged arguments and results, and configured patterns anywhere", async () => {
    const h = harness([turn(call("read_item", { id: "tok_abc123", password: "hunter2" })), { content: "done" }], {
      config: { redact: { patterns: ["tok_[a-z0-9]+"] } },
    });
    await h.agent.run({ task: "t" });
    const trace = JSON.stringify(h.sink.events);
    expect(trace).not.toContain("hunter2");
    expect(trace).not.toContain("tok_abc123");
    expect(trace).toContain("[REDACTED]");
  });

  it("logs unparseable arguments by length only, since they cannot be redacted by field", async () => {
    const h = harness([{ toolCalls: [{ name: "read_item", rawArguments: '{"password":"hunter2' }] }, turn(call("read_item", { id: "a" })), { content: "ok" }]);
    await h.agent.run({ task: "t" });
    expect(JSON.stringify(h.sink.events)).not.toContain("hunter2");
  });
});

describe("custom collaborators", () => {
  it("accepts a prebuilt registry and a shared store", async () => {
    const backend = createBackend();
    const store = new MemoryRunStore();
    const h = harness([{ content: "hi" }], { backend, config: { store } });
    const result = await h.agent.run({ task: "t" });
    expect((await store.load(result.runId))!.status).toBe("completed");
    expect((await h.agent.inspect(result.runId))!.status).toBe("completed");
    expect(await h.agent.inspect("run_none")).toBeUndefined();
  });
});
