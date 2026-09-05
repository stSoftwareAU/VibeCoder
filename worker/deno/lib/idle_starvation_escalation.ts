/**
 * Escalating idle capacity that files no idle task (Issue #1052).
 *
 * The fleet filed no idle task for **ten days** — last created 2026-08-26,
 * zero open across all eighteen monitored repos — while slot capacity sat
 * unused, and nothing said so. The operator found it by noticing the fleet
 * did not look busy.
 *
 * Every instrument needed to notice was present, running, and correct:
 *
 * - `slot_idle_accounting.ts` (Issue #925) measured it —
 *   `slots=2 available=1616s occupied=171s occupied_pct=10.6 idle_pct=31.4
 *   unstaffed=937s occupied_by_slot=s2=171s`, so `s1` contributed nothing.
 * - `run_core.ts` logged the refusal on every cycle, with its reason and
 *   count — `skipping=idle-task-filer reason=audit_found_claimable
 *   claimable_total=24 streak=2`.
 * - `idle_decision_census.ts` emitted a per-repo availability line for all
 *   eighteen repos, every cycle.
 *
 * All three end at `log(...)`. The information was complete, correct,
 * machine-readable, and read by nobody.
 *
 * # Why `idle_inversion_streak.ts` does not cover it
 *
 * Issue #321 gave *one* signal a memory: a **per-repo** contradiction, where
 * the census sees claimable work the claim scan refuses. What happened here
 * is a **fleet-level** one — the census was arguably right that work existed,
 * the scan was right that this slot could not claim it, and the filer refused
 * on the census's number. No single repo's inversion need be sustained enough
 * to trip the per-repo detector, and the aggregate condition — capacity idle,
 * nothing filed, for days — was not watched at all.
 *
 * # What this escalates on
 *
 * The **outcome**, and only the outcome: no idle task anywhere in the
 * monitored set for {@link IDLE_STARVATION_HOURS} consecutive hours **while**
 * the #925 accounting measured more than
 * {@link IDLE_STARVATION_IDLE_SLOT_SECONDS} of idle slot-seconds over that
 * same span. Both halves matter, and either alone is noise:
 *
 * - A **busy** fleet files no idle task for days by design — its slots are
 *   occupied, so the idle half never trips.
 * - A **genuinely quiet** fleet with an empty backlog files an idle task, and
 *   `maybe-file-idle-task` keeps at most one open across the whole monitored
 *   set. One open wrapper is the fleet supplying itself, so the episode ends
 *   and the clock restarts.
 *
 * An alert that fires on a healthy fleet gets muted, and then it is Issue
 * #321's lesson all over again: *an alert that fires every cycle and changes
 * nothing is indistinguishable from no alert.*
 *
 * # Persistence, because #1051 was inert without it
 *
 * The counter this replaces lived in memory for the length of one run, so a
 * restart — or the end of a cycle — returned it to zero and it never reached
 * any threshold. Both halves of the condition are therefore banked in a small
 * JSON file written atomically: the episode's start instant, and the idle
 * slot-seconds accumulated across every run since. The #925 ledger is
 * per-run, so each observation banks the **delta** against the reading this
 * episode last saw from that run id; a new run id starts a fresh reading from
 * zero and its seconds are added to the episode's running total.
 *
 * Shape follows `idle_inversion_streak.ts` throughout: an atomically-written
 * JSON file, marker-based dedup on the issue **body** (as `run_failure_issue`
 * does) so two hosts converge on one issue, one issue per episode rather than
 * one per cycle, and filing into the worker's own repo for the reason Issue
 * #459 established — the accounting, the census, the hooks and the filer are
 * all worker code, so no change in a subject repo can fix what this reports.
 *
 * Unlike the #321 streak this needs no per-cycle guard: it counts elapsed
 * time and measured slot-seconds, both of which are unchanged by observing
 * them twice inside one cycle.
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

/**
 * Consecutive hours without an idle task anywhere in the monitored set
 * before an issue is filed.
 *
 * Half a day. Long enough that a fleet working a large milestone overnight —
 * which legitimately files nothing — is never asked about it, and short
 * enough that the ten-day gap this exists to catch is caught twenty times
 * over. The idle half below is what separates the two cases; this one only
 * sets how long the fleet is given to sort itself out first.
 */
