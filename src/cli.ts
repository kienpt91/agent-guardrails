#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { ApprovalError, FileApprovalGate, type ApprovalStore } from "./approvals.js";
import { PolicyEngine, loadPolicyFile } from "./policy.js";
import { readTraceFile, renderTimeline } from "./trace.js";
import { SIDE_EFFECTS, type SideEffect } from "./types.js";
import { errorMessage } from "./util.js";

export interface CliIo {
  out(text: string): void;
  err(text: string): void;
}

const USAGE = `agent-guardrails <command>

  trace <run.jsonl> [--json]                          print a run timeline from a trace file
  approvals list    --dir <dir>                       list approval requests and their status
  approvals show    --dir <dir> <id>                  show one request in full
  approvals approve --dir <dir> --by <name> [--reason <text>] <id>
  approvals deny    --dir <dir> --by <name> [--reason <text>] <id>
  policy check <policy.(json|yaml)>                   validate a policy file
  policy explain <policy.(json|yaml)> --tool <name> --side-effect <class>
        [--args <json>] [--env <name>] [--tainted] [--injection]
                                                      show the decision for a hypothetical call
`;

function describeRequest(entry: Awaited<ReturnType<ApprovalStore["list"]>>[number]): string {
  const { request, decision } = entry;
  return `${request.id}  ${decision.status.padEnd(8)}  ${request.tool}  run=${request.runId}  ${request.summary}`;
}

async function approvals(argv: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { dir: { type: "string" }, by: { type: "string" }, reason: { type: "string" } },
  });
  const [action, id] = positionals;
  if (!values.dir) {
    io.err("approvals: --dir is required\n");
    return 2;
  }
  const store = new FileApprovalGate(values.dir);
  try {
    if (action === "list") {
      const entries = await store.list();
      io.out(entries.length === 0 ? "no approval requests\n" : `${entries.map(describeRequest).join("\n")}\n`);
      return 0;
    }
    if (!id) {
      io.err(`approvals ${action ?? ""}: an approval id is required\n`);
      return 2;
    }
    if (action === "show") {
      const entry = (await store.list()).find((e) => e.request.id === id);
      if (!entry) throw new ApprovalError("not_found", `unknown approval ${id}`);
      io.out(`${JSON.stringify(entry, null, 2)}\n`);
      return 0;
    }
    if (action === "approve" || action === "deny") {
      if (!values.by) {
        io.err(`approvals ${action}: --by <name> is required so the decision is attributable\n`);
        return 2;
      }
      const decision = await store.decide(id, action === "approve" ? "approved" : "denied", values.by, values.reason);
      io.out(`${id} ${decision.status} by ${values.by}\n`);
      return 0;
    }
  } catch (err) {
    if (err instanceof ApprovalError) {
      io.err(`${err.message}\n`);
      return 1;
    }
    throw err;
  }
  io.err(USAGE);
  return 2;
}

function policy(argv: string[], io: CliIo): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      tool: { type: "string" },
      "side-effect": { type: "string" },
      args: { type: "string" },
      env: { type: "string" },
      tainted: { type: "boolean", default: false },
      injection: { type: "boolean", default: false },
    },
  });
  const [action, file] = positionals;
  if ((action !== "check" && action !== "explain") || !file) {
    io.err(USAGE);
    return 2;
  }
  const loaded = loadPolicyFile(file);
  const engine = new PolicyEngine(loaded);
  if (action === "check") {
    io.out(`policy ok: ${loaded.rules.length} rules, default ${loaded.default}, budgets ${JSON.stringify(loaded.budgets)}\n`);
    return 0;
  }
  const sideEffect = values["side-effect"];
  if (!values.tool || !sideEffect || !SIDE_EFFECTS.includes(sideEffect as SideEffect)) {
    io.err(`policy explain: --tool and --side-effect (${SIDE_EFFECTS.join(" | ")}) are required\n`);
    return 2;
  }
  const decision = engine.evaluate({
    tool: values.tool,
    sideEffect: sideEffect as SideEffect,
    args: values.args ? JSON.parse(values.args) : {},
    environment: values.env ?? "development",
    tainted: values.tainted || values.injection,
    suspectedInjection: values.injection,
  });
  io.out(`${JSON.stringify(decision, null, 2)}\n`);
  return 0;
}

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "trace": {
        const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { json: { type: "boolean", default: false } } });
        const file = positionals[0];
        if (!file) {
          io.err(USAGE);
          return 2;
        }
        const events = readTraceFile(file);
        io.out(values.json ? `${JSON.stringify(events, null, 2)}\n` : `${renderTimeline(events)}\n`);
        return 0;
      }
      case "approvals":
        return await approvals(rest, io);
      case "policy":
        return policy(rest, io);
      default:
        io.err(USAGE);
        return command === undefined || command === "help" || command === "--help" ? 0 : 2;
    }
  } catch (err) {
    io.err(`error: ${errorMessage(err)}\n`);
    return 1;
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(realpathSync(entry)).href) {
  process.exitCode = await runCli(process.argv.slice(2), {
    out: (t) => process.stdout.write(t),
    err: (t) => process.stderr.write(t),
  });
}
