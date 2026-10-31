import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ApprovalError,
  FileApprovalGate,
  HttpCallbackApprovalGate,
  InMemoryApprovalGate,
  ManualClock,
  SIGNATURE_HEADER,
  approvalIdFor,
  createCallbackServer,
  effectiveStatus,
  sign,
  type ApprovalRequest,
  type ApprovalStore,
} from "../src/index.js";

const SECRET = "0123456789abcdef-test-secret";

function request(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: approvalIdFor("run_1", "call_1"),
    runId: "run_1",
    toolCallId: "call_1",
    tool: "send_message",
    sideEffect: "external-send",
    args: { to: ["a@x.example"] },
    summary: "Send a message",
    reasons: ["approve-send"],
    context: { environment: "production", tainted: false, suspectedInjection: false },
    requestedAt: 1000,
    ...overrides,
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "approvals-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("approvalIdFor", () => {
  it("is deterministic and distinct per call", () => {
    expect(approvalIdFor("run_1", "call_1")).toBe(approvalIdFor("run_1", "call_1"));
    expect(approvalIdFor("run_1", "call_1")).not.toBe(approvalIdFor("run_1", "call_2"));
    expect(approvalIdFor("run_1", "call_1")).not.toBe(approvalIdFor("run_2", "call_1"));
    expect(approvalIdFor("run_1", "call_1")).toMatch(/^apr_[0-9a-f]{16}$/);
  });
});

describe("effectiveStatus", () => {
  it("turns a pending request past its expiry into expired", () => {
    const req = request({ expiresAt: 2000 });
    expect(effectiveStatus(req, { status: "pending" }, 1999).status).toBe("pending");
    expect(effectiveStatus(req, { status: "pending" }, 2000).status).toBe("expired");
  });

  it("never overrides a recorded decision", () => {
    const req = request({ expiresAt: 2000 });
    expect(effectiveStatus(req, { status: "approved", decidedBy: "x" }, 9999).status).toBe("approved");
  });

  it("never expires a request without a timeout", () => {
    expect(effectiveStatus(request(), { status: "pending" }, 1e12).status).toBe("pending");
  });
});

const stores: [string, () => ApprovalStore][] = [
  ["in-memory", () => new InMemoryApprovalGate(new ManualClock({ start: 1500 }))],
  ["file", () => new FileApprovalGate(join(dir, "approvals"), new ManualClock({ start: 1500 }))],
];

describe.each(stores)("%s approval store", (_name, make) => {
  it("starts pending and records an approval with who decided it", async () => {
    const store = make();
    await store.request(request());
    expect(await store.status(request().id)).toEqual({ status: "pending" });
    const decision = await store.decide(request().id, "approved", "reviewer", "looks fine");
    expect(decision).toMatchObject({ status: "approved", decidedBy: "reviewer", reason: "looks fine", decidedAt: 1500 });
    expect(await store.status(request().id)).toMatchObject({ status: "approved" });
  });

  it("records a denial", async () => {
    const store = make();
    await store.request(request());
    expect((await store.decide(request().id, "denied", "reviewer")).status).toBe("denied");
  });

  it("refuses a second decision, so a denial cannot be flipped", async () => {
    const store = make();
    await store.request(request());
    await store.decide(request().id, "denied", "a");
    await expect(store.decide(request().id, "approved", "b")).rejects.toMatchObject({ code: "already_decided" });
    expect((await store.status(request().id)).status).toBe("denied");
  });

  it("refuses a decision after the request expired", async () => {
    const store = make();
    await store.request(request({ expiresAt: 1400 }));
    await expect(store.decide(request().id, "approved", "late")).rejects.toMatchObject({ code: "expired" });
  });

  it("requires an attributable decider", async () => {
    const store = make();
    await store.request(request());
    await expect(store.decide(request().id, "approved", "  ")).rejects.toBeInstanceOf(ApprovalError);
  });

  it("reports unknown ids", async () => {
    const store = make();
    await expect(store.status("apr_missing")).rejects.toMatchObject({ code: "not_found" });
    await expect(store.decide("apr_missing", "approved", "x")).rejects.toMatchObject({ code: "not_found" });
  });

  it("re-requesting the same id does not reset a decision", async () => {
    const store = make();
    await store.request(request());
    await store.decide(request().id, "approved", "x");
    await store.request(request());
    expect((await store.status(request().id)).status).toBe("approved");
  });

  it("lists requests with their decisions", async () => {
    const store = make();
    await store.request(request());
    const listed = await store.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.decision.status).toBe("pending");
  });
});