export const IDLE_STARVATION_HOURS = 12;

/**
 * Idle slot-seconds that must accumulate over the same span before the
 * silence counts as starvation.
 *
 * Four slot-hours. The recorded incident measured `idle_pct=31.4` on a
 * two-slot host — roughly 2,250 idle slot-seconds per wall hour — so a fleet
 * idling like that reaches this in about six hours and the alert lands well
 * inside the twelve. A fleet whose slots are genuinely working accrues only
 * the seconds between claims and never approaches it.
 */
export const IDLE_STARVATION_IDLE_SLOT_SECONDS = 14_400;

/** State file name, placed in the worker's work directory. */
export const IDLE_STARVATION_STATE_FILE = "idle_starvation.json";

/** Body marker used to dedup the escalation issue across hosts. */
export const IDLE_STARVATION_MARKER = "VIBE_IDLE_STARVATION";

/**
 * Where the escalation lands (Issue #459).
 *
 * The slot accounting, the census, the idle hooks and the idle-task filer
 * all live here, so the fix for every issue this module raises is a change to
 * worker code. Same reasoning, and same shape, as
 * `idle_inversion_streak.ts`'s `IDLE_INVERSION_TARGET_REPO` and
 * `run_failure_issue.ts`'s `RUN_FAILURE_TARGET_REPO`.
 */
export const IDLE_STARVATION_TARGET_REPO = "stSoftwareAU/VibeCoder";

/**
 * The evidence carried into the issue body, so the alert arrives
 * diagnosable rather than bare (the lesson of Issues #1019 and #1020 — an
 * alert that names no cause makes a human reproduce what the machine
 * already saw).
 */
export interface IdleStarvationEvidence {
  /** The latest `slot-utilisation:` line (Issue #925), verbatim. */
  slotUtilisation: string;
  /** The last `[idle-hooks]` refusal reason, e.g. `audit_found_claimable`. */
  refusalReason: string;
  /** That refusal's `claimable_total`. */
  claimableTotal: number;
  /** The per-repo `[idle-census]` availability lines. */
  censusLines: readonly string[];
}

/** One observation of "the fleet holds no idle task". */
export interface IdleStarvationObservation {
  /** Wall clock for this observation. */
  nowMs: number;
  /**
   * Identifies the run whose {@link idleSlotSeconds} reading this is. The
   * #925 ledger restarts with the process, so a change here means the
   * reading restarted at zero and the whole of it is new.
   */
  runId: string;
  /** Run-cumulative idle slot-seconds from the #925 ledger. */
  idleSlotSeconds: number;
  /**
   * Open `idle-task`-labelled issues across the whole monitored set,
   * assigned or not. Non-zero means the fleet is supplying itself and the
   * episode is over — `maybe-file-idle-task` keeps at most one open across
   * the fleet, so one is the healthy steady state, not a shortfall.
   */
  openIdleTasks: number;
  /** What to put in the issue body if this episode escalates. */
  evidence: IdleStarvationEvidence;
}

/** The persisted episode — everything the threshold is judged on. */
export interface IdleStarvationEpisode {
  /** First observation with no idle task anywhere. */
  startedMs: number;
  /** Idle slot-seconds banked since {@link startedMs}, across runs. */
  idleSlotSeconds: number;
  /** Run whose ledger reading was last banked. */
  runId: string;
  /** That run's cumulative reading at the time it was banked. */
  runIdleSlotSeconds: number;
  /** Most recent observation, so a stale episode is recognisable. */
  lastObservedMs: number;
  /** Issue filed for this episode; set once so it is filed once. */
  issueNumber?: number;
  /** Latest evidence, kept so a restart still files a diagnosable issue. */
  evidence?: IdleStarvationEvidence;
}

