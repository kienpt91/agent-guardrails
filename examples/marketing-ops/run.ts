import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  FileTraceSink,
  ScriptedModel,
  readTraceFile,
  renderPlan,
  renderTimeline,
  runWithReviewer,
  type RunResult,
  type ScriptStep,
} from "../../src/index.js";
import { createMarketingEnv } from "./agent.js";

export const EXAMPLE_TASK =
  "Draft a short launch page for the Spring Outdoor Sale, publish it, then email the Northwind Outfitters contact to tell them about it.";

/** What a model would say for this task, as plain data. The example runs offline, so no real model is involved. */
export const EXAMPLE_SCRIPT: ScriptStep[] = [
  { toolCalls: [{ name: "crm_search_accounts", args: { query: "Northwind" } }] },
  { toolCalls: [{ name: "crm_get_account", args: { accountId: "acct_1001" } }] },
  {
    toolCalls: [
      {
        name: "cms_create_draft",
        args: {
          title: "Spring Outdoor Sale",
          body: "Twenty percent off tents, packs and trail shoes until the end of April.",
        },
      },
    ],
  },
  // Reads the page id out of the previous tool result, as a model would. In a dry run that id is a placeholder.
  (request) => {
    const last = request.messages[request.messages.length - 1];
    const body = last?.role === "tool" ? (JSON.parse(last.content) as { result?: { id?: string } }) : {};
    return { toolCalls: [{ name: "cms_publish_page", args: { pageId: body.result?.id ?? "page_unknown" } }] };
  },
  {
    toolCalls: [
      {
        name: "crm_send_email",
        args: {
          to: ["ana@northwind.example"],
          subject: "Spring Outdoor Sale is live",
          body: "Hi Ana, our Spring Outdoor Sale page is live at https://cms.example/spring-outdoor-sale.",
        },
      },
    ],
  },
  { content: "The Spring Outdoor Sale page is published and Ana Reyes at Northwind Outfitters has been emailed." },
];

export interface ExampleOutput {
  result: RunResult;
  reviewerLog: string[];
  timeline: string;
  plan: string;
  emailsSent: number;
  pages: string[];
  /** Directory holding run state, approvals and the JSONL trace. */
  dir: string;
}

export async function runExample(options: { dryRun?: boolean; dir: string }): Promise<ExampleOutput> {
  const traces = new FileTraceSink(join(options.dir, "traces"));
  const model = new ScriptedModel(EXAMPLE_SCRIPT);
  const env = createMarketingEnv({
    model,
    dryRun: options.dryRun ?? false,
    persistDir: options.dir,
    sink: traces,
  });
  const reviewerLog: string[] = [];
  const result = await runWithReviewer({
    makeAgent: () => env.makeAgent(),
    approvals: env.approvals,
    clock: env.clock,
    task: EXAMPLE_TASK,
    decide: () => "approve",
    onPause: (req) => reviewerLog.push(`[reviewer] approving ${req.id}: ${req.summary}`),
  });
  return {
    result,
    reviewerLog,
    timeline: renderTimeline(readTraceFile(traces.pathFor(result.runId))),
    plan: renderPlan(result.plan),
    emailsSent: env.crm.sent.length,
    pages: [...env.cms.pages.values()].map((p) => `${p.id}=${p.status}`),
    dir: options.dir,
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "dry-run": { type: "boolean", default: false },
      out: { type: "string" },
    },
  });
  const dryRun = values["dry-run"] ?? false;
  const dir = values.out ?? mkdtempSync(join(tmpdir(), "agent-guardrails-example-"));
  const out = await runExample({ dryRun, dir });
  for (const line of out.reviewerLog) console.log(line);
  const { result } = out;
  console.log(`\nStatus: ${result.status}${result.reason ? ` (${result.reason})` : ""}`);
  if (result.finalMessage) console.log(`Final message: ${result.finalMessage}`);
  console.log(`\n${out.timeline}`);
  if (dryRun) console.log(`\n${out.plan}`);
  console.log(`\nCRM emails sent: ${out.emailsSent}; CMS pages: ${out.pages.join(", ") || "none"}`);
  if (values.out) console.log(`State and trace written to ${dir}`);
  else rmSync(dir, { recursive: true, force: true });
}

if (import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? "")).href) {
  await main();
}
