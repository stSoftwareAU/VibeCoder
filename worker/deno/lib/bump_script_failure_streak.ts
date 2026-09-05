/**
 * Consecutive `bump-deps.sh` rejection streaks per repo (Issue #207).
 *
 * A repo whose bump script exits non-zero has its bump reverted and the run
 * carries on — correct, but silent: a script that is broken on *every* run
 * disables dependency bumps for that repo for ever and nothing ever says so.
 *
 * This module counts consecutive script rejections per repo across runs and,
 * at {@link BUMP_SCRIPT_FAILURE_THRESHOLD}, files **one** tracking issue
 * against the repo that owns the broken script. The streak clears the moment
 * the script runs cleanly again.
 *
 * Shape follows the fleet's existing recurring-failure surfaces: a small JSON
 * state file written atomically (as `milestone_sync_streak.ts` does) and
 * marker-based dedup on the issue body rather than the title (as
 * `run_failure_issue.ts` does), so two hosts converge on one issue.
 *
 * Repo isolation: the issue is filed against the repo whose `bump-deps.sh` is
 * broken — the fix belongs there, never in a central repo.
 *
 * The issue is filed with no label. The worker cannot self-apply `work-on`
 * (`worker_label_guard.ts`; a worker-applied pickup label is stripped on the
 * next scan), and naming a content label that the target repo may not define
 * would fail the creation outright — the issue existing is the guarantee, so
 * the body asks a human to apply `work-on` to schedule the fix.
 *
 * Best-effort throughout: never throws, so a bump phase can call it without a
 * guard. Every failure is logged rather than swallowed.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  ALERT_DEDUP_JSON_FIELDS,
  type AlertDedupRow,
  selectFleetAuthoredMatches,
} from "./alert_dedup_authors.ts";
import { atomicWrite } from "./file_utils.ts";
import { withStateLock } from "./state_mutex.ts";

/** Consecutive rejections before a tracking issue is filed. */
export const BUMP_SCRIPT_FAILURE_THRESHOLD = 3;

/** State file name, placed in the worker's work directory. */
export const BUMP_SCRIPT_FAILURE_STATE_FILE = "bump_script_failures.json";

/** Body marker prefix used to dedup the tracking issue. */
export const BUMP_SCRIPT_FAILURE_MARKER_PREFIX = "VIBE_BUMP_SCRIPT_FAILURE";

/** One repo's streak state. */
export interface BumpScriptStreakEntry {
  /** Consecutive runs whose bump script exited non-zero. */
  count: number;
  /** Tracking issue filed for this streak; set once so it is filed once. */
  issueNumber?: number;
}

/** Streak state keyed by `owner/repo`. */
export type BumpScriptStreaks = Record<string, BumpScriptStreakEntry>;

/** Resolve the streak file path for a work directory. */
export function bumpScriptStreakPath(workDir: string): string {
  return `${workDir}/${BUMP_SCRIPT_FAILURE_STATE_FILE}`;
}

