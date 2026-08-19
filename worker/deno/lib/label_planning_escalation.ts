/**
 * Planning escalation for the Vibe Coder worker (Issues #557, #977, #1476).
 *
 * Provides:
 *   - `PLANNING_ESCALATION_HEADINGS` — known comment headings to detect
 *   - `detectPlanningEscalationInComments` — pure detection helper
 *   - `checkAndHealPlanningEscalation` — fetch comments and detect
 *   - `escalateToPlanning` — post the escalation comment and unassign
 *
 * The worker never adds the operational `planning` label itself — a trusted
 * human must add it to confirm escalation (Issue #1476).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { runGhCommand } from "./github.ts";
import type { EscalationOptions, LabelManagerDeps } from "./label_types.ts";
import { DEFAULT_LABEL_CONFIG } from "./label_types.ts";

/**
 * Heading patterns that indicate planning escalation in issue comments.
 *
 * These headings are posted by `escalateToPlanning()` and `checkClaimChurn()`
 * before the label is added. If the label add fails, these comments remain
 * as the only signal that planning mode was requested.
 */
export const PLANNING_ESCALATION_HEADINGS = [
  "## Automatic Escalation to Planning Mode",
  "## Claim Churn Detected",
] as const;

/**
 * Detect whether issue comments contain a planning escalation heading.
 *
 * This is a pure function — no side effects. It checks for the heading
 * patterns posted by `escalateToPlanning()` and claim churn detection.
 *
 * Issue #977: Fallback detection when the planning label was not
 * successfully added.
 *
 * @param commentsText - Concatenated issue comments (or a single comment body)
 * @returns True if any planning escalation heading is found
 */
export function detectPlanningEscalationInComments(
  commentsText: string,
): boolean {
  if (!commentsText) return false;
  return PLANNING_ESCALATION_HEADINGS.some((heading) =>
    commentsText.includes(heading)
  );
}

/**
 * Check an issue's comments for planning escalation.
 *
 * Issue #977: Comment-based fallback detection for planning escalation.
 *
 * Issue #1476: The worker no longer attempts to re-add the `planning`
 * label when an escalation comment is detected. The `planning` label is
 * operational — a trusted human must add it to confirm escalation. This
 * function therefore always returns `labelAdded: false` when detected.
 * The return shape is retained so existing callers keep compiling.
 *
 * @param repo - Repository in "owner/repo" format
 * @param issueNumber - Issue number to check
 * @param _planningLabel - The planning label name (retained for API
 *   compatibility; no longer used for self-healing)
 * @param deps - Injectable dependencies for testability
 * @returns Result with true if planning escalation was detected
 */
export async function checkAndHealPlanningEscalation(
  repo: string,
  issueNumber: number,
  _planningLabel: string,
  deps: LabelManagerDeps = {},
): Promise<Result<{ detected: boolean; labelAdded: boolean }>> {
  const ghCommandFn = deps.ghCommandFn ?? runGhCommand;

  // Fetch issue comments
  let commentsText: string;
  try {
    commentsText = await ghCommandFn([
      "issue",
      "view",
      String(issueNumber),
      "--repo",
      repo,
      "--json",
      "comments",
      "--jq",
      '[.comments[].body] | join("\\n")',
    ]);
  } catch {
    return {
      ok: false,
      error: new Error(
        `Failed to fetch comments for issue #${issueNumber} in ${repo}`,
      ),
    };
  }

  const detected = detectPlanningEscalationInComments(commentsText);
  // Issue #1476: detection only — do not re-add the planning label.
  // A trusted human must add the label to confirm escalation.
  return { ok: true, value: { detected, labelAdded: false } };
}

/**
 * Escalate a too-complex issue to planning mode.
 *
 * Issue #1476: The worker posts the escalation comment and unassigns, but
 * does NOT add the `planning` label. The `planning` label is an operational
 * label that trusted humans must add to confirm escalation. Worker-added
 * operational labels are stripped by `verifyOperationalLabels`, producing
 * `[SECURITY] [UNTRUSTED_LABEL_CHANGE]` noise and thrashing.
 */
export async function escalateToPlanning(
  options: EscalationOptions,
  deps: LabelManagerDeps = {},
): Promise<Result<void>> {
  const ghCommandFn = deps.ghCommandFn ?? runGhCommand;
  const labels = options.labels ?? DEFAULT_LABEL_CONFIG;

  let commentBody = `## Automatic Escalation to Planning Mode

This issue has been detected as too complex for a single implementation attempt. It should be broken down into smaller, focused sub-issues via planning mode.

### What happens next?
- A trusted human needs to add the \`${labels.planningLabel}\` label to this issue to confirm escalation
- On the next worker scan after the label is added, this issue will be processed in planning mode to create sub-issues
- The worker has unassigned itself so the issue is available for review`;

  // Append worker identity footer (Issue #436)
  if (options.workerFooter) {
    commentBody += options.workerFooter;
  }

  try {
    await ghCommandFn([
      "issue",
      "comment",
      String(options.issueNumber),
      "--repo",
      options.repo,
      "--body",
      commentBody,
    ]);
  } catch {
    return {
      ok: false,
      error: new Error(
        `Failed to post planning escalation comment for issue #${options.issueNumber}`,
      ),
    };
  }

  // Issue #1476: Do NOT add the planning label programmatically. The
  // planning label is operational — a trusted human must add it to confirm
  // escalation. Adding it here produces [SECURITY] [UNTRUSTED_LABEL_CHANGE]
  // events because verifyOperationalLabels strips worker-added labels.

  // Unassign
  try {
    await ghCommandFn([
      "issue",
      "edit",
      String(options.issueNumber),
      "--repo",
      options.repo,
      "--remove-assignee",
      options.githubUser,
    ]);
  } catch {
    // Best-effort
  }

  return { ok: true, value: undefined };
}
