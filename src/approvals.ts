import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { join } from "node:path";
import { z } from "zod";
import { systemClock, type Clock } from "./clock.js";
import type { SideEffect } from "./types.js";
import { assertSafeId, errorMessage, isRecord, sha256Hex } from "./util.js";

export interface ApprovalRequest {
  id: string;
  runId: string;
  toolCallId: string;
  tool: string;
  sideEffect: SideEffect;
  /** Arguments as shown to the reviewer (secret fields redacted). */
  args: unknown;
  summary: string;
  /** Rule ids and reasons that required approval. */
  reasons: string[];
  context: { environment: string; tainted: boolean; suspectedInjection: boolean };
  requestedAt: number;
  expiresAt?: number;
}

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";

export interface ApprovalDecision {
  status: ApprovalStatus;
  decidedBy?: string;
  reason?: string;
  decidedAt?: number;
}

export interface RequestOutcome {
  /** Whether a human was actively told about the request (webhook delivered, etc.). */
  notified: boolean;
  detail?: string;
}

/**
 * Where approval requests go and where decisions come from. The run never blocks on a gate:
 * `request` is called once per pending call, `status` is polled when the run starts or resumes.
 */
export interface ApprovalGate {
  request(request: ApprovalRequest): Promise<RequestOutcome | void>;
  status(id: string): Promise<ApprovalDecision>;
}

export interface ApprovalStore extends ApprovalGate {
  decide(id: string, decision: "approved" | "denied", decidedBy: string, reason?: string): Promise<ApprovalDecision>;
  list(): Promise<{ request: ApprovalRequest; decision: ApprovalDecision }[]>;
}

export class ApprovalError extends Error {
  constructor(
    readonly code: "not_found" | "already_decided" | "expired" | "invalid",
    message: string,
  ) {
    super(message);
    this.name = "ApprovalError";
  }
}

/** Deterministic: the same run and tool call always map to the same approval id. */
export function approvalIdFor(runId: string, toolCallId: string): string {
  return `apr_${sha256Hex(`${runId}\n${toolCallId}`).slice(0, 16)}`;
}

/** Applies expiry: a still-pending request past `expiresAt` counts as expired. */
export function effectiveStatus(request: ApprovalRequest, decision: ApprovalDecision, now: number): ApprovalDecision {
  if (decision.status === "pending" && request.expiresAt !== undefined && now >= request.expiresAt) {
    return { status: "expired", reason: "no decision before the approval timeout" };
  }
  return decision;
}

interface Entry {
  request: ApprovalRequest;
  decision: ApprovalDecision;
}

function applyDecision(
  entry: Entry,
  decision: "approved" | "denied",
  decidedBy: string,
  reason: string | undefined,
  now: number,
): ApprovalDecision {
  if (entry.decision.status !== "pending") {
    throw new ApprovalError("already_decided", `approval ${entry.request.id} is already ${entry.decision.status}`);
  }
  if (entry.request.expiresAt !== undefined && now >= entry.request.expiresAt) {
    throw new ApprovalError("expired", `approval ${entry.request.id} expired before a decision was recorded`);
  }
  if (decidedBy.trim() === "") throw new ApprovalError("invalid", "decidedBy is required");
  entry.decision = { status: decision, decidedBy, ...(reason ? { reason } : {}), decidedAt: now };
  return entry.decision;
}

export class InMemoryApprovalGate implements ApprovalStore {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly clock: Clock = systemClock) {}

  async request(request: ApprovalRequest): Promise<RequestOutcome> {
    if (!this.entries.has(request.id)) this.entries.set(request.id, { request, decision: { status: "pending" } });
    return { notified: false, detail: "held in memory" };
  }

  async status(id: string): Promise<ApprovalDecision> {
    const entry = this.entries.get(id);
    if (!entry) throw new ApprovalError("not_found", `unknown approval ${id}`);
    return entry.decision;
  }

  async decide(id: string, decision: "approved" | "denied", decidedBy: string, reason?: string): Promise<ApprovalDecision> {
    const entry = this.entries.get(id);
    if (!entry) throw new ApprovalError("not_found", `unknown approval ${id}`);
    return applyDecision(entry, decision, decidedBy, reason, this.clock.now());
  }

  async list(): Promise<Entry[]> {
    return [...this.entries.values()];
  }
}

const EntrySchema = z.object({
  request: z.custom<ApprovalRequest>((v) => isRecord(v) && typeof v["id"] === "string"),
  decision: z.object({
    status: z.enum(["pending", "approved", "denied", "expired"]),
    decidedBy: z.string().optional(),
    reason: z.string().optional(),
    decidedAt: z.number().optional(),
  }),
});

/**
 * One JSON file per request under `dir`. Because the files outlive the process, a run can pause,
 * the process can exit, and a reviewer can decide from another process (see the `approvals` CLI).
 */
export class FileApprovalGate implements ApprovalStore {
  constructor(
    private readonly dir: string,
    private readonly clock: Clock = systemClock,
  ) {
    mkdirSync(dir, { recursive: true });
  }

  private pathFor(id: string): string {
    assertSafeId("approval", id);
    return join(this.dir, `${id}.json`);
  }

