/**
 * Test support for the claim-point PR state re-read (Issue #1774).
 *
 * Every PR pass now asks `gh pr view --json state` before its first write, so
 * a fixture whose `gh` stub answers nothing reports `UNKNOWN` and the pass
 * correctly stands down. A fixture that means "this PR is open" has to say so,
 * and this is where it says it — once, rather than in forty test files.
 *
 * The predicate itself lives beside the call it recognises, in
 * `lib/pr_live_state.ts`, so the fixtures and the real argv cannot drift.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

export { isPrLiveStateRead } from "../../lib/pr_live_state.ts";
import { isPrLiveStateRead } from "../../lib/pr_live_state.ts";

/**
 * Wrap a test `gh` stub so the claim-point read reports an open PR.
 *
 * @param inner - The fixture's own stub; defaults to one that returns "".
 * @returns A stub that answers the state read and delegates everything else.
 */
export function openPrGh(
  inner: (args: string[]) => Promise<string> = () => Promise.resolve(""),
): (args: string[]) => Promise<string> {
  return (args: string[]) =>
    isPrLiveStateRead(args) ? Promise.resolve("OPEN") : inner(args);
}

/**
 * A `gh` stub that answers the claim-point read with `state` and records
 * every call, so a write to a PR the pass should have skipped is visible.
 *
 * @param calls - Collector every call's argv is appended to.
 * @param state - What `gh pr view --json state` reports.
 */
export function recordingStateGh(
  calls: string[][],
  state: string,
): (args: string[]) => Promise<string> {
  return (args: string[]) => {
    calls.push(args);
    return isPrLiveStateRead(args)
      ? Promise.resolve(state)
      : Promise.resolve("");
  };
}

/**
 * The recorded `gh` calls that write to a PR — a comment, a label, a reaction.
 *
 * Read-only calls are excluded, so an empty result is the assertion
 * "this PR received nothing".
 */
export function prWriteCalls(calls: readonly string[][]): string[][] {
  return calls.filter((args) =>
    args.includes("--body") || args.includes("--add-label") ||
    args.includes("--remove-label") ||
    (args[0] === "api" && args.includes("-X"))
  );
}
