import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ModelError,
  RecordingModel,
  ReplayModel,
  ScriptedModel,
  approvalRequestedFor,
  approvalResolved,
  attemptedTool,
  calledTool,
  custom,
  defineScenario,
  escalated,
  evaluate,
  finalMessageMatches,
  formatResultsTable,
  injectionFlagged,
  matchesArgs,
  neverCalledTool,
  policyDenied,
  readFixture,
  reasonMatches,
  requestDigest,
  runScenario,
  status,
  stoppedByBudget,
  traceLacks,
  withinBudget,
  writeFixture,
  type RunOutcome,
} from "../src/index.js";
import { ALLOW_READS, call, harness, policyOf, turn } from "./helpers.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eval-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const request = (text: string) => ({ messages: [{ role: "user" as const, content: text }], tools: [] });

describe("record and replay", () => {
  it("records responses with request digests and replays them identically", async () => {
    const recorder = new RecordingModel(new ScriptedModel([{ content: "one" }, { toolCalls: [{ name: "t", args: { a: 1 } }] }]));
    const r1 = await recorder.complete(request("hello"));
    const r2 = await recorder.complete(request("again"));
    const fixture = recorder.toFixture("demo");
    expect(fixture.turns).toHaveLength(2);

    const replay = new ReplayModel(fixture);
    expect(await replay.complete(request("hello"))).toEqual(r1);
    expect(await replay.complete(request("again"))).toEqual(r2);
    expect(replay.turnsRemaining).toBe(0);
  });

  it("round-trips fixtures through a file", async () => {
    const recorder = new RecordingModel(new ScriptedModel([{ content: "one", costUnits: 2 }]));
    await recorder.complete(request("hello"));
    const path = join(dir, "nested", "demo.json");
    writeFixture(path, recorder.toFixture("demo"));
    expect(readFixture(path)).toEqual(recorder.toFixture("demo"));
  });

  it("rejects a fixture file that does not have the expected shape", () => {
    writeFileSync(join(dir, "bad.json"), '{"version":1,"scenario":"x","turns":[{"nope":1}]}');
    expect(() => readFixture(join(dir, "bad.json"))).toThrow();
  });

  it("detects drift: the model is shown something other than what was recorded", async () => {
    const recorder = new RecordingModel(new ScriptedModel([{ content: "one" }]));
    await recorder.complete(request("hello"));
    const replay = new ReplayModel(recorder.toFixture("demo"));
    await expect(replay.complete(request("something else"))).rejects.toThrow(/drifted at turn 1/);
  });

  it("can skip request verification", async () => {
    const recorder = new RecordingModel(new ScriptedModel([{ content: "one" }]));
    await recorder.complete(request("hello"));
    const replay = new ReplayModel(recorder.toFixture("demo"), { verifyRequests: false });
    expect((await replay.complete(request("anything"))).content).toBe("one");
  });

  it("fails when the agent asks for more turns than were recorded", async () => {
    const replay = new ReplayModel({ version: 1, scenario: "demo", turns: [] });
    await expect(replay.complete(request("x"))).rejects.toBeInstanceOf(ModelError);
  });

  it("digests depend on messages and tool names, not on key order", () => {
    const a = requestDigest({ messages: [{ role: "user", content: "x" }], tools: [{ name: "t", description: "d", parameters: {} }] });
    const b = requestDigest({ messages: [{ content: "x", role: "user" } as never], tools: [{ name: "t", description: "other", parameters: { type: "object" } }] });
    expect(a).toBe(b);
    expect(requestDigest(request("y"))).not.toBe(requestDigest(request("x")));
  });
});

