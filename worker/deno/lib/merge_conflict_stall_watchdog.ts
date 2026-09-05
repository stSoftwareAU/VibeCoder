/**
 * Watchdog for a merge-conflict queue that stalled before its first attempt
 * (Issue #1112).
 *
 * `docs/workflows/merge-conflicts.md` already records the "nothing stalls
 * unowned" rule: a PR out of attempt budget with no `needs-human` is escalated
 * by the next scan, so a missed escalation at the *end* of the ladder cannot
 * leave a PR silent. Nothing covered a stall *before the first attempt*, which
 * is the case that actually happened — NEAT-AI-Ockham#116 carried
 * `merge-conflict` for over three hours while nothing followed.
 *
 * Whatever suppressed the pass that time — a rate-limit pause, a dead
 * launcher, a lane that never came round — the observable was the same: the
 * label went on, and nothing followed. So this watchdog detects the **shape**
 * rather than any one cause, and the next novel cause produces a visible
 * record instead of silence.
 *
 * The detection signal is deliberately unlike every other guard in this
 * subsystem: it keys on **wall-clock time since the label was applied**, read
 * from the PR's `labeled` timeline event, not on attempt records. An
 * attempt-based guard cannot fire here, because the failure mode is that no
 * attempt record exists.
 *
 * Two boundaries the rest of this subsystem depends on:
 *
 * - **It never applies `needs-human`.** A mechanical stall is work, not a
 *   decision, and that label is a cross-subsystem veto (Issue #569) — the
 *   conflict scan skips any PR carrying it, so applying it here would remove
 *   the PR from the very lane that could clear it. The blockage is filed
 *   through `escalateAsWork` and the PR gets the non-vetoing `escalated`
 *   marker.
 * - **It never starts an attempt.** Forcing one from a watchdog would race the
 *   ordinary pass and manufacture the disrupted-attempt state the workflow
 *   works hard to avoid. It observes and escalates; that is all.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import type { Logger, Result } from "../types.ts";
import {
  escalateAsWork,
  ESCALATED_AS_WORK_LABEL,
  type WorkEscalation,
  workEscalationMarker,
} from "./escalate_as_work.ts";
import { fetchIssueCommentPages } from "./issue_comment_pages.ts";
import { getLabelLastAddInfoComplete } from "./issue_query.ts";
import { addLabelToIssue, ensureLabelExists } from "./label_operations.ts";
import {
  CONFLICT_ATTEMPT_MARKER,
  CONFLICT_FAILED_MARKER,
  CONFLICT_RESOLVED_MARKER,
  type ConflictPrDecision,
  conflictPrKey,
  conflictReasonOperands,
  type ConflictSkipReason,
  DEFAULT_CONFLICT_COOLDOWN_HOURS,
  MERGE_CONFLICT_LABEL,
} from "./pr_merge_conflict_scan.ts";
import type { TimelineCache } from "./timeline_cache.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Hours a PR may carry `merge-conflict` with nothing concluding before the
 * queue is called stalled.
 *
 * Twice the post-attempt cooldown: one whole cooldown window can pass with no
 * attempt for entirely ordinary reasons (a busy lane, a held lease), so the
 * bound is the window a healthy queue cannot plausibly exceed.
 */
export const DEFAULT_CONFLICT_STALL_THRESHOLD_HOURS = 2 *
  DEFAULT_CONFLICT_COOLDOWN_HOURS;

/**
 * Noun phrase for the escalation issue's title.
 *
 * Deliberately free of the label age: `escalateAsWork` deduplicates on the
 * exact title, so a summary that grew by an hour each pass would file a fresh
 * issue every pass. The age lives in the body, which is what the update
 * comment carries anyway.
 */
export const CONFLICT_STALL_SUMMARY =
  "the merge-conflict queue stalled with no attempt concluding";

