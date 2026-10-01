// The `needs-human` label a held /review-fleet-prs PR carries (Issue #2927).

import type { LogRecord, Outcome } from "./review_log.ts";

export const NEEDS_HUMAN = "needs-human";

export type LabelAction = "add" | "remove";

export interface LabelError {
  action: LabelAction;
  error: string;
}

export type RunGh = (args: string[]) => Promise<string>;

// add for a hold; remove only when the PR's latest log record says the skill added it.
export function needsHumanAction(
  outcome: Outcome,
  previous: LogRecord | undefined,
): LabelAction | undefined {
  if (outcome === "held") return "add";
  return previous?.addedNeedsHuman === true ? "remove" : undefined;
}

// Best effort, never throws: a failed label call never stops the review
// being posted, and is reported via labelError so the caller can log it.
export async function syncNeedsHumanLabel(
  outcome: Outcome,
  previous: LogRecord | undefined,
  pr: { repo: string; number: number },
  runGh: RunGh,
): Promise<{ addedNeedsHuman: boolean; labelError?: LabelError }> {
  const action = needsHumanAction(outcome, previous);
  if (!action) return { addedNeedsHuman: false };
  try {
    await runGh([
      "pr",
      "edit",
      String(pr.number),
      "-R",
      pr.repo,
      action === "add" ? "--add-label" : "--remove-label",
      NEEDS_HUMAN,
    ]);
    return { addedNeedsHuman: action === "add" };
  } catch (e) {
    // A failed add keeps an earlier skill-added label known; a failed removal
    // leaves the label on, so the next approve/send-back tries again.
    return {
      addedNeedsHuman: action === "add"
        ? previous?.addedNeedsHuman === true
        : true,
      labelError: { action, error: (e as Error).message },
    };
  }
}