/** Resolve the episode file path for a work directory. */
export function idleStarvationStatePath(workDir: string): string {
  return `${workDir}/${IDLE_STARVATION_STATE_FILE}`;
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function parseEvidence(value: unknown): IdleStarvationEvidence | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Partial<IdleStarvationEvidence>;
  return {
    slotUtilisation: typeof raw.slotUtilisation === "string"
      ? raw.slotUtilisation
      : "",
    refusalReason: typeof raw.refusalReason === "string"
      ? raw.refusalReason
      : "unknown",
    claimableTotal: Math.max(
      0,
      Math.floor(finiteNumber(raw.claimableTotal, 0)),
    ),
    censusLines: Array.isArray(raw.censusLines)
      ? raw.censusLines.filter((l): l is string => typeof l === "string")
      : [],
  };
}

/**
 * Load the episode; a missing or corrupt file reads as "no episode".
 *
 * A corrupt file restarts the clock rather than escalating on rubbish — the
 * failure it must not produce is a false alarm, and the next twelve hours of
 * genuine starvation re-raise it.
 */
export async function loadIdleStarvationEpisode(
  path: string,
): Promise<IdleStarvationEpisode | null> {
  try {
    const parsed = JSON.parse(await Deno.readTextFile(path));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const raw = parsed as Partial<IdleStarvationEpisode>;
    const startedMs = finiteNumber(raw.startedMs, 0);
    if (startedMs <= 0) return null;
    const issueNumber = finiteNumber(raw.issueNumber, 0);
    return {
      startedMs,
      idleSlotSeconds: Math.max(0, finiteNumber(raw.idleSlotSeconds, 0)),
      runId: typeof raw.runId === "string" ? raw.runId : "",
      runIdleSlotSeconds: Math.max(0, finiteNumber(raw.runIdleSlotSeconds, 0)),
      lastObservedMs: finiteNumber(raw.lastObservedMs, startedMs),
      ...(issueNumber > 0 ? { issueNumber: Math.floor(issueNumber) } : {}),
      ...(parseEvidence(raw.evidence) === undefined
        ? {}
        : { evidence: parseEvidence(raw.evidence) }),
    };
  } catch {
    // Missing or corrupt — the episode simply restarts.
    return null;
  }
}

/**
 * Persist the episode atomically, or remove the file when the episode is
 * over. A failed write is reported, never silent: a counter that cannot
 * persist is the defect Issue #1051 shipped.
 */
export async function saveIdleStarvationEpisode(
  path: string,
  episode: IdleStarvationEpisode | null,
  log: (message: string) => void = (m) => console.error(m),
): Promise<boolean> {
  if (episode === null) {
    try {
      await Deno.remove(path);
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) {
        log(
          `[idle-starvation] could not clear ${path}: ${
            err instanceof Error ? err.message : String(err)
          } — a stale episode may be re-read on the next cycle`,
        );
        return false;
      }
    }
    return true;
  }
  const result = await atomicWrite({
    targetFile: path,
    content: JSON.stringify(episode, null, 2) + "\n",
  });
  if (!result.ok) {
    log(
      `[idle-starvation] could not persist ${path}: ${result.error.message} ` +
        `— the episode will restart on the next cycle`,
    );
    return false;
  }
  return true;
}

/** The dedup marker carried by the escalation issue body. */
export function formatIdleStarvationMarker(): string {
  return `<!-- ${IDLE_STARVATION_MARKER} -->`;
}

/** Whether a body is the auto-filed idle-starvation escalation. */
export function isIdleStarvationIssue(body: string): boolean {
  return (body ?? "").includes(formatIdleStarvationMarker());
}

/** Stable title; dedup never uses it, humans find the issue by it. */
export function formatIdleStarvationTitle(): string {
  return "fix: the fleet has filed no idle task while slot capacity sat idle";
}

/**
 * Name the reason the idle-task filer was refused, in `run_core.ts`'s own
 * `[idle-hooks]` vocabulary.
 *
 * The wiring sees the two facts the hooks decide on — the census's
 * fleet-global inversion verdict and the audit's claimable total — one step
 * before the hooks themselves do, so the reason is reconstructed here rather
 * than reaching into the loop for it.
 *
 * Evidence only, never a gate: this string is printed in an issue body and
 * decides nothing, so a reason one bound out of step with the loop's own
 * streak logic misnames a line rather than suppressing or manufacturing an
 * escalation.
 */
