/**
 * Escalating a sustained idle-inversion signal (Issue #321).
 *
 * `idle_decision_census.ts` and `idle_detect_diagnostics.ts` both detect the
 * fleet contradicting itself — the census can see claimable work the claim
 * scan cannot — and both end at `log(...)`. On VibeCoder#187/#188 those lines
 * fired on tick after tick, cycle after cycle, for over a day while the two
 * issues sat unclaimable. The cause (Issue #319) was found by a human asking
 * why, not by the alert. An alert that fires every cycle and changes nothing
 * is indistinguishable from no alert.
 *
 * This module gives the signal a memory. It counts consecutive **cycles** in
 * which a repo raises the inversion, and at
 * {@link IDLE_INVERSION_THRESHOLD} files one issue against that repo.
 *
 * **Cycles, not ticks.** The detector runs several times per cycle — the
 * VibeCoder#319 log shows ticks 1, 2 and 3 inside one — so a per-tick count
 * would escalate within a single cycle and turn a momentary deferral into a
 * filed issue. Each entry records the cycle that last incremented it and
 * ignores repeats.
 *
 * Shape follows this repo's existing recurring-failure surfaces: a small JSON
 * file written atomically, and marker-based dedup on the issue body rather
 * than the title (as `run_failure_issue.ts` does), so two hosts watching the
 * same repo converge on one issue.
 *
 * The issue is filed with no label. The worker cannot self-apply `work-on`
 * (`worker_label_guard.ts` strips a worker-applied pickup label on the next
 * scan), so the body asks a human to apply it.
 *
 * Best-effort throughout: never throws, so the idle path can call it without
 * a guard. Every failure is logged rather than swallowed.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { atomicWrite } from "./file_utils.ts";
import { withStateLock } from "./state_mutex.ts";

/** Consecutive cycles raising the signal before an issue is filed. */
export const IDLE_INVERSION_THRESHOLD = 3;

/** State file name, placed in the worker's work directory. */
export const IDLE_INVERSION_STATE_FILE = "idle_inversion_streak.json";

/** Body marker prefix used to dedup the escalation issue. */
export const IDLE_INVERSION_MARKER_PREFIX = "VIBE_IDLE_INVERSION";

/** One repo's streak state. */
export interface IdleInversionEntry {
  /** Consecutive cycles this repo raised the signal. */
  count: number;
  /** Cycle that last incremented `count` — repeats within it are ignored. */
  lastCycleId: string;
  /** Issue filed for this streak; set once so it is filed once. */
  issueNumber?: number;
}

/** Streak state keyed by `owner/repo`. */
export type IdleInversionStreaks = Record<string, IdleInversionEntry>;

/** Resolve the streak file path for a work directory. */
export function idleInversionStatePath(workDir: string): string {
  return `${workDir}/${IDLE_INVERSION_STATE_FILE}`;
}

