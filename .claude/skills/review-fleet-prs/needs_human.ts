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

// `gh pr edit --add-label` is idempotent, so without this check an add would
// report addedNeedsHuman: true even when a human or a worker lane's own
// escalation (see stall_repair.ts) had already put the label on — and a later
// approve/send-back would then strip a label this skill never added.
async function hasNeedsHumanLabel(
  pr: { repo: string; number: number },
  runGh: RunGh,
): Promise<boolean> {
  const out = await runGh([
    "pr",
    "view",
    String(pr.number),
    "-R",
    pr.repo,
    "--json",
    "labels",
  ]);
  const parsed = JSON.parse(out) as { labels?: { name: string }[] };
  // Case-insensitive: `gh pr edit` resolves label names case-insensitively
  // (GitHub label names are case-insensitively unique), so a canonical label
  // spelled e.g. `Needs-Human` must still match (same convention as
  // label_security.ts and stall_repair.ts).
  return (parsed.labels ?? []).some(
    (l) => l.name.trim().toLowerCase() === NEEDS_HUMAN,
  );
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

  if (action === "add") {
    // Best-effort ownership check: a failed read falls through to the add
    // attempt below, same as before this check existed.
    const alreadyPresent = await hasNeedsHumanLabel(pr, runGh).catch(() =>
      false
    );
    if (alreadyPresent) {
      // Someone else already holds this PR — never claim it as added by us.
      return { addedNeedsHuman: previous?.addedNeedsHuman === true };
    }
  }

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