describe("assertion helpers", () => {
  async function outcome(): Promise<RunOutcome> {
    const h = harness(
      [
        turn(call("read_item", { id: "a" })),
        turn(call("wipe", { id: "x" })),
        turn(call("send_message", { to: ["a@x.example", "b@x.example"], body: "hi" })),
        { content: "finished" },
      ],
      { policy: policyOf({ rules: [ALLOW_READS, { id: "approve-send", effect: "require_approval", match: { sideEffect: "external-send" } }], budgets: { maxSteps: 10 } }) },
    );
    let result = await h.agent.run({ task: "t" });
    await h.approvals.decide(result.pendingApprovals[0]!.id, "approved", "x");
    result = await h.agent.resume(result.runId);
    return { result, events: h.sink.events };
  }
  const passes = (o: RunOutcome, a: ReturnType<typeof status>) => a.check(o) === undefined;

  it("status and reasonMatches", async () => {
    const o = await outcome();
    expect(passes(o, status("completed"))).toBe(true);
    expect(status("failed").check(o)).toMatch(/expected status failed, got completed/);
    expect(reasonMatches(/x/).check(o)).toMatch(/reason was ""/);
  });

  it("calledTool checks execution, argument matchers and counts", async () => {
    const o = await outcome();
    expect(passes(o, calledTool("read_item"))).toBe(true);
    expect(passes(o, calledTool("read_item", { args: { id: "a" }, times: 1 }))).toBe(true);
    expect(calledTool("read_item", { args: { id: "zzz" } }).check(o)).toMatch(/never executed with matching/);
    expect(calledTool("read_item", { times: 2 }).check(o)).toMatch(/executed 1x, expected 2x/);
    expect(calledTool("wipe").check(o)).toMatch(/never executed/); // denied by policy, so it did not run
    expect(passes(o, calledTool("send_message", { args: { to: (v: unknown) => Array.isArray(v) && v.length === 2 } }))).toBe(true);
  });

  it("neverCalledTool is satisfied by a blocked call and failed by an executed one", async () => {
    const o = await outcome();
    expect(passes(o, neverCalledTool("wipe"))).toBe(true);
    expect(neverCalledTool("read_item").check(o)).toMatch(/executed 1x/);
  });

  it("attemptedTool sees calls that policy blocked", async () => {
    const o = await outcome();
    expect(passes(o, attemptedTool("wipe", { args: { id: "x" } }))).toBe(true);
    expect(attemptedTool("nope").check(o)).toMatch(/never requested/);
  });

  it("policyDenied, approvalRequestedFor and approvalResolved", async () => {
    const o = await outcome();
    expect(passes(o, policyDenied("wipe", "default"))).toBe(true);
    expect(policyDenied("wipe", "other-rule").check(o)).toMatch(/no policy deny/);
    expect(passes(o, approvalRequestedFor("send_message"))).toBe(true);
    expect(approvalRequestedFor("read_item").check(o)).toMatch(/no approval/);
    expect(passes(o, approvalResolved("send_message", "approved"))).toBe(true);
    expect(approvalResolved("send_message", "denied").check(o)).toMatch(/was not denied/);
  });

  it("withinBudget reports each limit it checks", async () => {
    const o = await outcome();
    expect(withinBudget({ maxSteps: 10, maxToolCalls: 10, maxSpendUnits: 100, maxWallClockMs: 10_000 }).check(o)).toBeUndefined();
    expect(withinBudget({ maxSteps: 2 }).check(o)).toMatch(/steps 4 > 2/);
    expect(withinBudget({ maxToolCalls: 1 }).check(o)).toMatch(/tool calls/);
    expect(withinBudget({ maxSpendUnits: 1 }).check(o)).toMatch(/spend/);
  });

  it("escalated, stoppedByBudget, injectionFlagged, finalMessageMatches and traceLacks", async () => {
    const o = await outcome();
    expect(escalated().check(o)).toMatch(/not escalated/);
    expect(stoppedByBudget("max_steps").check(o)).toMatch(/status completed/);
    expect(injectionFlagged().check(o)).toMatch(/no injection/);
    expect(passes(o, finalMessageMatches(/finish/))).toBe(true);
    expect(finalMessageMatches(/nope/).check(o)).toMatch(/final message was "finished"/);
    expect(traceLacks("never-appears").check(o)).toBeUndefined();
    expect(traceLacks("read_item").check(o)).toMatch(/found in trace/);
  });

  it("custom accepts booleans and failure strings, and evaluate collects every result", async () => {
    const o = await outcome();
    const results = evaluate(o, [custom("ok", () => true), custom("bad", () => false), custom("msg", () => "because")]);
    expect(results).toEqual([{ description: "ok" }, { description: "bad", failure: "custom check failed" }, { description: "msg", failure: "because" }]);
  });
});

