import { z } from "zod";
import { ToolError, computeDiff, createEscalationTool, defineTool, type Tool } from "../../src/index.js";
import type { HttpClient, HttpRequest } from "./fakes.js";

/** Maps an HTTP-style response to a result or a typed tool error. 429 and 5xx are retryable; other 4xx are not. */
async function call<T = unknown>(client: HttpClient, label: string, req: HttpRequest): Promise<T> {
  const res = await client.request(req);
  if (res.status >= 200 && res.status < 300) return res.body as T;
  const message = (res.body as { error?: string } | null)?.error ?? `HTTP ${res.status}`;
  if (res.status === 404) throw new ToolError("not_found", `${label}: ${message}`);
  if (res.status === 422) {
    throw new ToolError("unknown_recipient", `${label}: ${message}`, { details: res.body });
  }
  if (res.status === 429 || res.status >= 500) {
    throw new ToolError("upstream_unavailable", `${label}: ${message} (HTTP ${res.status})`, { retryable: true });
  }
  throw new ToolError("bad_request", `${label}: ${message} (HTTP ${res.status})`);
}

const email = z.string().email().max(254);

export function createMarketingTools(clients: { crm: HttpClient; cms: HttpClient }): Tool[] {
  const { crm, cms } = clients;

  const searchAccounts = defineTool({
    name: "crm_search_accounts",
    description: "Find CRM accounts by name. Returns id, name, industry and the primary contact email.",
    sideEffect: "read",
    input: z.object({ query: z.string().min(1).max(100), limit: z.number().int().min(1).max(20).default(5) }),
    output: z.object({
      accounts: z.array(z.object({ id: z.string(), name: z.string(), industry: z.string(), contactEmail: z.string().nullable() })),
    }),
    retry: { maxAttempts: 2 },
    async execute(input) {
      return call(crm, "crm_search_accounts", {
        method: "GET",
        path: "/accounts",
        query: { q: input.query, limit: String(input.limit) },
      });
    },
  });

  const getAccount = defineTool({
    name: "crm_get_account",
    description: "Fetch one CRM account with contacts and free-text notes written by account managers.",
    sideEffect: "read",
    // Notes are free text entered by people and imported from other systems.
    trust: "untrusted",
    input: z.object({ accountId: z.string().regex(/^acct_\d+$/) }),
    output: z.object({
      id: z.string(),
      name: z.string(),
      industry: z.string(),
      plan: z.string(),
      contacts: z.array(z.object({ name: z.string(), email: z.string() })),
      notes: z.string(),
    }),
    retry: { maxAttempts: 2 },
    async execute(input) {
      return call(crm, "crm_get_account", { method: "GET", path: `/accounts/${input.accountId}` });
    },
  });

  const createDraft = defineTool({
    name: "cms_create_draft",
    description: "Create a draft page in the CMS. A draft is not visible to the public until it is published.",
    sideEffect: "write",
    idempotency: "key",
    retry: { maxAttempts: 2 },
    input: z.object({
      title: z.string().min(1).max(120),
      body: z.string().min(1).max(5000),
      slug: z.string().regex(/^[a-z0-9-]+$/).max(80).optional(),
    }),
    output: z.object({ id: z.string(), slug: z.string(), status: z.literal("draft") }),
    async execute(input, ctx) {
      return call(cms, "cms_create_draft", {
        method: "POST",
        path: "/pages",
        headers: { "idempotency-key": ctx.idempotencyKey },
        body: input,
      });
    },
    describe: (input) => `Create draft page "${input.title}"`,
    simulate(input) {
      const slug = input.slug ?? input.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      return {
        summary: `would create draft page "${input.title}"`,
        result: { id: "page_simulated", slug, status: "draft" as const },
        diff: computeDiff({}, { title: input.title, slug, status: "draft" }),
      };
    },
  });

  const publishPage = defineTool({
    name: "cms_publish_page",
    description: "Publish a draft page so it becomes public.",
    sideEffect: "write",
    idempotency: "key",
    retry: { maxAttempts: 2 },
    input: z.object({ pageId: z.string().regex(/^page_\w+$/) }),
    output: z.object({ id: z.string(), status: z.literal("published"), url: z.string() }),
    async execute(input, ctx) {
      return call(cms, "cms_publish_page", {
        method: "POST",
        path: `/pages/${input.pageId}/publish`,
        headers: { "idempotency-key": ctx.idempotencyKey },
      });
    },
    describe: (input) => `Publish page ${input.pageId}`,
    async simulate(input) {
      // The page may be a placeholder from an earlier simulated draft, so a missing page is not an error here.
      const page = await call<{ title: string; status: string }>(cms, "cms_publish_page (simulation read)", {
        method: "GET",
        path: `/pages/${input.pageId}`,
      }).catch((err: unknown) => {
        if (err instanceof ToolError && err.code === "not_found") return undefined;
        throw err;
      });
      return {
        summary: page
          ? `would publish "${page.title}" (${input.pageId})`
          : `would publish ${input.pageId} (not found in the CMS; it may be a draft created earlier in this plan)`,
        result: { id: input.pageId, status: "published" as const, url: "https://cms.example/(simulated)" },
        diff: [{ path: `${input.pageId}.status`, before: page?.status, after: "published" }],
      };
    },
  });

  const deletePage = defineTool({
    name: "cms_delete_page",
    description: "Permanently delete a page.",
    sideEffect: "destructive",
    idempotency: "key",
    input: z.object({ pageId: z.string().regex(/^page_\w+$/) }),
    output: z.object({ deleted: z.literal(true) }),
    async execute(input) {
      return call(cms, "cms_delete_page", { method: "DELETE", path: `/pages/${input.pageId}` });
    },
    describe: (input) => `Delete page ${input.pageId}`,
  });

  const sendEmail = defineTool({
    name: "crm_send_email",
    description:
      "Send an email through the CRM to contacts that already exist in it. Recipients that are not CRM contacts are rejected.",
    sideEffect: "external-send",
    idempotency: "key",
    retry: { maxAttempts: 3, backoffMs: 100 },
    timeoutMs: 2000,
    costUnits: 5,
    input: z.object({
      to: z.array(email).min(1).max(500),
      subject: z.string().min(1).max(150),
      body: z.string().min(1).max(5000),
    }),
    output: z.object({ messageId: z.string(), delivered: z.number().int(), deduplicated: z.boolean() }),
    async execute(input, ctx) {
      return call(crm, "crm_send_email", {
        method: "POST",
        path: "/emails",
        headers: { "idempotency-key": ctx.idempotencyKey },
        body: input,
      });
    },
    describe: (input) => `Send "${input.subject}" to ${input.to.length} recipient(s): ${input.to.slice(0, 3).join(", ")}${input.to.length > 3 ? ", ..." : ""}`,
    simulate(input) {
      return {
        summary: `would send "${input.subject}" to ${input.to.length} recipient(s)`,
        result: { messageId: "msg_simulated", delivered: input.to.length, deduplicated: false },
        diff: [{ path: "outbox", before: undefined, after: { subject: input.subject, to: input.to } }],
      };
    },
  });

  return [searchAccounts, getAccount, createDraft, publishPage, deletePage, sendEmail, createEscalationTool()];
}
