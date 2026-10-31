import type { PlanEntry } from "./state.js";
import { renderDiff } from "./diff.js";
import { sanitizeText } from "./util.js";

/** Review text for a dry run: what the agent would have changed, in order, and which steps would need a human. */
export function renderPlan(plan: PlanEntry[]): string {
  if (plan.length === 0) return "Plan: no side effects were proposed.";
  const lines = [`Plan: ${plan.length} intended side effect${plan.length === 1 ? "" : "s"} (nothing was executed)`];
  plan.forEach((entry, i) => {
    const approval = entry.wouldRequireApproval ? "  [needs approval]" : "";
    lines.push(`${i + 1}. ${entry.tool} [${entry.sideEffect}]${approval}`);
    lines.push(`   ${entry.summary}`);
    lines.push(`   policy: ${entry.policy.effect} (${entry.policy.decidedBy})`);
    lines.push(`   args: ${JSON.stringify(entry.args)}`);
    for (const change of renderDiff(entry.diff)) lines.push(`   diff: ${change}`);
  });
  return lines.map(sanitizeText).join("\n");
}
