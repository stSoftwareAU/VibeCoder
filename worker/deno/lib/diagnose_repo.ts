/**
 * Repository diagnosis library (Issue #1118).
 *
 * Migrates business logic from worker/diagnose-repo.sh to Deno TypeScript.
 * Provides label formatting, blocking reason detection, per-issue diagnosis,
 * and summary generation for the repository diagnostic report.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import type { FilterableIssue } from "./issue_filter.ts";
import { isMilestoneOccupied } from "./issue_filter.ts";
import type { BlockingPRInfo, OpenPR } from "./issue_query.ts";
import { getBlockingPRForIssue } from "./issue_query.ts";

/**
 * Label configuration for blocking reason detection.
 *
 * Issue #2031: `needsClarificationLabel` retired. The blocking signal
 * is `needsHumanLabel` (worker-to-human handoff).
 */
export interface LabelConfig {
  failedLabel: string;
  failedOnceLabel: string;
  needsHumanLabel: string;
  refineIssueLabel: string;
  planningLabel: string;
  questionLabel: string;
}

/**
 * A single blocking label reason with its human-readable explanation.
 */
export interface BlockingLabelReason {
  /** The label name. */
  label: string;
  /** Human-readable reason for the blocking. */
  reason: string;
  /** Whether this label actually blocks issue pickup (failed-once does not). */
  isBlocking: boolean;
}

/**
 * Diagnostic result for a single issue within a repo diagnosis.
 */
export interface IssueDiagnostic {
  /** Issue number. */
  issueNumber: number;
  /** Issue title. */
  issueTitle: string;
  /** Formatted label names. */
  labelNames: string;
  /** Milestone title (empty if none). */
  milestone: string;
  /** List of human-readable reasons (blocking and informational). */
  reasons: string[];
  /** Whether the issue is blocked from pickup. */
  isBlocked: boolean;
}

/**
 * Input for diagnosing a single issue within a repo context.
 */
export interface RepoIssueDiagnosticInput {
  /** The issue to diagnose. */
  issue: FilterableIssue;
  /** Open PRs by the worker in this repo. */
  prs: OpenPR[];
  /** All open issues in the repo (for milestone occupancy checks). */
  allIssues: FilterableIssue[];
  /** Label configuration. */
  labelConfig: LabelConfig;
  /** The worker's GitHub username (for milestone occupancy checks). */
  workerUser: string;
  /**
   * The fleet-account set (every fleet login). Fleet-aware milestone
   * occupancy counts an assignment by any fleet account, not just the
   * current host (Issue #3099). Optional — defaults to empty; the worker's
   * own login is always counted.
   */
  allowedAuthors?: string[];
  /**
   * The fleet's push-capable logins (`resolveFleetMaintenanceAuthorSet`).
   * Only these accounts' open PRs block an issue — a human's open PR is
   * theirs to manage (Issue #4133). Optional: omitted or empty keeps the
   * fail-safe where an unclassifiable PR still blocks.
   */
  pushCapableAuthors?: string[];
  /** Whether the issue is currently in cooldown. */
  isInCooldown?: boolean;
  /** Unmet dependency description (if any). */
  unmetDependencies?: string;
  /** Open sub-issues description (if any). */
  openSubIssues?: string;
}

/**
 * Input counts for generating the overall summary.
 */
export interface SummaryCounts {
  totalIssues: number;
  eligibleCount: number;
  prBlockedCount: number;
  labelBlockedCount: number;
  dependencyBlockedCount: number;
  otherBlockedCount: number;
}

/**
 * Generated summary with statistics and guidance.
 */
export interface DiagnosticSummary {
  totalIssues: number;
  eligibleCount: number;
  prBlockedCount: number;
  labelBlockedCount: number;
  dependencyBlockedCount: number;
  otherBlockedCount: number;
  /** Conditional guidance lines for resolving blocked issues. */
  guidance: string[];
  /** Pre-formatted human-readable summary text. */
  formatted: string;
}

