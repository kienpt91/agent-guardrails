import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { join } from "node:path";
import { z } from "zod";
import { systemClock, type Clock } from "./clock.js";
import { SIDE_EFFECTS, type SideEffect } from "./types.js";
import { LockError, acquireFileLock } from "./lock.js";
import { assertSafeId, canonicalJson, errorMessage, sha256Hex } from "./util.js";

export interface ApprovalRequest {
  id: string;
  runId: string;
  toolCallId: string;
  tool: string;
  sideEffect: SideEffect;
  /** `callDigest` of the run, call, tool and the exact (unredacted) arguments this approval is for. */
  digest: string;
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
  /** Digest stored in the request record this decision belongs to. The runner compares it with the call it is about to execute. */
  requestDigest: string;
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
  /** When `digest` is given it must equal the stored request's digest, or the decision is rejected. */
  decide(id: string, decision: "approved" | "denied", decidedBy: string, reason?: string, digest?: string): Promise<ApprovalDecision>;
  list(): Promise<ApprovalListing[]>;
}

export class ApprovalError extends Error {
  constructor(
    readonly code: "not_found" | "already_decided" | "expired" | "invalid" | "digest_mismatch" | "busy",
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

/**
 * Digest of exactly what an approval authorises: run, call id, tool and the canonical JSON of the
 * unredacted arguments. An approval record whose digest differs from the call about to run is not valid for it.
 */
export function callDigest(runId: string, toolCallId: string, tool: string, args: unknown): string {
  return sha256Hex(canonicalJson({ runId, toolCallId, tool, args }));
}

/** Applies expiry: a still-pending request past `expiresAt` counts as expired. */
export function effectiveStatus(request: ApprovalRequest, decision: ApprovalDecision, now: number): ApprovalDecision {
  if (decision.status === "pending" && request.expiresAt !== undefined && now >= request.expiresAt) {
    return { status: "expired", requestDigest: decision.requestDigest, reason: "no decision before the approval timeout" };
  }
  return decision;
}

type StoredDecision = Omit<ApprovalDecision, "requestDigest">;

interface Entry {
  request: ApprovalRequest;
  decision: StoredDecision;
}

export interface ApprovalListing {
  request: ApprovalRequest;
  decision: ApprovalDecision;
}

const view = (entry: Entry): ApprovalDecision => ({ ...entry.decision, requestDigest: entry.request.digest });

function applyDecision(
  entry: Entry,
  decision: "approved" | "denied",
  decidedBy: string,
  reason: string | undefined,
  now: number,
  digest: string | undefined,
): ApprovalDecision {
  if (digest !== undefined && digest !== entry.request.digest) {
    throw new ApprovalError("digest_mismatch", `approval ${entry.request.id} was issued for a different call than the one this decision names`);
  }
  if (entry.decision.status !== "pending") {
    throw new ApprovalError("already_decided", `approval ${entry.request.id} is already ${entry.decision.status}`);
  }
  if (entry.request.expiresAt !== undefined && now >= entry.request.expiresAt) {
    throw new ApprovalError("expired", `approval ${entry.request.id} expired before a decision was recorded`);
  }
  if (decidedBy.trim() === "") throw new ApprovalError("invalid", "decidedBy is required");
  entry.decision = { status: decision, decidedBy, ...(reason ? { reason } : {}), decidedAt: now };
  return view(entry);
}

/** What `request()` reports when a record for the same id already exists. */
function reuseOrReplace(existing: Entry | undefined, request: ApprovalRequest): { entry: Entry; detail: string } {
  if (!existing) return { entry: { request, decision: { status: "pending" } }, detail: "recorded" };
  if (existing.request.digest === request.digest) return { entry: existing, detail: "record already exists for this exact call" };
  return {
    entry: { request, decision: { status: "pending" } },
    detail: "replaced a stale record that was issued for a different call; its decision was discarded",
  };
}

export class InMemoryApprovalGate implements ApprovalStore {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly clock: Clock = systemClock) {}

  async request(request: ApprovalRequest): Promise<RequestOutcome> {
    const { entry, detail } = reuseOrReplace(this.entries.get(request.id), request);
    this.entries.set(request.id, entry);
    return { notified: false, detail: `held in memory; ${detail}` };
  }

  async status(id: string): Promise<ApprovalDecision> {
    const entry = this.entries.get(id);
    if (!entry) throw new ApprovalError("not_found", `unknown approval ${id}`);
    return view(entry);
  }

  async decide(id: string, decision: "approved" | "denied", decidedBy: string, reason?: string, digest?: string): Promise<ApprovalDecision> {
    const entry = this.entries.get(id);
    if (!entry) throw new ApprovalError("not_found", `unknown approval ${id}`);
    return applyDecision(entry, decision, decidedBy, reason, this.clock.now(), digest);
  }

  async list(): Promise<ApprovalListing[]> {
    return [...this.entries.values()].map((e) => ({ request: e.request, decision: view(e) }));
  }
}

export const ApprovalRequestSchema = z.object({
  id: z.string(),
  runId: z.string(),
  toolCallId: z.string(),
  tool: z.string(),
  sideEffect: z.enum(SIDE_EFFECTS),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  args: z.unknown(),
  summary: z.string(),
  reasons: z.array(z.string()),
  context: z.object({ environment: z.string(), tainted: z.boolean(), suspectedInjection: z.boolean() }),
  requestedAt: z.number(),
  expiresAt: z.number().optional(),
});

const EntrySchema = z.object({
  request: ApprovalRequestSchema,
  decision: z.object({
    status: z.enum(["pending", "approved", "denied", "expired"]),
    decidedBy: z.string().optional(),
    reason: z.string().optional(),
    decidedAt: z.number().optional(),
  }),
});

const LOCK_TTL_MS = 10_000;

/**
 * One JSON file per request under `dir`. Because the files outlive the process, a run can pause,
 * the process can exit, and a reviewer can decide from another process (see the `approvals` CLI).
 * Writes to one record are serialised with an advisory lock file, so a concurrent approve and
 * deny cannot overwrite each other.
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

  private async locked<T>(id: string, fn: () => T): Promise<T> {
    const lockPath = `${this.pathFor(id)}.lock`;
    for (let attempt = 0; ; attempt++) {
      try {
        const lock = acquireFileLock(lockPath, LOCK_TTL_MS);
        try {
          return fn();
        } finally {
          lock.release();
        }
      } catch (err) {
        if (!(err instanceof LockError)) throw err;
        if (attempt >= 50) throw new ApprovalError("busy", `approval ${id} is being updated by another process`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  }

  async request(request: ApprovalRequest): Promise<RequestOutcome> {
    return this.locked(request.id, () => {
      let existing: Entry | undefined;
      try {
        existing = this.read(request.id);
      } catch (err) {
        if (!(err instanceof ApprovalError)) throw err;
      }
      const { entry, detail } = reuseOrReplace(existing, request);
      if (entry !== existing) this.write(entry);
      return { notified: false, detail: `written to the file approval store; ${detail}` };
    });
  }

  async status(id: string): Promise<ApprovalDecision> {
    return view(this.read(id));
  }

  async decide(id: string, decision: "approved" | "denied", decidedBy: string, reason?: string, digest?: string): Promise<ApprovalDecision> {
    return this.locked(id, () => {
      const entry = this.read(id);
      const result = applyDecision(entry, decision, decidedBy, reason, this.clock.now(), digest);
      this.write(entry);
      return result;
    });
  }

  async list(): Promise<ApprovalListing[]> {
    const files = readdirSync(this.dir).filter((f) => f.endsWith(".json")).sort();
    return files.map((f) => {
      const entry = this.read(f.slice(0, -".json".length));
      return { request: entry.request, decision: view(entry) };
    });
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
  /** How far a decision's timestamp may differ from this process's clock. Default 5 minutes. */
  freshnessWindowMs?: number;
  clock?: Clock;
}

