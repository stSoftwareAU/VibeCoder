/**
 * Shared `gh` argv classifier (Issue #1588).
 *
 * Two counters used to decide independently what an `api graphql`
 * invocation is, and they parsed argv differently:
 *
 * - `classifyGhArgs` (`gh_call_metrics.ts`) skipped any token starting with
 *   `-` as a flag, so the *value* of a value-taking flag was read as the next
 *   positional — `["api", "-f", "query=…", "graphql"]` classified as `"api"`.
 * - `isQuotaExemptGhCall` (`primary_quota_latch.ts`) required `args[0] ===
 *   "api"` with no flag skipping at all, then tested `args.includes(
 *   "graphql")`, which matched the token anywhere in argv — including as a
 *   flag value.
 *
 * The two therefore answered slightly different questions, and the
 * `api-graphql=` bucket could not be reconciled with the GraphQL attribution
 * that shares the `isQuotaExemptGhCall` predicate. This module is the single
 * argv classifier both now derive from: flag-aware, with an explicit list of
 * value-taking flags so a flag value is never mistaken for a positional.
 *
 * It deliberately lives in its own module rather than in either caller:
 * `gh_call_metrics.ts` already imports from `primary_quota_latch.ts`, so a
 * helper in `gh_call_metrics.ts` would invert that direction.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { normaliseGhArgs } from "./gh_flag_parser.ts";

/**
 * Long `gh` flags that consume the following argv token as their value.
 *
 * Anything not listed here is treated as a boolean flag, so a missing entry
 * lets that flag's value be read as a positional token. The list is a
 * superset of the long flags named in Issue #1588: it also covers the
 * remaining value-taking `gh api` and global flags (`--cache`, `--preview`,
 * `--hostname`), because those are the ones that can precede the `graphql`
 * endpoint token and would otherwise let a real GraphQL call be classified as
 * REST — the direction the latch must never be wrong in.
 *
 * `--flag=value` needs no entry: it is one token and consumes nothing.
 */
const VALUE_TAKING_LONG_FLAGS: ReadonlySet<string> = new Set([
  "--field",
  "--raw-field",
  "--header",
  "--method",
  "--jq",
  "--template",
  "--input",
  "--repo",
  "--cache",
  "--preview",
  "--hostname",
]);

/**
 * Shorthand letters that consume the following argv token as their value:
 * `-f`, `-F`, `-H`, `-X`, `-q`, `-t`, `-R`, `-p`, matching the long flags
 * above.
 *
 * This is deliberately *not* `gh_flag_parser.ts`'s `GH_VALUE_SHORTHANDS`, and
 * the two must not be merged: that set is intentionally over-inclusive
 * (any letter that takes a value under *any* subcommand) because ending a
 * shorthand-group walk too late is its fail-closed direction. Here the
 * asymmetry is the other way round — treating a boolean letter as
 * value-taking would swallow the endpoint token and classify a GraphQL call
 * as REST — so this set lists only the letters that genuinely take a value,
 * and it is complete for `gh api`'s own value-taking shorthands.
 */
const VALUE_TAKING_SHORTHANDS: ReadonlySet<string> = new Set(
  ["f", "F", "H", "X", "q", "t", "R", "p"],
);

/**
 * Whether a shorthand token takes the *following* argv token as its value.
 *
 * pflag reads `-iq .data` as `-i -q .data`: boolean letters are walked past,
 * and the first value-taking letter ends the group. If that letter is last,
 * its value is the next argv token; if anything follows it in the same token,
 * that remainder is the value and nothing further is consumed (`-iq.data`).
 *
 * `normaliseGhArgs` already expands the groups whose value the `gh` guards
 * read (`-R`, `-l`, `-X`, `-f`, `-F`); this covers the rest, so a group like
 * `gh api -iq .data graphql` cannot hide the endpoint token.
 */
function shorthandTakesNextToken(token: string): boolean {
  for (let i = 1; i < token.length; i++) {
    const letter = token[i]!;
    // Boolean here; pflag moves on to the next letter in the group.
    if (!VALUE_TAKING_SHORTHANDS.has(letter)) continue;
    return i === token.length - 1;
  }
  return false;
}

/**
 * The positional tokens of a `gh` argument list, in order, with flags and
 * their values removed.
 *
 * `--` ends flag processing: every token after it is positional, which is how
 * `gh` itself reads argv.
 *
 * argv is first run through `normaliseGhArgs` so a pflag shorthand group
 * carrying an attached value — `gh api -iXPOST graphql`, which is
 * `-i -X POST graphql` — is expanded to its separated form.
 *
 * @param args - Argument list passed to the `gh` binary.
 */
export function ghPositionalArgs(args: readonly string[]): string[] {
  const normalised = normaliseGhArgs(args);
  const positionals: string[] = [];
  for (let i = 0; i < normalised.length; i++) {
    const token = normalised[i]!;
    if (token === "--") {
      positionals.push(...normalised.slice(i + 1));
      break;
    }
    if (token.startsWith("--")) {
      // `--flag=value` carries its value in the same token.
      if (!token.includes("=") && VALUE_TAKING_LONG_FLAGS.has(token)) i++;
      continue;
    }
    if (token.startsWith("-") && token !== "-") {
      if (shorthandTakesNextToken(token)) i++;
      continue;
    }
    positionals.push(token);
  }
  return positionals;
}

/**
 * What kind of GitHub API budget a `gh` invocation spends.
 *
 * - `api-graphql` — an explicit `gh api graphql …` call.
 * - `api-rest` — a plain `gh api <path>` call, which rides the separate
 *   core REST quota.
 * - `sub-command` — every other `gh` sub-command (`issue list`, `pr view`,
 *   `search …`); all of them are GraphQL-backed.
 * - `unknown` — no positional token at all (`gh --version`, `gh`). Not a
 *   REST `api` call, so the latch bills it like any other non-REST
 *   invocation rather than waving it through.
 */
export type GhCallKind = "api-graphql" | "api-rest" | "sub-command" | "unknown";

/**
 * Classify already-extracted positional tokens (Issue #1588).
 *
 * Exposed so a caller that has parsed argv once — `classifyGhArgs`, which
 * also needs the sub-command verb — does not parse it a second time to ask
 * the same question.
 *
 * `graphql` counts only as the positional token immediately after `api`, so a
 * REST path or a flag value containing the word — `gh api
 * /search/issues?q=graphql`, `gh api repos/o/r/labels --jq graphql` — is REST,
 * not GraphQL.
 */
export function ghCallKindOf(positionals: readonly string[]): GhCallKind {
  const head = positionals[0];
  if (head === undefined) return "unknown";
  if (head !== "api") return "sub-command";
  return positionals[1] === "graphql" ? "api-graphql" : "api-rest";
}

/**
 * Classify a `gh` argument list by which API budget it spends (Issue #1588).
 *
 * @param args - Argument list passed to the `gh` binary.
 */
export function classifyGhCall(args: readonly string[]): GhCallKind {
  return ghCallKindOf(ghPositionalArgs(args));
}