describe("FileApprovalGate persistence", () => {
  it("keeps requests and decisions across instances, as after a process restart", async () => {
    const first = new FileApprovalGate(join(dir, "a"));
    await first.request(request());
    const second = new FileApprovalGate(join(dir, "a"));
    expect((await second.status(request().id)).status).toBe("pending");
    await second.decide(request().id, "approved", "ops");
    const third = new FileApprovalGate(join(dir, "a"));
    expect(await third.status(request().id)).toMatchObject({ status: "approved", decidedBy: "ops" });
  });

  it("writes owner-only files", async () => {
    const gate = new FileApprovalGate(join(dir, "a"));
    await gate.request(request());
    const { statSync } = await import("node:fs");
    expect(statSync(join(dir, "a", `${request().id}.json`)).mode & 0o077).toBe(0);
  });

  it("rejects ids that could escape the directory", async () => {
    const gate = new FileApprovalGate(join(dir, "a"));
    await expect(gate.status("../../etc/passwd")).rejects.toThrow(/invalid approval id/);
    await expect(gate.decide("a/b", "approved", "x")).rejects.toThrow(/invalid approval id/);
  });

  it("rejects a tampered file that is not a valid record", async () => {
    const gate = new FileApprovalGate(join(dir, "a"));
    await gate.request(request());
    writeFileSync(join(dir, "a", `${request().id}.json`), '{"request":{"id":"x"},"decision":{"status":"hacked"}}');
    await expect(gate.status(request().id)).rejects.toThrow();
  });
});

