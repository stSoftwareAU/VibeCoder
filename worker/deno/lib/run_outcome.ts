/**
 * Run outcome carried from a coding run to the claim-release site (Issue
 * #4325, part of #4291).
 *
 * A claim release used to say only "released this claim" — nothing about
 * whether a PR was raised or why not (four such comments on #4174). The
 * outcome never reached the release site: `WorkOnIssueResult` dropped the
 * PR URL and `processIssue` narrowed everything to booleans. This module
 * defines the outcome that now travels the whole chain, and the one builder
 * that derives it from a `WorkOnIssueResult`.
 *
 * `category` for a failure comes from `detectFailureCategory()` — the single
 * diagnosis path (#4298's corrected timeout messages flow through it) — never
 * from a parallel derivation.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  detectFailureCategory,
  type FailureCategory,
} from "./failure_diagnosis.ts";
import type { ClaimStaleReason, StaleClaim } from "./claim_freshness.ts";

/**
 * Short facts a run wants stated on the release comment alongside whatever it
 * achieved (Issue #210) — a follow-up reference the agent named that does not
 * exist, for instance. Independent of `kind`: a run can raise a PR *and* have
 * got a reference wrong.
 */
export interface RunOutcomeNotes {
  notes?: string[];
}

/** What a run achieved, as reported in the claim-release comment. */
export type RunOutcome =
  & (
    | { kind: "pr"; prUrl: string; prNumber: number }
    | {
      kind: "no_pr";
      /** Failure category from failure_diagnosis.ts (#4298's corrected diagnosis). */
      category: FailureCategory;
      /** Phase that died — the `phase` field of WorkOnIssueResult. */
      phase: string;
      /** Wall-clock seconds from claim to release. */
      elapsedSeconds: number;
      /** Raw failure message, for downstream classification/filing. */
      message: string;
    }
    | { kind: "no_pr_expected"; phase: string; summary: string }
    /**
     * The issue was resolved by another PR while this run was working on it
     * (Issue #218) — a sibling host's PR merged mid-run on VibeCoder#185. The
     * run raised no PR and nothing failed, so it is neither a `no_pr` failure
     * (which files a run-failure issue and labels the issue) nor a plain
     * `no_pr_expected` (which says nothing about what resolved the issue).
     */
    | {
      kind: "superseded";
      /** Phase that discovered the superseding PR. */
      phase: string;
      prUrl: string;
      prNumber: number;
      prState: "MERGED" | "CLOSED";
      /** WIP this run preserved on its branch before stopping, if any. */
      wipNote?: string;
    }
    /**
     * The claim was still legitimate when it was taken, but the world moved
     * before the PR went up (Issue #344) — the issue closed mid-cycle, or a
     * PR overtook this run. The run stopped cleanly rather than opening a PR
     * against resolved work, so it is not a failure and must not feed the
     * failure streak.
     */
    | {
      kind: "claim_stale";
      /** Phase that found the claim stale. */
      phase: string;
      /** Which freshness rule fired. */
      reason: ClaimStaleReason;
      /** One sentence naming what changed. */
      detail: string;
      /** Branch this run's work is on, when it pushed one. */
      branch?: string;
      /** The PR that overtook this run, when one did. */
      prUrl?: string;
      prNumber?: number;
    }
  )
  & RunOutcomeNotes;

/**
 * Attach notes to an outcome for the release comment (Issue #210).
 *
 * Blank notes are dropped and existing ones are preserved, so a caller can
 * add a note without knowing what the run already recorded.
 */
export function withRunOutcomeNotes(
  outcome: RunOutcome,
  notes: readonly string[],
): RunOutcome {
  const extra = notes.map((note) => note.trim()).filter((note) => note !== "");
  if (extra.length === 0) return outcome;
  return { ...outcome, notes: [...(outcome.notes ?? []), ...extra] };
}

/** The subset of a work result the builder reads. */
export interface RunOutcomeSource {
  success: boolean;
  phase: string;
  reason: string;
  timings?: Record<string, number>;
  /** PR raised by the run, when one was (completion or self-heal). */
  prUrl?: string;
  prNumber?: number;
  /** Wall-clock seconds for the run; defaults to the sum of `timings`. */
  elapsedSeconds?: number;
}

/** PR number parsed from a GitHub PR URL, or 0. */
export function prNumberFromUrl(prUrl: string): number {
  const match = /\/pull\/(\d+)/.exec(prUrl);
  return match ? parseInt(match[1]!, 10) : 0;
}

/**
 * Derive the outcome of a coding run.
 *
 * - a run that raised a PR → `pr` (URL and number);
 * - a failed run → `no_pr` with the diagnosed category, the dying phase,
 *   the elapsed seconds and the raw reason;
 * - a successful run that deliberately raised no PR (merged-PR pre-check
 *   short-circuit, no-changes hand-off, context-budget exit) →
 *   `no_pr_expected` with the reason as the summary.
 */
