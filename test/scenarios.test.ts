import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runScenario } from "../src/index.js";
import { FIXTURE_DIR } from "../examples/marketing-ops/eval.js";
import { SCENARIOS } from "../examples/marketing-ops/scenarios.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "scenarios-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("marketing-ops scenario suite", () => {
  it("has at least 15 scenarios with unique names and a committed fixture each", () => {
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(15);
    expect(new Set(SCENARIOS.map((s) => s.name)).size).toBe(SCENARIOS.length);
    const files = readdirSync(FIXTURE_DIR).sort();
    expect(files).toEqual(SCENARIOS.map((s) => `${s.name}.json`).sort());
  });

  it("covers the required behaviours", () => {
    const names = SCENARIOS.map((s) => s.name).join(" ");
    for (const needle of ["injection", "denied", "budget", "invalid-arguments", "flaky", "escalat", "dry-run", "resume", "times-out"]) {
      expect(names).toContain(needle);
    }
  });

  it.each(SCENARIOS.map((s) => [s.name, s] as const))("%s passes against its recorded fixture", async (_name, scenario) => {
    const result = await runScenario(scenario, { fixtureDir: FIXTURE_DIR });
    expect(result.failures).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it("committed fixtures are exactly what the scripts produce (no drift)", async () => {
    for (const scenario of SCENARIOS) {
      await runScenario(scenario, { fixtureDir: dir, mode: "record" });
      const committed = readFileSync(join(FIXTURE_DIR, `${scenario.name}.json`), "utf8");
      expect(readFileSync(join(dir, `${scenario.name}.json`), "utf8"), scenario.name).toBe(committed);
    }
  });
});
