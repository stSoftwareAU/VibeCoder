/**
 * Consecutive PR branch-update failure streaks per `(repo, branch)`
 * (Issue #335).
 *
 * The branch-update pass logs a failure and moves on, and the next cycle tries
 * the same branch again from scratch. Across one recent log window that meant
 * 65 identical `Failed to checkout branch 'issue-3832-detect-cycles-linear'`
 * warnings for one branch: a permanent condition retried hourly, at WARNING,
 * for days, with nothing concluding that it would never succeed.
 *
 * This module gives that failure a memory. It counts consecutive **cycles** in
 * which a given branch fails to update and, at
 * {@link PR_BRANCH_UPDATE_FAILURE_THRESHOLD}, files **one** issue against the
 * repo that owns the branch — naming the PR, the branch, the consecutive count
 * and the underlying git error. Once escalated the branch is skipped rather
 * than retried every cycle, with a bounded re-probe every
 * {@link PR_BRANCH_UPDATE_RETRY_AFTER_SKIPS} cycles so a branch that is fixed
 * heals itself instead of staying suppressed for ever.
 *
 * **Per `(repo, branch)`**, so one bad branch never suppresses updates for the
 * rest, and **cycles, not attempts**: the pass can run more than once per
 * cycle, and a momentary failure must not escalate within a single cycle.
 *
 * Shape follows this repo's existing recurring-failure surfaces —
 * `bump_script_failure_streak.ts` (Issue #207) and `idle_inversion_streak.ts`
 * (Issue #321): a small JSON state file written atomically, and marker-based
 * dedup on the issue body rather than the title, so two hosts watching the
 * same repo converge on one issue.
 *
 * Repo isolation: the issue is filed against the repo whose branch is stuck —
 * the fix belongs there, never in a central repo.
 *
 * The issue is filed with no label. The worker cannot self-apply `work-on`
 * (`worker_label_guard.ts` strips a worker-applied pickup label on the next
 * scan), so the body asks a human to apply it.
 *
 * Best-effort throughout: never throws, so the branch-update pass can call it
 * without a guard. Every failure is logged rather than swallowed.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { atomicWrite } from "./file_utils.ts";
import { withStateLock } from "./state_mutex.ts";

/** Consecutive failing cycles before an issue is filed. */
export const PR_BRANCH_UPDATE_FAILURE_THRESHOLD = 3;

/**
 * Cycles an escalated branch is skipped before one re-probe is allowed.
 *
 * Without this a branch fixed after escalation would never be retried; with
 * it the log cost of a permanently broken branch falls from one warning per
 * cycle to one per this many cycles.
 */
export const PR_BRANCH_UPDATE_RETRY_AFTER_SKIPS = 10;

/** State file name, placed in the worker's work directory. */
export const PR_BRANCH_UPDATE_FAILURE_STATE_FILE =
  "pr_branch_update_failures.json";

/** Body marker prefix used to dedup the escalation issue. */
export const PR_BRANCH_UPDATE_FAILURE_MARKER_PREFIX =
  "VIBE_PR_BRANCH_UPDATE_FAILURE";

/** One branch's streak state. */
export interface PrBranchFailureEntry {
  /** Consecutive cycles this branch failed to update. */
  count: number;
  /** Cycle that last changed this entry — repeats within it are ignored. */
  lastCycleId: string;
  /** Cycles skipped since the last re-probe of an escalated branch. */
  skippedCycles: number;
  /** Issue filed for this streak; set once so it is filed once. */
  issueNumber?: number;
}

/** Streak state keyed by {@link prBranchFailureKey}. */
export type PrBranchFailureStreaks = Record<string, PrBranchFailureEntry>;

/** State key for one PR branch. */
export function prBranchFailureKey(repo: string, branch: string): string {
  return `${repo}#${branch}`;
}

/** Resolve the streak file path for a work directory. */
export function prBranchFailureStatePath(workDir: string): string {
  return `${workDir}/${PR_BRANCH_UPDATE_FAILURE_STATE_FILE}`;
}

/** Load streaks; a missing or corrupt file reads as empty. */
export async function loadPrBranchFailureStreaks(
  path: string,
): Promise<PrBranchFailureStreaks> {
  try {
    const parsed = JSON.parse(await Deno.readTextFile(path));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const streaks: PrBranchFailureStreaks = {};
    for (const [key, value] of Object.entries(parsed)) {
      const entry = value as Partial<PrBranchFailureEntry> | null;
      if (
        !entry || typeof entry !== "object" ||
        typeof entry.count !== "number" || !Number.isFinite(entry.count)
      ) {
        continue;
      }
      streaks[key] = {
        count: Math.max(0, Math.floor(entry.count)),
        lastCycleId: typeof entry.lastCycleId === "string"
          ? entry.lastCycleId
          : "",
        skippedCycles: typeof entry.skippedCycles === "number" &&
            Number.isFinite(entry.skippedCycles)
          ? Math.max(0, Math.floor(entry.skippedCycles))
          : 0,
        ...(typeof entry.issueNumber === "number" && entry.issueNumber > 0
          ? { issueNumber: Math.floor(entry.issueNumber) }
          : {}),
      };
    }
    return streaks;
  } catch {
    // Missing or corrupt — the streak simply restarts.
    return {};
  }
}

