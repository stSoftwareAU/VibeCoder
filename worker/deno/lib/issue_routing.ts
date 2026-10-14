/**
 * Deterministic cross-repository issue routing (Issue #3691).
 *
 * The worker files issues in whichever repository it happened to be working
 * in, so a product gap seen while working on the Vibe Coder repository lands
 * in the wrong place (and vice versa). This module decides, from the draft
 * text alone and with no model call, which repository should own an issue,
 * then creates it there — or reuses an existing one — behind a permission
 * check, a duplicate search and a deterministic tie-break between concurrent
 * filers.
 *
 * Invariants:
 *
 * - **Diagnostics stay put (#2592).** A repo-scoped fast-failure diagnostic
 *   is filed in the repository it describes, whatever its text mentions.
 * - **Ambiguity closes nothing.** An ambiguous decision is filed where it
 *   was found with the basis recorded, and nothing is closed automatically.
 * - **Fail loud.** Permission problems throw {@link IssueRoutingPermissionError}
 *   and malformed `gh` output throws; nothing is swallowed. Every failure
 *   precedes the write it guards, so a retry is safe.
 * - **Labels are never silently migrated.** A cross-repository issue is
 *   created without labels and says so in its body.
 * - **Dry-run is read-only.**
 *
 * Every regex below is a flat alternation of literals with no nested or
 * overlapping quantifier, because the input is untrusted issue text.
 *
 * Australian English spelling used throughout.
 */

export type {
  IssueKind,
  IssueRoutingAudit,
  IssueRoutingContext,
  IssueRoutingDraft,
  IssueRoutingPart,
  RoutedIssueRef,
  RoutingAction,
  RoutingDecision,
} from "./issue_routing_types.ts";
export { IssueRoutingPermissionError } from "./issue_routing_types.ts";
export { classifyIssueRouting } from "./issue_routing_classifier.ts";
export { formatRoutingAuditBlock } from "./issue_routing_audit.ts";
export { routeIssueCreation } from "./issue_routing_filing.ts";
export { resolveWrongRepoDuplicate } from "./issue_routing_resolve.ts";
