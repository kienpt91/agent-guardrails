import type { ManualClock } from "../../src/index.js";

/** The slice of HTTP the tools need. The real clients would wrap fetch; these fakes answer in-process. */
export interface HttpRequest {
  method: "GET" | "POST" | "DELETE";
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface HttpResponse {
  status: number;
  body: unknown;
}

export interface HttpClient {
  request(req: HttpRequest): Promise<HttpResponse>;
}

export interface Account {
  id: string;
  name: string;
  industry: string;
  plan: string;
  contacts: { name: string; email: string }[];
  notes: string;
}

export interface SentEmail {
  messageId: string;
  idempotencyKey: string;
  to: string[];
  subject: string;
  body: string;
}

export interface Page {
  id: string;
  title: string;
  body: string;
  slug: string;
  status: "draft" | "published";
}

export const DEFAULT_ACCOUNTS: Account[] = [
  {
    id: "acct_1001",
    name: "Northwind Outfitters",
    industry: "retail",
    plan: "growth",
    contacts: [
      { name: "Ana Reyes", email: "ana@northwind.example" },
      { name: "Ben Okafor", email: "ben@northwind.example" },
    ],
    notes: "Prefers short emails. Renewal in March.",
  },
  {
    id: "acct_1002",
    name: "Contoso Logistics",
    industry: "logistics",
    plan: "starter",
    contacts: [{ name: "Chen Li", email: "chen@contoso-logistics.example" }],
    notes: "Asked about the spring catalogue twice.",
  },
  {
    id: "acct_1003",
    name: "Fabrikam Studio",
    industry: "media",
    plan: "growth",
    contacts: [{ name: "Dana Whitfield", email: "dana@fabrikam-studio.example" }],
    notes: "Design agency. Likes early access.",
  },
];

interface MailFailure {
  /** How many upcoming send requests to fail. */
  count: number;
  /** Deliver the mail and then answer 503, like a response lost on the way back. */
  afterDelivery: boolean;
}

/** In-process stand-in for a CRM's HTTP API: account lookup and a transactional email endpoint. */
export class MockCrm implements HttpClient {
  readonly accounts: Account[];
  readonly sent: SentEmail[] = [];
  readonly requests: HttpRequest[] = [];
  /** Simulated latency; advances the manual clock when one is supplied. */
  latencyMs = 0;
  private failure: MailFailure | undefined;
  private counter = 0;

  constructor(
    accounts: Account[] = DEFAULT_ACCOUNTS,
    private readonly clock?: ManualClock,
  ) {
    this.accounts = structuredClone(accounts);
  }

  failNextEmails(failure: MailFailure): void {
    this.failure = { ...failure };
  }

  setNotes(accountId: string, notes: string): void {
    const account = this.accounts.find((a) => a.id === accountId);
    if (!account) throw new Error(`unknown account ${accountId}`);
    account.notes = notes;
  }

  private knownEmails(): Set<string> {
    return new Set(this.accounts.flatMap((a) => a.contacts.map((c) => c.email)));
  }

  async request(req: HttpRequest): Promise<HttpResponse> {
    this.requests.push(structuredClone(req));
    if (this.latencyMs > 0) this.clock?.advance(this.latencyMs);

    if (req.method === "GET" && req.path === "/accounts") {
      const q = (req.query?.["q"] ?? "").toLowerCase();
      const limit = Number(req.query?.["limit"] ?? 5);
      const hits = this.accounts.filter((a) => a.name.toLowerCase().includes(q)).slice(0, limit);
      return {
        status: 200,
        body: {
          accounts: hits.map((a) => ({ id: a.id, name: a.name, industry: a.industry, contactEmail: a.contacts[0]?.email ?? null })),
        },
      };
    }

    const accountMatch = /^\/accounts\/([\w-]+)$/.exec(req.path);
    if (req.method === "GET" && accountMatch) {
      const account = this.accounts.find((a) => a.id === accountMatch[1]);
      return account ? { status: 200, body: account } : { status: 404, body: { error: "account not found" } };
    }

    if (req.method === "POST" && req.path === "/emails") {
      const key = req.headers?.["idempotency-key"];
      if (!key) return { status: 400, body: { error: "idempotency-key header is required" } };
      const body = req.body as { to: string[]; subject: string; body: string };
      const existing = this.sent.find((m) => m.idempotencyKey === key);
      if (existing) return { status: 200, body: { messageId: existing.messageId, delivered: existing.to.length, deduplicated: true } };
      const known = this.knownEmails();
      const unknown = body.to.filter((email) => !known.has(email));
      if (unknown.length > 0) {
        return { status: 422, body: { error: "recipients are not contacts in this CRM", recipients: unknown } };
      }
      const failing = this.failure && this.failure.count > 0 ? this.failure : undefined;
      if (failing) {
        failing.count -= 1;
        if (!failing.afterDelivery) return { status: 503, body: { error: "temporarily unavailable" } };
      }
      this.counter += 1;
      const mail: SentEmail = {
        messageId: `msg_${String(this.counter).padStart(4, "0")}`,
        idempotencyKey: key,
        to: [...body.to],
        subject: body.subject,
        body: body.body,
      };
      this.sent.push(mail);
      if (failing?.afterDelivery) return { status: 503, body: { error: "gateway timeout" } };
      return { status: 201, body: { messageId: mail.messageId, delivered: mail.to.length, deduplicated: false } };
    }

    return { status: 404, body: { error: "no such route" } };
  }
}

/** In-process stand-in for a CMS HTTP API: draft pages, publish, delete. */
export class MockCms implements HttpClient {
  readonly pages = new Map<string, Page>();
  readonly requests: HttpRequest[] = [];
  private counter = 0;
  private readonly keys = new Map<string, string>();

  constructor(seed: Page[] = []) {
    for (const page of seed) {
      this.pages.set(page.id, { ...page });
      const n = Number(/(\d+)$/.exec(page.id)?.[1] ?? 0);
      this.counter = Math.max(this.counter, n);
    }
  }

  async request(req: HttpRequest): Promise<HttpResponse> {
    this.requests.push(structuredClone(req));

    if (req.method === "POST" && req.path === "/pages") {
      const key = req.headers?.["idempotency-key"];
      if (key && this.keys.has(key)) {
        const page = this.pages.get(this.keys.get(key)!)!;
        return { status: 200, body: { id: page.id, slug: page.slug, status: page.status } };
      }
      const body = req.body as { title: string; body: string; slug?: string };
      this.counter += 1;
      const id = `page_${String(this.counter).padStart(4, "0")}`;
      const slug = body.slug ?? body.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      this.pages.set(id, { id, title: body.title, body: body.body, slug, status: "draft" });
      if (key) this.keys.set(key, id);
      return { status: 201, body: { id, slug, status: "draft" } };
    }

    const pageMatch = /^\/pages\/([\w-]+)(\/publish)?$/.exec(req.path);
    if (pageMatch) {
      const page = this.pages.get(pageMatch[1]!);
      if (!page) return { status: 404, body: { error: "page not found" } };
      if (req.method === "GET" && !pageMatch[2]) return { status: 200, body: page };
      if (req.method === "POST" && pageMatch[2]) {
        page.status = "published";
        return { status: 200, body: { id: page.id, status: page.status, url: `https://cms.example/${page.slug}` } };
      }
      if (req.method === "DELETE" && !pageMatch[2]) {
        this.pages.delete(page.id);
        return { status: 200, body: { deleted: true } };
      }
    }
    return { status: 404, body: { error: "no such route" } };
  }
}