// =============================================================================
// formatLabels
// =============================================================================

/**
 * Format an array of label names into a comma-separated string.
 *
 * @param labels - Array of label name strings
 * @returns Comma-separated label names, or "none" if empty
 */
export function formatLabels(labels: string[]): string {
  if (labels.length === 0) return "none";
  return labels.join(", ");
}

// =============================================================================
// getBlockingLabelReasons
// =============================================================================

/**
 * Identify which labels on an issue are blocking and map them to
 * human-readable reasons.
 *
 * @param labels - Array of label name strings from the issue
 * @param config - Label configuration with blocking label names
 * @returns Array of blocking label reasons (may be empty)
 */
export function getBlockingLabelReasons(
  labels: string[],
  config: LabelConfig,
): BlockingLabelReason[] {
  const reasons: BlockingLabelReason[] = [];

  for (const label of labels) {
    if (label === config.failedLabel) {
      reasons.push({ label, reason: "permanently failed", isBlocking: true });
    } else if (label === config.failedOnceLabel) {
      reasons.push({
        label,
        reason: "failed once — eligible for retry",
        isBlocking: false,
      });
    } else if (label === config.needsHumanLabel) {
      reasons.push({
        label,
        reason: "handed back to a human",
        isBlocking: true,
      });
    } else if (label === config.refineIssueLabel) {
      reasons.push({
        label,
        reason: "undergoing refinement",
        isBlocking: true,
      });
    } else if (label === config.planningLabel) {
      reasons.push({ label, reason: "in planning mode", isBlocking: true });
    } else if (label === config.questionLabel) {
      reasons.push({ label, reason: "question workflow", isBlocking: true });
    }
  }

  return reasons;
}

// =============================================================================
// diagnoseRepoIssue
// =============================================================================

/**
 * Analyse a single issue and determine all blocking reasons.
 *
 * This is the per-issue diagnostic used by the repository diagnosis command.
 * It checks assignment, labels, cooldown, PR blocking, and milestone occupancy.
 *
 * @param input - All data needed to diagnose the issue
 * @returns Diagnostic result with blocking reasons and status
 */
export function diagnoseRepoIssue(
  input: RepoIssueDiagnosticInput,
): IssueDiagnostic {
  const { issue, prs, allIssues, labelConfig } = input;
  const reasons: string[] = [];
  let isBlocked = false;

  // Check assignment
  if (issue.assignees.length > 0) {
    reasons.push(`Assigned to: ${issue.assignees.join(", ")}`);
    isBlocked = true;
  }

  // Check blocking labels
  const blockingReasons = getBlockingLabelReasons(issue.labels, labelConfig);
  for (const br of blockingReasons) {
    if (br.isBlocking) {
      reasons.push(`Blocking label: ${br.label} (${br.reason})`);
      isBlocked = true;
    } else {
      reasons.push(`Label: ${br.label} (${br.reason})`);
    }
  }

  // Check cooldown
  if (input.isInCooldown) {
    reasons.push("In cooldown (recently failed — temporarily skipped)");
    isBlocked = true;
  }

  // Check PR blocking (milestone-aware via existing library)
  const blockingPR: BlockingPRInfo | null = getBlockingPRForIssue(
    prs,
    issue.milestone,
    input.pushCapableAuthors ?? [],
  );
  if (blockingPR) {
    reasons.push(
      `Blocked by open PR #${blockingPR.number}: ${blockingPR.title}`,
    );
    isBlocked = true;
  }

  // Check unmet dependencies (passed in from caller)
  if (input.unmetDependencies) {
    reasons.push(`Unmet dependencies: ${input.unmetDependencies}`);
    isBlocked = true;
  }

  // Check open sub-issues (passed in from caller)
  if (input.openSubIssues) {
    reasons.push(`Open sub-issues: ${input.openSubIssues}`);
    isBlocked = true;
  }

  // Check milestone occupancy (fleet-only — human assignments don't block).
  // Fleet-aware: any fleet account's assignment occupies (Issue #3099).
  if (issue.milestone && allIssues.length > 0) {
    if (
      isMilestoneOccupied(
        allIssues,
        issue.milestone,
        input.workerUser,
        input.allowedAuthors ?? [],
      )
    ) {
      reasons.push(
        `Milestone '${issue.milestone}' is occupied by a fleet-assigned issue`,
      );
      isBlocked = true;
    }
  }

  return {
    issueNumber: issue.number,
    issueTitle: issue.title,
    labelNames: formatLabels(issue.labels),
    milestone: issue.milestone,
    reasons,
    isBlocked,
  };
}

