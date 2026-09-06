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
 * {@link IDLE_INVERSION_THRESHOLD} files one issue naming that repo.
 *
 * **Filed here, about them (Issue #459).** The issue lands in
 * {@link IDLE_INVERSION_TARGET_REPO} — the worker's own repo — because the
 * census, the claim scan and this filer are all worker code, so no change in
 * the subject repo can fix what it reports. GRQ#4465 was filed into GRQ,
 * where an agent claiming it has neither the deciding code nor write access
 * beyond that repo; the only outcome available to it was a `needs-human`
 * hand-off.
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
 * **Only a refusal counts (Issues #437, #460).** A cycle escalates a repo
 * only when the claim scan completed an eligibility pass, still claimed
 * nothing **from that repo**, and left work behind.
 * Cycles that ended on the deadline — the pool stops before its next claim
 * and never evaluates the backlog — are neither counted nor treated as clean,
 * so a busy fleet with a real backlog no longer escalates "the claim scan
 * keeps refusing" work nothing refused. Issue #460 adds the other half: a
 * repo the scan *claimed from* this cycle was served, not refused, however
 * that run ended — two slots against an 80-issue backlog leave claimable
 * work on every cycle by construction. `idle_decision_census.ts` decides
 * which repos qualify (`escalationRepos`).
 *
 * The issue is filed with no label — the worker still cannot self-apply
 * `work-on` (`worker_label_guard.ts` strips a worker-applied pickup label on
 * the next scan). Since Issue #505 it does not have to: the marker below is
 * recognised provenance, so `collect_self_diagnostic_candidates.ts` schedules
 * this issue itself (tier 2b, capped, audited and announced) unless an
 * operator has switched that path off. A human `work-on` still works and
 * still outranks it.
 *
 * Best-effort throughout: never throws, so the idle path can call it without
 * a guard. Every failure is logged rather than swallowed.
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
import {
  recordSelfDiagnosticFiling,
  type SelfDiagnosticFiling,
} from "./self_diagnostic_attestation.ts";

/** Consecutive cycles raising the signal before an issue is filed. */
export const IDLE_INVERSION_THRESHOLD = 3;

/** State file name, placed in the worker's work directory. */
export const IDLE_INVERSION_STATE_FILE = "idle_inversion_streak.json";

/** Body marker prefix used to dedup the escalation issue. */
export const IDLE_INVERSION_MARKER_PREFIX = "VIBE_IDLE_INVERSION";

/** Self-diagnostic family id for issues this module files (Issue #1277). */
export const IDLE_INVERSION_FAMILY_ID = "idle-inversion";

/**
 * Where the escalation lands, whichever repo raised the inversion
 * (Issue #459).
 *
 * The census, the claim scan and this filer all live here, so the fix for
 * every issue this module raises is a change to worker code. Filing into the
 * *subject* repo — as GRQ#4465 was — hands the work to an agent whose
 * checkout contains none of the deciding code and whose write allowlist
 * covers only that repo, so the only available outcome is a `needs-human`
 * hand-off. Same reasoning, and same shape, as
 * `run_failure_issue.ts`'s `RUN_FAILURE_TARGET_REPO`.
 *
 * The dedup marker stays keyed on the **subject** repo, so two hosts
 * watching the same repo still converge on one issue.
 */
export const IDLE_INVERSION_TARGET_REPO = "stSoftwareAU/VibeCoder";

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

/**
 * Stable title; dedup never uses it, humans find the issue by it.
 *
 * `repo` is the **subject** — the monitored repo that raised the inversion.
 * The issue itself is filed in {@link IDLE_INVERSION_TARGET_REPO}, so the
 * title leads with the defect and names the subject as the evidence.
 */
export function formatIdleInversionTitle(repo: string): string {
  return `fix: idle-inversion on ${repo} — claimable work the claim scan ` +
    `keeps refusing, sustained across cycles`;
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
  /**
   * Issue numbers the census counted as claimable (Issue #460).
   *
   * GRQ#4465 carried a count and nothing else, so the reader could not tell
   * *which* issues the two sides disagreed about — and the claim scan logs
   * only aggregate top-3 skip totals, so it was not recoverable from the log
   * either. Naming them costs nothing: the census already holds the numbers.
   */
  claimableIssues?: readonly number[];
  /**
   * The claim scan's own per-issue skip reason, where the caller has it
   * (Issue #460). This is the single most useful line in the issue: it names
   * the gate the two sides disagree about instead of asking a human to find
   * it. Absent when the scan recorded no reason for that issue.
   */
  scanSkips?: readonly { issue: number; reason: string }[];
}

/** Escape so script output cannot close our fence or forge a marker. */
function bodySafe(text: string): string {
  return text.replace(/<!--/g, "<!- -").replace(/-->/g, "- ->")
    .replace(/```/g, "'''");
}

/** `#4326, #4376` — the issues, or an empty string when none were passed. */
function formatClaimableIssues(issues: readonly number[] | undefined): string {
  if (!issues || issues.length === 0) return "";
  return issues.map((n) => `#${n}`).join(", ");
}

/** One `- #N — reason` line per issue the scan recorded a reason for. */
function formatScanSkips(
  skips: readonly { issue: number; reason: string }[] | undefined,
): string[] {
  if (!skips || skips.length === 0) return [];
  return [
    "## What the claim scan did with them",
    "",
    ...skips.map((s) => `- #${s.issue} — \`${bodySafe(s.reason)}\``),
    "",
    "A reason here that names a **permanent** condition on an issue the " +
    "census calls claimable is the bug: the two sides are modelling " +
    "different gates.",
    "",
  ];
}

/** Issue body: marker first, then the diagnosis and what to do. */
export function formatIdleInversionBody(
  report: IdleInversionReport,
): string {
  const issueList = formatClaimableIssues(report.claimableIssues);
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
    // Issue #459: this issue lives in the worker's repo because that is the
    // only place its cause can be fixed. Say so, so nobody moves it back.
    `The subject is \`${report.repo}\`; the defect is here. The census ` +
    "(`idle_decision_census.ts`), the claim scan " +
    "(`collect_*_candidates.ts`) and this filer " +
    "(`idle_inversion_streak.ts`) are all worker code, so no change in the " +
    "subject repo can resolve it.",
    "",
    "Every cycle counted here is one in which the claim scan **completed an " +
    "eligibility pass** and still claimed nothing — a cycle that ended on the " +
    "deadline (or drained) before the scan looked is not counted, because " +
    "nothing refused the work (Issue #437). A repo the scan **did** claim " +
    "from this cycle is not counted either (Issue #460).",
    "",
    ...(issueList === "" ? [] : [
      "## The issues the census counted",
      "",
      issueList,
      "",
    ]),
    ...formatScanSkips(report.scanSkips),
    "## What the census saw",
    "",
    "```",
    bodySafe(report.detail),
    "```",
    "",
    "## What to check",
    "",
    "1. `[idle-detect] ... ALERT mis_classification ...` and " +
    "`[idle-census] ... ALERT inversion ...` in the worker log for the " +
    "cycle — both name the subject repo on every affected cycle.",
    "2. Whether the census models every gate the claim scan applies. Each " +
    "gate present in one and missing from the other manufactures this " +
    "alert (Issue #460).",
    "3. Issue #319 was one instance: a merged PR's title mentioning `#N` " +
    "blocked those issue numbers for ever, under a skip reason that read as " +
    "a passing cooldown.",
    "",
    "The worker schedules this diagnostic itself (Issue #505): the marker " +
    "above is recognised provenance, so it is claimed without waiting for a " +
    "label — capped, recorded in the audit chain, and announced in a comment " +
    "below when it happens. Apply `work-on` to schedule it sooner; that " +
    "outranks self-scheduling and is still the only way to raise its " +
    "priority.",
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
  /**
   * Records the filing attestation tier 2b checks (Issue #1277).
   *
   * Injected so a test never appends to the host's real audit chain.
   * Production callers omit it and get {@link recordSelfDiagnosticFiling}.
   */
  recordFiling?: (filing: SelfDiagnosticFiling) => Promise<boolean>;
}

/** Parse the issue number out of `gh issue create` output. */
function parseCreatedIssueNumber(output: string): number {
  const match = /\/issues\/(\d+)\s*$/.exec(output.trim());
  return match ? parseInt(match[1]!, 10) : 0;
}

/**
 * Find the open escalation issue for subject `repo`, or null when there is
 * none. Throws when the search itself failed — a lookup we could not perform
 * must not read as "no issue exists" and file a duplicate.
 *
 * Issue #459: the search runs against {@link IDLE_INVERSION_TARGET_REPO},
 * where the issue is filed, while the marker stays keyed on the subject repo
 * so two hosts watching the same subject still converge on one issue.
 */
async function findOpenEscalationIssue(
  repo: string,
  opts: RecordIdleInversionOptions,
  log: (message: string) => void,
): Promise<number | null> {
  const raw = await opts.ghFn([
    "issue",
    "list",
    "--repo",
    IDLE_INVERSION_TARGET_REPO,
    "--state",
    "open",
    "--search",
    `"${IDLE_INVERSION_MARKER_PREFIX}:${repo}" in:body`,
    "--json",
    ALERT_DEDUP_JSON_FIELDS,
    "--limit",
    "20",
  ]);
  const rows = JSON.parse(raw || "[]") as AlertDedupRow[];
  const verified = await selectFleetAuthoredMatches(
    rows.filter((row) => isIdleInversionIssue(row.body ?? "", repo)),
    `idle-inversion ${repo}`,
    opts,
    log,
  );
  const match = verified.sort((a, b) => a.number - b.number)[0];
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
    existing = await findOpenEscalationIssue(repo, opts, log);
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

  const body = formatIdleInversionBody({
    ...opts.report,
    consecutiveCycles: entry.count,
  });
  try {
    const created = await opts.ghFn([
      "issue",
      "create",
      "--repo",
      // Issue #459: the worker's own repo — the subject repo cannot fix it.
      IDLE_INVERSION_TARGET_REPO,
      "--title",
      formatIdleInversionTitle(repo),
      "--body",
      body,
    ]);
    const issueNumber = parseCreatedIssueNumber(created);
    if (issueNumber > 0) entry.issueNumber = issueNumber;
    // Issue #1277: attest the filing out of band, so tier 2b can tell this
    // diagnostic from one an injected agent typed the marker into.
    const recordFiling = opts.recordFiling ??
      ((filing: SelfDiagnosticFiling) =>
        recordSelfDiagnosticFiling(filing, { log }));
    await recordFiling({
      repo: IDLE_INVERSION_TARGET_REPO,
      issueNumber,
      familyId: IDLE_INVERSION_FAMILY_ID,
      body,
      filedBy: "worker/deno/lib/idle_inversion_streak.ts",
    });
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
