import { describe, expect, it } from "vitest";
import { ModelError, OpenAICompatibleModel, ScriptedModel, toWireMessages, type ChatMessage, type ModelRequest } from "../src/index.js";

const request: ModelRequest = {
  messages: [
    { role: "system", content: "sys" },
    { role: "user", content: "hello" },
  ],
  tools: [{ name: "lookup", description: "Look something up", parameters: { type: "object", properties: { q: { type: "string" } } } }],
};

describe("ScriptedModel", () => {
  it("replays turns in order and numbers tool call ids", async () => {
    const model = new ScriptedModel([
      { toolCalls: [{ name: "a", args: { x: 1 } }, { name: "b" }] },
      { content: "done", costUnits: 3 },
    ]);
    const first = await model.complete(request);
    expect(first.toolCalls).toEqual([
      { id: "call_1_1", name: "a", arguments: '{"x":1}' },
      { id: "call_1_2", name: "b", arguments: "{}" },
    ]);
    expect(first.costUnits).toBe(1);
    expect(await model.complete(request)).toMatchObject({ content: "done", toolCalls: [], costUnits: 3 });
    expect(model.turnsUsed).toBe(2);
  });

  it("uses explicit ids and raw argument strings verbatim", async () => {
    const model = new ScriptedModel([{ toolCalls: [{ id: "mine", name: "a", rawArguments: "{broken" }] }]);
    expect((await model.complete(request)).toolCalls[0]).toEqual({ id: "mine", name: "a", arguments: "{broken" });
  });

  it("fails loudly when the script runs out", async () => {
    const model = new ScriptedModel([]);
    await expect(model.complete(request)).rejects.toThrow(/exhausted/);
  });

  it("supports reactive steps that see the request and turn index", async () => {
    const model = new ScriptedModel([(req, i) => ({ content: `${req.messages.length} messages at turn ${i}` })]);
    expect((await model.complete(request)).content).toBe("2 messages at turn 0");
  });

  it("keeps a copy of every request for assertions", async () => {
    const model = new ScriptedModel([{ content: "a" }]);
    const req = structuredClone(request);
    await model.complete(req);
    req.messages.push({ role: "user", content: "later" });
    expect(model.requests[0]!.messages).toHaveLength(2);
  });
});

describe("toWireMessages", () => {
  it("maps assistant tool calls and tool results to the chat-completions shape", () => {
    const messages: ChatMessage[] = [
      { role: "assistant", content: null, toolCalls: [{ id: "c1", name: "lookup", arguments: '{"q":"x"}' }] },
      { role: "tool", toolCallId: "c1", name: "lookup", content: '{"ok":true}' },
      { role: "assistant", content: "text only" },
    ];
    expect(toWireMessages(messages)).toEqual([
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "lookup", arguments: '{"q":"x"}' } }] },
      { role: "tool", tool_call_id: "c1", content: '{"ok":true}' },
      { role: "assistant", content: "text only" },
    ]);
  });
});

function fakeFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init: init! });
    return respond(String(url), init!);
  };
  return { fn, calls };
}

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe("OpenAICompatibleModel", () => {
  it("posts model, messages, tools and auth to <baseUrl>/chat/completions", async () => {
    const { fn, calls } = fakeFetch(() => ok({ choices: [{ message: { content: "hi" } }] }));
    const model = new OpenAICompatibleModel({ baseUrl: "https://llm.example/v1/", apiKey: "test-key-value", model: "m-1", fetch: fn, temperature: 0 });
    await model.complete(request);
    expect(calls[0]!.url).toBe("https://llm.example/v1/chat/completions");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer test-key-value");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toMatchObject({
      model: "m-1",
      temperature: 0,
      tool_choice: "auto",
      messages: [{ role: "system", content: "sys" }, { role: "user", content: "hello" }],
      tools: [{ type: "function", function: { name: "lookup", description: "Look something up" } }],
    });
  });

  it("omits tools and tool_choice when there are none", async () => {
    const { fn, calls } = fakeFetch(() => ok({ choices: [{ message: { content: "hi" } }] }));
    await new OpenAICompatibleModel({ baseUrl: "https://x/v1", apiKey: "k", model: "m", fetch: fn }).complete({ ...request, tools: [] });
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("tool_choice");
  });

  it("parses text, tool calls and usage into spend units", async () => {
    const { fn } = fakeFetch(() =>
      ok({
        choices: [
          { message: { content: null, tool_calls: [{ id: "call_9", type: "function", function: { name: "lookup", arguments: '{"q":"a"}' } }] } },
        ],
        usage: { prompt_tokens: 1500, completion_tokens: 500 },
      }),
    );
    const model = new OpenAICompatibleModel({ baseUrl: "https://x/v1", apiKey: "k", model: "m", fetch: fn, unitsPer1kTokens: 0.5 });
    expect(await model.complete(request)).toEqual({
      content: null,
      toolCalls: [{ id: "call_9", name: "lookup", arguments: '{"q":"a"}' }],
      costUnits: 1,
      usage: { promptTokens: 1500, completionTokens: 500 },
    });
  });

  it("synthesises ids for tool calls that lack one and defaults missing arguments", async () => {
    const { fn } = fakeFetch(() => ok({ choices: [{ message: { tool_calls: [{ function: { name: "a" } }, { id: "", function: { name: "b", arguments: "{}" } }] } }] }));
    const res = await new OpenAICompatibleModel({ baseUrl: "https://x/v1", apiKey: "k", model: "m", fetch: fn }).complete(request);
    expect(res.toolCalls.map((c) => [c.id, c.arguments])).toEqual([
      ["call_2_1", "{}"],
      ["call_2_2", "{}"],
    ]);
  });

  it("raises ModelError with the status for HTTP errors and truncates the body", async () => {
    const { fn } = fakeFetch(() => new Response("x".repeat(1000), { status: 429 }));
    const err = await new OpenAICompatibleModel({ baseUrl: "https://x/v1", apiKey: "k", model: "m", fetch: fn }).complete(request).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelError);
    expect((err as ModelError).status).toBe(429);
    expect((err as ModelError).message.length).toBeLessThan(400);
  });

  it("never puts the API key into an error, even when the transport fails", async () => {
    const { fn } = fakeFetch(() => {
      throw new Error("connect failed for Bearer super-secret-key");
    });
    const err = await new OpenAICompatibleModel({ baseUrl: "https://x/v1", apiKey: "super-secret-key", model: "m", fetch: fn }).complete(request).catch((e: unknown) => e);
    expect((err as Error).message).not.toContain("super-secret-key");
  });

  it("rejects bodies that are not JSON or not the expected shape", async () => {
    const make = (res: Response) => new OpenAICompatibleModel({ baseUrl: "https://x/v1", apiKey: "k", model: "m", fetch: async () => res });
    await expect(make(new Response("<html>", { status: 200 })).complete(request)).rejects.toThrow(/not JSON/);
    await expect(make(ok({ choices: [] })).complete(request)).rejects.toThrow(/unexpected response shape/);
    await expect(make(ok({ nope: true })).complete(request)).rejects.toThrow(/unexpected response shape/);
  });

  it("passes the caller's abort signal to fetch", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const model = new OpenAICompatibleModel({
      baseUrl: "https://x/v1",
      apiKey: "k",
      model: "m",
      fetch: async (_url, init) => {
        seen = init!.signal as AbortSignal;
        return ok({ choices: [{ message: { content: "x" } }] });
      },
    });
    await model.complete(request, controller.signal);
    controller.abort();
    expect(seen!.aborted).toBe(true);
  });
});