/** Persist streaks atomically; a failed write is reported, never silent. */
export async function savePrBranchFailureStreaks(
  path: string,
  streaks: PrBranchFailureStreaks,
  log: (message: string) => void = (m) => console.error(m),
): Promise<boolean> {
  const result = await atomicWrite({
    targetFile: path,
    content: JSON.stringify(streaks, null, 2) + "\n",
  });
  if (!result.ok) {
    log(
      `[pr-branch-failure] could not persist ${path}: ${result.error.message} ` +
        `— the streak will restart on the next cycle`,
    );
    return false;
  }
  return true;
}

/** The dedup marker carried by a branch's escalation issue body. */
export function formatPrBranchFailureMarker(
  repo: string,
  branch: string,
): string {
  return `<!-- ${PR_BRANCH_UPDATE_FAILURE_MARKER_PREFIX}:${
    prBranchFailureKey(repo, branch)
  } -->`;
}

/** Whether a body is the auto-filed escalation issue for this branch. */
export function isPrBranchFailureIssue(
  body: string,
  repo: string,
  branch: string,
): boolean {
  return (body ?? "").includes(formatPrBranchFailureMarker(repo, branch));
}

/** Stable title; dedup never uses it, humans find the issue by it. */
export function formatPrBranchFailureTitle(
  prNumber: number,
  branch: string,
): string {
  return `fix: PR #${prNumber} branch '${branch}' fails to update on every ` +
    `cycle — the worker cannot keep it current`;
}

/** What the branch-update pass saw, for the issue body. */
export interface PrBranchFailureReport {
  /** Repository in `owner/repo` form — where the issue is filed. */
  repo: string;
  /** PR whose head branch is stuck. */
  prNumber: number;
  /** The head branch that will not update. */
  branch: string;
  /** The base branch the update targets. */
  baseBranch: string;
  /** The underlying git failure, verbatim. */
  error: string;
  /** Consecutive cycles the failure has held. */
  consecutiveCycles: number;
}

