/**
 * Unmet acceptance criteria are advice (Issues #4146, #4234).
 *
 * The owner's ruling in #4146 was "If the criteria is not met then don't
 * raise a PR, just complete the job." A run whose PR summary closes a
 * criterion out `partial` or `missing` used to raise a PR that closed the
 * issue on merge and file a `Finish #N` follow-up for the rest (Issues #2562,
 * #3506). #4146 made that a blocking gate; #4234 then made every completion
 * summary gate advice, so the gate no longer withholds the pull request:
 *
 * ```mermaid
 * flowchart TD
 *     S["PR summary closure block"] --> U{"Any criterion<br/>partial, missing<br/>or unassessed?"}
 *     U -- no --> P["PR raised; it closes the issue"]
 *     U -- yes --> N["The agent is told once, in the session,<br/>with the unmet criteria named"]
 *     N --> G{"Still unmet on the next pass?"}
 *     G -- no --> P
 *     G -- yes --> A["PR raised and armed anyway.<br/>The unmet criteria are named in one<br/>'Notes for the reviewer' comment.<br/>A `missing` entry makes the body `Part of #N`"]
 * ```
 *
 * No follow-up issue is filed and nothing is labelled `needs-human`.
 *
 * This module only assesses the criteria and words the note; the completion
 * phase (`phases/completion_phase.ts`) decides what happens to the PR.
 *
 * Whether the run was degraded (served by a fallback model) changes nothing
 * here: the `Degraded:` run-stats line is telemetry, not a delivery decision.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  extractAcceptedScope,
  parseClosureEntries,
} from "./acceptance_criteria_gate.ts";
import {
  assessScopeShortfalls,
  type DegradedShortfall,
  isPendingMergeCheck,
  UNSTATED_SCOPE_ITEM,
} from "./degraded_delivery.ts";

/**
 * How many in-run rounds an unmet-criteria block gets (Issue #4146): the
 * first recovery turn plus further rounds while each one meets more criteria
 * than the last. A round that makes no progress ends the run sooner.
 */
export const MAX_UNMET_CRITERIA_ROUNDS = 3;

/** Longest criterion text quoted back in the gate comment. */
const MAX_QUOTED_LENGTH = 300;

/**
 * The criteria the run has not met, as the PR summary closes them out.
 *
 * Every `partial` or `missing` closure entry counts (a pending merge check —
 * "CI not yet verified" — does not: it is not unfinished work). An
 * `unassessed` scope item counts too when the closure block assesses fewer
 * entries than the issue states criteria: the run said nothing about it, and
 * silence is not `met`. An issue that states no criteria has nothing to leave
 * unassessed, so only its reported gaps count.
 *
 * @param issueBody - The issue the run implemented.
 * @param prBody - The assembled PR body (summary included).
 * @returns The unmet criteria, in issue order, then unmatched gaps.
 */
export function assessUnmetCriteria(
  issueBody: string,
  prBody: string,
): DegradedShortfall[] {
  const { shortfalls } = assessScopeShortfalls(issueBody, prBody);
  const gaps = shortfalls.filter((s) => s.status !== "unassessed");
  const stated = extractAcceptedScope(issueBody);
  const assessed =
    parseClosureEntries(prBody).filter((entry) =>
      entry.status !== "unrequested" && !isPendingMergeCheck(entry)
    ).length;
  const unassessed = stated.length > 0 && assessed < stated.length
    ? shortfalls.filter((s) =>
      s.status === "unassessed" && s.criterion !== UNSTATED_SCOPE_ITEM
    )
    : [];
  return [...gaps, ...unassessed];
}

/** One-line block reason naming how many criteria are unmet. */
export function unmetCriteriaReason(
  unmet: readonly DegradedShortfall[],
): string {
  const n = unmet.length;
  return `${n} acceptance criteri${
    n === 1 ? "on is" : "a are"
  } not met — named on the pull request, which is raised anyway`;
}

function quoted(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_QUOTED_LENGTH
    ? `${flat.slice(0, MAX_QUOTED_LENGTH - 1)}…`
    : flat;
}

/**
 * The note the gate produces: which criteria are unmet, and that they do not
 * stop the pull request. It is shown to the agent once in the session, and
 * posted on the pull request when criteria are still unmet afterwards.
 */
export function buildUnmetCriteriaGateComment(
  unmet: readonly DegradedShortfall[],
): string {
  const lines = unmet.map((s) => `- **${s.status}** — ${quoted(s.criterion)}`);
  return [
    "### Acceptance criteria not met",
    "",
    "The PR summary does not show every acceptance criterion as `met`:",
    "",
    ...lines,
    "",
    "These do not block the pull request, which is raised and armed " +
    "anyway. Finish what you can in this session; a criterion still unmet " +
    "is named for the reviewer on the pull request. A `missing` entry makes " +
    "the pull request body `Part of #N`, so the issue stays open. No " +
    "follow-up issue is filed.",
  ].join("\n");
}
