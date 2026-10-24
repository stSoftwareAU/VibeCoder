/**
 * The finish-deadline budget of one agent session (Issue #4244, part of #4224).
 *
 * The run's timeline (`run_timeline.ts`) names the instant the run must have
 * finished by. An agent session started late in the run must not outlive it,
 * so each session's timeout is the smaller of the one its caller asked for and
 * the time left before the finish, less the kill grace and the WIP checkpoint
 * reserve (so the commit-and-push still lands). A session with too little
 * time left is not started at all, and the agent is told the deadline in the
 * last line of its user prompt (never the system prompt, whose bytes the
 * prompt cache keys on).
 *
 * Pure: the timeline and the current time are passed in, so every branch is
 * testable with an injected clock.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { WIP_CHECKPOINT_RESERVE_SECONDS } from "./run_hard_cap.ts";
import type { RunTimeline } from "./run_timeline.ts";

/**
 * The least time an agent session is worth starting with (Issue #4244).
 *
 * A session given less than this before the finish deadline cannot read the
 * task, change anything and push it, so it is not spawned.
 */
export const MIN_AGENT_SESSION_SECONDS = 120;

/** What the finish deadline allows one session. */
export type AgentSessionBudget =
  | {
    /** The session may start; `timeoutSeconds` is what it gets. */
    readonly kind: "run";
    readonly timeoutSeconds: number;
    /** True when the finish deadline cut the requested timeout short. */
    readonly clamped: boolean;
    /** Epoch-ms past which the session must not run (finish − grace − reserve). */
    readonly limitMs: number;
    /** The finish deadline, ISO-8601. */
    readonly finishIso: string;
    /** Whole seconds from now to the finish deadline. */
    readonly remainingToFinishSeconds: number;
  }
  | {
    /** Too little time is left; the session must not be spawned. */
    readonly kind: "refuse";
    readonly availableSeconds: number;
    readonly finishIso: string;
  };

/**
 * Decide what the finish deadline allows a session started now.
 *
 * The floor applies to the time the deadline leaves, not to the requested
 * timeout: a 30 s health check is not refused for being short, only a run with
 * under {@link MIN_AGENT_SESSION_SECONDS} left before the finish.
 *
 * @param input - The timeline, current epoch-ms, requested timeout and grace.
 * @returns Whether to run (and with what timeout) or to refuse.
 */
export function planAgentSessionBudget(input: {
  timeline: RunTimeline;
  nowMs: number;
  requestedSeconds: number;
  killAfterSeconds: number;
}): AgentSessionBudget {
  const { timeline, nowMs, requestedSeconds, killAfterSeconds } = input;
  const reserveMs = (killAfterSeconds + WIP_CHECKPOINT_RESERVE_SECONDS) * 1000;
  const finishIso = new Date(timeline.finishMs).toISOString();
  const availableMs = timeline.clampToFinishMs(Infinity, nowMs, reserveMs);
  const availableSeconds = Math.floor(availableMs / 1000);
  if (availableSeconds < MIN_AGENT_SESSION_SECONDS) {
    return { kind: "refuse", availableSeconds, finishIso };
  }
  const clamped = availableSeconds < requestedSeconds;
  return {
    kind: "run",
    timeoutSeconds: clamped ? availableSeconds : requestedSeconds,
    clamped,
    limitMs: timeline.finishMs - reserveMs,
    finishIso,
    remainingToFinishSeconds: Math.floor(
      timeline.remainingToFinishMs(nowMs) / 1000,
    ),
  };
}

/**
 * The worker-written line appended to the end of the agent's user prompt.
 *
 * @param budget - A session budget that may run.
 * @returns The text to append: a blank line, then one sentence.
 */
export function finishDeadlinePromptLine(
  budget: Extract<AgentSessionBudget, { kind: "run" }>,
): string {
  return `\n\nWorker note: this run's finish deadline is ${budget.finishIso} ` +
    `(${budget.remainingToFinishSeconds}s remaining). You must commit and ` +
    `push your work before then.`;
}
