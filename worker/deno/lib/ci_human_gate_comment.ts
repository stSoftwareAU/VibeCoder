/**
 * The one comment the CI-fix lane posts for a human-gate check (Issue #2727,
 * parent #2683).
 *
 * A check that prints `vibe-human-gate: <step>` waits on a person, not on a
 * code change. The lane announces the step once per pull request per gate
 * check and then stays silent; the marker the comment carries is what makes
 * every later pass, on any host, post nothing.
 *
 * The step comes from the check's log, which a pull-request author can
 * influence. The classifier has already flattened it, neutralised its
 * HTML-comment markers and bounded it; this module renders it inside a code
 * span whose fence is longer than any backtick run in the step, so it can
 * neither break out into Markdown structure nor `@`-mention anyone.
 *
 * Pure: builds a string, does no I/O.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

/**
 * Render untrusted single-line text as an inert Markdown code span.
 *
 * CommonMark closes a code span only on a backtick run of the *same* length
 * as the opener, so a fence one longer than the longest run inside cannot be
 * closed early. The padding spaces keep a leading or trailing backtick in the
 * text from merging with the fence; CommonMark strips one from each side.
 *
 * @param text - Single-line text (the classifier already flattened it).
 * @returns The text wrapped in a code span.
 */
export function inertCodeSpan(text: string): string {
  const longestRun = Math.max(
    0,
    ...(text.match(/`+/g) ?? []).map((run) => run.length),
  );
  const fence = "`".repeat(longestRun + 1);
  return `${fence} ${text} ${fence}`;
}

/** Inputs for {@link buildHumanGateComment}. */
export interface HumanGateCommentInput {
  /** The check name, already made inert for a fleet-authored body. */
  safeCheckName: string;
  /** The human step the classifier extracted. */
  humanStep: string;
  /** The `vibe-ci-human-gate` marker for this check. */
  marker: string;
}

/**
 * Build the single gate comment for one check.
 *
 * @param input - Inert check name, the human step and the gate marker.
 * @returns The comment body.
 */
export function buildHumanGateComment(input: HumanGateCommentInput): string {
  return [
    "### CI check waiting on a human step",
    "",
    `The failing check **${input.safeCheckName}** declares a human gate. ` +
    "It clears only once a person takes this step:",
    "",
    inertCodeSpan(input.humanStep),
    "",
    "The fleet has not attempted a code fix for this check, has added no " +
    "label, and will not comment on it again. The check passes once the " +
    "step is done and it re-runs.",
    "",
    input.marker,
  ].join("\n");
}
