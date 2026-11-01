// The `needs-human` label a held /review-fleet-prs PR carries (Issue #2927).

import type { LogRecord, Outcome } from "./review_log.ts";
import { REVIEW_MARKER, sameLogin } from "./review_log.ts";

export const NEEDS_HUMAN = "needs-human";

export type LabelAction = "add" | "remove";

export interface LabelError {
  action: LabelAction;
  error: string;
}

export type RunGh = (args: string[]) => Promise<string>;

/** A current change request from anyone else preserves the shared label. */
export async function hasIndependentReviewHold(
  pr: { repo: string; number: number },
  reviewer: string,
  runGh: RunGh,
): Promise<boolean> {
  const pages = JSON.parse(
    await runGh([
      "api",
      `repos/${pr.repo}/pulls/${pr.number}/reviews`,
      "--paginate",
      "--slurp",
    ]),
  );
  if (!Array.isArray(pages) || !pages.every(Array.isArray)) {
    throw new Error("malformed review history");
  }
  const latest = new Map<string, string>();
  for (const review of pages.flat()) {
    if (
      typeof review?.user?.login !== "string" ||
      typeof review.state !== "string"
    ) {
      throw new Error("malformed review in history");
    }
    if (
      !sameLogin(review.user.login, reviewer) &&
      ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state)
    ) {
      latest.set(review.user.login.toLowerCase(), review.state);
    }
  }
  return [...latest.values()].includes("CHANGES_REQUESTED");
}

/** Recover an old host's ownership only from complete GitHub history. */
export async function reviewerOwnedLabelFromHistory(
  pr: { repo: string; number: number; headSha: string },
  reviewer: string,
  runGh: RunGh,
): Promise<boolean> {
  const readPages = async (path: string): Promise<unknown[]> => {
    const pages = JSON.parse(
      await runGh(["api", path, "--paginate", "--slurp"]),
    );
    if (!Array.isArray(pages) || !pages.every(Array.isArray)) {
      throw new Error("malformed GitHub history");
    }
    return pages.flat();
  };
  const object = (v: unknown): Record<string, unknown> | undefined =>
    typeof v === "object" && v !== null && !Array.isArray(v)
      ? v as Record<string, unknown>
      : undefined;
  const events = await readPages(`repos/${pr.repo}/issues/${pr.number}/events`);
  const labels: Record<string, unknown>[] = [];
  for (const event of events) {
    const e = object(event);
    if (!e || typeof e.event !== "string") {
      throw new Error("malformed issue event");
    }
    if (e.event !== "labeled" && e.event !== "unlabeled") continue;
    const label = object(e.label);
    if (typeof label?.name !== "string") {
      throw new Error("malformed label event");
    }
    if (label.name.toLowerCase() === NEEDS_HUMAN) labels.push(e);
  }
  const last = labels.at(-1);
  const actor = object(last?.actor);
  if (
    !last || last.event !== "labeled" || typeof actor?.login !== "string" ||
    !sameLogin(actor.login, reviewer) ||
    typeof last.created_at !== "string" ||
    !Number.isFinite(Date.parse(last.created_at))
  ) return false;
  const reviews = await readPages(
    `repos/${pr.repo}/pulls/${pr.number}/reviews`,
  );
  if (
    reviews.some((item) => {
      const r = object(item);
      const user = object(r?.user);
      return r?.state === "CHANGES_REQUESTED" &&
        typeof user?.login === "string" && !sameLogin(user.login, reviewer);
    })
  ) return false;
  return reviews.some((item) => {
    const r = object(item);
    const user = object(r?.user);
    return r?.state === "COMMENTED" && typeof user?.login === "string" &&
      sameLogin(user.login, reviewer) && r.commit_id === pr.headSha &&
      typeof r.body === "string" &&
      r.body.startsWith(
        "Held for owner review: this PR changes existing tests.",
      ) &&
      r.body.includes(REVIEW_MARKER) && typeof r.submitted_at === "string" &&
      Number.isFinite(Date.parse(r.submitted_at)) &&
      Date.parse(r.submitted_at) <= Date.parse(last.created_at as string);
  });
}

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
  if (
    !Array.isArray(parsed.labels) ||
    !parsed.labels.every((label) => typeof label.name === "string")
  ) {
    throw new Error("PR response lacks a valid labels list");
  }
  // Case-insensitive: `gh pr edit` resolves label names case-insensitively
  // (GitHub label names are case-insensitively unique), so a canonical label
  // spelled e.g. `Needs-Human` must still match (same convention as
  // label_security.ts and stall_repair.ts).
  return parsed.labels.some(
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
    // Without a successful read an idempotent add cannot establish ownership.
    let alreadyPresent: boolean;
    try {
      alreadyPresent = await hasNeedsHumanLabel(pr, runGh);
    } catch (e) {
      return {
        addedNeedsHuman: previous?.addedNeedsHuman === true,
        labelError: {
          action: "add",
          error: `could not read labels: ${(e as Error).message}`,
        },
      };
    }
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