export function describeIdleHooksRefusal(opts: {
  inversionDetected: boolean;
  claimableTotal: number;
}): string {
  if (opts.inversionDetected) return "unblocked_work_exists";
  if (opts.claimableTotal > 0) return "audit_found_claimable";
  return "none";
}

/** What the detector saw, for the issue body. */
export interface IdleStarvationReport {
  /** Hours since the fleet last held an idle task. */
  hours: number;
  /** Idle slot-seconds measured over those hours (Issue #925). */
  idleSlotSeconds: number;
  /** The hours threshold that was crossed. */
  thresholdHours: number;
  /** The idle slot-seconds threshold that was crossed. */
  thresholdIdleSlotSeconds: number;
  /** Evidence gathered on the most recent observation. */
  evidence: IdleStarvationEvidence;
}

/** Escape so log output cannot close our fence or forge a marker. */
function bodySafe(text: string): string {
  return text.replace(/<!--/g, "<!- -").replace(/-->/g, "- ->")
    .replace(/```/g, "'''");
}

/** `4.2 days (101h)` — the duration in the units an operator thinks in. */
function formatDuration(hours: number): string {
  const days = hours / 24;
  return days >= 1
    ? `${days.toFixed(1)} days (${hours.toFixed(1)}h)`
    : `${hours.toFixed(1)}h`;
}

/** `4h 0m` of measured idle capacity. */
function formatSlotSeconds(seconds: number): string {
  const whole = Math.round(seconds);
  return `${whole}s (${(whole / 3600).toFixed(1)} slot-hours)`;
}

/**
 * The per-repo census, fenced and capped.
 *
 * Eighteen repos of census lines is the point — the reader should be able to
 * see which repos were available and which were busy without going to the
 * log — but an unbounded paste is not, so the tail is summarised rather than
 * dropped silently.
 */
function formatCensus(lines: readonly string[]): string[] {
  const limit = 40;
  const shown = lines.slice(0, limit);
  const omitted = lines.length - shown.length;
  return [
    "## The per-repo availability census",
    "",
    "```",
    ...(shown.length === 0 ? ["(the census recorded no lines)"] : shown)
      .map(bodySafe),
    ...(omitted > 0 ? [`… ${omitted} further census line(s) in the log`] : []),
    "```",
    "",
  ];
}

/** Issue body: marker first, then the measurement, the evidence, the fix. */
export function formatIdleStarvationBody(
  report: IdleStarvationReport,
): string {
  const e = report.evidence;
  return [
    formatIdleStarvationMarker(),
    "",
    `Auto-filed by the Vibe Coder (Issue #1052): no \`idle-task\` issue has ` +
    `existed anywhere in the monitored set for **${
      formatDuration(report.hours)
    }**, while the slot accounting measured **${
      formatSlotSeconds(report.idleSlotSeconds)
    }** of idle slot capacity over the same span.`,
    "",
    `Both halves are required — the thresholds are ` +
    `${report.thresholdHours}h and ${
      formatSlotSeconds(report.thresholdIdleSlotSeconds)
    }. A busy fleet files no idle task for days by design and never trips ` +
    "the idle half; a genuinely quiet fleet files one and ends the episode. " +
    "Idle capacity with no idle task is neither, and is what went unnoticed " +
    "for ten days.",
    "",
    // Issue #459: this issue lives in the worker's repo because that is the
    // only place its cause can be fixed. Say so, so nobody moves it back.
    "The slot accounting (`slot_idle_accounting.ts`), the census " +
    "(`idle_decision_census.ts`), the idle hooks (`run_core.ts`) and the " +
    "filer (`maybe_file_idle_task.ts`) are all worker code, so no change in " +
    "any monitored repo can resolve this.",
    "",
    "## What the slot accounting measured",
    "",
    "```",
    bodySafe(e.slotUtilisation || "(no slot-utilisation line was recorded)"),
    "```",
    "",
    "## Why the filer did not file",
    "",
    `The last \`[idle-hooks]\` decision recorded ` +
    `\`reason=${bodySafe(e.refusalReason)}\` with ` +
    `\`claimable_total=${e.claimableTotal}\`.`,
    "",
    "A reason naming work the claim scan then never claimed is the defect: " +
    "the filer is being refused on a census number the scan does not act on, " +
    "which is exactly the shape of the recorded incident " +
    "(`reason=audit_found_claimable claimable_total=24` on every cycle, with " +
    "one of two slots contributing no occupied seconds at all).",
    "",
    ...formatCensus(e.censusLines),
    "## What to check",
    "",
    "1. The `slot-utilisation:` line above — an `occupied_by_slot` that names " +
    "fewer slots than `slots` is a slot doing nothing (Issue #925).",
    "2. The `[idle-hooks] … skipping=idle-task-filer` lines for the reason " +
    "above, and whether the work it counted was ever claimable.",
    "3. The census lines for repos reading `availability=available` that no " +
    "slot claimed from.",
    "",
    "The worker files this once per episode. It stops as soon as an " +
    "`idle-task` issue exists anywhere in the monitored set, and a later " +
    "episode files again.",
  ].join("\n");
}

