export interface InjectionPattern {
  name: string;
  pattern: RegExp;
}

/**
 * Heuristics for instructions smuggled into tool output. They catch the blunt, common phrasings
 * and nothing else: a paraphrase or another language passes. They exist to raise a flag (which
 * policy can act on) and to make attempts visible in the trace, not to be a security boundary.
 */
export const DEFAULT_INJECTION_PATTERNS: InjectionPattern[] = [
  {
    name: "ignore-previous-instructions",
    pattern: /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all)\b[^.\n]{0,30}\b(instructions?|prompts?|rules|guidelines)\b/i,
  },
  { name: "new-instructions", pattern: /\b(new|updated|real)\s+instructions?\s*[:\-]/i },
  { name: "role-tag-spoof", pattern: /<\/?\s*(system|assistant|developer|tool)\s*>|\[\s*(system|assistant)\s*\]/i },
  {
    name: "send-data-elsewhere",
    pattern: /\b(send|email|forward|post|upload|export)\b[^.\n]{0,40}\b(customer|client|contact|user|account)s?\b[^.\n]{0,20}\b(list|database|data|emails?|records)\b/i,
  },
  { name: "conceal-from-user", pattern: /\b(do not|don't|never)\s+(tell|inform|mention|notify|alert)\b[^.\n]{0,30}\b(user|human|operator|admin|reviewer)\b/i },
  { name: "reveal-system-prompt", pattern: /\b(reveal|print|show|repeat)\b[^.\n]{0,30}\bsystem prompt\b/i },
];

export type InjectionDetector = (text: string) => string[];

export function detectInjection(text: string, patterns: InjectionPattern[] = DEFAULT_INJECTION_PATTERNS): string[] {
  return patterns.filter((p) => p.pattern.test(text)).map((p) => p.name);
}
