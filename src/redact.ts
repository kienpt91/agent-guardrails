import { isRecord, setOwn } from "./util.js";

export const REDACTED = "[REDACTED]";

/**
 * Field names that are always redacted. A key matches when its normalised form (lower case, no `_`
 * or `-`) equals or ends with one of these, so `accessToken` and `client_secret` match but
 * `promptTokens` does not.
 */
export const DEFAULT_SECRET_FIELDS = [
  "password",
  "passwd",
  "pwd",
  "secret",
  "apikey",
  "authorization",
  "cookie",
  "token",
  "privatekey",
  "credential",
  "credentials",
  "jwt",
  "ssn",
];

/** Field names that are redacted only when the whole key matches (a suffix match would hit `idempotencyKey`, `sortKey`, ...). */
const EXACT_SECRET_FIELDS = ["key", "auth", "session", "bearer"];

/** Value patterns applied to every string: bearer tokens, URL credentials, JWTs and a few well-known key shapes. */
const DEFAULT_PATTERNS: [RegExp, string][] = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${"[REDACTED]"}`],
  [/:\/\/[^/\s:@]+:[^/\s@]+@/g, `://${"[REDACTED]"}@`],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[REDACTED]"],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, "[REDACTED]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/g, "[REDACTED]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED]"],
];

export interface RedactionConfig {
  /** Extra field names to redact, matched like `DEFAULT_SECRET_FIELDS`. */
  fields?: string[];
  /** Extra regular expressions (source strings) applied to string values, on top of the built-in patterns. */
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
    return EXACT_SECRET_FIELDS.includes(n) || this.fields.some((f) => n === f || n.endsWith(f));
  }

  redactString(text: string): string {
    const builtIn = DEFAULT_PATTERNS.reduce((acc, [re, replacement]) => acc.replace(re, replacement), text);
    return this.patterns.reduce((acc, re) => acc.replace(re, REDACTED), builtIn);
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
        setOwn(out, key, this.isSecretKey(key) ? REDACTED : this.walk(v, depth + 1));
      }
      return out;
    }
    return value;
  }
}
