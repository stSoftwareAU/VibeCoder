/**
 * The acting GitHub login for a command invocation (Issue #965).
 *
 * Three command entry points — `pr-maintenance`, `refinement-processor` and
 * `revision-processor` — resolve "who is this run acting as?" the same way:
 * the `--github-user` argument when the caller passed one, otherwise the
 * `GITHUB_USER` environment variable, otherwise empty (which every caller
 * rejects). Reading the environment at the point of use meant the only way
 * to test the rejection was `Deno.env.delete("GITHUB_USER")`, which races
 * every other test sharing the process and is what keeps the quality gate's
 * `deno test` stage serial (Issue #880, plan in #944).
 *
 * Taking an {@link EnvLookup} moves the read to a seam the caller controls
 * while leaving the process environment as the default, so production
 * behaviour is unchanged.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { type EnvLookup, processEnvLookup } from "./env_lookup.ts";

/**
 * Resolve the GitHub login a command should act as.
 *
 * @param args - The command's parsed arguments; `github-user` wins when set.
 * @param env - Where `GITHUB_USER` is read from. Defaults to the process
 *        environment, so shell callers behave exactly as they always have;
 *        a test hands in a fixed map instead of mutating the process.
 * @returns The resolved login, or `""` when neither source supplies one —
 *          the callers treat that as a missing required argument and fail.
 */
export function resolveActingGithubUser(
  args: Record<string, unknown>,
  env: EnvLookup = processEnvLookup,
): string {
  return String(args["github-user"] ?? env("GITHUB_USER") ?? "");
}
