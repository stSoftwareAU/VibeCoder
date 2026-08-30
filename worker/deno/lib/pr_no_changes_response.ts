/**
 * Classifier-aware no-changes response builder (Issue #1691).
 *
 * When the worker reviews a CI failure or PR feedback comment but pushes no
 * code changes, we must not post a confident "transient or infrastructure"
 * fallback — that conclusion is almost never correct, and for code-fix
 * categories like semgrep findings it is actively wrong (see PR #1678).
 *
 * This module produces the comment body and label decision for the
 * no-changes case based on the classifier output from
 * {@link ./ci_failure_classifier.ts}.
 *
 * Pure function — no side effects, no I/O.
 */

import type {
  CiFailureCategory,
  CiFailureClassification,
} from "./ci_failure_classifier.ts";
import { assertNever } from "./assert_never.ts";

/**
 * Result of building a no-changes response.
 *
 * - `body` — the PR comment body for the non-escalating paths
 *   (timing / infrastructure / unknown). Posted as-is.
 * - `addNeedsHuman` — whether the `needs-human` label should be added to the
 *   PR. Only set for the `code-fix-required` category.
 * - `reason` / `nextStep` — when `addNeedsHuman` is true, these supply the
 *   `**Why:**` and `**Next step:**` lines for the shared
 *   {@link ../needs_human_escalation.ts | escalateToHuman} helper (Issue
 *   #2211). They are not used on the non-escalating paths.
 */
export interface NoChangesResponse {
  body: string;
  addNeedsHuman: boolean;
  category: CiFailureCategory;
  reason?: string;
  nextStep?: string;
}

/**
 * Standard "what the reviewer should do" sentence appended to escalation
 * comments on PR paths. Centralised so both the CI and feedback no-changes
 * helpers stay aligned.
 */
export const PR_ESCALATION_NEXT_STEP =
  "Review the failing check and either push a fix or reply with guidance, " +
  "then remove the `needs-human` label so the worker can retry.";

/** Render the matched signals into a short bullet list, truncated for length. */
function formatSignals(signals: ReadonlyArray<string>): string {
  if (signals.length === 0) return "_(no specific signals)_";
  const top = signals.slice(0, 6);
  const lines = top.map((s) => `- \`${s}\``);
  if (signals.length > top.length) {
    lines.push(`- _(+${signals.length - top.length} more)_`);
  }
  return lines.join("\n");
}

/**
 * Build the PR comment body and label decision for a CI failure where the
 * worker did not push any code changes.
 *
 * @param checkName - The failing CI check name (used in the message header).
 * @param classification - Output of {@link classifyCiFailure}.
 */
export function buildCiNoChangesResponse(
  checkName: string,
  classification: CiFailureClassification,
): NoChangesResponse {
  const { category, reason, signals } = classification;
  const signalBlock = formatSignals(signals);
  const trailer =
    `\n\n**Classifier reason:** ${reason}\n**Signals:**\n${signalBlock}`;

  switch (category) {
    case "code-fix-required": {
      // Issue #2211: route the escalation through the shared helper, so
      // `body` is no longer posted directly. `reason` and `nextStep` are
      // what the helper substitutes into the comment. The legacy `body` is
      // kept (and explicitly mentions `needs-human`) for any caller that
      // still inspects it.
      const reason =
        `I reviewed the CI check failure (**${checkName}**) but could not produce a code fix. ` +
        `The classifier indicates this requires a code change.${trailer}`;
      return {
        category,
        addNeedsHuman: true,
        reason,
        nextStep: PR_ESCALATION_NEXT_STEP,
        body:
          `I reviewed the CI check failure (**${checkName}**) but could not produce a code fix. ` +
          `The classifier indicates this requires a code change, so a human reviewer is required — ` +
          `I have added the \`needs-human\` label.${trailer}`,
      };
    }
    case "history-rewrite-required": {
      // Issue #630. Reaching here means the content fix produced no change,
      // so the rebuild never ran — and a secret finding that survives with
      // nothing left to correct is in the BASE branch, not this PR. Say that,
      // because "CI is failing" would send a reviewer to the wrong place.
      const escalationReason =
        `The **${checkName}** check scans every commit in the branch rather than the working ` +
        `tree, and I produced no content change to rebuild the branch around. A finding that ` +
        `survives with nothing left to correct is already in the base branch, so rewriting this ` +
        `PR cannot clear it.${trailer}`;
      return {
        category,
        addNeedsHuman: true,
        reason: escalationReason,
        nextStep:
          `Rotate the exposed credential first — it must be assumed compromised regardless of ` +
          `what happens to the history. Then purge it from the base branch's history and force-push ` +
          `that, which is a repository-wide operation this worker will not perform unattended.`,
        body: escalationReason,
      };
    }
    case "timing":
      return {
        category,
        addNeedsHuman: false,
        body:
          `I reviewed the CI check failure (**${checkName}**) and it looks like a timing or timeout issue. ` +
          `No code change was applied — please re-run the failing check before escalating.${trailer}`,
      };
    case "infrastructure":
      return {
        category,
        addNeedsHuman: false,
        body:
          `I reviewed the CI check failure (**${checkName}**) and it looks infrastructure-related ` +
          `(network, runner, or upstream service). No code change was applied — please re-run the ` +
          `failing check.${trailer}`,
      };
    case "unknown":
      return {
        category: "unknown",
        addNeedsHuman: false,
        body:
          `I investigated the CI check failure (**${checkName}**) but could not determine a fix — ` +
          `please review.${trailer}`,
      };
    default:
      // Exhaustiveness guard: a new CiFailureCategory must get its own arm
      // rather than silently mapping to the "unknown" path (Issue #2794).
      return assertNever(category);
  }
}

/**
 * Build the PR comment body and label decision for PR review feedback where
 * the worker did not push any code changes.
 *
 * When `classification` is omitted (pure human review feedback with no
 * associated CI check), the message is a neutral acknowledgement that does
 * not assert transience and does not add `needs-human`.
 */
export function buildFeedbackNoChangesResponse(
  classification?: CiFailureClassification,
): NoChangesResponse {
  if (!classification) {
    return {
      category: "unknown",
      addNeedsHuman: false,
      body:
        "I reviewed this feedback and could not identify a code change to apply. " +
        "Please clarify if a change is required.",
    };
  }
  // When a failing check is associated with the feedback, route via the
  // CI-style helper using a neutral check label.
  return buildCiNoChangesResponse("PR feedback", classification);
}
