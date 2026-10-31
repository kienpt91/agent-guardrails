import { z } from "zod";
import { ModelError, type ChatMessage, type ModelAdapter, type ModelRequest, type ModelResponse } from "../types.js";
import { truncate } from "../util.js";

export interface OpenAICompatibleOptions {
  /** Base URL without the trailing `/chat/completions`, e.g. `https://host/v1`. */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Injected so tests (and callers with a proxy or custom agent) control the transport. Defaults to global fetch. */
  fetch?: typeof fetch;
  temperature?: number;
  timeoutMs?: number;
  /** Spend units charged per 1000 tokens (prompt + completion). Default 1. */
  unitsPer1kTokens?: number;
  /** Responses larger than this are rejected. Default 4 MiB. */
  maxResponseBytes?: number;
  /** Permit a plain `http://` base URL to a non-loopback host. Off by default, since the API key would travel in clear text. */
  allowInsecureHttp?: boolean;
}

const ResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullable().optional(),
          tool_calls: z
            .array(
              z.object({
                id: z.string().optional(),
                type: z.literal("function").optional(),
                function: z.object({ name: z.string(), arguments: z.string().optional() }),
              }),
            )
            .nullable()
            .optional(),
        }),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().finite().nonnegative(),
      completion_tokens: z.number().finite().nonnegative(),
    })
    .optional(),
});

export function toWireMessages(messages: ChatMessage[]): Record<string, unknown>[] {
  return messages.map((m) => {
    switch (m.role) {
      case "assistant":
        return {
          role: "assistant",
          content: m.content,
          ...(m.toolCalls?.length
            ? {
                tool_calls: m.toolCalls.map((c) => ({
                  id: c.id,
                  type: "function",
                  function: { name: c.name, arguments: c.arguments },
                })),
              }
            : {}),
        };
      case "tool":
        return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
      default:
        return { role: m.role, content: m.content };
    }
  });
}

/**
 * Chat-completions client for any server that speaks the OpenAI `/chat/completions` tool-calling
 * format. It is exercised in tests against a fake `fetch` only; it has not been run against a real endpoint.
 */
export class OpenAICompatibleModel implements ModelAdapter {
  readonly name: string;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: OpenAICompatibleOptions) {
    this.name = `openai-compatible:${options.model}`;
    this.fetchFn = options.fetch ?? fetch;
    assertTransportIsSafe(options.baseUrl, options.allowInsecureHttp ?? false);
  }

  async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
    const url = `${this.options.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const body = {
      model: this.options.model,
      messages: toWireMessages(request.messages),
      ...(request.tools.length
        ? {
            tools: request.tools.map((t) => ({
              type: "function",
              function: { name: t.name, description: t.description, parameters: t.parameters },
            })),
            tool_choice: "auto",
          }
        : {}),
      ...(this.options.temperature !== undefined ? { temperature: this.options.temperature } : {}),
    };
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 60_000);
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.options.apiKey}` },
        body: JSON.stringify(body),
        // A redirect would resend the whole conversation and the API key to another origin.
        redirect: "error",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (err) {
      throw new ModelError(`model request failed: ${err instanceof Error ? err.name : "error"}`);
    }
    const text = await readCapped(res, this.options.maxResponseBytes ?? 4 * 1024 * 1024);
    if (!res.ok) {
      // The error body is truncated and never includes the request, so the API key cannot leak through it.
      throw new ModelError(`model endpoint answered HTTP ${res.status}: ${truncate(text, 300)}`, res.status);
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ModelError("model endpoint returned a body that is not JSON", res.status);
    }
    const parsed = ResponseSchema.safeParse(json);
    if (!parsed.success) throw new ModelError("model endpoint returned an unexpected response shape", res.status);
    const choice = parsed.data.choices[0]!;
    const usage = parsed.data.usage;
    const toolCalls = (choice.message.tool_calls ?? []).map((call, i) => ({
      id: call.id && call.id !== "" ? call.id : `call_${request.messages.length}_${i + 1}`,
      name: call.function.name,
      arguments: call.function.arguments ?? "{}",
    }));
    // A response without `usage` must not make the spend budget stop applying: estimate roughly 4 characters per token.
    const tokens = usage
      ? usage.prompt_tokens + usage.completion_tokens
      : Math.ceil(
          (JSON.stringify(body.messages).length + (choice.message.content ?? "").length + toolCalls.reduce((n, c) => n + c.name.length + c.arguments.length, 0)) / 4,
        );
    return {
      content: choice.message.content ?? null,
      toolCalls,
      costUnits: (tokens / 1000) * (this.options.unitsPer1kTokens ?? 1),
      ...(usage ? { usage: { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens } } : {}),
    };
  }
}

function assertTransportIsSafe(baseUrl: string, allowInsecureHttp: boolean): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("baseUrl is not a valid URL");
  }
  if (url.protocol === "https:") return;
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol === "http:" && (loopback || allowInsecureHttp)) return;
  throw new Error("baseUrl must be https:// (plain http is accepted only for loopback hosts, or with allowInsecureHttp)");
}

/** Reads a response body but gives up once it exceeds `maxBytes`. */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new ModelError(`model response is larger than ${maxBytes} bytes`, res.status);
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new ModelError(`model response is larger than ${maxBytes} bytes`, res.status);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
