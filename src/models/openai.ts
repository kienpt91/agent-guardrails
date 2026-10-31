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
  usage: z.object({ prompt_tokens: z.number(), completion_tokens: z.number() }).optional(),
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
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (err) {
      throw new ModelError(`model request failed: ${err instanceof Error ? err.name : "error"}`);
    }
    const text = await res.text();
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
    const tokens = usage ? usage.prompt_tokens + usage.completion_tokens : 0;
    return {
      content: choice.message.content ?? null,
      toolCalls: (choice.message.tool_calls ?? []).map((call, i) => ({
        id: call.id && call.id !== "" ? call.id : `call_${request.messages.length}_${i + 1}`,
        name: call.function.name,
        arguments: call.function.arguments ?? "{}",
      })),
      costUnits: (tokens / 1000) * (this.options.unitsPer1kTokens ?? 1),
      ...(usage ? { usage: { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens } } : {}),
    };
  }
}
