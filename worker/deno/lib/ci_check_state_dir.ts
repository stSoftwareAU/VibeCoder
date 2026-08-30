/**
 * Where the CI-fix lane keeps its retry and auto-fix-attempt state.
 *
 * The directory used to be the bare relative path `.ci_check_state`, resolved
 * against the worker process's current working directory. In container mode
 * that directory is the read-only checkout, so every automatic CI fix died in
 * `recordCiCheckRetry` with `Read-only file system (os error 30)` before the
 * agent ever ran (Issue #580).
 *
 * Issue #580 put the *processor* on the work volume. It left the **scanner**
 * (`findFailedCiChecks`) on the relative default, so the two halves of the
 * lane addressed different stores: the scanner read retry counters that were
 * never there, and its green-build sweep cleared auto-fix budgets in a
 * directory the processor never wrote to. A signature that reached
 * `maxAutoFixAttempts` therefore stayed spent forever and the lane escalated
 * to a human instead of fixing the check — which is why semgrep failures
 * waited for someone to ask for a fix by hand (Issue #552).
 *
 * This module is the single resolver both halves share. It lives on its own so
 * `pr_maintenance` can use it without importing the much larger
 * `pr_ci_processor`.
 *
 * The resolved path is **always absolute** and always inside the
 * agent-writable work directory — the same place the other worker state files
 * live (`.circuit_breaker_state.json`, `.cooldown_state.json`, …) and the
 * behaviour `docs/INTERNALS.md` documents.
 */

/** Leaf directory holding the retry and auto-fix-attempt state files. */
export const CI_CHECK_STATE_DIR_NAME = ".ci_check_state";

/**
 * Last-resort base when neither a work directory nor `HOME` names an absolute
 * path. Writable on every supported platform, so the retry cap keeps working
 * rather than silently addressing a directory nothing can write to.
 */
export const FALLBACK_CI_CHECK_WORK_DIR = "/tmp/auto-issue-work";

/** Work-directory name derived from `HOME` — mirrors `config.ts`. */
const HOME_WORK_DIR_NAME = "auto-issue-work";

/** Trim whitespace and trailing slashes; `/` normalises to `""`. */
function normaliseDir(value: string | undefined): string {
  return (value ?? "").trim().replace(/\/+$/, "");
}

/**
 * Resolve the absolute directory holding CI-check state.
 *
 * Candidates are tried in order — the explicit work directory, `WORK_DIR`,
 * `$HOME/auto-issue-work` — and the first **absolute** one wins. A relative or
 * empty candidate is skipped rather than used, because a relative state
 * directory is exactly the fault this function exists to prevent.
 *
 * Callers must pass the work-volume root rather than a repo clone, so the
 * counters survive a re-clone and the container restarts they are measured
 * across.
 *
 * @param workDir - The resolved work directory (the volume mount).
 * @param env - Environment lookup, injectable for testing.
 * @returns Absolute path to the CI-check state directory.
 */
export function resolveCiCheckStateDir(
  workDir?: string,
  env: (name: string) => string | undefined = (name) => Deno.env.get(name),
): string {
  const home = normaliseDir(env("HOME"));

  const candidates = [
    normaliseDir(workDir),
    normaliseDir(env("WORK_DIR")),
    home ? `${home}/${HOME_WORK_DIR_NAME}` : "",
  ];

  const base = candidates.find((candidate) => candidate.startsWith("/")) ??
    FALLBACK_CI_CHECK_WORK_DIR;
  return `${base}/${CI_CHECK_STATE_DIR_NAME}`;
}