describe("HttpCallbackApprovalGate", () => {
  function setup(fetchImpl?: typeof fetch) {
    const store = new FileApprovalGate(join(dir, "http"), new ManualClock({ start: 1500 }));
    const calls: { url: string; init: RequestInit }[] = [];
    const fakeFetch: typeof fetch =
      fetchImpl ??
      (async (url, init) => {
        calls.push({ url: String(url), init: init! });
        return new Response("ok", { status: 202 });
      });
    const gate = new HttpCallbackApprovalGate({
      store,
      notifyUrl: "https://hooks.example/approvals",
      secret: SECRET,
      callbackBaseUrl: "https://agent.example/",
      fetch: fakeFetch,
    });
    return { store, gate, calls };
  }

  it("persists the request and POSTs a signed notification with a callback URL", async () => {
    const { store, gate, calls } = setup();
    const outcome = await gate.request(request());
    expect(outcome).toMatchObject({ notified: true });
    expect(calls).toHaveLength(1);
    const body = String(calls[0]!.init.body);
    expect((calls[0]!.init.headers as Record<string, string>)[SIGNATURE_HEADER]).toBe(sign(SECRET, body));
    expect(JSON.parse(body)).toMatchObject({
      type: "approval.requested",
      request: { id: request().id },
      callbackUrl: `https://agent.example/approvals/${request().id}`,
    });
    expect((await store.status(request().id)).status).toBe("pending");
  });

  it("keeps the request pending when the notification endpoint fails", async () => {
    const down = setup(async () => new Response("no", { status: 500 }));
    expect(await down.gate.request(request())).toMatchObject({ notified: false });
    expect((await down.gate.status(request().id)).status).toBe("pending");
    const broken = setup(async () => {
      throw new Error("ECONNREFUSED");
    });
    const outcome = await broken.gate.request(request());
    expect(outcome).toMatchObject({ notified: false });
    expect(outcome.detail).toContain("ECONNREFUSED");
  });

  it("rejects a short secret", () => {
    expect(() => new HttpCallbackApprovalGate({ store: new InMemoryApprovalGate(), notifyUrl: "https://x", secret: "short" })).toThrow(/16 characters/);
  });

  it("records a decision from a correctly signed callback", async () => {
    const { gate } = setup();
    await gate.request(request());
    const body = JSON.stringify({ decision: "approved", decidedBy: "alice@corp.example", reason: "ok" });
    const res = await gate.handleCallback(request().id, body, sign(SECRET, `${request().id}.${body}`));
    expect(res).toEqual({ status: 200, body: { id: request().id, status: "approved" } });
    expect(await gate.status(request().id)).toMatchObject({ status: "approved", decidedBy: "alice@corp.example" });
  });

  it("rejects missing, wrong or cross-request signatures without changing state", async () => {
    const { gate } = setup();
    await gate.request(request());
    const body = JSON.stringify({ decision: "approved", decidedBy: "mallory" });
    expect((await gate.handleCallback(request().id, body, undefined)).status).toBe(401);
    expect((await gate.handleCallback(request().id, body, "sha256=00")).status).toBe(401);
    expect((await gate.handleCallback(request().id, body, sign("another-secret-value-1234", `${request().id}.${body}`))).status).toBe(401);
    expect((await gate.handleCallback(request().id, body, sign(SECRET, `apr_other.${body}`))).status).toBe(401);
    expect((await gate.status(request().id)).status).toBe("pending");
  });

  it("rejects malformed bodies", async () => {
    const { gate } = setup();
    await gate.request(request());
    const send = (body: string) => gate.handleCallback(request().id, body, sign(SECRET, `${request().id}.${body}`));
    expect((await send("not json")).status).toBe(400);
    expect((await send(JSON.stringify({ decision: "maybe", decidedBy: "x" }))).status).toBe(400);
    expect((await send(JSON.stringify({ decision: "approved" }))).status).toBe(400);
  });

  it("answers 404 for unknown ids and 409 for repeated decisions", async () => {
    const { gate } = setup();
    await gate.request(request());
    const body = JSON.stringify({ decision: "denied", decidedBy: "bob" });
    const sig = (id: string) => sign(SECRET, `${id}.${body}`);
    expect((await gate.handleCallback("apr_unknown", body, sig("apr_unknown"))).status).toBe(404);
    expect((await gate.handleCallback(request().id, body, sig(request().id))).status).toBe(200);
    expect((await gate.handleCallback(request().id, body, sig(request().id))).status).toBe(409);
  });

  it("round-trips over a real loopback HTTP server", async () => {
    const { gate } = setup();
    await gate.request(request());
    const server = createCallbackServer(gate);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const url = `http://127.0.0.1:${port}/approvals/${request().id}`;
      const body = JSON.stringify({ decision: "approved", decidedBy: "carol" });
      const bad = await fetch(url, { method: "POST", body, headers: { [SIGNATURE_HEADER]: "sha256=bad" } });
      expect(bad.status).toBe(401);
      const ok = await fetch(url, { method: "POST", body, headers: { [SIGNATURE_HEADER]: sign(SECRET, `${request().id}.${body}`) } });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ id: request().id, status: "approved" });
      expect((await fetch(`http://127.0.0.1:${port}/other`, { method: "POST", body })).status).toBe(404);
      expect((await fetch(url, { method: "GET" })).status).toBe(404);
      const huge = await fetch(url, { method: "POST", body: "x".repeat(20_000), headers: { [SIGNATURE_HEADER]: "sha256=bad" } });
      expect(huge.status).toBe(413);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(readFileSync(join(dir, "http", `${request().id}.json`), "utf8")).toContain("carol");
  });
});
