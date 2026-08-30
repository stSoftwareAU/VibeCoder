/**
 * Where the CI-fix lane keeps its retry state (Issue #552).
 *
 * The directory used to be the bare relative path `.ci_check_state`, resolved
 * against the worker process's current working directory. In container mode
 * that directory is the read-only `--base-dir` mount, so every automatic CI
 * fix died in `recordCiCheckRetry` with `Read-only file system (os error 30)`
 * before the agent ever ran:
 *
 * ```text
 * ERROR: [m1] Error in priority 1.55 (CI Fix): Read-only file system
 *   (os error 30): writefile '.ci_check_state/stSoftwareAU_VibeCoder_99156131115.retries'
 * ```
 *
 * Nothing downstream ran, so semgrep (and every other) failure waited for a
 * human to ask for a fix by hand.
 *
 * The resolved path is therefore **always absolute** and always inside the
 * agent-writable work directory — the same place the other worker state files
 * live (`.circuit_breaker_state.json`, `.cooldown_state.json`, …) and the
 * behaviour `docs/INTERNALS.md` already documents.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

/** Leaf directory holding one `.retries` file per check run. */
export const CI_CHECK_STATE_DIR_NAME = ".ci_check_state";

/**
 * Last-resort base when neither a work directory nor `HOME` names an absolute
 * path. Writable on every supported platform, so the retry cap keeps working
 * rather than the whole lane aborting.
 */
export const FALLBACK_CI_CHECK_WORK_DIR = "/tmp/auto-issue-work";

/** Work-directory name derived from `HOME` — mirrors `config.ts`. */
const HOME_WORK_DIR_NAME = "auto-issue-work";

/** Options for {@link resolveCiCheckStateDir}. */
export interface CiCheckStateDirOptions {
  /** Explicit work directory (`config.workDir`), preferred when absolute. */
  workDir?: string;
  /** Environment lookup, injected by tests. */
  env?: (name: string) => string | undefined;
}

/** Trim whitespace and trailing slashes; `/` normalises to `""`. */
function normaliseDir(value: string | undefined): string {
  return (value ?? "").trim().replace(/\/+$/, "");
}

/**
 * Resolve the absolute directory holding CI-check retry state.
 *
 * Candidates are tried in order — explicit work directory, `WORK_DIR`,
 * `$HOME/auto-issue-work` — and the first **absolute** one wins. A relative
 * or empty candidate is skipped rather than used, because a relative state
 * directory is exactly the fault this function exists to prevent.
 *
 * @param options - Explicit work directory and/or an injected environment
 * @returns Absolute path to the CI-check state directory
 */
export function resolveCiCheckStateDir(
  options: CiCheckStateDirOptions = {},
): string {
  const env = options.env ?? ((name: string) => Deno.env.get(name));
  const home = normaliseDir(env("HOME"));

  const candidates = [
    normaliseDir(options.workDir),
    normaliseDir(env("WORK_DIR")),
    home ? `${home}/${HOME_WORK_DIR_NAME}` : "",
  ];

  const base = candidates.find((candidate) => candidate.startsWith("/")) ??
    FALLBACK_CI_CHECK_WORK_DIR;
  return `${base}/${CI_CHECK_STATE_DIR_NAME}`;
}
