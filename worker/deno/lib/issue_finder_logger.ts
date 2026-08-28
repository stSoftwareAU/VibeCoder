/**
 * Diagnostic logger for the issue finder pipeline (Issue #1062).
 *
 * Provides structured logging for each filtering stage in the issue
 * finder, gated behind the ISSUE_FINDER_DEBUG environment variable
 * to avoid noise in normal operation.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import type { FleetAuthorSetDivergence } from "./fleet_authors.ts";

/**
 * Skip reason codes for issue filtering.
 *
 * Declared as a runtime tuple, not a bare type union, so other modules can
 * enumerate the gates rather than restate them (Issue #460). The census's
 * `CENSUS_SCAN_GATE_COVERAGE` is a total map over this list, so adding a
 * reason here fails the type check until the census classifies it — the
 * check that #3526, #3852 and GRQ#4419 each went without.
 */
export const SKIP_REASONS = [
  "repo-not-allowed",
  "repo-deprioritised",
  "repo-busy",
  "fetch-error",
  "assigned",
  "blocking-label",
  "milestone-occupied",
  "pr-blocked",
  "closed-pr-cooldown",
  /**
   * Issue #319: a **merged** fleet PR blocks permanently (Issue #3151),
   * unlike the cooldown-windowed closed-unmerged case. Distinct so the
   * scan tally does not report a permanent strand as a passing cooldown.
   */
  "merged-pr-permanent",
  "dependency-blocked",
  "cooldown",
  "cross-worker-cooldown",
  "label-author-not-allowed",
  "non-wrapper-title",
  "untrusted-operational-label",
  "content-modified-after-approval",
  /** Issue #3649: approval baseline unusable — fail closed rather than bless */
  "content-check-error",
  /** Issue #3715: the actor behind the edit could not be resolved */
  "content-editor-unresolved",
  /** Issue #3874: workDir names no store, so no baseline exists to verify */
  "content-store-unconfigured",
  /** Issue #3868: the refreshed approval baseline could not be persisted */
  "content-snapshot-persist-failed",
  /** Issue #3876: no approval baseline to verify the prompt content against */
  "no-approval-snapshot",
  "filtered-out",
  /** Issue #1470: worker-to-human escalation — skip issues with needs-human */
  "needs-human",
  /** Issue #2752: dependency cycle detected — escalated and dropped */
  "dependency-cycle-escalated",
  /** Issue #2752: milestone-tracking issue labelled work-on — escalated */
  "dead-label-tracker-escalated",
  /** Issue #4078: blocked by a human-authored PR — nudged and escalated */
  "human-pr-blocked-escalated",
  /**
   * Issue #505: an auto-filed worker diagnostic the self-scheduling path
   * refused this scan — the in-flight cap is full, or the decision could
   * not be recorded/announced. Distinct so a refusal is never mistaken for
   * "no diagnostic was there".
   */
  "self-schedule-refused",
  /** Issue #505: an unschedulable diagnostic escalated to a human */
  "self-schedule-escalated",
] as const;

/**
 * Skip reason codes for issue filtering. Derived from {@link SKIP_REASONS}
 * so the type and the enumerable list cannot drift.
 */
export type SkipReason = typeof SKIP_REASONS[number];

/**
 * Repo classification for diagnostic output.
 */
export type RepoClassification =
  | "free"
  | "busy"
  | "deprioritised"
  | "not-allowed"
  /** Held by another slot on this host (Issue #4176). */
  | "in-flight"
  | "error";

/**
 * Claim race outcome for diagnostic logging (Issue #1090).
 */
export type ClaimRaceOutcome = "won" | "lost";

/**
 * Diagnostic summary counts, keyed by skip reason.
 */
export type DiagnosticSummary = {
  totalConsidered: number;
  totalEligible: number;
  skippedByReason: Partial<Record<SkipReason, number>>;
  /** Number of claim races won during this scan cycle (Issue #1090). */
  claimRaceWins: number;
  /** Number of claim races lost during this scan cycle (Issue #1090). */
  claimRaceLosses: number;
};

/**
 * Description of a configured-label issue that was considered for
 * selection but blocked at one of the per-issue eligibility checks
 * (Issue #1718). Surfaced in the selection-reasoning diagnostic so the
 * user can see exactly which top-priority issues were skipped, and why,
 * when a lower-priority work-on candidate is processed instead.
 */
export interface BlockedCandidateInfo {
  /** Repository in "owner/repo" format. */
  repo: string;
  /** Issue number. */
  issueNumber: number;
  /** Milestone title (empty string if no milestone). */
  milestone: string;
  /** Skip reason that caused the issue to be blocked. */
  reason: SkipReason;
}

