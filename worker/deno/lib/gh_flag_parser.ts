/**
 * pflag-faithful argv normalisation for the `gh` guards (Issue #3867).
 *
 * `gh` is a Go program built on cobra + pflag, and pflag accepts a shorthand
 * flag's value **attached** to the flag as well as separated:
 * `-Rowner/repo` and `-R=owner/repo` mean exactly what `-R owner/repo` means.
 * The guards hand-rolled their own argv scanning and matched only the
 * separated form, so `gh issue comment 5 -Rattacker/evil` derived no repo at
 * all — the write-repo allowlist saw a cwd-scoped write and waved it through,
 * and `-ltop-priority` never reached the reserved-label denylist.
 *
 * Normalising once, here, keeps a single place that knows the pflag spelling
 * rules: every consumer then only has to match the separated form.
 *
 * **Scope.** Only the shorthands whose values the guards actually read are
 * expanded. A shorthand group of boolean flags (`-ab`) is left alone, because
 * splitting it would invent values the guards would then have to interpret.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/**
 * Shorthand flags whose value the guards read.
 *
 * `R` is `--repo` (write-repo allowlist), `l` is `--label`/`--add-label`
 * (reserved-label denylist) and `X` is `--method` (`gh api` mutation
 * detection).
 */
const GH_VALUE_SHORTHANDS: ReadonlySet<string> = new Set(["R", "l", "X"]);

/**
 * Split one token into its separated form when it is a value-carrying
 * shorthand with an attached value.
 *
 * @param token - A single argv token.
 * @returns `[flag, value]`, or undefined when the token is not an attached
 *   value-carrying shorthand.
 */
function expandAttachedShorthand(
  token: string,
): [string, string] | undefined {
  if (token.length <= 2) return undefined;
  if (!token.startsWith("-") || token.startsWith("--")) return undefined;
  const letter = token[1]!;
  if (!GH_VALUE_SHORTHANDS.has(letter)) return undefined;
  // pflag: `-R=value` strips the `=`, `-Rvalue` takes the remainder verbatim.
  const value = token[2] === "=" ? token.slice(3) : token.slice(2);
  return [`-${letter}`, value];
}

/**
 * Rewrite a `gh` argument vector into the spellings the guards match.
 *
 * Attached shorthand values are expanded to their separated form; every other
 * token — long flags, `--`, positionals, values — is passed through verbatim.
 *
 * @param args - Arguments as they would be passed to the `gh` binary.
 * @returns An equivalent vector using only separated shorthand values.
 */
export function normaliseGhArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  for (const token of args) {
    if (token === undefined) continue;
    const expanded = expandAttachedShorthand(token);
    if (expanded) out.push(expanded[0], expanded[1]);
    else out.push(token);
  }
  return out;
}
