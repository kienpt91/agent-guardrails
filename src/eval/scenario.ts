import { join } from "node:path";
import type { RunResult } from "../agent.js";
import { MemoryTraceSink } from "../trace.js";
import type { ModelAdapter } from "../types.js";
import { ScriptedModel, type ScriptedTurn } from "../models/scripted.js";
import { evaluate, type Assertion, type RunOutcome } from "./assertions.js";
import { ReplayModel, RecordingModel, readFixture, writeFixture } from "./fixtures.js";

export interface ScenarioHarness {
  model: ModelAdapter;
  sink: MemoryTraceSink;
}

export interface BuiltScenario {
  /** Runs the agent to its final result, including any pause/resume the scenario wants to exercise. */
  run(): Promise<RunResult>;
  assertions: Assertion[];
  /** Called after the run, e.g. to close servers or remove temp dirs. */
  cleanup?(): Promise<void> | void;
}

export interface Scenario {
  name: string;
  description: string;
  /** Short label for the kind of behaviour under test; shown in the results table. */
  category: string;
  /** What the scripted model says, in order. Used only when recording; replay reads the fixture. */
  script: ScriptedTurn[];
  build(harness: ScenarioHarness): Promise<BuiltScenario> | BuiltScenario;
}

export const defineScenario = (scenario: Scenario): Scenario => scenario;

export interface ScenarioResult {
  name: string;
  category: string;
  description: string;
  passed: boolean;
  status: RunResult["status"];
  reason?: string;
  steps: number;
  toolCalls: number;
  spendUnits: number;
  checks: { description: string; failure?: string }[];
  failures: string[];
  /** Model turns recorded but never consumed during replay (should be 0). */
  unusedTurns: number;
}

export interface RunScenarioOptions {
  fixtureDir: string;
  /** `replay` (default) reads the committed fixture; `record` regenerates it from the scenario's script. */
  mode?: "replay" | "record";
}

export function fixturePath(dir: string, scenario: Scenario): string {
  return join(dir, `${scenario.name}.json`);
}

export async function runScenario(scenario: Scenario, options: RunScenarioOptions): Promise<ScenarioResult> {
  const mode = options.mode ?? "replay";
  const file = fixturePath(options.fixtureDir, scenario);
  const sink = new MemoryTraceSink();
  let model: ModelAdapter;
  let recorder: RecordingModel | undefined;
  let replay: ReplayModel | undefined;
  if (mode === "record") {
    recorder = new RecordingModel(new ScriptedModel(scenario.script));
    model = recorder;
  } else {
    replay = new ReplayModel(readFixture(file));
    model = replay;
  }

  const built = await scenario.build({ model, sink });
  try {
    const result = await built.run();
    if (recorder) writeFixture(file, recorder.toFixture(scenario.name));
    const outcome: RunOutcome = { result, events: sink.events };
    const checks = evaluate(outcome, built.assertions);
    const failures = checks.filter((c) => c.failure !== undefined).map((c) => `${c.description}: ${c.failure}`);
    const unusedTurns = replay?.turnsRemaining ?? 0;
    if (unusedTurns > 0) failures.push(`fixture has ${unusedTurns} unused model turn(s)`);
    return {
      name: scenario.name,
      category: scenario.category,
      description: scenario.description,
      passed: failures.length === 0,
      status: result.status,
      ...(result.reason ? { reason: result.reason } : {}),
      steps: result.usage.steps,
      toolCalls: result.usage.toolCalls,
      spendUnits: result.usage.spendUnits,
      checks,
      failures,
      unusedTurns,
    };
  } finally {
    await built.cleanup?.();
  }
}

export function formatResultsTable(results: ScenarioResult[]): string {
  const rows = results.map((r) => [
    r.name,
    r.category,
    r.reason && (r.status === "budget_exceeded" || r.status === "failed") ? `${r.status} (${r.reason})` : r.status,
    String(r.steps),
    String(r.toolCalls),
    String(r.spendUnits),
    `${r.checks.filter((c) => !c.failure).length}/${r.checks.length}`,
    r.passed ? "pass" : "FAIL",
  ]);
  const header = ["scenario", "category", "final status", "steps", "tool calls", "spend", "checks", "result"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i]!.length)));
  const line = (cells: string[]) => `| ${cells.map((c, i) => c.padEnd(widths[i]!)).join(" | ")} |`;
  const sep = `| ${widths.map((w) => "-".repeat(w)).join(" | ")} |`;
  const passed = results.filter((r) => r.passed).length;
  return [line(header), sep, ...rows.map(line), "", `${passed}/${results.length} scenarios passed`].join("\n");
}

