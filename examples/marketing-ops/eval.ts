import { dirname, join } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { formatResultsTable, runScenario, sanitizeText, type ScenarioResult } from "../../src/index.js";
import { SCENARIOS } from "./scenarios.js";

export const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

export async function runAll(mode: "replay" | "record" = "replay"): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = [];
  for (const scenario of SCENARIOS) results.push(await runScenario(scenario, { fixtureDir: FIXTURE_DIR, mode }));
  return results;
}

async function main(): Promise<void> {
  const mode = process.argv.includes("--record") ? "record" : "replay";
  const results = await runAll(mode);
  console.log(formatResultsTable(results));
  for (const r of results.filter((x) => !x.passed)) {
    console.error(`\n${r.name} failed:`);
    for (const f of r.failures) console.error(`  - ${sanitizeText(f)}`);
  }
  if (mode === "record") console.log(`\nFixtures written to ${FIXTURE_DIR}`);
  if (results.some((r) => !r.passed)) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? "")).href) {
  await main();
}