/** What clears this stall. */
export const CONFLICT_STALL_NEXT_STEP =
  "Find out why no resolution attempt ran: check that a host reached " +
  "priority 1.61 for this repository, that the pass was not rate-limited or " +
  "cut short, and that the PR is still `CONFLICTING` rather than merely " +
  "carrying a stale label. Merging the base branch into the PR branch by " +
  "hand — keeping both sides' changes — also clears it. No attempt budget " +
  "has been spent, so the ordinary ladder resumes as soon as one attempt " +
  "concludes.";

/** Label whose presence means a human already owns the PR. */
const NEEDS_HUMAN_LABEL = "needs-human";

/** The only `mergeable` state that is a merge-conflict queue. */
const CONFLICTING_STATE = "CONFLICTING";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** What the watchdog needs to know about one labelled PR. */
export interface ConflictStallObservation {
  /** Repository in `owner/repo` form. */
  repo: string;
  prNumber: number;
  /** Label names currently on the PR. */
  labels: readonly string[];
  /**
   * Epoch milliseconds of the most recent `merge-conflict` `labeled` event.
   * Absent when the timeline could not be read — the age is then unknown, and
   * an unknown age is never reported as a stall.
   */
  labelledAtMs?: number;
  /** Raw comment objects from the GitHub REST API, oldest first. */
  comments: readonly unknown[];
  /** Skip reasons this cycle recorded for the PR (Issue #1109). */
  skipReasons?: readonly ConflictSkipReason[];
  /** True when the PR is closed — nothing is queued behind it. */
  closed?: boolean;
  /**
   * GitHub's live `mergeable` state. Only `CONFLICTING` is a queue at all:
   * the label is not removed when a conflict clears by other means, so a
   * labelled PR that now merges cleanly is a **stale label**, not a stall —
   * the lesson `docs/workflows/merge-conflicts.md` draws from #116 in as many
   * words. Absent or `UNKNOWN` means the state was not established, and an
   * unestablished state is never escalated.
   */
  mergeableState?: string;
}

/** A merge-conflict queue that has stopped moving on one PR. */
export interface ConflictQueueStall {
  repo: string;
  prNumber: number;
  /** Epoch milliseconds the label was applied. */
  labelledAtMs: number;
  /** How long the label has been on, in milliseconds. */
  labelAgeMs: number;
  /**
   * Epoch milliseconds the stall clock started: the label event, or the most
   * recent attempt conclusion after it — whichever is later.
   */
  stalledSinceMs: number;
  /** How long nothing has happened, in milliseconds. */
  stalledMs: number;
  /** Epoch milliseconds of the last concluded attempt, when there was one. */
  lastConclusionAtMs?: number;
  /**
   * True when an attempt opened and never concluded — the disrupted case. It
   * is still a stall: the disruption bound has not fired either, so nothing
   * is moving the PR.
   */
  openAttempt: boolean;
  /** Skip reasons recorded for the PR this cycle (Issue #1109). */
  skipReasons: readonly ConflictSkipReason[];
}

/** Options for {@link detectConflictQueueStall}. */
export interface DetectConflictStallOptions {
  /** Current time, epoch milliseconds. */
  nowMs: number;
  /** Whether a comment author is one of the fleet's own. */
  isTrustedAuthor: (login: string) => boolean;
  /** Hours before a labelled PR with no conclusion is called stalled. */
  thresholdHours?: number;
  /** Label meaning a human owns the PR. Defaults to `needs-human`. */
  needsHumanLabel?: string;
}

// ---------------------------------------------------------------------------
// Detection (pure)
// ---------------------------------------------------------------------------

/** The `user.login` a raw REST comment object carries, when it carries one. */
function commentAuthor(raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const login = (raw as { user?: { login?: unknown } }).user?.login;
  return typeof login === "string" && login.trim().length > 0
    ? login.trim()
    : undefined;
}