/** Load streaks; a missing or corrupt file reads as empty. */
export async function loadIdleInversionStreaks(
  path: string,
): Promise<IdleInversionStreaks> {
  try {
    const parsed = JSON.parse(await Deno.readTextFile(path));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const streaks: IdleInversionStreaks = {};
    for (const [repo, value] of Object.entries(parsed)) {
      const entry = value as Partial<IdleInversionEntry> | null;
      if (
        !entry || typeof entry !== "object" ||
        typeof entry.count !== "number" || !Number.isFinite(entry.count)
      ) {
        continue;
      }
      streaks[repo] = {
        count: Math.max(0, Math.floor(entry.count)),
        lastCycleId: typeof entry.lastCycleId === "string"
          ? entry.lastCycleId
          : "",
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
export async function saveIdleInversionStreaks(
  path: string,
  streaks: IdleInversionStreaks,
  log: (message: string) => void = (m) => console.error(m),
): Promise<boolean> {
  const result = await atomicWrite({
    targetFile: path,
    content: JSON.stringify(streaks, null, 2) + "\n",
  });
  if (!result.ok) {
    log(
      `[idle-inversion] could not persist ${path}: ${result.error.message} — ` +
        `the streak will restart on the next cycle`,
    );
    return false;
  }
  return true;
}

/** The dedup marker carried by a repo's escalation issue body. */
export function formatIdleInversionMarker(repo: string): string {
  return `<!-- ${IDLE_INVERSION_MARKER_PREFIX}:${repo} -->`;
}

/** Whether a body is the auto-filed escalation issue for `repo`. */
export function isIdleInversionIssue(body: string, repo: string): boolean {
  return (body ?? "").includes(formatIdleInversionMarker(repo));
}

/** Stable title; dedup never uses it, humans find the issue by it. */
export function formatIdleInversionTitle(repo: string): string {
  return `fix: ${repo} has claimable work the claim scan keeps refusing — ` +
    `inversion sustained across cycles`;
}

/** What the detector saw, for the issue body. */
export interface IdleInversionReport {
  repo: string;
  /** Consecutive cycles the signal has held. */
  consecutiveCycles: number;
  /** Issues the census counted as claimable, by priority. */
  claimable: number;
  /** Free-text detail from the census line, already redaction-safe. */
  detail: string;
}

/** Escape so script output cannot close our fence or forge a marker. */
function bodySafe(text: string): string {
  return text.replace(/<!--/g, "<!- -").replace(/-->/g, "- ->")
    .replace(/```/g, "'''");
}

/** Issue body: marker first, then the diagnosis and what to do. */
export function formatIdleInversionBody(
  report: IdleInversionReport,
): string {
  return [
    formatIdleInversionMarker(report.repo),
    "",
    `Auto-filed by the Vibe Coder (Issue #321): the idle-decision census has ` +
    `reported **${report.claimable} claimable issue(s)** in \`${report.repo}\` ` +
    `on **${report.consecutiveCycles} consecutive cycles**, while the claim ` +
    `scan claimed nothing from it.`,
    "",
    "The two disagree. One of them is wrong, and until this is resolved that " +
    "work is not being done by anyone.",
    "",
    "## What the census saw",
    "",
    "```",
    bodySafe(report.detail),
    "```",
    "",
    "## What to check",
    "",
    "1. `[idle-detect] ... ALERT mis_classification ...` and " +
    "`[idle-census] ... ALERT inversion ...` in `~/logs/worker.log` — both " +
    "name this repo on every affected cycle.",
    "2. The claim scan's own skip reasons for those issues " +
    "(`no eligible work: ... top-skips=...`). A skip reason that names a " +
    "*permanent* condition on issues the census calls claimable is the bug.",
    "3. Issue #319 was one instance: a merged PR's title mentioning `#N` " +
    "blocked those issue numbers for ever, under a skip reason that read as " +
    "a passing cooldown.",
    "",
    "Apply `work-on` to schedule the fix — the worker cannot self-apply that " +
    "label.",
    "",
    "The worker files this once per streak and stops reporting as soon as " +
    "the repo has a clean cycle.",
  ].join("\n");
}

/** Outcome of one recorded cycle. */
export type IdleInversionDecision =
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

/** Options for {@link recordIdleInversion}. */
export interface RecordIdleInversionOptions {
  statePath: string;
  report: Omit<IdleInversionReport, "consecutiveCycles">;
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
 * Find the open escalation issue for `repo`, or null when there is none.
 * Throws when the search itself failed — a lookup we could not perform must
 * not read as "no issue exists" and file a duplicate.
 */
async function findOpenEscalationIssue(
  repo: string,
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
    `"${IDLE_INVERSION_MARKER_PREFIX}:${repo}" in:body`,
    "--json",
    "number,body",
    "--limit",
    "20",
  ]);
  const rows = JSON.parse(raw || "[]") as { number: number; body?: string }[];
  const match = rows
    .filter((row) => isIdleInversionIssue(row.body ?? "", repo))
    .sort((a, b) => a.number - b.number)[0];
  return match ? match.number : null;
}

/**
 * Record one cycle in which `repo` raised the inversion signal.
 *
 * Never throws: a GitHub or filesystem failure is returned as a decision and
 * logged, so the idle path is never derailed by its own reporting.
 */
export async function recordIdleInversion(
  opts: RecordIdleInversionOptions,
): Promise<IdleInversionDecision> {
  const log = opts.log ?? ((message: string) => console.error(message));
  const threshold = opts.threshold ?? IDLE_INVERSION_THRESHOLD;
  const repo = opts.report.repo;

  try {
    return await withStateLock(
      `idle-inversion:${opts.statePath}`,
      async () => {
        const streaks = await loadIdleInversionStreaks(opts.statePath);
        const entry = streaks[repo] ?? { count: 0, lastCycleId: "" };

        // Cycles, not ticks: the detector runs several times per cycle.
        if (entry.lastCycleId === opts.cycleId) {
          return { action: "already-counted" as const, count: entry.count };
        }
        entry.count++;
        entry.lastCycleId = opts.cycleId;
        streaks[repo] = entry;

        const decision = await decide(entry, threshold, opts, log);
        await saveIdleInversionStreaks(opts.statePath, streaks, log);
        return decision;
      },
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log(`[idle-inversion] ${repo}: streak update failed: ${reason}`);
    return { action: "gh-failed", count: 0, reason };
  }
}

/** Threshold handling for one recorded cycle; mutates `entry` on filing. */
async function decide(
  entry: IdleInversionEntry,
  threshold: number,
  opts: RecordIdleInversionOptions,
  log: (message: string) => void,
): Promise<IdleInversionDecision> {
  const repo = opts.report.repo;
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
    existing = await findOpenEscalationIssue(repo, opts.ghFn);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log(
      `[idle-inversion] ${repo}: could not search for an existing escalation ` +
        `issue: ${reason} — not filing (a duplicate is worse)`,
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
      formatIdleInversionTitle(repo),
      "--body",
      formatIdleInversionBody({
        ...opts.report,
        consecutiveCycles: entry.count,
      }),
    ]);
    const issueNumber = parseCreatedIssueNumber(created);
    if (issueNumber > 0) entry.issueNumber = issueNumber;
    return { action: "filed", count: entry.count, issueNumber };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log(`[idle-inversion] ${repo}: could not file the issue: ${reason}`);
    return { action: "gh-failed", count: entry.count, reason };
  }
}

/**
 * Clear a repo's streak after a clean cycle. A no-op when nothing is
 * tracked. Never throws.
 */
export async function clearIdleInversion(
  statePath: string,
  repo: string,
  log: (message: string) => void = (m) => console.error(m),
): Promise<void> {
  try {
    await withStateLock(`idle-inversion:${statePath}`, async () => {
      const streaks = await loadIdleInversionStreaks(statePath);
      if (!(repo in streaks)) return;
      delete streaks[repo];
      await saveIdleInversionStreaks(statePath, streaks, log);
    });
  } catch (err) {
    log(
      `[idle-inversion] ${repo}: could not clear the streak: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