  private read(id: string): Entry {
    const file = this.pathFor(id);
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      throw new ApprovalError("not_found", `unknown approval ${id}`);
    }
    return EntrySchema.parse(JSON.parse(text)) as Entry;
  }

  private write(entry: Entry): void {
    const file = this.pathFor(entry.request.id);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(entry, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, file);
  }

  async request(request: ApprovalRequest): Promise<RequestOutcome> {
    try {
      this.read(request.id);
    } catch (err) {
      if (!(err instanceof ApprovalError)) throw err;
      this.write({ request, decision: { status: "pending" } });
    }
    return { notified: false, detail: "written to the file approval store" };
  }

  async status(id: string): Promise<ApprovalDecision> {
    return this.read(id).decision;
  }

  async decide(id: string, decision: "approved" | "denied", decidedBy: string, reason?: string): Promise<ApprovalDecision> {
    const entry = this.read(id);
    const result = applyDecision(entry, decision, decidedBy, reason, this.clock.now());
    this.write(entry);
    return result;
  }

  async list(): Promise<Entry[]> {
    const files = readdirSync(this.dir).filter((f) => f.endsWith(".json")).sort();
    return files.map((f) => this.read(f.slice(0, -".json".length)));
  }
}

export interface HttpCallbackOptions {
  /** Durable store that holds requests and decisions. */
  store: ApprovalStore;
  /** Where approval requests are POSTed (for example a small service that posts to chat). */
  notifyUrl: string;
  /** Shared secret used to sign outgoing notifications and to verify incoming decisions. */
  secret: string;
  fetch?: typeof fetch;
  /** Included in the notification so the receiver knows where to send the decision. */
  callbackBaseUrl?: string;
}

export const SIGNATURE_HEADER = "x-guardrails-signature";

export function sign(secret: string, payload: string): string {
  return `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
}

function signaturesMatch(expected: string, received: string): boolean {
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(received).digest();
  return timingSafeEqual(a, b);
}

const DecisionBody = z.object({
  decision: z.enum(["approved", "denied"]),
  decidedBy: z.string().min(1).max(200),
  reason: z.string().max(1000).optional(),
});

export interface CallbackResponse {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Approvals decided over HTTP. `request` persists the request and POSTs a signed notification;
 * the reviewer's system answers by POSTing a signed decision to `handleCallback` (or the server
 * from `createCallbackServer`). The decision is stored, so the run can be resumed in any process.
 */
export class HttpCallbackApprovalGate implements ApprovalGate {
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: HttpCallbackOptions) {
    if (options.secret.length < 16) throw new Error("approval callback secret must be at least 16 characters");
    this.fetchFn = options.fetch ?? fetch;
  }

  async request(request: ApprovalRequest): Promise<RequestOutcome> {
    await this.options.store.request(request);
    const body = JSON.stringify({
      type: "approval.requested",
      request,
      ...(this.options.callbackBaseUrl
        ? { callbackUrl: `${this.options.callbackBaseUrl.replace(/\/$/, "")}/approvals/${request.id}` }
        : {}),
    });
    try {
      const res = await this.fetchFn(this.options.notifyUrl, {
        method: "POST",
        headers: { "content-type": "application/json", [SIGNATURE_HEADER]: sign(this.options.secret, body) },
        body,
      });
      if (!res.ok) return { notified: false, detail: `notify endpoint answered HTTP ${res.status}; request is still pending` };
      return { notified: true, detail: `notified (HTTP ${res.status})` };
    } catch (err) {
      return { notified: false, detail: `notify failed: ${errorMessage(err)}; request is still pending` };
    }
  }

  status(id: string): Promise<ApprovalDecision> {
    return this.options.store.status(id);
  }

  /** Verifies the signature over `${id}.${rawBody}` and records the decision. */
  async handleCallback(id: string, rawBody: string, signature: string | undefined): Promise<CallbackResponse> {
    if (!signature || !signaturesMatch(sign(this.options.secret, `${id}.${rawBody}`), signature)) {
      return { status: 401, body: { error: "invalid signature" } };
    }
    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      return { status: 400, body: { error: "body is not valid JSON" } };
    }
    const parsed = DecisionBody.safeParse(json);
    if (!parsed.success) return { status: 400, body: { error: "body must be {decision, decidedBy, reason?}" } };
    try {
      const decision = await this.options.store.decide(id, parsed.data.decision, parsed.data.decidedBy, parsed.data.reason);
      return { status: 200, body: { id, status: decision.status } };
    } catch (err) {
      if (err instanceof ApprovalError) {
        const status = err.code === "not_found" ? 404 : err.code === "invalid" ? 400 : 409;
        return { status, body: { error: err.message } };
      }
      throw err;
    }
  }
}

const MAX_CALLBACK_BODY = 16 * 1024;

async function readBody(req: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_CALLBACK_BODY) return undefined;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Minimal HTTP server: `POST /approvals/<id>` with a signed JSON decision. The caller decides where to listen. */
export function createCallbackServer(gate: HttpCallbackApprovalGate): Server {
  return createServer(async (req, res) => {
    const send = (status: number, body: Record<string, unknown>) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    try {
      const match = /^\/approvals\/([A-Za-z0-9_-]+)$/.exec(req.url ?? "");
      if (req.method !== "POST" || !match) return send(404, { error: "not found" });
      const raw = await readBody(req);
      if (raw === undefined) return send(413, { error: "body too large" });
      const header = req.headers[SIGNATURE_HEADER];
      const result = await gate.handleCallback(match[1]!, raw, Array.isArray(header) ? header[0] : header);
      return send(result.status, result.body);
    } catch {
      return send(500, { error: "internal error" });
    }
  });
}
