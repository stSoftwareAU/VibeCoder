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
import { neutraliseAgentMarkers } from "./agent_marker_neutralisation.ts";

/**
 * Result of building a no-changes response.
 *
 * - `body` — the PR comment body for the non-escalating paths
 *   (timing / infrastructure / unknown). Posted as-is.
 * - `addNeedsHuman` — whether the `needs-human` label should be added to the
 *   PR. Only set for the `history-rewrite-required` category: a secret
 *   already in the base branch's history needs a credential rotation no
 *   worker performs (Issue #4304 removed every other hand-back).
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
 * Standard "what the reviewer should do" sentence for the one escalation
 * left on PR paths — a secret already in the base branch's history, whose
 * own arm supplies the rotate-the-credential `nextStep`. Kept as the
 * callers' fallback when a response carries no `nextStep` of its own.
 */
export const PR_ESCALATION_NEXT_STEP =
  "Review the failing check and either push a fix or reply with guidance, " +
  "then remove the `needs-human` label so the worker can retry.";

/**
 * What happens next on every non-escalating no-change reply (Issue #4304).
 * The worker re-runs the check itself and retries; nobody is asked to act.
 */
export const RETRY_SENTENCE =
  "The worker re-runs the failing check and tries again from this diagnosis; " +
  "if the automatic fix attempts are spent on this same failure, the PR is " +
  "closed and its issue redone from the base branch.";

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
 * Render the classifier trailer appended to every no-changes reply.
 *
 * Exported so the verbatim path in `pr_ci_processor.ts` (Issue #1876) — which
 * posts the agent's own `.pr_response_message` instead of the stock text —
 * shares one rendering with the stock bodies built below.
 *
 * Issue #2260: the classifier's own reason and signals quote the failing
 * check's name (`check:<name>`, "no recognised pattern in check '<name>'"),
 * and a fork chooses that name on a `pull_request`-triggered workflow. The
 * rendered trailer is therefore made inert as a whole — it carries no marker
 * of the worker's own, and the worker's marker is concatenated after it.
 *
 * @param classification - Output of {@link classifyCiFailure}.
 * @returns The trailer, including its leading blank line.
 */
export function formatClassifierTrailer(
  classification: CiFailureClassification,
): string {
  const { reason, signals } = classification;
  return neutraliseAgentMarkers(
    `\n\n**Classifier reason:** ${reason}\n**Signals:**\n${
      formatSignals(signals)
    }`,
  ).text;
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
  const { category } = classification;
  const trailer = formatClassifierTrailer(classification);
  // Issue #2260: on a `pull_request`-triggered workflow the job name comes
  // from the head ref, so a fork chooses it. Every body below is posted by
  // the fleet account, whose markers are the fleet-wide CI-fix record, so the
  // name's HTML-comment delimiters are made inert by construction before it
  // is interpolated — a check name can no longer open or close a marker.
  const name = neutraliseAgentMarkers(checkName).text;

  switch (category) {
    // Issue #2726: this path classifies the AGENT's output, not the check's,
    // so a gate line here did not come from the check and must not let the
    // agent dodge a retry — it gets the code-fix-required response.
    //
    // Issue #4304: no needs-human. The worker re-runs the failing check and
    // the next attempt starts from this diagnosis; once the attempt cap is
    // spent the PR is closed and its issue redone (`pr_ci_processor.ts`).
    case "human-gate":
    case "code-fix-required":
      return {
        category: "code-fix-required",
        addNeedsHuman: false,
        body:
          `I reviewed the CI check failure (**${name}**) but could not produce a code fix this attempt. ` +
          `The classifier indicates this requires a code change. ${RETRY_SENTENCE}${trailer}`,
      };
    case "history-rewrite-required": {
      // Issue #630. Reaching here means the content fix produced no change,
      // so the rebuild never ran — and a secret finding that survives with
      // nothing left to correct is in the BASE branch, not this PR. Say that,
      // because "CI is failing" would send a reviewer to the wrong place.
      const escalationReason =
        `The **${name}** check scans every commit in the branch rather than the working ` +
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
          `I reviewed the CI check failure (**${name}**) and it looks like a timing or timeout issue. ` +
          `No code change was applied. ${RETRY_SENTENCE}${trailer}`,
      };
    case "infrastructure":
      return {
        category,
        addNeedsHuman: false,
        body:
          `I reviewed the CI check failure (**${name}**) and it looks infrastructure-related ` +
          `(network, runner, or upstream service). No code change was applied. ` +
          `${RETRY_SENTENCE}${trailer}`,
      };
    case "unknown":
      return {
        category: "unknown",
        addNeedsHuman: false,
        body:
          `I investigated the CI check failure (**${name}**) but could not determine a fix this ` +
          `attempt. ${RETRY_SENTENCE}${trailer}`,
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
 * associated CI check), the message is a plain statement that no change was
 * made. It never asks the reviewer to clarify (Issue #4304): the caller posts
 * the agent's own reasoned reply instead whenever the agent wrote one, so
 * this body is only the fallback for a run that wrote nothing.
 */
export function buildFeedbackNoChangesResponse(
  classification?: CiFailureClassification,
): NoChangesResponse {
  if (!classification) {
    return {
      category: "unknown",
      addNeedsHuman: false,
      body:
        "I reviewed this feedback and could not identify a code change to " +
        "apply: as far as I could establish, the code on this branch already " +
        "does what the feedback describes.",
    };
  }
  // When a failing check is associated with the feedback, route via the
  // CI-style helper using a neutral check label.
  return buildCiNoChangesResponse("PR feedback", classification);
}
