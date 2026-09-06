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
 * ## Shorthand groups (Issue #1219, SEC-1219-01)
 *
 * The first version of this module only looked at `token[1]`, and only for
 * `R`, `l` and `X`. pflag also accepts a **group** of shorthands in one token,
 * where the first flag that takes a value swallows the remainder of the group
 * as that value — so `-iXDELETE` is `-i -X DELETE`. Verified against the
 * installed `gh`: `gh api -iXGET rate_limit` returns a 200 with response
 * headers (so `-i` was honoured *and* `X` took `GET`), and `-iXBOGUSMETHOD`
 * is rejected by the server with a 403 (so the bogus method really was sent).
 *
 * Because `-X` sat at index 2 rather than index 1, `normaliseGhArgs` passed
 * the token through untouched and `classifyGhApi` never saw a method: it fell
 * back to `GET`, decided the command was not a mutation at all, and
 * `gh api -iXDELETE repos/o/r/git/refs/heads/main` reached GitHub without
 * passing the audit journal, the write-repo allowlist or the issue-lifecycle
 * guard. The same gap covered `f`/`F`, which were absent from the expansion
 * set entirely: `gh api -XPATCH repos/o/r/issues/9 -fstate=closed` was
 * classified as a body `edit` — a verb allowed by default — rather than a
 * `close`, defeating the guard that exists to stop an agent closing its own
 * issue.
 *
 * ## Why the walk stops where it does
 *
 * A letter listed in {@link GH_VALUE_SHORTHANDS} ends the group: pflag would
 * hand it the rest of the token, so there is no hidden flag behind it. Only
 * letters treated as boolean are walked through. That ordering is what keeps
 * the rewrite honest in both directions — it cannot invent an `-X` out of the
 * middle of a `-q` jq expression (a false mutation), and it cannot miss one
 * hiding behind a boolean (a waved-through mutation). The set is not a perfect
 * model of `gh` — one letter is genuinely ambiguous across subcommands — so
 * see {@link GH_VALUE_SHORTHANDS} for which way that ambiguity is resolved and
 * why the residue is bounded.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/**
 * Shorthand flags whose value the guards read, and which are therefore
 * rewritten into the separated form.
 *
 * `R` is `--repo` (write-repo allowlist), `l` is `--label`/`--add-label`
 * (reserved-label denylist), `X` is `--method` (`gh api` mutation detection)
 * and `f`/`F` are `--raw-field`/`--field` (the `state=closed` payload the
 * issue-lifecycle guard reads).
 */
const GH_GUARD_SHORTHANDS: ReadonlySet<string> = new Set([
  "R",
  "l",
  "X",
  "f",
  "F",
]);

/**
 * Shorthand letters treated as taking a value, so the group walk stops there.
 *
 * Enumerated from `gh <subcommand> --help` across `api`, `issue`, `pr`,
 * `label`, `release`, `repo`, `run`, `search` and `workflow`. A letter is
 * listed when *any* subcommand gives it an argument, because this set is only
 * used to decide where a shorthand group ends — and treating a value-carrying
 * letter as boolean is the mistake that invents flags out of flag *values*.
 *
 * **`i` is the one deliberate omission, and it is not "boolean everywhere".**
 * `gh api -i` is `--include` (boolean) while `gh run watch -i` is
 * `--interval int` (a value). The two cannot both be honoured by a
 * subcommand-agnostic set, and `api` is the subcommand whose method the
 * mutation classifier reads — listing `i` would end the walk at `-iXDELETE`
 * and wave the mutation through, which is the bypass this module exists to
 * close. So `i` is walked past, and the residue is bounded: only a `gh run
 * watch` interval *value* whose text begins with `R`, `l`, `X`, `f` or `F`
 * misexpands, and `--interval` takes an int, so no such value parses.
 *
 * The failure direction of a wrong guess here is asymmetric, which is why the
 * omission is safe to make in this direction only: treating a value letter as
 * boolean can invent flag evidence and *refuse* a legitimate command
 * (fail-closed), whereas treating a boolean letter as value-carrying ends the
 * walk early and lets a real mutation past (fail-open).
 */
const GH_VALUE_SHORTHANDS: ReadonlySet<string> = new Set(
  "ABDFHLORSTXabcdefjklmnopqrstuw".split(""),
);

/** A shorthand group split into the tokens pflag would see. */
type ExpandedGroup = string[];

/**
 * Expand one shorthand token into the separated spellings the guards match.
 *
 * Walks the group left to right. Boolean letters are emitted as their own
 * tokens; the first value-carrying letter takes the remainder of the token as
 * its value (pflag strips one leading `=`). When that letter is not one the
 * guards read, the token is left byte-identical so downstream scanning
 * behaves exactly as it did before — rewriting `-q.foo` into `-q .foo` would
 * turn a jq expression into a positional the classifier would read as the
 * endpoint.
 *
 * @param token - A single argv token.
 * @returns The expanded tokens, or `undefined` when the token must be passed
 *   through verbatim (not a shorthand group, or nothing the guards read).
 */
function expandShorthandGroup(token: string): ExpandedGroup | undefined {
  if (token.length <= 2) return undefined;
  if (!token.startsWith("-") || token.startsWith("--")) return undefined;

  const booleans: string[] = [];
  for (let i = 1; i < token.length; i++) {
    const letter = token[i]!;
    if (!GH_VALUE_SHORTHANDS.has(letter)) {
      // Boolean everywhere in `gh`; pflag moves on to the next letter.
      booleans.push(`-${letter}`);
      continue;
    }
    // This letter takes the rest of the token as its value.
    if (!GH_GUARD_SHORTHANDS.has(letter)) return undefined;
    const rest = token.slice(i + 1);
    // pflag: `-R=value` strips the `=`, `-Rvalue` takes the remainder verbatim.
    const value = rest.startsWith("=") ? rest.slice(1) : rest;
    // An empty remainder means the value is the next argv token, which is
    // already the separated form the guards match.
    return value === ""
      ? [...booleans, `-${letter}`]
      : [...booleans, `-${letter}`, value];
  }
  // An all-boolean group carries no value for a guard to read.
  return undefined;
}

/**
 * Rewrite a `gh` argument vector into the spellings the guards match.
 *
 * Attached shorthand values are expanded to their separated form, including
 * when the flag is buried in a shorthand group; every other token — long
 * flags, `--`, positionals, values — is passed through verbatim.
 *
 * @param args - Arguments as they would be passed to the `gh` binary.
 * @returns An equivalent vector using only separated shorthand values.
 */
export function normaliseGhArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  for (const token of args) {
    if (token === undefined) continue;
    const expanded = expandShorthandGroup(token);
    if (expanded) out.push(...expanded);
    else out.push(token);
  }
  return out;
}
