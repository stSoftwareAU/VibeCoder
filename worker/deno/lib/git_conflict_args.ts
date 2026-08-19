/**
 * Helpers for building safe git argument arrays used in conflict resolution
 * (Issue #3294).
 *
 * A conflicted filename reaching these calls is an untrusted positional: it is
 * derived from the raw stdout of `git diff --name-only --diff-filter=U`, split
 * on newlines. Git can track a working-tree path whose name begins with `-`
 * (e.g. `-rf`, `--pathspec-from-file=…`), so we always place the `--`
 * end-of-options separator before the filename. Without it `git checkout
 * --theirs -rf` / `git add --pathspec-from-file=…` is parsed by git as an
 * option, not a pathspec — an argument/option-injection foot-gun.
 *
 * This mirrors the `buildBranchDeleteArgs` hardening (Issue #2798). The calls
 * use `Deno.Command` argument arrays, so there is no shell exposure — the `--`
 * separator is defence-in-depth that keeps the practice consistent across every
 * conflict-resolution call site.
 */

/**
 * Build the argv for staging a (untrusted) conflicted path with the `--`
 * end-of-options separator before the filename.
 *
 * @param file - The conflicted path to stage (untrusted positional).
 * @returns The git argument array, e.g. `["add", "--", file]`.
 */
export function buildAddPathArgs(file: string): string[] {
  return ["add", "--", file];
}

/**
 * Build the argv for checking out one side of a conflicted path with the `--`
 * end-of-options separator before the (untrusted) filename.
 *
 * @param strategy - Which side to accept ("ours" for upstream, "theirs" for
 *   local).
 * @param file - The conflicted path to check out (untrusted positional).
 * @returns The git argument array, e.g. `["checkout", "--theirs", "--", file]`.
 */
export function buildCheckoutStrategyArgs(
  strategy: "ours" | "theirs",
  file: string,
): string[] {
  return ["checkout", `--${strategy}`, "--", file];
}