export function deriveRunOutcome(source: RunOutcomeSource): RunOutcome {
  if (source.prUrl) {
    return {
      kind: "pr",
      prUrl: source.prUrl,
      prNumber: source.prNumber && source.prNumber > 0
        ? source.prNumber
        : prNumberFromUrl(source.prUrl),
    };
  }
  if (source.success) {
    return {
      kind: "no_pr_expected",
      phase: source.phase,
      summary: source.reason,
    };
  }
  const elapsedSeconds = source.elapsedSeconds ??
    Object.values(source.timings ?? {}).reduce((a, b) => a + b, 0);
  return {
    kind: "no_pr",
    category: detectFailureCategory(source.reason),
    phase: source.phase,
    elapsedSeconds: Math.max(0, Math.round(elapsedSeconds)),
    message: source.reason,
  };
}

/** One-word label for logs (`kind`, plus category for failures). */
export function describeRunOutcome(outcome: RunOutcome | undefined): string {
  if (!outcome) return "none";
  switch (outcome.kind) {
    case "pr":
      return `pr:#${outcome.prNumber}`;
    case "no_pr":
      return `no_pr:${outcome.category}:${outcome.phase}`;
    case "no_pr_expected":
      return `no_pr_expected:${outcome.phase}`;
    case "superseded":
      return `superseded:pr#${outcome.prNumber}`;
    case "claim_stale":
      return `claim_stale:${outcome.reason}`;
  }
}

/**
 * Outcome for a run whose issue was resolved by another PR mid-run (Issue
 * #218). Not a failure: no category, no `unknown` class, nothing filed.
 */
export function supersededOutcome(options: {
  phase: string;
  prUrl: string;
  prNumber: number;
  prState: "MERGED" | "CLOSED";
  wipNote?: string;
}): RunOutcome {
  return {
    kind: "superseded",
    phase: options.phase,
    prUrl: options.prUrl,
    prNumber: options.prNumber,
    prState: options.prState,
    ...(options.wipNote ? { wipNote: options.wipNote } : {}),
  };
}

/**
 * Outcome for a run that stopped because its claim went stale (Issue #344) —
 * the issue closed mid-cycle, or a PR overtook the run. Like
 * {@link supersededOutcome} this is the system working: no category, no
 * `unknown` class, nothing filed, and no contribution to the failure streak.
 */
export function claimStaleOutcome(options: {
  phase: string;
  stale: StaleClaim;
  /** Branch the work is on, when the run pushed one. */
  branch?: string;
}): RunOutcome {
  const { phase, stale, branch } = options;
  return {
    kind: "claim_stale",
    phase,
    reason: stale.reason,
    detail: stale.detail,
    ...(branch ? { branch } : {}),
    ...(stale.prUrl ? { prUrl: stale.prUrl } : {}),
    ...(stale.prNumber ? { prNumber: stale.prNumber } : {}),
  };
}

// ---------------------------------------------------------------------------
// Non-coding terminal paths (Issue #4330, part of #4291)
// ---------------------------------------------------------------------------

/** A deliberate no-PR outcome for a non-coding phase (planning, question…). */
export function expectedNoPrOutcome(
  phase: string,
  summary: string,
): RunOutcome {
  return { kind: "no_pr_expected", phase, summary };
}

/** A genuine failure inside a non-coding phase — the same shape the coding path reports. */
export function failedRunOutcome(
  phase: string,
  message: string,
  elapsedSeconds: number,
): RunOutcome {
  return {
    kind: "no_pr",
    category: detectFailureCategory(message),
    phase,
    elapsedSeconds: Math.max(0, Math.round(elapsedSeconds)),
    message,
  };
}

/**
 * Outcome for a non-coding processor's `Result`: ok → the deliberate
 * no-PR (with the result's own summary when it has one); not ok → a
 * failure diagnosed by `detectFailureCategory`.
 */
export function outcomeForNonCodingResult(
  phase: string,
  result: { ok: true; value: unknown } | { ok: false; error: Error },
  elapsedSeconds: number,
  defaultSummary: string,
): RunOutcome {
  if (result.ok) {
    const summary = (result.value as { summary?: unknown } | null)?.summary;
    return expectedNoPrOutcome(
      phase,
      typeof summary === "string" && summary.trim().length > 0
        ? summary
        : defaultSummary,
    );
  }
  return failedRunOutcome(phase, result.error.message, elapsedSeconds);
}

/** Outcome for a non-coding processor that threw. */
export function outcomeForThrown(
  phase: string,
  err: unknown,
  elapsedSeconds: number,
): RunOutcome {
  return failedRunOutcome(
    phase,
    err instanceof Error ? err.message : String(err),
    elapsedSeconds,
  );
}
