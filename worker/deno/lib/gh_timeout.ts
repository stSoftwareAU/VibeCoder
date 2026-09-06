/**
 * Default timeouts for `gh` subprocesses (Issue #1229).
 *
 * The `gh` chokepoint (`gh_spawn.ts`) used to attach an `AbortSignal` only
 * when a caller supplied one, and the dominant path
 * (`github.ts:runGhCommandRaw` → `runGhOrThrow(args)`) supplies none — so the
 * great majority of `gh` invocations ran with no timeout at all and a stalled
 * GitHub call hung the run until the host was killed.
 *
 * This module is the `gh` counterpart of `git_timeout.ts:getTimeoutForOperation`:
 * the chokepoint asks it for a timeout on every call, so the control is
 * unavoidable rather than opt-in. The environment variables are the ones
 * already documented in `docs/CONFIGURATION.md`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { type EnvLookup, processEnvLookup } from "./env_lookup.ts";

/** Default timeout in seconds for a standard `gh` invocation. */
export const DEFAULT_GH_COMMAND_TIMEOUT = 60;

/** Default timeout in seconds for `gh repo clone`. */
export const DEFAULT_GH_CLONE_TIMEOUT = 600;

/**
 * Default timeout in seconds for a paginated read (`gh api --paginate`).
 *
 * One call walks every `Link: rel="next"` page, so it legitimately outlives a
 * single-request command — a busy org's collaborator or timeline listing is
 * minutes of round trips, not seconds.
 */
export const DEFAULT_GH_PAGINATED_TIMEOUT = 300;

/** Exit code reported when a `gh` invocation is aborted by its timeout. */
export const GH_TIMEOUT_EXIT_CODE = 124;

/**
 * Read a positive timeout from the environment, falling back to a default.
 *
 * A missing, non-numeric or non-positive value falls back rather than
 * disabling the control — a `GH_COMMAND_TIMEOUT=0` must not restore the
 * unbounded behaviour this module exists to remove.
 */
function timeoutFromEnv(
  env: EnvLookup,
  name: string,
  fallback: number,
): number {
  const raw = env(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Determine the default timeout for one `gh` invocation.
 *
 * Cloning and paginated reads are legitimately long, so they get their own
 * budgets; everything else takes the standard command timeout.
 *
 * @param args - Arguments passed to the `gh` binary (e.g. `["pr", "view"]`).
 * @param env - Environment lookup; defaults to the process environment, so
 *   production callers pass nothing and a test hands in a fixed map rather
 *   than mutating the environment every parallel test shares (Issue #880).
 * @returns Timeout duration in seconds.
 */
export function getGhTimeoutForOperation(
  args: readonly string[],
  env: EnvLookup = processEnvLookup,
): number {
  if (args[0] === "repo" && args[1] === "clone") {
    return timeoutFromEnv(env, "GH_CLONE_TIMEOUT", DEFAULT_GH_CLONE_TIMEOUT);
  }
  if (args.includes("--paginate")) {
    return timeoutFromEnv(
      env,
      "GH_PAGINATED_TIMEOUT",
      DEFAULT_GH_PAGINATED_TIMEOUT,
    );
  }
  return timeoutFromEnv(env, "GH_COMMAND_TIMEOUT", DEFAULT_GH_COMMAND_TIMEOUT);
}

/**
 * Check whether an exit code indicates a `gh` timeout.
 *
 * @param exitCode - The exit code to check.
 * @returns True when the code is the timeout code.
 */
export function isGhTimeoutExitCode(exitCode: number): boolean {
  return exitCode === GH_TIMEOUT_EXIT_CODE;
}
