import { createHash } from "node:crypto";

/** JSON with object keys sorted recursively, so equal values always serialise equally. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? "null";
}

/** Sets an own property even for keys such as `__proto__`, which plain assignment would turn into a prototype change. */
export function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      setOwn(out, key, sortKeys((value as Record<string, unknown>)[key]));
    }
    return out;
  }
  return value;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…[+${text.length - max} chars]`;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Ids end up in file names, so only a conservative character set is accepted. */
export function assertSafeId(kind: string, id: string): void {
  if (!SAFE_ID.test(id)) throw new Error(`invalid ${kind} id: ${JSON.stringify(id)}`);
}

// C0 and C1 controls, bidirectional overrides and line separators: everything that can move the cursor,
// recolour the terminal, reorder text or forge a new line.
const UNSAFE_TERMINAL_CHARS = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

/** Makes text that came from a model, a tool or a third party safe to print on one terminal line. */
export function sanitizeText(text: string): string {
  return text.replace(UNSAFE_TERMINAL_CHARS, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