/** Escape so git output cannot close our fence or forge a marker. */
function bodySafe(text: string): string {
  return text.replace(/<!--/g, "<!- -").replace(/-->/g, "- ->")
    .replace(/```/g, "'''");
}

/** Issue body: marker first, then the diagnosis and what to do. */
export function formatPrBranchFailureBody(
  report: PrBranchFailureReport,
): string {
  return [
    formatPrBranchFailureMarker(report.repo, report.branch),
    "",
    `Auto-filed by the Vibe Coder (Issue #335): the branch-update pass has ` +
    `failed to bring PR #${report.prNumber}'s head branch ` +
    `\`${report.branch}\` up to date with \`${report.baseBranch}\` on ` +
    `**${report.consecutiveCycles} consecutive cycles**.`,
    "",
    "A failure that repeats every cycle is not transient — nothing the worker " +
    "does will clear it, so the PR never gets its branch updated and never " +
    "merges.",
    "",
    "## The underlying git failure",
    "",
    "```",
    bodySafe(report.error),
    "```",
    "",
    "## What to check",
    "",
    `1. Whether \`${report.branch}\` still exists on origin, and whether the ` +
    "PR should simply be closed.",
    "2. The git error above, reproduced in a fresh clone: a missing ref, a " +
    "dirty tree, or a checkout the worker's clone can never perform.",
    "3. Whether the PR's head branch was force-pushed or renamed out from " +
    "under the open PR.",
    "",
    "Until this is resolved the worker skips this branch rather than retrying " +
    `it every cycle, re-probing once every ` +
    `${PR_BRANCH_UPDATE_RETRY_AFTER_SKIPS} cycles. The streak clears — and ` +
    "normal updates resume — the moment one update succeeds.",
    "",
    "Apply `work-on` to schedule the fix — the worker cannot self-apply that " +
    "label.",
  ].join("\n");
}

/** Outcome of one recorded failing cycle. */
export type PrBranchFailureDecision =
  /** Already counted this cycle — nothing to do. */
  | { action: "already-counted"; count: number }
  /** Below the threshold — counted only. */
  | { action: "counted"; count: number }
  /** Threshold reached and an issue was filed. */
  | { action: "filed"; count: number; issueNumber: number }
  /** Threshold reached; an open issue already covers it. */
  | { action: "already-open"; count: number; issueNumber: number }
  /** This streak has already filed its issue. */
  | { action: "already-filed"; count: number; issueNumber?: number }
  /** Threshold reached but GitHub could not be reached. */
  | { action: "gh-failed"; count: number; reason: string };

/** Options for {@link recordPrBranchUpdateFailure}. */
export interface RecordPrBranchFailureOptions {
  statePath: string;
  report: Omit<PrBranchFailureReport, "consecutiveCycles">;
  /** Identifies this cycle — repeats within it do not increment. */
  cycleId: string;
  /** gh runner: resolves stdout, rejects on failure. */
  ghFn: (args: string[]) => Promise<string>;
  /** Threshold override (tests). */
  threshold?: number;
  /** Sink for diagnostics. */
  log?: (message: string) => void;
}

/** Parse the issue number out of `gh issue create` output. */
function parseCreatedIssueNumber(output: string): number {
  const match = /\/issues\/(\d+)\s*$/.exec(output.trim());
  return match ? parseInt(match[1]!, 10) : 0;
}

/**
 * Find the open escalation issue for this branch, or null when there is none.
 * Throws when the search itself failed — a lookup we could not perform must
 * not read as "no issue exists" and file a duplicate.
 */
async function findOpenEscalationIssue(
  repo: string,
  branch: string,
  ghFn: (args: string[]) => Promise<string>,
): Promise<number | null> {
  const raw = await ghFn([
    "issue",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    "--search",
    `"${PR_BRANCH_UPDATE_FAILURE_MARKER_PREFIX}:${
      prBranchFailureKey(repo, branch)
    }" in:body`,
    "--json",
    "number,body",
    "--limit",
    "20",
  ]);
  const rows = JSON.parse(raw || "[]") as { number: number; body?: string }[];
  const match = rows
    .filter((row) => isPrBranchFailureIssue(row.body ?? "", repo, branch))
    .sort((a, b) => a.number - b.number)[0];
  return match ? match.number : null;
}

/**
 * Record one cycle in which a PR branch failed to update.
 *
 * Never throws: a GitHub or filesystem failure is returned as a decision and
 * logged, so the branch-update pass is never derailed by its own reporting.
 */
export async function recordPrBranchUpdateFailure(
  opts: RecordPrBranchFailureOptions,
): Promise<PrBranchFailureDecision> {
  const log = opts.log ?? ((message: string) => console.error(message));
  const threshold = opts.threshold ?? PR_BRANCH_UPDATE_FAILURE_THRESHOLD;
  const { repo, branch } = opts.report;
  const key = prBranchFailureKey(repo, branch);

  try {
    return await withStateLock(
      `pr-branch-failure:${opts.statePath}`,
      async () => {
        const streaks = await loadPrBranchFailureStreaks(opts.statePath);
        const entry = streaks[key] ??
          { count: 0, lastCycleId: "", skippedCycles: 0 };

        // Cycles, not attempts: the pass can run more than once per cycle.
        if (entry.lastCycleId === opts.cycleId) {
          return { action: "already-counted" as const, count: entry.count };
        }
        entry.count++;
        entry.lastCycleId = opts.cycleId;
        entry.skippedCycles = 0;
        streaks[key] = entry;

        const decision = await decide(entry, threshold, opts, log);
        await savePrBranchFailureStreaks(opts.statePath, streaks, log);
        return decision;
      },
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log(`[pr-branch-failure] ${key}: streak update failed: ${reason}`);
    return { action: "gh-failed", count: 0, reason };
  }
}

/** Threshold handling for one recorded cycle; mutates `entry` on filing. */
async function decide(
  entry: PrBranchFailureEntry,
  threshold: number,
  opts: RecordPrBranchFailureOptions,
  log: (message: string) => void,
): Promise<PrBranchFailureDecision> {
  const { repo, branch, prNumber } = opts.report;
  const key = prBranchFailureKey(repo, branch);
  if (entry.count < threshold) {
    return { action: "counted", count: entry.count };
  }
  if (entry.issueNumber !== undefined) {
    return {
      action: "already-filed",
      count: entry.count,
      issueNumber: entry.issueNumber,
    };
  }

  let existing: number | null;
  try {
    existing = await findOpenEscalationIssue(repo, branch, opts.ghFn);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log(
      `[pr-branch-failure] ${key}: could not search for an existing ` +
        `escalation issue: ${reason} — not filing (a duplicate is worse)`,
    );
    return { action: "gh-failed", count: entry.count, reason };
  }

  if (existing !== null) {
    entry.issueNumber = existing;
    return {
      action: "already-open",
      count: entry.count,
      issueNumber: existing,
    };
  }

  try {
    const created = await opts.ghFn([
      "issue",
      "create",
      "--repo",
      repo,
      "--title",
      formatPrBranchFailureTitle(prNumber, branch),
      "--body",
      formatPrBranchFailureBody({
        ...opts.report,
        consecutiveCycles: entry.count,
      }),
    ]);
    const issueNumber = parseCreatedIssueNumber(created);
    if (issueNumber > 0) entry.issueNumber = issueNumber;
    return { action: "filed", count: entry.count, issueNumber };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log(`[pr-branch-failure] ${key}: could not file the issue: ${reason}`);
    return { action: "gh-failed", count: entry.count, reason };
  }
}

/** Whether this cycle should skip a branch, and why. */
export interface PrBranchSuppression {
  /** True when the branch is escalated and this cycle must not retry it. */
  suppressed: boolean;
  /** Consecutive failing cycles recorded so far. */
  count: number;
  /** The escalation issue, when one has been filed. */
  issueNumber?: number;
}

/** Options for {@link checkPrBranchUpdateSuppression}. */
export interface CheckPrBranchSuppressionOptions {
  statePath: string;
  repo: string;
  branch: string;
  /** Identifies this cycle — repeats within it do not count twice. */
  cycleId: string;
  /** Skipped cycles allowed before one re-probe (tests). */
  retryAfterSkips?: number;
  /** Sink for diagnostics. */
  log?: (message: string) => void;
}

/**
 * Decide whether an escalated branch is skipped this cycle.
 *
 * Only a branch whose streak has already filed an issue is ever suppressed,
 * and it is re-probed once every `retryAfterSkips` cycles so a branch that is
 * fixed recovers on its own. Never throws — a state failure means "do not
 * suppress", so the pass degrades to today's behaviour rather than silently
 * skipping work.
 */
export async function checkPrBranchUpdateSuppression(
  opts: CheckPrBranchSuppressionOptions,
): Promise<PrBranchSuppression> {
  const log = opts.log ?? ((message: string) => console.error(message));
  const retryAfter = opts.retryAfterSkips ?? PR_BRANCH_UPDATE_RETRY_AFTER_SKIPS;
  const key = prBranchFailureKey(opts.repo, opts.branch);
  try {
    return await withStateLock(
      `pr-branch-failure:${opts.statePath}`,
      async () => {
        const streaks = await loadPrBranchFailureStreaks(opts.statePath);
        const entry = streaks[key];
        if (!entry || entry.issueNumber === undefined) {
          return { suppressed: false, count: entry?.count ?? 0 };
        }
        // Already accounted for this cycle — hold the same verdict.
        if (entry.lastCycleId === opts.cycleId) {
          return {
            suppressed: entry.skippedCycles > 0,
            count: entry.count,
            issueNumber: entry.issueNumber,
          };
        }
        entry.lastCycleId = opts.cycleId;
        if (entry.skippedCycles >= retryAfter) {
          // Re-probe: let this cycle attempt the update again.
          entry.skippedCycles = 0;
          await savePrBranchFailureStreaks(opts.statePath, streaks, log);
          return {
            suppressed: false,
            count: entry.count,
            issueNumber: entry.issueNumber,
          };
        }
        entry.skippedCycles++;
        await savePrBranchFailureStreaks(opts.statePath, streaks, log);
        return {
          suppressed: true,
          count: entry.count,
          issueNumber: entry.issueNumber,
        };
      },
    );
  } catch (err) {
    log(
      `[pr-branch-failure] ${key}: could not read the streak: ${
        err instanceof Error ? err.message : String(err)
      } — not suppressing`,
    );
    return { suppressed: false, count: 0 };
  }
}

/**
 * Clear a branch's streak after a successful update. A no-op when nothing is
 * tracked. Never throws.
 */
export async function clearPrBranchUpdateFailure(
  statePath: string,
  repo: string,
  branch: string,
  log: (message: string) => void = (m) => console.error(m),
): Promise<void> {
  const key = prBranchFailureKey(repo, branch);
  try {
    await withStateLock(`pr-branch-failure:${statePath}`, async () => {
      const streaks = await loadPrBranchFailureStreaks(statePath);
      if (!(key in streaks)) return;
      delete streaks[key];
      await savePrBranchFailureStreaks(statePath, streaks, log);
    });
  } catch (err) {
    log(
      `[pr-branch-failure] ${key}: could not clear the streak: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
