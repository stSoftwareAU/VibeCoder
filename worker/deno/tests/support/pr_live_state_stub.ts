/**
 * Test support for the claim-point PR state re-read (Issue #1774).
 *
 * Every PR pass now asks `gh pr view --json state` before its first write, so
 * a fixture whose `gh` stub answers nothing reports `UNKNOWN` and the pass
 * correctly stands down. A fixture that means "this PR is open" has to say so,
 * and this is where it says it — once, rather than in forty test files.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

/** True when these `gh` args are the claim-point live-state read. */
export function isPrStateRead(args: readonly string[]): boolean {
  return args[0] === "pr" && args[1] === "view" && args.includes("state");
}

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
    isPrStateRead(args) ? Promise.resolve("OPEN") : inner(args);
}