/** Epoch milliseconds of a raw comment's `created_at`, when it parses. */
function commentCreatedAtMs(raw: unknown): number | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const createdAt = (raw as { created_at?: unknown }).created_at;
  if (typeof createdAt !== "string") return undefined;
  const parsed = Date.parse(createdAt);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** The comment body, when it has one. */
function commentBody(raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const body = (raw as { body?: unknown }).body;
  return typeof body === "string" ? body : undefined;
}

/** What the PR's thread says has happened since the label went on. */
interface StallSignals {
  /**
   * Epoch milliseconds of the most recent conclusion — merged, or judged and
   * failed — since the label went on, when there is one.
   */
  lastConclusionAtMs?: number;
  /** An attempt opened after the most recent conclusion. */
  openAttempt: boolean;
  /** This stall has already been escalated. */
  escalated: boolean;
}

/**
 * Read the three signals out of the PR's own thread.
 *
 * Every signal requires a **trusted author**. A comment body is text anybody
 * may write on a public repository, and each of these signals *suppresses* the
 * watchdog — so trusting a forged one buys silence, which is the outcome this
 * watchdog exists to remove. (`hasOpenDeferralNotice` is author-blind about
 * conclusions for the opposite reason: there, a forged marker only causes an
 * extra comment.)
 *
 * A conclusion restarts everything after it: an attempt that opened before it
 * is no longer open, and an escalation posted before it belonged to the stall
 * that conclusion ended.
 *
 * @param comments - Raw REST comment objects, oldest first.
 * @param sinceMs - The label event; comments older than it belong to a
 *   previous conflict and say nothing about this one.
 */
function readStallSignals(
  comments: readonly unknown[],
  sinceMs: number,
  isTrustedAuthor: (login: string) => boolean,
  escalationMarker: string,
): StallSignals {
  const signals: StallSignals = { openAttempt: false, escalated: false };

  for (const raw of comments) {
    const body = commentBody(raw);
    if (body === undefined) continue;
    const createdAtMs = commentCreatedAtMs(raw);
    // An undated comment cannot be placed relative to the label, so it is not
    // allowed to suppress anything.
    if (createdAtMs === undefined || createdAtMs < sinceMs) continue;
    const author = commentAuthor(raw);
    if (author === undefined || !isTrustedAuthor(author)) continue;

    if (
      body.includes(CONFLICT_RESOLVED_MARKER) ||
      body.includes(CONFLICT_FAILED_MARKER)
    ) {
      if (
        signals.lastConclusionAtMs === undefined ||
        createdAtMs > signals.lastConclusionAtMs
      ) {
        signals.lastConclusionAtMs = createdAtMs;
      }
      // Everything before this conclusion belongs to the stall it ended.
      signals.openAttempt = false;
      signals.escalated = false;
      continue;
    }
    if (body.includes(CONFLICT_ATTEMPT_MARKER)) signals.openAttempt = true;
    if (body.includes(escalationMarker)) signals.escalated = true;
  }

  return signals;
}

/**
 * Decide whether one labelled PR's queue has stalled.
 *
 * Returns `null` for every PR that is legitimately not a stall: parked behind
 * `needs-human`, closed, not in the queue at all, of unknown label age, inside
 * the threshold, moved by a concluded attempt, or already escalated for this
 * same stall.
 *
 * An attempt that opened and never concluded still counts as a stall — the
 * disruption bound has not fired either, so nothing is moving the PR. Keying
 * on "any attempt marker exists" instead of "a *conclusion* exists" would miss
 * exactly that shape, which is the real GRQ#4408 case.
 */
