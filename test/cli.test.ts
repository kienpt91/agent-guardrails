import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { FileApprovalGate, approvalIdFor, callDigest, type ApprovalRequest } from "../src/index.js";
import { runExample } from "../examples/marketing-ops/run.js";
import { POLICY_PATH } from "../examples/marketing-ops/agent.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cli-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function cli(...argv: string[]) {
  let out = "";
  let err = "";
  const code = await runCli(argv, { out: (t) => (out += t), err: (t) => (err += t) });
  return { code, out, err };
}

const request = (): ApprovalRequest => ({
  id: approvalIdFor("run_1", "call_1"),
  runId: "run_1",
  toolCallId: "call_1",
  tool: "crm_send_email",
  sideEffect: "external-send",
  digest: callDigest("run_1", "call_1", "crm_send_email", {}),
  args: {},
  summary: "Send an email",
  reasons: ["approve-external-send"],
  context: { environment: "production", tainted: false, suspectedInjection: false },
  requestedAt: 0,
});

describe("trace command", () => {
  it("prints the timeline of a real run's trace file", async () => {
    const example = await runExample({ dir });
    const file = join(dir, "traces", `${example.result.runId}.jsonl`);
    const { code, out } = await cli("trace", file);
    expect(code).toBe(0);
    expect(out).toContain(`run ${example.result.runId}`);
    expect(out).toContain("PAUSED");
    expect(out).toContain("END  status=completed");
  });

  it("prints raw events with --json", async () => {
    const example = await runExample({ dir });
    const { out } = await cli("trace", join(dir, "traces", `${example.result.runId}.jsonl`), "--json");
    expect(JSON.parse(out)[0].type).toBe("run.start");
  });

  it("reports a missing file or a malformed trace", async () => {
    expect((await cli("trace", join(dir, "nope.jsonl"))).code).toBe(1);
    writeFileSync(join(dir, "bad.jsonl"), "garbage\n");
    const bad = await cli("trace", join(dir, "bad.jsonl"));
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("not valid JSON");
    expect((await cli("trace")).code).toBe(2);
  });
});

describe("approvals command", () => {
  it("lists, shows, approves and denies requests", async () => {
    const gate = new FileApprovalGate(dir);
    await gate.request(request());
    await gate.request({ ...request(), id: approvalIdFor("run_1", "call_2"), toolCallId: "call_2" });

    const listed = await cli("approvals", "list", "--dir", dir);
    expect(listed.out).toContain("pending");
    expect(listed.out.trim().split("\n")).toHaveLength(2);

    expect((await cli("approvals", "show", "--dir", dir, request().id)).out).toContain('"tool": "crm_send_email"');

    const approved = await cli("approvals", "approve", "--dir", dir, "--by", "alice", "--reason", "fine", request().id);
    expect(approved).toMatchObject({ code: 0, out: `${request().id} approved by alice\n` });
    expect(await gate.status(request().id)).toMatchObject({ status: "approved", decidedBy: "alice", reason: "fine" });

    const second = approvalIdFor("run_1", "call_2");
    expect((await cli("approvals", "deny", "--dir", dir, "--by", "bob", second)).code).toBe(0);
    expect((await gate.status(second)).status).toBe("denied");
  });

  it("requires --dir, an id and an attributable --by", async () => {
    expect((await cli("approvals", "list")).code).toBe(2);
    expect((await cli("approvals", "approve", "--dir", dir)).code).toBe(2);
    const gate = new FileApprovalGate(dir);
    await gate.request(request());
    const noBy = await cli("approvals", "approve", "--dir", dir, request().id);
    expect(noBy.code).toBe(2);
    expect(noBy.err).toContain("--by");
  });

  it("refuses to change a decision or decide an unknown request", async () => {
    const gate = new FileApprovalGate(dir);
    await gate.request(request());
    await cli("approvals", "deny", "--dir", dir, "--by", "a", request().id);
    const again = await cli("approvals", "approve", "--dir", dir, "--by", "b", request().id);
    expect(again.code).toBe(1);
    expect(again.err).toContain("already denied");
    expect((await cli("approvals", "approve", "--dir", dir, "--by", "b", "apr_unknown")).code).toBe(1);
  });

  it("says so when there is nothing to review", async () => {
    expect((await cli("approvals", "list", "--dir", dir)).out).toBe("no approval requests\n");
  });
});

describe("policy command", () => {
  it("validates a policy file", async () => {
    const ok = await cli("policy", "check", POLICY_PATH);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain("policy ok: 9 rules, default deny");
    writeFileSync(join(dir, "bad.yaml"), "version: 2\n");
    const bad = await cli("policy", "check", join(dir, "bad.yaml"));
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("invalid policy");
  });

  it("explains the decision for a hypothetical call", async () => {
    const denied = JSON.parse((await cli("policy", "explain", POLICY_PATH, "--tool", "cms_delete_page", "--side-effect", "destructive", "--env", "production")).out);
    expect(denied).toMatchObject({ effect: "deny", decidedBy: "deny-destructive-in-production" });
    const staging = JSON.parse((await cli("policy", "explain", POLICY_PATH, "--tool", "cms_delete_page", "--side-effect", "destructive", "--env", "staging")).out);
    expect(staging.effect).toBe("require_approval");
    const bulk = JSON.parse(
      (await cli("policy", "explain", POLICY_PATH, "--tool", "crm_send_email", "--side-effect", "external-send", "--args", JSON.stringify({ to: Array.from({ length: 51 }, (_, i) => `u${i}@x.example`) }))).out,
    );
    expect(bulk.decidedBy).toBe("deny-bulk-send");
    const injected = JSON.parse((await cli("policy", "explain", POLICY_PATH, "--tool", "cms_create_draft", "--side-effect", "write", "--injection")).out);
    expect(injected.decidedBy).toBe("deny-writes-after-injection");
  });

  it("requires --tool and a valid --side-effect for explain", async () => {
    expect((await cli("policy", "explain", POLICY_PATH, "--tool", "x")).code).toBe(2);
    expect((await cli("policy", "explain", POLICY_PATH, "--tool", "x", "--side-effect", "bogus")).code).toBe(2);
  });
});

describe("usage", () => {
  it("prints usage for no command or help, and fails for an unknown one", async () => {
    expect((await cli()).code).toBe(0);
    expect((await cli("help")).err).toContain("agent-guardrails <command>");
    const unknown = await cli("frobnicate");
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain("trace <run.jsonl>");
  });
});
