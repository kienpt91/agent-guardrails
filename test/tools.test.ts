import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ToolError, ToolRegistry, defineTool, parseArguments } from "../src/index.js";

const base = {
  name: "do_thing",
  description: "Does a thing.",
  sideEffect: "read" as const,
  input: z.object({ id: z.string(), count: z.number().int().default(1) }),
  output: z.object({ ok: z.boolean() }),
  execute: () => ({ ok: true }),
};

describe("defineTool", () => {
  it("applies defaults for timeout, idempotency, retry and trust", () => {
    const tool = defineTool(base);
    expect(tool.timeoutMs).toBe(10_000);
    expect(tool.idempotency).toBe("none");
    expect(tool.retry).toEqual({ maxAttempts: 1, backoffMs: 0 });
    expect(tool.trust).toBe("trusted");
    expect(tool.safeExit).toBe(false);
    expect(tool.costUnits({})).toBe(0);
  });

  it("rejects names that are not simple identifiers", () => {
    expect(() => defineTool({ ...base, name: "bad name" })).toThrow(/invalid tool name/);
    expect(() => defineTool({ ...base, name: "../x" })).toThrow(/invalid tool name/);
  });

  it("refuses retries on a write tool that cannot dedupe", () => {
    expect(() => defineTool({ ...base, sideEffect: "write", retry: { maxAttempts: 2 } })).toThrow(/idempotency/);
    expect(() => defineTool({ ...base, sideEffect: "external-send", retry: { maxAttempts: 2 } })).toThrow(/idempotency/);
  });

  it("allows retries on reads and on writes that declare idempotency keys", () => {
    expect(defineTool({ ...base, retry: { maxAttempts: 3 } }).retry.maxAttempts).toBe(3);
    expect(defineTool({ ...base, sideEffect: "write", idempotency: "key", retry: { maxAttempts: 3 } }).retry.maxAttempts).toBe(3);
  });

  it("rejects invalid retry counts and timeouts", () => {
    expect(() => defineTool({ ...base, retry: { maxAttempts: 0 } })).toThrow(/maxAttempts/);
    expect(() => defineTool({ ...base, timeoutMs: 0 })).toThrow(/timeoutMs/);
  });

  it("requires idempotency: key for a custom idempotency key function", () => {
    expect(() => defineTool({ ...base, idempotencyKey: () => "k" })).toThrow(/requires idempotency/);
  });

  it("supports a cost function", () => {
    const tool = defineTool({ ...base, costUnits: (input) => input.count * 2 });
    expect(tool.costUnits({ id: "a", count: 3 })).toBe(6);
  });
});

describe("idempotency keys", () => {
  const tool = defineTool({ ...base, sideEffect: "write", idempotency: "key" });

  it("is stable for the same run, tool and arguments regardless of key order", () => {
    expect(tool.idempotencyKeyFor("run_1", { id: "a", count: 1 })).toBe(tool.idempotencyKeyFor("run_1", { count: 1, id: "a" }));
  });

  it("changes with the run id and with the arguments", () => {
    const k = tool.idempotencyKeyFor("run_1", { id: "a" });
    expect(tool.idempotencyKeyFor("run_2", { id: "a" })).not.toBe(k);
    expect(tool.idempotencyKeyFor("run_1", { id: "b" })).not.toBe(k);
  });

  it("uses a custom business key independent of the run", () => {
    const custom = defineTool({ ...base, sideEffect: "write", idempotency: "key", idempotencyKey: (i) => `campaign-${i.id}` });
    expect(custom.idempotencyKeyFor("run_1", { id: "a" })).toBe(custom.idempotencyKeyFor("run_2", { id: "a" }));
    expect(custom.idempotencyKeyFor("run_1", { id: "a" })).not.toBe(custom.idempotencyKeyFor("run_1", { id: "b" }));
  });
});

describe("ToolRegistry", () => {
  it("registers, looks up and lists tools", () => {
    const registry = new ToolRegistry([defineTool(base)]);
    expect(registry.get("do_thing")?.name).toBe("do_thing");
    expect(registry.get("nope")).toBeUndefined();
    expect(registry.names()).toEqual(["do_thing"]);
  });

  it("rejects duplicate names", () => {
    expect(() => new ToolRegistry([defineTool(base), defineTool(base)])).toThrow(/duplicate tool/);
  });

  it("describes tools with JSON Schema parameters and the side-effect class", () => {
    const [spec] = new ToolRegistry([defineTool({ ...base, sideEffect: "destructive" })]).specs();
    expect(spec!.description).toContain("destructive");
    expect(spec!.parameters["type"]).toBe("object");
    expect(spec!.parameters).not.toHaveProperty("$schema");
    expect(Object.keys(spec!.parameters["properties"] as object)).toEqual(["id", "count"]);
    expect(spec!.parameters["required"]).toEqual(["id"]);
  });
});

describe("parseArguments", () => {
  const tool = defineTool(base);

  it("parses valid JSON and applies schema defaults", () => {
    expect(parseArguments(tool, '{"id":"a"}')).toEqual({ ok: true, value: { id: "a", count: 1 } });
  });

  it("treats an empty argument string as an empty object", () => {
    const noArgs = defineTool({ ...base, input: z.object({}) });
    expect(parseArguments(noArgs, "")).toEqual({ ok: true, value: {} });
  });

  it("reports malformed JSON as a structured error", () => {
    const result = parseArguments(tool, '{"id": ');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("invalid_arguments");
      expect(result.error.tool).toBe("do_thing");
      expect(result.error.issues[0]!.code).toBe("invalid_json");
    }
  });

  it("lists each failing field with its path", () => {
    const result = parseArguments(tool, '{"id": 5, "count": "x"}');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.issues.map((i) => i.path).sort()).toEqual(["count", "id"]);
  });

  it("does not echo offending values back to the model", () => {
    const result = parseArguments(tool, '{"id": "ok", "count": "super-secret-value"}');
    expect(JSON.stringify(result)).not.toContain("super-secret-value");
  });

  it("rejects a non-object top level", () => {
    expect(parseArguments(tool, "[1,2]").ok).toBe(false);
  });
});

describe("ToolError", () => {
  it("carries a code, retryable flag and details", () => {
    const err = new ToolError("rate_limited", "slow down", { retryable: true, details: { after: 5 } });
    expect(err.code).toBe("rate_limited");
    expect(err.retryable).toBe(true);
    expect(err.details).toEqual({ after: 5 });
    expect(new ToolError("x", "y").retryable).toBe(false);
  });
});