/**
 * Identifying details of the issue ultimately selected by
 * `selectHighestPriority`. Only the fields needed to render the
 * selection-reasoning line are included so callers don't have to leak
 * the full `IssueCandidate` shape into the logger.
 */
export interface SelectionReasoningSubject {
  repo: string;
  number: number;
  source: string;
}

/**
 * Details of an open PR found to be blocking `work-on` issues in a repo
 * (Issue #4024).
 *
 * `inMaintenanceSet` is the fleet invariant made visible: a blocking PR
 * whose author is *not* in the PR-maintenance scan set is a PR nothing
 * will fix, answer, or merge — the #4023 stall, findable by a log grep
 * instead of a code read. An author that cannot be determined renders as
 * `(unknown)` and counts as *not* covered, because coverage could not be
 * confirmed.
 */
export interface BlockingPrInfo {
  /** Repository in "owner/repo" format. */
  repo: string;
  /** The blocking PR's number. */
  prNumber: number;
  /** The PR author's login ("" when unknown). */
  author: string;
  /** The PR's base branch. */
  baseRef: string;
  /** Numbers of the `work-on` issues this PR deferred. */
  blockedIssues: number[];
  /** Whether the author is covered by the PR-maintenance scan set. */
  inMaintenanceSet: boolean;
}

/**
 * Interface for the issue finder diagnostic logger.
 */
export interface IssueFinderDiagnostics {
  /** Whether diagnostics are enabled */
  readonly enabled: boolean;
  /** Log repo classification (free/busy/deprioritised) */
  logRepoClassification(repo: string, classification: RepoClassification): void;
  /** Log an issue being considered */
  logIssueConsidered(repo: string, issueNumber: number, title: string): void;
  /** Log an issue being skipped with reason */
  logIssueSkipped(
    repo: string,
    issueNumber: number,
    reason: SkipReason,
    detail?: string,
  ): void;
  /** Log an issue being selected as eligible */
  logIssueEligible(repo: string, issueNumber: number): void;
  /**
   * Log the open-PR duplicate guard decision for a repo (Issue #3138).
   *
   * Records the fleet authors queried and the per-author open-PR counts so
   * a future duplicate-PR miss can be diagnosed from the logs alone: an
   * author present in the fleet set with a `0` count that should have been
   * non-zero points at a stale per-user cache; an author *absent* from the
   * fleet set points at a missing fleet-account config.
   */
  logFleetPrGuard(
    repo: string,
    authors: string[],
    perAuthorCounts: Record<string, number>,
    totalPrs: number,
  ): void;
  /**
   * Warn that the blocking-guard author set and the PR-maintenance scan
   * set have diverged (Issue #4024).
   *
   * Emitted once per iteration and written unconditionally (like
   * `logSelectionReasoning`) — this is the in-production signal that the
   * #4023 class of bug has returned, and it must not need
   * `ISSUE_FINDER_DEBUG` to be visible. A consistent pair emits nothing,
   * so callers may call this unconditionally.
   */
  logFleetAuthorSetDivergence(divergence: FleetAuthorSetDivergence): void;
  /**
   * Log that an open PR is blocking one or more `work-on` issues
   * (Issue #4024). Written unconditionally for the same reason as the
   * divergence warning.
   */
  logBlockingPr(info: BlockingPrInfo): void;
  /** Log the final candidate selection */
  logFinalSelection(repo: string, issueNumber: number, source: string): void;
  /** Log a claim race outcome (Issue #1090) */
  logClaimRaceOutcome(
    repo: string,
    issueNumber: number,
    outcome: ClaimRaceOutcome,
    competingWorkers: number,
  ): void;
  /**
   * Emit a structured `selection-reasoning` line explaining why a
   * work-on candidate was selected even though configured-label
   * candidates were considered or blocked (Issue #1718). Always
   * written to the underlying sink regardless of `enabled`, because it
   * answers a question the user is asking right now (#1717). Callers
   * are responsible for invoking it only in the cases described in
   * the issue's acceptance criteria.
   */
  logSelectionReasoning(
    selected: SelectionReasoningSubject,
    configuredLabelConsidered: number,
    blockedEntries: BlockedCandidateInfo[],
  ): void;
  /** Log and return the accumulated summary */
  getSummary(): DiagnosticSummary;
  /** Get all logged messages (for testing) */
  getMessages(): string[];
}

/**
 * Maximum length for an untrusted field once interpolated into a log
 * line (Issue #2797). Clamps attacker-controlled titles/details so a
 * single log entry cannot be padded out to obscure the surrounding
 * diagnostic trail.
 */
const MAX_UNTRUSTED_FIELD_LENGTH = 200;