describe("matchesArgs", () => {
  it("matches subsets of objects, regexes, predicates and exact arrays", () => {
    expect(matchesArgs({ a: 1, b: { c: 2, d: 3 } }, { b: { c: 2 } })).toBe(true);
    expect(matchesArgs({ a: 1 }, { a: 2 })).toBe(false);
    expect(matchesArgs({ s: "hello" }, { s: /^he/ })).toBe(true);
    expect(matchesArgs({ s: 5 }, { s: /5/ })).toBe(false);
    expect(matchesArgs({ n: 5 }, { n: (v: unknown) => (v as number) > 3 })).toBe(true);
    expect(matchesArgs({ l: [1, 2] }, { l: [1, 2] })).toBe(true);
    expect(matchesArgs({ l: [1, 2] }, { l: [1] })).toBe(false);
    expect(matchesArgs(undefined, { a: 1 })).toBe(false);
  });
});

describe("runScenario", () => {
  const scenario = defineScenario({
    name: "tiny",
    category: "test",
    description: "one read then done",
    script: [turn(call("read_item", { id: "a" })), { content: "done" }],
    build({ model, sink }) {
      const h = harness([], { config: { model, trace: sink } });
      return { run: () => h.agent.run({ task: "t" }), assertions: [status("completed"), calledTool("read_item")] };
    },
  });

  it("records a fixture and then replays it", async () => {
    const recorded = await runScenario(scenario, { fixtureDir: dir, mode: "record" });
    expect(recorded.passed).toBe(true);
    expect(readdirSync(dir)).toEqual(["tiny.json"]);
    const replayed = await runScenario(scenario, { fixtureDir: dir });
    expect(replayed).toMatchObject({ passed: true, status: "completed", steps: 2, toolCalls: 1, unusedTurns: 0 });
    expect(replayed.checks).toHaveLength(2);
  });

  it("fails a scenario whose assertion does not hold and reports why", async () => {
    await runScenario(scenario, { fixtureDir: dir, mode: "record" });
    const failing = defineScenario({ ...scenario, build: async (h) => ({ ...(await scenario.build(h)), assertions: [status("failed")] }) });
    const result = await runScenario(failing, { fixtureDir: dir });
    expect(result.passed).toBe(false);
    expect(result.failures[0]).toContain("expected status failed, got completed");
  });

  it("fails when the fixture has turns the run never used", async () => {
    await runScenario(scenario, { fixtureDir: dir, mode: "record" });
    const fixture = readFixture(join(dir, "tiny.json"));
    writeFixture(join(dir, "tiny.json"), { ...fixture, turns: [...fixture.turns, fixture.turns[1]!] });
    const result = await runScenario(scenario, { fixtureDir: dir });
    expect(result.passed).toBe(false);
    expect(result.failures).toContain("fixture has 1 unused model turn(s)");
  });

  it("calls cleanup even when the run throws", async () => {
    let cleaned = false;
    const broken = defineScenario({
      ...scenario,
      build: () => ({
        run: async () => {
          throw new Error("boom");
        },
        assertions: [],
        cleanup: () => {
          cleaned = true;
        },
      }),
    });
    await runScenario(scenario, { fixtureDir: dir, mode: "record" });
    await expect(runScenario(broken, { fixtureDir: dir })).rejects.toThrow("boom");
    expect(cleaned).toBe(true);
  });

  it("formats a results table with a pass count", async () => {
    await runScenario(scenario, { fixtureDir: dir, mode: "record" });
    const table = formatResultsTable([await runScenario(scenario, { fixtureDir: dir })]);
    expect(table).toContain("| tiny");
    expect(table).toContain("1/1 scenarios passed");
  });
});