export function detectConflictQueueStall(
  observation: ConflictStallObservation,
  options: DetectConflictStallOptions,
): ConflictQueueStall | null {
  const {
    nowMs,
    isTrustedAuthor,
    thresholdHours = DEFAULT_CONFLICT_STALL_THRESHOLD_HOURS,
    needsHumanLabel = NEEDS_HUMAN_LABEL,
  } = options;

  if (observation.closed === true) return null;
  if (!observation.labels.includes(MERGE_CONFLICT_LABEL)) return null;
  // Read the live state, never the label: a label left behind by a conflict
  // that cleared is the expected shape once the base moves on, and escalating
  // it would report a queue that does not exist.
  if (observation.mergeableState !== CONFLICTING_STATE) return null;
  // A human already owns it; this watchdog never overrides that.
  if (observation.labels.includes(needsHumanLabel)) return null;

  const labelledAtMs = observation.labelledAtMs;
  if (labelledAtMs === undefined || !Number.isFinite(labelledAtMs)) return null;

  const labelAgeMs = nowMs - labelledAtMs;
  // The clock can never start before the label, so a label inside the
  // threshold is not a stall whatever the thread says — and the caller may
  // skip reading the thread at all on the strength of it.
  if (labelAgeMs < thresholdHours * 3600_000) return null;

  const signals = readStallSignals(
    observation.comments,
    labelledAtMs,
    isTrustedAuthor,
    workEscalationMarker(observation.repo, observation.prNumber),
  );
  if (signals.escalated) return null;

  // A conclusion puts the PR back in the ordinary ladder and starts a fresh
  // clock: the stall being measured is the silence *since* the last thing that
  // happened, not since the label. Without this, one failed attempt in hour
  // two buys permanent silence for a PR that then never gets its second — a
  // queue nothing else watches, because its budget is not spent either.
  const stalledSinceMs = signals.lastConclusionAtMs ?? labelledAtMs;
  const stalledMs = nowMs - stalledSinceMs;
  if (stalledMs < thresholdHours * 3600_000) return null;

  return {
    repo: observation.repo,
    prNumber: observation.prNumber,
    labelledAtMs,
    labelAgeMs,
    stalledSinceMs,
    stalledMs,
    ...(signals.lastConclusionAtMs !== undefined
      ? { lastConclusionAtMs: signals.lastConclusionAtMs }
      : {}),
    openAttempt: signals.openAttempt,
    skipReasons: observation.skipReasons ?? [],
  };
}

// ---------------------------------------------------------------------------
// What the escalation says
// ---------------------------------------------------------------------------