/** Load streaks; a missing or corrupt file reads as empty. */
export async function loadBumpScriptStreaks(
  path: string,
): Promise<BumpScriptStreaks> {
  try {
    const parsed = JSON.parse(await Deno.readTextFile(path));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const streaks: BumpScriptStreaks = {};
    for (const [repo, value] of Object.entries(parsed)) {
      const entry = value as Partial<BumpScriptStreakEntry> | null;
      if (
        !entry || typeof entry !== "object" ||
        typeof entry.count !== "number" || !Number.isFinite(entry.count)
      ) {
        continue;
      }
      streaks[repo] = {
        count: Math.max(0, Math.floor(entry.count)),
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

/**
 * Persist streaks atomically. Returns false (and says so through `log`) when
 * the write failed — the caller carries on, but the loss is never silent.
 */
export async function saveBumpScriptStreaks(
  path: string,
  streaks: BumpScriptStreaks,
  log: (message: string) => void = (m) => console.error(m),
): Promise<boolean> {
  const result = await atomicWrite({
    targetFile: path,
    content: JSON.stringify(streaks, null, 2) + "\n",
  });
  if (!result.ok) {
    log(
      `[bump-script-streak] Could not persist ${path}: ${result.error.message} ` +
        `— the rejection streak will restart on the next run`,
    );
    return false;
  }
  return true;
}

/** The dedup marker carried by a repo's tracking issue body. */
export function formatBumpScriptFailureMarker(repo: string): string {
  return `<!-- ${BUMP_SCRIPT_FAILURE_MARKER_PREFIX}:${repo} -->`;
}

/** Whether a body is the auto-filed bump-script tracking issue for `repo`. */
export function isBumpScriptFailureIssue(body: string, repo: string): boolean {
  return (body ?? "").includes(formatBumpScriptFailureMarker(repo));
}

/** Stable title; dedup never uses it, humans find the issue by it. */
export function formatBumpScriptFailureTitle(scriptName: string): string {
  return `fix: \`${scriptName}\` fails on every run — dependency bumps are ` +
    `disabled for this repo`;
}

/**
 * Neutralise script output for a GitHub body: it must not close our fenced
 * block, nor forge an HTML comment that a later marker read would trust.
 */
function bodySafe(text: string): string {
  return text
    .replace(/<!--/g, "<!- -")
    .replace(/-->/g, "- ->")
    .replace(/```/g, "'''");
}

/** What the bump phase knows about the failing script. */
export interface BumpScriptFailureReport {
  /** Repo that owns the broken script (`owner/repo`). */
  repo: string;
  /** Script filename, e.g. `bump-deps.sh`. */
  scriptName: string;
  /** Consecutive runs rejected so far. */
  consecutiveFailures: number;
  /** Single-line rejection summary from `BumpInfo.rejectionReason`. */
  rejectionReason: string;
  /** Secret-redacted tail of the script's combined output. */
  outputTail: string;
  /** Issue the run was working when the rejection happened. */
  sourceIssueNumber?: number;
}

/** Issue body: marker first, then the diagnosis and what to do. */
export function formatBumpScriptFailureBody(
  report: BumpScriptFailureReport,
): string {
  const tail = report.outputTail.trim().length > 0
    ? ["```", bodySafe(report.outputTail), "```"]
    : ["_The script produced no output._"];
  return [
    formatBumpScriptFailureMarker(report.repo),
    "",
    `Auto-filed by the Vibe Coder (Issue #207): \`${report.scriptName}\` in ` +
    `this repo has exited non-zero on **${report.consecutiveFailures} ` +
    `consecutive runs**. Each time, the worker reverted the bump and carried ` +
    `on — so dependency bumps are silently disabled for this repo until the ` +
    `script is fixed.`,
    "",
    `**Last rejection:** ${bodySafe(report.rejectionReason)}`,
    ...(report.sourceIssueNumber
      ? [`**Seen while working:** #${report.sourceIssueNumber}`]
      : []),
    "",
    `## \`${report.scriptName}\` output (secret-redacted tail)`,
    "",
    ...tail,
    "",
    "## What to do",
    "",
    `1. Reproduce with \`bash ${report.scriptName}\` in a clean checkout.`,
    "2. Fix the script (a missing tool on the unattended `PATH` and a " +
    "registry error are the two usual causes) so it exits `0` on a no-op.",
    "3. Apply `work-on` to schedule the fix — the worker cannot self-apply " +
    "that label.",
    "",
    "The worker files this issue once per streak; it does not re-file while " +
    "this issue stays open.",
  ].join("\n");
}

/** Outcome of one recorded rejection. */
export type BumpScriptStreakDecision =
  /** Below the threshold — counted only. */
  | { action: "counted"; count: number }
  /** Threshold reached and a tracking issue was created. */
  | { action: "filed"; count: number; issueNumber: number }
  /** Threshold reached; an open tracking issue already covers it. */
  | { action: "already_open"; count: number; issueNumber: number }
  /** This streak has already filed its issue. */
  | { action: "already_filed"; count: number; issueNumber?: number }
  /** Threshold reached but GitHub could not be reached. */
  | { action: "gh_failed"; count: number; reason: string };

/** Options for {@link recordBumpScriptRejection}. */
export interface RecordBumpScriptRejectionOptions {
  /** Path to the streak state file. */
  statePath: string;
  /** Report describing this rejection (its `consecutiveFailures` is ignored). */
  report: Omit<BumpScriptFailureReport, "consecutiveFailures">;
  /** gh runner: resolves stdout, rejects on failure. */
  ghFn: (args: string[]) => Promise<string>;
  /** Threshold override (tests). */
  threshold?: number;
  /** Sink for diagnostics. */
  log?: (message: string) => void;
  /**
   * Fleet logins whose escalation markers are trusted.
   *
   * A marker in an issue body is text anyone can write, so a dedup match is
   * only evidence the alert already exists when a fleet account authored it.
   * Omitted means "read the configured fleet identity"
   * (`service_accounts` / `fleet_pr_authors` / `GITHUB_USER`), which is what
   * every production caller does. An empty list is an *unresolved* fleet:
   * the match cannot be attributed, so it is not treated as an existing
   * alert and the escalation is raised.
   */
  fleetAuthors?: readonly string[];
}

/** Parse the issue number out of `gh issue create` output. */
function parseCreatedIssueNumber(output: string): number {
  const match = /\/issues\/(\d+)\s*$/.exec(output.trim());
  return match ? parseInt(match[1]!, 10) : 0;
}

/**
 * Find the open tracking issue for `repo`, or `null` when there is none.
 * Throws when the search itself failed — a lookup we could not perform must
 * not read as "no issue exists" and file a duplicate.
 */
async function findOpenTrackingIssue(
  repo: string,
  opts: RecordBumpScriptRejectionOptions,
  log: (message: string) => void,
): Promise<number | null> {
  const raw = await opts.ghFn([
    "issue",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    "--search",
    `"${BUMP_SCRIPT_FAILURE_MARKER_PREFIX}:${repo}" in:body`,
    "--json",
    ALERT_DEDUP_JSON_FIELDS,
    "--limit",
    "20",
  ]);
  const rows = JSON.parse(raw || "[]") as AlertDedupRow[];
  const verified = await selectFleetAuthoredMatches(
    rows.filter((row) => isBumpScriptFailureIssue(row.body ?? "", repo)),
    `bump-script ${repo}`,
    opts,
    log,
  );
  const match = verified.sort((a, b) => a.number - b.number)[0];
  return match ? match.number : null;
}

/**
 * Record one `bump-deps.sh` rejection for a repo and, at the threshold, file
 * the tracking issue once.
 *
 * Never throws: a GitHub or filesystem failure is returned as a decision and
 * logged, so the bump phase is never derailed by its own reporting.
 */
export async function recordBumpScriptRejection(
  opts: RecordBumpScriptRejectionOptions,
): Promise<BumpScriptStreakDecision> {
  const log = opts.log ?? ((message: string) => console.error(message));
  const threshold = opts.threshold ?? BUMP_SCRIPT_FAILURE_THRESHOLD;
  const repo = opts.report.repo;

  try {
    return await withStateLock(
      `bump-script-streak:${opts.statePath}`,
      async () => {
        const streaks = await loadBumpScriptStreaks(opts.statePath);
        const entry = streaks[repo] ?? { count: 0 };
        entry.count++;
        streaks[repo] = entry;

        const decision = await decide(entry, threshold, opts, log);
        await saveBumpScriptStreaks(opts.statePath, streaks, log);
        return decision;
      },
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log(`[bump-script-streak] ${repo}: streak update failed: ${reason}`);
    return { action: "gh_failed", count: 0, reason };
  }
}

/** Threshold handling for one recorded rejection; mutates `entry` on filing. */
async function decide(
  entry: BumpScriptStreakEntry,
  threshold: number,
  opts: RecordBumpScriptRejectionOptions,
  log: (message: string) => void,
): Promise<BumpScriptStreakDecision> {
  const repo = opts.report.repo;
  if (entry.count < threshold) {
    return { action: "counted", count: entry.count };
  }
  if (entry.issueNumber !== undefined) {
    return {
      action: "already_filed",
      count: entry.count,
      issueNumber: entry.issueNumber,
    };
  }

  let existing: number | null;
  try {
    existing = await findOpenTrackingIssue(repo, opts, log);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log(
      `[bump-script-streak] ${repo}: could not search for an existing ` +
        `tracking issue: ${reason} — not filing (a duplicate is worse)`,
    );
    return { action: "gh_failed", count: entry.count, reason };
  }

  if (existing !== null) {
    entry.issueNumber = existing;
    return {
      action: "already_open",
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
      formatBumpScriptFailureTitle(opts.report.scriptName),
      "--body",
      formatBumpScriptFailureBody({
        ...opts.report,
        consecutiveFailures: entry.count,
      }),
    ]);
    const issueNumber = parseCreatedIssueNumber(created);
    if (issueNumber > 0) entry.issueNumber = issueNumber;
    return { action: "filed", count: entry.count, issueNumber };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log(
      `[bump-script-streak] ${repo}: could not file the tracking issue: ` +
        `${reason}`,
    );
    return { action: "gh_failed", count: entry.count, reason };
  }
}

/**
 * Clear a repo's streak after its bump script ran cleanly (or disappeared).
 * A no-op when nothing is tracked. Never throws.
 */
export async function clearBumpScriptStreak(
  statePath: string,
  repo: string,
  log: (message: string) => void = (m) => console.error(m),
): Promise<void> {
  try {
    await withStateLock(`bump-script-streak:${statePath}`, async () => {
      const streaks = await loadBumpScriptStreaks(statePath);
      if (!(repo in streaks)) return;
      delete streaks[repo];
      await saveBumpScriptStreaks(statePath, streaks, log);
    });
  } catch (err) {
    log(
      `[bump-script-streak] ${repo}: could not clear the streak: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
