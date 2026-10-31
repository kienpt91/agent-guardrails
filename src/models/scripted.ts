import { ModelError, type ModelAdapter, type ModelRequest, type ModelResponse, type ToolCallRequest } from "../types.js";

export interface ScriptedToolCall {
  id?: string;
  name: string;
  /** Arguments object; serialised to JSON like a real model would. */
  args?: unknown;
  /** Verbatim argument string, for simulating malformed JSON. Wins over `args`. */
  rawArguments?: string;
}

export interface ScriptedTurn {
  content?: string | null;
  toolCalls?: ScriptedToolCall[];
  costUnits?: number;
  usage?: { promptTokens: number; completionTokens: number };
}

export type ScriptStep = ScriptedTurn | ((request: ModelRequest, turnIndex: number) => ScriptedTurn);

/** Deterministic stand-in for a model: replays a fixed list of turns and fails loudly when it runs out. */
export class ScriptedModel implements ModelAdapter {
  readonly name = "scripted";
  private index = 0;
  /** Every request received, for assertions. */
  readonly requests: ModelRequest[] = [];

  constructor(private readonly script: ScriptStep[]) {}

  get turnsUsed(): number {
    return this.index;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(structuredClone(request));
    const step = this.script[this.index];
    if (step === undefined) {
      throw new ModelError(`scripted model exhausted after ${this.index} turns`);
    }
    const turn = typeof step === "function" ? step(request, this.index) : step;
    this.index += 1;
    return toResponse(turn, this.index);
  }
}

export function toResponse(turn: ScriptedTurn, turnNumber: number): ModelResponse {
  const toolCalls: ToolCallRequest[] = (turn.toolCalls ?? []).map((call, i) => ({
    id: call.id ?? `call_${turnNumber}_${i + 1}`,
    name: call.name,
    arguments: call.rawArguments ?? JSON.stringify(call.args ?? {}),
  }));
  return {
    content: turn.content ?? null,
    toolCalls,
    costUnits: turn.costUnits ?? 1,
    ...(turn.usage ? { usage: turn.usage } : {}),
  };
}