/** Outcome of one recorded observation. */
export type IdleStarvationDecision =
  /** The fleet holds an idle task: no episode, or the episode just ended. */
  | { action: "supplied"; openIdleTasks: number }
  /** An episode is running but has not met both thresholds. */
  | { action: "watching"; hours: number; idleSlotSeconds: number }
  /** Both thresholds met and an issue was filed. */
  | { action: "filed"; hours: number; idleSlotSeconds: number; issue: number }
  /** Both thresholds met; an open issue already covers this episode. */
  | { action: "already-open"; hours: number; issue: number }
  /** This episode has already filed its issue. */
  | { action: "already-filed"; hours: number; issue?: number }
  /** Both thresholds met but GitHub could not be reached. */
  | { action: "gh-failed"; hours: number; reason: string };

/** Options for {@link recordIdleStarvationObservation}. */
export interface RecordIdleStarvationOptions {
  statePath: string;
  observation: IdleStarvationObservation;
  /** gh runner: resolves stdout, rejects on failure. */
  ghFn: (args: string[]) => Promise<string>;
  /** Hours threshold override (tests). */
  thresholdHours?: number;
  /** Idle slot-seconds threshold override (tests). */
  thresholdIdleSlotSeconds?: number;
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
 * Find the open escalation issue, or null when there is none. Throws when
 * the search itself failed — a lookup we could not perform must not read as
 * "no issue exists" and file a duplicate.
 *
 * This is what makes two hosts converge: whichever files first, the other's
 * search finds the marker in the body and adopts that issue number.
 */
async function findOpenEscalationIssue(
  opts: RecordIdleStarvationOptions,
  log: (message: string) => void,
): Promise<number | null> {
  const raw = await opts.ghFn([
    "issue",
    "list",
    "--repo",
    IDLE_STARVATION_TARGET_REPO,
    "--state",
    "open",
    "--search",
    `"${IDLE_STARVATION_MARKER}" in:body`,
    "--json",
    ALERT_DEDUP_JSON_FIELDS,
    "--limit",
    "20",
  ]);
  const rows = JSON.parse(raw || "[]") as AlertDedupRow[];
  const verified = await selectFleetAuthoredMatches(
    rows.filter((row) => isIdleStarvationIssue(row.body ?? "")),
    "idle-starvation",
    opts,
    log,
  );
  const match = verified.sort((a, b) => a.number - b.number)[0];
  return match ? match.number : null;
}

/**
 * Bank this observation's idle slot-seconds onto the episode.
 *
 * The #925 ledger is per-run and cumulative, so within one run the delta is
 * the reading's increase, and a reading from a run this episode has not seen
 * before is entirely new — which is how the episode survives a restart with
 * its measurement intact.
 */
function bankIdleSlotSeconds(
  episode: IdleStarvationEpisode,
  observation: IdleStarvationObservation,
): void {
  const reading = Math.max(0, observation.idleSlotSeconds);
  const delta = episode.runId === observation.runId
    ? Math.max(0, reading - episode.runIdleSlotSeconds)
    : reading;
  episode.idleSlotSeconds += delta;
  episode.runId = observation.runId;
  episode.runIdleSlotSeconds = reading;
}

/**
 * Record one observation of the fleet's idle-task supply.
 *
 * Never throws: a GitHub or filesystem failure is returned as a decision and
 * logged, so the idle path is never derailed by its own reporting.
 */
export async function recordIdleStarvationObservation(
  opts: RecordIdleStarvationOptions,
): Promise<IdleStarvationDecision> {
  const log = opts.log ?? ((message: string) => console.error(message));
  const thresholdHours = opts.thresholdHours ?? IDLE_STARVATION_HOURS;
  const thresholdSeconds = opts.thresholdIdleSlotSeconds ??
    IDLE_STARVATION_IDLE_SLOT_SECONDS;
  const obs = opts.observation;

  try {
    return await withStateLock(
      `idle-starvation:${opts.statePath}`,
      async () => {
        const stored = await loadIdleStarvationEpisode(opts.statePath);

        // The fleet is supplying itself: at most one wrapper is open across
        // the whole monitored set by design, so one is health, not shortfall.
        if (obs.openIdleTasks > 0) {
          if (stored !== null) {
            await saveIdleStarvationEpisode(opts.statePath, null, log);
          }
          return {
            action: "supplied" as const,
            openIdleTasks: obs.openIdleTasks,
          };
        }

        const episode: IdleStarvationEpisode = stored ?? {
          startedMs: obs.nowMs,
          idleSlotSeconds: 0,
          runId: obs.runId,
          runIdleSlotSeconds: 0,
          lastObservedMs: obs.nowMs,
        };
        bankIdleSlotSeconds(episode, obs);
        episode.lastObservedMs = obs.nowMs;
        episode.evidence = obs.evidence;

        const hours = Math.max(0, obs.nowMs - episode.startedMs) / 3_600_000;
        const decision = await decide(
          episode,
          hours,
          thresholdHours,
          thresholdSeconds,
          opts,
          log,
        );
        await saveIdleStarvationEpisode(opts.statePath, episode, log);
        return decision;
      },
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log(`[idle-starvation] episode update failed: ${reason}`);
    return { action: "gh-failed", hours: 0, reason };
  }
}

/** Threshold handling for one observation; mutates `episode` on filing. */
async function decide(
  episode: IdleStarvationEpisode,
  hours: number,
  thresholdHours: number,
  thresholdSeconds: number,
  opts: RecordIdleStarvationOptions,
  log: (message: string) => void,
): Promise<IdleStarvationDecision> {
  if (hours < thresholdHours || episode.idleSlotSeconds < thresholdSeconds) {
    return {
      action: "watching",
      hours,
      idleSlotSeconds: episode.idleSlotSeconds,
    };
  }
  if (episode.issueNumber !== undefined) {
    return { action: "already-filed", hours, issue: episode.issueNumber };
  }

  let existing: number | null;
  try {
    existing = await findOpenEscalationIssue(opts, log);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log(
      `[idle-starvation] could not search for an existing escalation issue: ` +
        `${reason} — not filing (a duplicate is worse)`,
    );
    return { action: "gh-failed", hours, reason };
  }

  if (existing !== null) {
    // Another host filed for this episode first; adopt its issue so this
    // host never files a second one.
    episode.issueNumber = existing;
    return { action: "already-open", hours, issue: existing };
  }

  try {
    const created = await opts.ghFn([
      "issue",
      "create",
      "--repo",
      // Issue #459: the worker's own repo — no monitored repo can fix it.
      IDLE_STARVATION_TARGET_REPO,
      "--title",
      formatIdleStarvationTitle(),
      "--body",
      formatIdleStarvationBody({
        hours,
        idleSlotSeconds: episode.idleSlotSeconds,
        thresholdHours,
        thresholdIdleSlotSeconds: thresholdSeconds,
        evidence: episode.evidence ?? {
          slotUtilisation: "",
          refusalReason: "unknown",
          claimableTotal: 0,
          censusLines: [],
        },
      }),
    ]);
    const issue = parseCreatedIssueNumber(created);
    if (issue > 0) episode.issueNumber = issue;
    return {
      action: "filed",
      hours,
      idleSlotSeconds: episode.idleSlotSeconds,
      issue,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log(`[idle-starvation] could not file the issue: ${reason}`);
    return { action: "gh-failed", hours, reason };
  }
}
