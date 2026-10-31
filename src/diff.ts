import { canonicalJson, isRecord } from "./util.js";

export interface DiffEntry {
  /** Dotted path inside the compared value; `""` for the root. */
  path: string;
  before: unknown;
  after: unknown;
}

/** Structural diff of two JSON-like values. Arrays are compared by index. */
export function computeDiff(before: unknown, after: unknown, path = ""): DiffEntry[] {
  if (canonicalJson(before) === canonicalJson(after)) return [];
  if (isRecord(before) && isRecord(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    return keys.flatMap((key) => computeDiff(before[key], after[key], path ? `${path}.${key}` : key));
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const length = Math.max(before.length, after.length);
    const out: DiffEntry[] = [];
    for (let i = 0; i < length; i++) {
      out.push(...computeDiff(before[i], after[i], path ? `${path}.${i}` : String(i)));
    }
    return out;
  }
  return [{ path, before, after }];
}

function show(value: unknown): string {
  return value === undefined ? "(absent)" : JSON.stringify(value);
}

export function renderDiff(entries: DiffEntry[]): string[] {
  return entries.map((e) => `${e.path || "(root)"}: ${show(e.before)} -> ${show(e.after)}`);
}
