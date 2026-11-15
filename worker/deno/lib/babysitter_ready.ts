/**
 * The babysitter's READY signal (Issue #4930).
 *
 * A repair agent reports that its fix is ready by ending its final response
 * with the line {@link BABYSITTER_READY_LINE}. Two parties read that line and
 * must agree on it: the host, which refuses to push a repair that did not
 * report ready (commands/fleet_pr_babysitter.ts), and the in-container
 * pre-push gate, which withholds the line when the repo's unit tests or
 * markdownlint fail over the agent's changes. Both use
 * {@link isBabysitterReady}, so the rule cannot drift between them.
 */

/** The exact line an agent ends its final response with when its fix is ready. */
export const BABYSITTER_READY_LINE = "BABYSITTER_READY";

/**
 * True when the agent's response ends with {@link BABYSITTER_READY_LINE} on
 * its own line, or consists of that line alone. Trailing whitespace is
 * ignored. The line must start a line: `xBABYSITTER_READY` and a line that
 * mentions the token mid-text do not count.
 *
 * @param response - The agent's final response text.
 * @returns true when the response reports ready.
 */
export function isBabysitterReady(response: string): boolean {
  return response.trimEnd().endsWith(`\n${BABYSITTER_READY_LINE}`) ||
    response.trim() === BABYSITTER_READY_LINE;
}
