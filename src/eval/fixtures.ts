import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { ModelError, type ModelAdapter, type ModelRequest, type ModelResponse } from "../types.js";
import { canonicalJson, sha256Hex } from "../util.js";

export interface FixtureTurn {
  /** Digest of what the model was shown (messages and tool names) when this response was recorded. */
  requestDigest: string;
  response: ModelResponse;
}

export interface Fixture {
  version: 1;
  scenario: string;
  turns: FixtureTurn[];
}

export function requestDigest(request: ModelRequest): string {
  return sha256Hex(canonicalJson({ messages: request.messages, tools: request.tools.map((t) => t.name) })).slice(0, 16);
}

const FixtureSchema = z.object({
  version: z.literal(1),
  scenario: z.string(),
  turns: z.array(
    z.object({
      requestDigest: z.string(),
      response: z.object({
        content: z.string().nullable(),
        toolCalls: z.array(z.object({ id: z.string(), name: z.string(), arguments: z.string() })),
        usage: z.object({ promptTokens: z.number(), completionTokens: z.number() }).optional(),
        costUnits: z.number(),
      }),
    }),
  ),
});

export function readFixture(path: string): Fixture {
  return FixtureSchema.parse(JSON.parse(readFileSync(path, "utf8"))) as Fixture;
}

export function writeFixture(path: string, fixture: Fixture): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
}

/** Wraps any model and records every request digest and response. Works with a live adapter or a scripted one. */
export class RecordingModel implements ModelAdapter {
  readonly name: string;
  readonly turns: FixtureTurn[] = [];

  constructor(private readonly inner: ModelAdapter) {
    this.name = `recording:${inner.name}`;
  }

  async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
    const response = await this.inner.complete(request, signal);
    this.turns.push({ requestDigest: requestDigest(request), response: structuredClone(response) });
    return response;
  }

  toFixture(scenario: string): Fixture {
    return { version: 1, scenario, turns: this.turns };
  }
}

export interface ReplayOptions {
  /** Fail when the model is shown something different from what was recorded. Default true. */
  verifyRequests?: boolean;
}

/** Plays back recorded responses in order, so agent behaviour can be tested offline and deterministically. */
export class ReplayModel implements ModelAdapter {
  readonly name: string;
  private index = 0;
  private readonly verify: boolean;

  constructor(
    private readonly fixture: Fixture,
    options: ReplayOptions = {},
  ) {
    this.name = `replay:${fixture.scenario}`;
    this.verify = options.verifyRequests ?? true;
  }

  get turnsUsed(): number {
    return this.index;
  }

  get turnsRemaining(): number {
    return this.fixture.turns.length - this.index;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const turn = this.fixture.turns[this.index];
    if (!turn) {
      throw new ModelError(`fixture ${this.fixture.scenario} has no turn ${this.index + 1}; the agent asked for more model calls than were recorded`);
    }
    if (this.verify) {
      const digest = requestDigest(request);
      if (digest !== turn.requestDigest) {
        throw new ModelError(
          `fixture ${this.fixture.scenario} drifted at turn ${this.index + 1}: the model was shown different input than when it was recorded (recorded ${turn.requestDigest}, now ${digest}); re-record the fixture if the change is intended`,
        );
      }
    }
    this.index += 1;
    return structuredClone(turn.response);
  }
}