export const SIGNATURE_HEADER = "x-guardrails-signature";
export const TIMESTAMP_HEADER = "x-guardrails-timestamp";
export const DIGEST_HEADER = "x-guardrails-digest";

export function sign(secret: string, payload: string): string {
  return `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
}

/** Signature a reviewer's system must send with a decision. Covers the approval id, the call digest, the timestamp and the exact body. */
export function signDecision(secret: string, parts: { id: string; digest: string; timestamp: number | string; body: string }): string {
  return sign(secret, `${parts.id}.${parts.digest}.${parts.timestamp}.${parts.body}`);
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

export interface CallbackAuth {
  signature: string | undefined;
  /** Milliseconds since the epoch, as sent in `x-guardrails-timestamp`. */
  timestamp: string | undefined;
  /** The call digest the decision is for, as sent in `x-guardrails-digest`. */
  digest: string | undefined;
}

/**
 * Approvals decided over HTTP. `request` persists the request and POSTs a signed notification;
 * the reviewer's system answers by POSTing a signed decision to `handleCallback` (or the server
 * from `createCallbackServer`). The decision is stored, so the run can be resumed in any process.
 *
 * A decision is accepted only if its signature covers the approval id, the digest of the call it
 * approves, a timestamp within the freshness window and the body; the digest must also equal the
 * one stored with the request, and a request can be decided once.
 */
export class HttpCallbackApprovalGate implements ApprovalGate {
  private readonly fetchFn: typeof fetch;
  private readonly clock: Clock;
  private readonly windowMs: number;

  constructor(private readonly options: HttpCallbackOptions) {
    if (options.secret.length < 16) throw new Error("approval callback secret must be at least 16 characters");
    this.fetchFn = options.fetch ?? fetch;
    this.clock = options.clock ?? systemClock;
    this.windowMs = options.freshnessWindowMs ?? 5 * 60_000;
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
    const timestamp = String(this.clock.now());
    try {
      const res = await this.fetchFn(this.options.notifyUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [TIMESTAMP_HEADER]: timestamp,
          [SIGNATURE_HEADER]: sign(this.options.secret, `${timestamp}.${body}`),
        },
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

  async handleCallback(id: string, rawBody: string, auth: CallbackAuth): Promise<CallbackResponse> {
    const { signature, timestamp, digest } = auth;
    if (!signature || !timestamp || !digest) return { status: 401, body: { error: "missing signature, timestamp or digest" } };
    if (!signaturesMatch(signDecision(this.options.secret, { id, digest, timestamp, body: rawBody }), signature)) {
      return { status: 401, body: { error: "invalid signature" } };
    }
    const sentAt = Number(timestamp);
    if (!Number.isFinite(sentAt) || Math.abs(this.clock.now() - sentAt) > this.windowMs) {
      return { status: 401, body: { error: "timestamp outside the freshness window" } };
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
      const decision = await this.options.store.decide(id, parsed.data.decision, parsed.data.decidedBy, parsed.data.reason, digest);
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
      const header = (name: string) => {
        const value = req.headers[name];
        return Array.isArray(value) ? value[0] : value;
      };
      const result = await gate.handleCallback(match[1]!, raw, {
        signature: header(SIGNATURE_HEADER),
        timestamp: header(TIMESTAMP_HEADER),
        digest: header(DIGEST_HEADER),
      });
      return send(result.status, result.body);
    } catch {
      return send(500, { error: "internal error" });
    }
  });
}