/** Render a duration in whole hours, floored — never rounded up. */
function formatHours(ms: number): string {
  const hours = Math.floor(ms / 3600_000);
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

/** One skip reason, as `kind (operand=value, …)`. */
function describeSkipReason(reason: ConflictSkipReason): string {
  const operands = Object.entries(conflictReasonOperands(reason))
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(", ");
  return operands.length > 0
    ? `\`${reason.kind}\` (${operands})`
    : `\`${reason.kind}\``;
}

/** Why this PR's queue is being reported as stalled. */
export function buildConflictStallReason(stall: ConflictQueueStall): string {
  const lines = [
    `${stall.repo}#${stall.prNumber} has carried \`${MERGE_CONFLICT_LABEL}\` ` +
    `since ${new Date(stall.labelledAtMs).toISOString()} — ` +
    `${formatHours(stall.labelAgeMs)} — and still conflicts with its base.`,
  ];

  lines.push(
    "",
    stall.lastConclusionAtMs === undefined
      ? "No resolution attempt has reached a conclusion in that time: no " +
        "resolved marker and no failure marker on the PR."
      : `The last attempt concluded at ${
        new Date(stall.lastConclusionAtMs).toISOString()
      } and nothing has happened in the ${
        formatHours(stall.stalledMs)
      } since — no further attempt, no conclusion, no escalation.`,
  );

  lines.push(
    "",
    stall.openAttempt
      ? "An attempt did open and then went silent, so it was never judged — " +
        "and the disrupted-attempt bound has not fired either. The queue is " +
        "stalled either way."
      : "No attempt is open, so the attempt budget is untouched and the " +
        "branch is exactly as its author pushed it.",
  );

  if (stall.skipReasons.length > 0) {
    lines.push(
      "",
      "**Skip reasons recorded for it** (Issue #1109)",
      "",
      ...stall.skipReasons.map((reason) => `- ${describeSkipReason(reason)}`),
    );
  } else {
    lines.push(
      "",
      "No skip reason was recorded for it this cycle, which is itself the " +
        "signal: the pass reached no decision about this PR at all.",
    );
  }

  return lines.join("\n");
}

/**
 * The comment posted on the PR itself.
 *
 * It opens with {@link workEscalationMarker}, which is what makes the
 * escalation once-per-stall across every host: the marker lives on the PR, so
 * a second host reads it rather than re-escalating, and a fresh label cycle
 * leaves it behind the new `labeled` event where it no longer suppresses.
 */
export function buildConflictStallComment(stall: ConflictQueueStall): string {
  return [
    workEscalationMarker(stall.repo, stall.prNumber),
    `⏳ **Merge-conflict queue stalled — ${
      formatHours(stall.stalledMs)
    } with nothing happening**`,
    "",
    buildConflictStallReason(stall),
    "",
    "Filed as work rather than parked behind `needs-human` (Issue #569): a " +
    "stalled queue is a mechanical failure the fleet can act on, and " +
    "`needs-human` would remove this PR from the very lane that clears it.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Escalation
// ---------------------------------------------------------------------------

/** Injected seams for {@link escalateConflictQueueStall}. */
export interface ConflictStallEscalationDeps {
  /** Injected `gh` CLI runner. */
  ghCommandFn: (args: string[]) => Promise<string>;
  logger: Logger;
  /** Files the blockage into the fleet's own queue. Injected by tests. */
  escalateWork?: (
    escalation: WorkEscalation,
  ) => Promise<Result<{ issueNumber: number; filed: boolean }>>;
  /** Applies the non-vetoing marker label. Injected by tests. */
  labelPr?: (
    repo: string,
    prNumber: number,
    label: string,
  ) => Promise<Result<void>>;
  /** Marker label. Defaults to `escalated` — never `needs-human`. */
  escalatedLabel?: string;
}

/** What {@link escalateConflictQueueStall} did. */
export interface ConflictStallEscalationOutcome {
  /** The escalation issue filed or updated. */
  issueNumber: number;
  /** True when this call filed a new issue rather than updating one. */
  filed: boolean;
}

/** Apply the marker label through the guarded label helpers. */
async function defaultLabelPr(
  repo: string,
  prNumber: number,
  label: string,
  ghCommandFn: (args: string[]) => Promise<string>,
): Promise<Result<void>> {
  const ensured = await ensureLabelExists(
    repo,
    label,
    "d4c5f9",
    "The fleet filed this PR's blockage as work; it is not waiting on a " +
      "human decision",
    { ghCommandFn },
  );
  if (!ensured.ok) return ensured;
  // Routed through the guarded helper, not a raw `gh pr edit --add-label`, so
  // the Rule-of-Two worker-label allowlist gates this call site (Issue #2382).
  return await addLabelToIssue(repo, prNumber, label, { ghCommandFn });
}

/**
 * File the stall as work, then say so on the PR.
 *
 * The order matters and is the opposite of the reading order: the marker
 * comment is the cross-host dedup key, so posting it before the issue exists
 * would let a filing failure leave a marker that suppresses every later pass —
 * an escalation nobody ever hears about. Filing first means a failure between
 * the two steps re-runs both next pass, and `escalateAsWork` deduplicates the
 * issue on its (stable) title.
 */
export async function escalateConflictQueueStall(
  stall: ConflictQueueStall,
  deps: ConflictStallEscalationDeps,
): Promise<Result<ConflictStallEscalationOutcome>> {
  const { ghCommandFn, logger } = deps;
  const escalatedLabel = deps.escalatedLabel ?? ESCALATED_AS_WORK_LABEL;
  const escalateWork = deps.escalateWork ??
    ((escalation: WorkEscalation) => escalateAsWork(escalation, { logger }));
  const labelPr = deps.labelPr ??
    ((repo: string, prNumber: number, label: string) =>
      defaultLabelPr(repo, prNumber, label, ghCommandFn));

  const filed = await escalateWork({
    repo: stall.repo,
    prNumber: stall.prNumber,
    summary: CONFLICT_STALL_SUMMARY,
    reason: buildConflictStallReason(stall),
    attempted: stall.openAttempt
      ? "One attempt opened and never reached a conclusion."
      : stall.lastConclusionAtMs !== undefined
      ? "An earlier attempt concluded, and nothing has followed it."
      : "Nothing — no attempt was ever opened.",
    nextStep: CONFLICT_STALL_NEXT_STEP,
  });
  if (!filed.ok) return { ok: false, error: filed.error };

  try {
    await ghCommandFn([
      "pr",
      "comment",
      String(stall.prNumber),
      "--repo",
      stall.repo,
      "--body",
      buildConflictStallComment(stall),
    ]);
  } catch (error) {
    return {
      ok: false,
      error: new Error(
        `merge-conflict stall watchdog: filed issue #${filed.value.issueNumber} ` +
          `but could not comment on ${stall.repo}#${stall.prNumber}: ${
            errorMessage(error)
          }`,
      ),
    };
  }

  // Issue #569: a non-vetoing marker, never `needs-human`. A failure here is
  // said out loud but does not undo an escalation that has already landed.
  const labelled = await labelPr(stall.repo, stall.prNumber, escalatedLabel);
  if (!labelled.ok) {
    logger.warn("Could not mark a stalled merge-conflict PR as escalated", {
      repo: stall.repo,
      prNumber: stall.prNumber,
      label: escalatedLabel,
      error: labelled.error.message,
    });
  }

  logger.warn("Merge-conflict queue stalled — filed as work", {
    repo: stall.repo,
    prNumber: stall.prNumber,
    labelAgeMs: stall.labelAgeMs,
    openAttempt: stall.openAttempt,
    issueNumber: filed.value.issueNumber,
  });

  return {
    ok: true,
    value: { issueNumber: filed.value.issueNumber, filed: filed.value.filed },
  };
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

/** Options for {@link scanConflictQueueStalls}. */
export interface ConflictStallScanOptions extends ConflictStallEscalationDeps {
  /** Monitored repos in `owner/repo` form. */
  repos: readonly string[];
  /** Whether a comment author is one of the fleet's own. */
  isTrustedAuthor: (login: string) => boolean;
  /** Clock override (epoch milliseconds). */
  nowMs?: () => number;
  /** Hours before a labelled PR with no conclusion is called stalled. */
  thresholdHours?: number;
  /** Label meaning a human owns the PR. Defaults to `needs-human`. */
  needsHumanLabel?: string;
  /** This cycle's per-PR decisions, so the comment can name them (#1109). */
  decisions?: readonly ConflictPrDecision[];
  /** Allowlist check for a repo. */
  isRepoAllowed?: (repo: string) => boolean;
  /** Shared timeline cache, when the caller keeps one. */
  timelineCache?: TimelineCache;
}

/** A PR the label listing returned. */
interface LabelledPr {
  number: number;
  labels: string[];
  mergeableState?: string;
}

/** Fields the label listing asks for — the live state rides along with it. */
const STALL_PR_FIELDS = "number,labels,mergeable";

/** Parse `gh pr list --json number,labels,mergeable` output. */
function parseLabelledPrs(raw: string): LabelledPr[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  const parsed: unknown = JSON.parse(trimmed);
  if (!Array.isArray(parsed)) return [];
  const prs: LabelledPr[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as {
      number?: unknown;
      labels?: unknown;
      mergeable?: unknown;
    };
    if (typeof record.number !== "number") continue;
    const labels: string[] = [];
    if (Array.isArray(record.labels)) {
      for (const label of record.labels) {
        const name = typeof label === "object" && label !== null
          ? (label as { name?: unknown }).name
          : label;
        if (typeof name === "string" && name.length > 0) labels.push(name);
      }
    }
    prs.push({
      number: record.number,
      labels,
      ...(typeof record.mergeable === "string"
        ? { mergeableState: record.mergeable.toUpperCase() }
        : {}),
    });
  }
  return prs;
}

/**
 * The distinct skip reasons this cycle recorded for one PR (Issue #1109).
 *
 * The drain calls the scan once per PR it takes, so a PR held back by the same
 * cooldown is decided on several times in one cycle. Identical reasons are
 * collapsed: the comment is public, and five copies of one line say no more
 * than one does.
 */
function skipReasonsFor(
  decisions: readonly ConflictPrDecision[] | undefined,
  repo: string,
  prNumber: number,
): ConflictSkipReason[] {
  if (!decisions) return [];
  const key = conflictPrKey(repo, prNumber);
  const seen = new Set<string>();
  const reasons: ConflictSkipReason[] = [];
  for (const decision of decisions) {
    if (decision.outcome !== "skipped") continue;
    if (conflictPrKey(decision.repo, decision.prNumber) !== key) continue;
    const fingerprint = JSON.stringify([
      decision.reason.kind,
      conflictReasonOperands(decision.reason),
    ]);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    reasons.push(decision.reason);
  }
  return reasons;
}

/**
 * Establish the live `mergeable` state for one labelled PR.
 *
 * GitHub computes mergeability lazily, so a listing can answer `UNKNOWN` for a
 * PR it has not got to yet. Falling straight through on that would drop the
 * stalled PR in silence — the very failure this watchdog exists to remove — so
 * the state is asked for again per PR, exactly as the conflict scan's REST
 * fallback does, and an answer that still cannot be established is said out
 * loud rather than assumed benign.
 *
 * @returns The state, or `undefined` when it could not be established.
 */
async function resolveMergeableState(
  repo: string,
  pr: LabelledPr,
  ghCommandFn: (args: string[]) => Promise<string>,
  logger: Logger,
): Promise<string | undefined> {
  if (pr.mergeableState !== undefined && pr.mergeableState !== "UNKNOWN") {
    return pr.mergeableState;
  }
  try {
    const raw = await ghCommandFn([
      "pr",
      "view",
      String(pr.number),
      "--repo",
      repo,
      "--json",
      "mergeable",
      "--jq",
      ".mergeable",
    ]);
    const state = raw.trim().toUpperCase();
    if (state.length > 0 && state !== "UNKNOWN") return state;
  } catch (error) {
    logger.warn(
      "Merge-conflict stall watchdog: mergeable lookup failed — a labelled " +
        "PR is being left unchecked",
      { repo, prNumber: pr.number, error: errorMessage(error) },
    );
    return undefined;
  }
  logger.warn(
    "Merge-conflict stall watchdog: GitHub has not computed a labelled PR's " +
      "mergeable state — it is left unchecked this pass",
    { repo, prNumber: pr.number },
  );
  return undefined;
}

/**
 * One pass: every open PR carrying `merge-conflict`, checked for a stalled
 * queue and escalated once if it has one.
 *
 * Best-effort per repository and per PR — a listing or a lookup that fails is
 * logged loudly and the pass continues, because a watchdog must never be the
 * reason the cycle stops. It reads only PRs that already carry the label, so
 * a fleet with an empty queue costs one listing per repository.
 *
 * @returns Every stall detected this pass, escalated or not.
 */
export async function scanConflictQueueStalls(
  options: ConflictStallScanOptions,
): Promise<ConflictQueueStall[]> {
  const {
    repos,
    ghCommandFn,
    logger,
    isTrustedAuthor,
    nowMs = () => Date.now(),
    thresholdHours,
    needsHumanLabel,
    decisions,
    isRepoAllowed,
    timelineCache,
  } = options;

  const now = nowMs();
  const stalls: ConflictQueueStall[] = [];

  for (const repo of repos) {
    if (isRepoAllowed && !isRepoAllowed(repo)) continue;

    let labelled: LabelledPr[];
    try {
      labelled = parseLabelledPrs(
        await ghCommandFn([
          "pr",
          "list",
          "--repo",
          repo,
          "--state",
          "open",
          "--label",
          MERGE_CONFLICT_LABEL,
          "--json",
          STALL_PR_FIELDS,
        ]),
      );
    } catch (error) {
      logger.warn(
        "Merge-conflict stall watchdog: failed to list labelled PRs",
        {
          repo,
          error: errorMessage(error),
        },
      );
      continue;
    }

    for (const pr of labelled) {
      const mergeableState = await resolveMergeableState(
        repo,
        pr,
        ghCommandFn,
        logger,
      );
      // A labelled PR that now merges cleanly is a stale label, not a stall,
      // and it is skipped before it costs a timeline or a comment read.
      if (mergeableState !== CONFLICTING_STATE) {
        if (mergeableState !== undefined) {
          logger.debug(
            "Merge-conflict stall watchdog: labelled PR is not conflicting",
            { repo, prNumber: pr.number, mergeableState },
          );
        }
        continue;
      }

      let observation: ConflictStallObservation;
      try {
        // The exhaustive timeline read, not the page-1 one: this decision is
        // acted on with a public comment naming a duration, so it must use
        // the genuinely most-recent `labeled` event (Issue #3709).
        const lastAdd = await getLabelLastAddInfoComplete(
          repo,
          pr.number,
          MERGE_CONFLICT_LABEL,
          ghCommandFn,
          timelineCache,
        );
        const labelledAtMs = lastAdd === null
          ? undefined
          : lastAdd.addedAt * 1000;
        // The stall clock can never start before the label, so a label inside
        // the threshold cannot be a stall — and the thread, which is the
        // expensive read, is never fetched for one.
        if (
          labelledAtMs !== undefined &&
          now - labelledAtMs <
            (thresholdHours ?? DEFAULT_CONFLICT_STALL_THRESHOLD_HOURS) *
              3600_000
        ) {
          continue;
        }
        observation = {
          repo,
          prNumber: pr.number,
          labels: pr.labels,
          mergeableState,
          ...(labelledAtMs !== undefined ? { labelledAtMs } : {}),
          comments: await fetchIssueCommentPages(repo, pr.number, ghCommandFn),
          skipReasons: skipReasonsFor(decisions, repo, pr.number),
        };
      } catch (error) {
        logger.warn("Merge-conflict stall watchdog: could not read a PR", {
          repo,
          prNumber: pr.number,
          error: errorMessage(error),
        });
        continue;
      }

      if (observation.labelledAtMs === undefined) {
        logger.warn(
          "Merge-conflict stall watchdog: no `labeled` event for the queue " +
            "label — the label age is unknown, so no stall is reported",
          { repo, prNumber: pr.number },
        );
        continue;
      }

      const stall = detectConflictQueueStall(observation, {
        nowMs: now,
        isTrustedAuthor,
        ...(thresholdHours !== undefined ? { thresholdHours } : {}),
        ...(needsHumanLabel !== undefined ? { needsHumanLabel } : {}),
      });
      if (stall === null) continue;
      stalls.push(stall);

      const escalation = await escalateConflictQueueStall(stall, options);
      if (!escalation.ok) {
        logger.error("Merge-conflict stall escalation failed", {
          repo,
          prNumber: pr.number,
          error: escalation.error.message,
        });
      }
    }
  }

  return stalls;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
