import type { Agent, RunResult } from "../agent.js";
import type { ApprovalRequest, ApprovalStore } from "../approvals.js";
import type { ManualClock } from "../clock.js";

/** What a scripted reviewer does with a pending approval. `ignore` leaves it undecided while time passes. */
export type ReviewerAction = "approve" | "deny" | "ignore" | { action: "deny"; reason: string };

export interface ReviewerDriverOptions {
  /** Builds a fresh agent each time, simulating a process restart: only the stores carry state across. */
  makeAgent(): Agent;
  approvals: ApprovalStore;
  clock: ManualClock;
  task: string;
  salt?: string;
  decide(request: ApprovalRequest): ReviewerAction;
  /** Simulated time the reviewer takes to respond, in ms. Default 60 000. */
  reviewDelayMs?: number;
  maxPauses?: number;
  onPause?(request: ApprovalRequest): void;
}

/**
 * Runs an agent to completion with a scripted human in the loop: start, pause on approval,
 * decide, resume with a new agent instance, repeat.
 */
export async function runWithReviewer(options: ReviewerDriverOptions): Promise<RunResult> {
  const maxPauses = options.maxPauses ?? 10;
  let result = await options.makeAgent().run({ task: options.task, ...(options.salt ? { salt: options.salt } : {}) });
  for (let pauses = 0; result.status === "paused"; pauses++) {
    if (pauses >= maxPauses) throw new Error(`run still paused after ${maxPauses} approvals`);
    for (const request of result.pendingApprovals) {
      options.onPause?.(request);
      options.clock.advance(options.reviewDelayMs ?? 60_000);
      const action = options.decide(request);
      if (action === "approve") await options.approvals.decide(request.id, "approved", "scripted-reviewer");
      else if (action === "deny") await options.approvals.decide(request.id, "denied", "scripted-reviewer");
      else if (action === "ignore") {
        if (request.expiresAt === undefined) throw new Error("cannot let an approval without a timeout expire");
        options.clock.advance(Math.max(0, request.expiresAt - options.clock.now()) + 1);
      } else await options.approvals.decide(request.id, "denied", "scripted-reviewer", action.reason);
    }
    result = await options.makeAgent().resume(result.runId);
  }
  return result;
}