/**
 * C0 (`0x00`-`0x1F`) and C1 (`0x7F`-`0x9F`) control-character ranges.
 * Built via RegExp constructor so the source file itself stays free of
 * literal control bytes.
 */
// deno-lint-ignore no-control-regex -- stripping control bytes is the point.
const CONTROL_CHARS = new RegExp("[\\x00-\\x1F\\x7F-\\x9F]", "g");

/**
 * Sanitise an untrusted, externally-controlled string before it is
 * interpolated into a structured log line (Issue #2797).
 *
 * GitHub issue titles (and skip details derived from them) are fully
 * attacker-controlled. Without sanitisation an embedded newline can
 * forge a `[issue-finder] …` log line, ANSI/terminal escapes can
 * manipulate an operator's terminal, and an embedded `"` can break the
 * `key="value"` field framing. This strips the C0/C1 control ranges
 * (replacing each with a space), escapes embedded double quotes, and
 * clamps the length.
 *
 * @param value - The untrusted string to sanitise.
 * @returns A single-line, control-character-free, length-clamped string.
 */
export function sanitiseLogField(value: string): string {
  return value
    .replace(CONTROL_CHARS, " ")
    .replace(/"/g, "'")
    .slice(0, MAX_UNTRUSTED_FIELD_LENGTH);
}

/**
 * Render a scan's counts as one log field set (Issue #219).
 *
 * A pool slot that finds no work logs this line, so "no eligible work" is
 * always accompanied by *why* — without needing `ISSUE_FINDER_DEBUG`, which
 * is off in production. `skipped` is the number of skip decisions taken
 * (the sum of `skippedByReason`), which counts repo-level skips that never
 * reach the per-issue `considered` tally.
 *
 * @param summary - Counts collected during the scan.
 * @param topReasons - How many skip reasons to name, busiest first.
 * @returns A single-line `key=value` summary.
 */
export function formatScanSummary(
  summary: DiagnosticSummary,
  topReasons = 3,
): string {
  const counts = Object.entries(summary.skippedByReason)
    .map(([reason, count]) => [reason, count ?? 0] as const)
    .filter(([, count]) => count > 0);
  const skipped = counts.reduce((total, [, count]) => total + count, 0);
  const top = counts
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(0, topReasons))
    .map(([reason, count]) => `${reason}=${count}`)
    .join(",");
  return `considered=${summary.totalConsidered} ` +
    `eligible=${summary.totalEligible} skipped=${skipped} ` +
    `top-skips=${top || "(none)"}`;
}

/**
 * Check whether issue finder diagnostics are enabled.
 *
 * Reads from the ISSUE_FINDER_DEBUG environment variable.
 * Returns true when set to "true" or "1".
 */
export function isDiagnosticsEnabled(): boolean {
  const value = Deno.env.get("ISSUE_FINDER_DEBUG");
  return value === "true" || value === "1";
}

/**
 * Create an issue finder diagnostic logger.
 *
 * When enabled, logs structured messages to stderr via the provided
 * write function. When disabled, all methods are no-ops (except
 * getSummary which still tracks counts).
 *
 * @param options - Configuration options
 * @returns Diagnostic logger instance
 */
