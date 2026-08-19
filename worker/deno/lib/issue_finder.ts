/**
 * Issue finding and selection orchestration (Issue #910).
 *
 * Barrel module that re-exports the three issue-finding entry points
 * from their dedicated files (Issue #1529 split). Existing callers
 * import from `./issue_finder.ts` and continue to work unchanged.
 *
 * - `findOldestIssue` — cross-repo oldest-issue scan (find_oldest_issue.ts)
 * - `findIssuesByLabel` — label-based lookup (find_issues_by_label.ts)
 * - `findPlanningIssuesWithFallback` — planning-label lookup with
 *   comment-based fallback (find_planning_issues.ts)
 *
 * Shared types and small helpers live in `issue_finder_common.ts`.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

export type {
  FindIssuesOptions,
  FindIssuesResult,
} from "./issue_finder_common.ts";

export { findOldestIssue } from "./find_oldest_issue.ts";
export { findIssuesByLabel } from "./find_issues_by_label.ts";
export { findPlanningIssuesWithFallback } from "./find_planning_issues.ts";
