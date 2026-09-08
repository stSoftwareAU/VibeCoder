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

/**
 * `gh` flags that consume the following argv token as their value.
 *
 * Anything not listed here is treated as a boolean flag, so a missing entry
 * lets that flag's value be read as a positional token. The list is a
 * superset of the flags named in Issue #1588: it also covers the remaining
 * value-taking `gh api` and global flags (`--cache`, `--preview`,
 * `--hostname`), because those are the ones that can precede the `graphql`
 * endpoint token and would otherwise let a real GraphQL call be classified as
 * REST — the direction the latch must never be wrong in.
 *
 * `--flag=value` needs no entry: it is one token and consumes nothing.
 */
const VALUE_TAKING_FLAGS: ReadonlySet<string> = new Set([
  "-f",
  "-F",
  "--field",
  "--raw-field",
  "-H",
  "--header",
  "-X",
  "--method",
  "-q",
  "--jq",
  "-t",
  "--template",
  "--input",
  "-R",
  "--repo",
  "--cache",
  "-p",
  "--preview",
  "--hostname",
]);

/**
 * The positional tokens of a `gh` argument list, in order, with flags and
 * their values removed.
 *
 * `--` ends flag processing: every token after it is positional, which is how
 * `gh` itself reads argv.
 *
 * @param args - Argument list passed to the `gh` binary.
 */
export function ghPositionalArgs(args: readonly string[]): string[] {
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === undefined) break;
    if (token === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (token.startsWith("-") && token !== "-") {
      // `--flag=value` carries its value in the same token.
      if (!token.includes("=") && VALUE_TAKING_FLAGS.has(token)) i++;
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
 * - `unknown` — no positional token at all (`gh --version`, `gh`), which
 *   issues no API request.
 */
export type GhCallKind = "api-graphql" | "api-rest" | "sub-command" | "unknown";

/**
 * Classify a `gh` argument list by which API budget it spends (Issue #1588).
 *
 * `graphql` counts only as the positional token immediately after `api`, so a
 * REST path or a flag value containing the word — `gh api
 * /search/issues?q=graphql`, `gh api repos/o/r/labels --jq graphql` — is REST,
 * not GraphQL.
 *
 * @param args - Argument list passed to the `gh` binary.
 */
export function classifyGhCall(args: readonly string[]): GhCallKind {
  const positionals = ghPositionalArgs(args);
  const head = positionals[0];
  if (head === undefined) return "unknown";
  if (head !== "api") return "sub-command";
  return positionals[1] === "graphql" ? "api-graphql" : "api-rest";
}

/** Whether `args` is an explicit `gh api graphql …` invocation (#1588). */
export function isApiGraphQLCall(args: readonly string[]): boolean {
  return classifyGhCall(args) === "api-graphql";
}