export function createDiagnostics(options: {
  enabled?: boolean;
  write?: (message: string) => void;
} = {}): IssueFinderDiagnostics {
  const enabled = options.enabled ?? isDiagnosticsEnabled();
  const write = options.write ?? ((msg: string) => console.error(msg));
  const messages: string[] = [];

  let totalConsidered = 0;
  let totalEligible = 0;
  const skippedByReason: Partial<Record<SkipReason, number>> = {};
  let claimRaceWins = 0;
  let claimRaceLosses = 0;

  function emit(msg: string): void {
    messages.push(msg);
    if (enabled) {
      write(msg);
    }
  }

  return {
    get enabled() {
      return enabled;
    },

    logRepoClassification(
      repo: string,
      classification: RepoClassification,
    ): void {
      emit(`[issue-finder] repo=${repo} classification=${classification}`);
    },

    logIssueConsidered(repo: string, issueNumber: number, title: string): void {
      totalConsidered++;
      emit(
        `[issue-finder] repo=${repo} issue=#${issueNumber} status=considered title="${
          sanitiseLogField(title)
        }"`,
      );
    },

    logIssueSkipped(
      repo: string,
      issueNumber: number,
      reason: SkipReason,
      detail?: string,
    ): void {
      skippedByReason[reason] = (skippedByReason[reason] ?? 0) + 1;
      const detailStr = detail ? ` detail="${sanitiseLogField(detail)}"` : "";
      emit(
        `[issue-finder] repo=${repo} issue=#${issueNumber} skipped=${reason}${detailStr}`,
      );
    },

    logIssueEligible(repo: string, issueNumber: number): void {
      totalEligible++;
      emit(`[issue-finder] repo=${repo} issue=#${issueNumber} status=eligible`);
    },

    logFleetPrGuard(
      repo: string,
      authors: string[],
      perAuthorCounts: Record<string, number>,
      totalPrs: number,
    ): void {
      const breakdown = authors
        .map((a) => `${sanitiseLogField(a)}=${perAuthorCounts[a] ?? 0}`)
        .join(",");
      emit(
        `[issue-finder] repo=${repo} fleet-pr-guard authors=${authors.length} per-author=${
          breakdown || "(none)"
        } total-open-prs=${totalPrs}`,
      );
    },

    logFleetAuthorSetDivergence(divergence: FleetAuthorSetDivergence): void {
      if (!divergence.diverged) return;
      const render = (authors: string[]) =>
        authors.map((a) => sanitiseLogField(a)).join(",") || "(none)";
      // Issue #4024: written unconditionally — a divergence means a fleet
      // PR can block work that no scan maintains, and an operator must see
      // it without enabling debug diagnostics.
      const message = `[issue-finder] fleet-author-set-divergence ` +
        `missing-from-maintenance=${
          render(divergence.missingFromMaintenance)
        } ` +
        `missing-from-blocking=${render(divergence.missingFromBlocking)}`;
      messages.push(message);
      write(message);
    },

    logBlockingPr(info: BlockingPrInfo): void {
      const blocked = info.blockedIssues.map((n) => `#${n}`).join(",") ||
        "(none)";
      const author = info.author.trim().length > 0
        ? sanitiseLogField(info.author)
        : "(unknown)";
      // Issue #4024: written unconditionally so a stalled fleet PR is
      // diagnosable from the ordinary worker log.
      const message = `[issue-finder] repo=${info.repo} pr-blocks-work-on ` +
        `pr=#${info.prNumber} author=${author} ` +
        `base=${sanitiseLogField(info.baseRef)} blocked-issues=${blocked} ` +
        `in-maintenance-set=${info.inMaintenanceSet}`;
      messages.push(message);
      write(message);
    },

    logFinalSelection(repo: string, issueNumber: number, source: string): void {
      emit(
        `[issue-finder] selected repo=${repo} issue=#${issueNumber} source=${source}`,
      );
    },

    logClaimRaceOutcome(
      repo: string,
      issueNumber: number,
      outcome: ClaimRaceOutcome,
      competingWorkers: number,
    ): void {
      if (outcome === "won") {
        claimRaceWins++;
      } else {
        claimRaceLosses++;
      }
      emit(
        `[issue-finder] repo=${repo} issue=#${issueNumber} claim_race=${outcome} competing_workers=${competingWorkers}`,
      );
    },

    logSelectionReasoning(
      selected: SelectionReasoningSubject,
      configuredLabelConsidered: number,
      blockedEntries: BlockedCandidateInfo[],
    ): void {
      // Issue #1718: this line is emitted unconditionally so the user
      // can see why top-priority was passed over without having to set
      // ISSUE_FINDER_DEBUG=true. All other diagnostic lines remain
      // debug-gated.
      const blockedList = blockedEntries
        .map((b) => `${b.repo}#${b.issueNumber}(${b.reason})`)
        .join(",");
      const blockedField = blockedList.length > 0
        ? ` blocked=${blockedList}`
        : "";
      const message =
        `[issue-finder] selection-reasoning selected=${selected.repo}#${selected.number} ` +
        `source=${selected.source} configured-label-considered=${configuredLabelConsidered} ` +
        `configured-label-blocked=${blockedEntries.length}${blockedField}`;
      messages.push(message);
      write(message);
    },

    getSummary(): DiagnosticSummary {
      const summary: DiagnosticSummary = {
        totalConsidered,
        totalEligible,
        skippedByReason: { ...skippedByReason },
        claimRaceWins,
        claimRaceLosses,
      };

      if (enabled) {
        const totalSkipped = totalConsidered - totalEligible;
        const reasonParts = Object.entries(skippedByReason)
          .map(([reason, count]) => `${reason}=${count}`)
          .join(" ");
        const raceParts = claimRaceWins + claimRaceLosses > 0
          ? ` claim_race_wins=${claimRaceWins} claim_race_losses=${claimRaceLosses}`
          : "";
        emit(
          `[issue-finder] summary total_considered=${totalConsidered} total_eligible=${totalEligible} total_skipped=${totalSkipped}${
            reasonParts ? ` ${reasonParts}` : ""
          }${raceParts}`,
        );
      }

      return summary;
    },

    getMessages(): string[] {
      return [...messages];
    },
  };
}
