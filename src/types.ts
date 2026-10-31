/** What a tool can do to the outside world. Policy rules and dry-run behaviour key off this. */
export const SIDE_EFFECTS = ["read", "write", "external-send", "destructive"] as const;
export type SideEffect = (typeof SIDE_EFFECTS)[number];

export interface ToolCallRequest {
  id: string;
  name: string;
  /** Raw arguments exactly as the model produced them (normally a JSON string). */
  arguments: string;
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; toolCalls?: ToolCallRequest[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
}

export interface ModelRequest {
  messages: ChatMessage[];
  tools: ToolSpec[];
}

export interface ModelResponse {
  content: string | null;
  toolCalls: ToolCallRequest[];
  usage?: { promptTokens: number; completionTokens: number };
  /** Abstract spend units charged for this call; counted against the `maxSpendUnits` budget. */
  costUnits: number;
}

export interface ModelAdapter {
  readonly name: string;
  complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse>;
}

export class ModelError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ModelError";
  }
}

export type RunStatus =
  | "running"
  | "paused"
  | "completed"
  | "escalated"
  | "budget_exceeded"
  | "failed";

export const TERMINAL_STATUSES: readonly RunStatus[] = [
  "completed",
  "escalated",
  "budget_exceeded",
  "failed",
];
