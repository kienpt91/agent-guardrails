import { isRecord } from "./util.js";

export const REDACTED = "[REDACTED]";

/** Field names that are always redacted. Matching is case-insensitive and ignores `_`/`-`. */
export const DEFAULT_SECRET_FIELDS = [
  "password",
  "passwd",
  "secret",
  "apikey",
  "authorization",
  "cookie",
  "accesstoken",
  "refreshtoken",
  "privatekey",
];

export interface RedactionConfig {
  /** Extra field names to redact. A key matches when its normalised form equals or ends with the field. */
  fields?: string[];
  /** Regular expressions (source strings); matching parts of string values are replaced. */
  patterns?: string[];
}

const normalise = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Redacts secret-looking fields and patterns from JSON-like values before they are written to a
 * trace or shown to a reviewer. It returns a copy and never mutates its input.
 */
export class Redactor {
  private readonly fields: string[];
  private readonly patterns: RegExp[];

  constructor(config: RedactionConfig = {}) {
    this.fields = [...DEFAULT_SECRET_FIELDS, ...(config.fields ?? [])].map(normalise).filter((f) => f.length > 0);
    this.patterns = (config.patterns ?? []).map((p) => new RegExp(p, "g"));
  }

  private isSecretKey(key: string): boolean {
    const n = normalise(key);
    return this.fields.some((f) => n === f || n.endsWith(f));
  }

  redactString(text: string): string {
    return this.patterns.reduce((acc, re) => acc.replace(re, REDACTED), text);
  }

  redact<T>(value: T): T {
    return this.walk(value, 0) as T;
  }

  private walk(value: unknown, depth: number): unknown {
    if (depth > 20) return "[TRUNCATED]";
    if (typeof value === "string") return this.redactString(value);
    if (Array.isArray(value)) return value.map((v) => this.walk(v, depth + 1));
    if (isRecord(value)) {
      const out: Record<string, unknown> = {};
      for (const [key, v] of Object.entries(value)) {
        out[key] = this.isSecretKey(key) ? REDACTED : this.walk(v, depth + 1);
      }
      return out;
    }
    return value;
  }
}