// =============================================================================
// generateSummary
// =============================================================================

/**
 * Generate an overall assessment summary with statistics and
 * conditional guidance for resolving blocked issues.
 *
 * @param counts - Aggregated blocking category counts
 * @returns Summary with statistics, guidance, and formatted text
 */
export function generateSummary(counts: SummaryCounts): DiagnosticSummary {
  const guidance: string[] = [];

  if (counts.eligibleCount === 0) {
    if (counts.prBlockedCount > 0) {
      guidance.push(
        "Merge or close open PRs to unblock PR-blocked issues.",
      );
    }
    if (counts.labelBlockedCount > 0) {
      guidance.push(
        "Remove blocking labels (failed, needs-human, planning, etc.) from issues that should be retried.",
      );
    }
    if (counts.dependencyBlockedCount > 0) {
      guidance.push(
        "Resolve open dependency issues or sub-issues.",
      );
    }
    if (counts.otherBlockedCount > 0) {
      guidance.push(
        "Wait for cooldown to expire, or unassign occupied milestones/issues.",
      );
    }
  }

  const lines: string[] = [];
  lines.push("## Overall Assessment");
  lines.push("");
  lines.push(`- **Total issues analysed**: ${counts.totalIssues}`);
  lines.push(`- **Eligible for pickup**: ${counts.eligibleCount}`);
  lines.push(`- **Blocked by open PRs**: ${counts.prBlockedCount}`);
  lines.push(`- **Blocked by labels**: ${counts.labelBlockedCount}`);
  lines.push(
    `- **Blocked by dependencies/sub-issues**: ${counts.dependencyBlockedCount}`,
  );
  lines.push(
    `- **Blocked by other reasons** (cooldown, milestone, assigned): ${counts.otherBlockedCount}`,
  );
  lines.push("");

  if (counts.eligibleCount === 0) {
    lines.push("**No issues are currently eligible for pickup.**");
    lines.push("");
    for (const g of guidance) {
      lines.push(`- ${g}`);
    }
  } else {
    lines.push(
      `**${counts.eligibleCount} issue(s) should be available for the worker to pick up.**`,
    );
  }

  return {
    ...counts,
    guidance,
    formatted: lines.join("\n"),
  };
}

/**
 * Format a single issue diagnostic as a human-readable string.
 *
 * @param diag - Issue diagnostic result
 * @returns Formatted markdown string
 */
export function formatIssueDiagnostic(diag: IssueDiagnostic): string {
  const lines: string[] = [];

  lines.push(`### Issue #${diag.issueNumber}: ${diag.issueTitle}`);
  lines.push("");
  lines.push(`- **Labels**: ${diag.labelNames}`);
  if (diag.milestone) {
    lines.push(`- **Milestone**: ${diag.milestone}`);
  }

  if (diag.reasons.length === 0) {
    lines.push("- **Status**: Eligible for pickup");
  } else {
    for (const reason of diag.reasons) {
      lines.push(`- ${reason}`);
    }
    if (diag.isBlocked) {
      lines.push("- **Status**: Blocked");
    } else {
      lines.push("- **Status**: Eligible for pickup");
    }
  }

  lines.push("");
  return lines.join("\n");
}
