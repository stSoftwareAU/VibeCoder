/**
 * Pre-commit safety gate (Issue #1758, part of #1751).
 *
 * Scans the staged file list before any worker `git commit` and refuses
 * the commit when hidden or secret-bearing files are staged — including
 * the non-hidden private-key and credential filenames added by Issue
 * #3660 (`*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa`, `credentials.json`,
 * `service-account*.json`).
 *
 * Defence-in-depth: protects even when `.gitignore` is missing, has been
 * bypassed (`git add -f`), or the canonical patterns from #1757 have
 * not yet been applied to a repo.
 *
 * The allowlist is derived from `REQUIRED_GITIGNORE_PATTERNS` in
 * `gitignore_enforcer.ts` (the single source of truth), so the two
 * layers cannot drift apart.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import type { Result } from "../types.ts";
import type { GitCommandOptions } from "./git_timeout.ts";
import { runGitCommand } from "./git_timeout.ts";
import { REQUIRED_GITIGNORE_PATTERNS } from "./gitignore_enforcer.ts";

/**
 * Hidden top-level paths permitted to be tracked. Derived from
 * `REQUIRED_GITIGNORE_PATTERNS` (entries beginning with `!`) so the
 * allowlist remains a single source of truth.
 */
export const ALLOWED_HIDDEN_PATHS: readonly string[] =
  REQUIRED_GITIGNORE_PATTERNS
    .filter((p) => p.startsWith("!"))
    .map((p) => p.slice(1));

/**
 * Always-forbidden patterns. Each regexp is matched against the full
 * staged path returned by `git diff --cached --name-only -z`.
 */
export const FORBIDDEN_STAGED_PATTERNS: readonly RegExp[] = [
  /^\.env(\..*)?$/,
  /^\.config.*\.json$/,
  /.*\.secret\.json$/,
  /^\.secrets\//,
  // Private key material and credential files (Issue #3660). Matched on the
  // final path segment so nested paths (`certs/server.pem`) are caught too.
  /(^|\/)[^/]+\.(pem|key|p12|pfx)$/,
  /(^|\/)id_rsa(\..*)?$/,
  /(^|\/)credentials\.json$/,
  /(^|\/)service-account[^/]*\.json$/,
];

/**
 * Result of inspecting the index for a commit.
 */
export interface InspectStagedResult {
  /** Paths that fail the safety gate and must not be committed. */
  violations: string[];
  /** Paths that pass the safety gate. */
  safe: string[];
}

/**
 * Classify a single staged path as safe or a violation.
 *
 * Order of checks:
 *   1. Explicit forbidden patterns (`.env`, `.config*.json`, etc.).
 *   2. Generic "hidden top-level path outside the allowlist" check —
 *      `^\.[^/]+` minus the entries on the allowlist. The check is
 *      applied to the first path segment so that allowlisted directories
 *      such as `.github/` permit nested files (e.g. `.github/workflows/ci.yml`).
 *
 * @param path Repository-relative path of a staged file.
 * @returns "violation" if the path is forbidden, "safe" otherwise.
 */
export function classifyStagedPath(path: string): "violation" | "safe" {
  for (const re of FORBIDDEN_STAGED_PATTERNS) {
    if (re.test(path)) return "violation";
  }

  if (path.startsWith(".")) {
    const topSegment = path.split("/")[0] ?? path;
    if (!ALLOWED_HIDDEN_PATHS.includes(topSegment)) {
      return "violation";
    }
  }

  return "safe";
}

/**
 * Inspect the git index and classify each staged path.
 *
 * Uses `git diff --cached --name-only -z` so paths containing whitespace
 * are unambiguously separated by NUL bytes.
 *
 * @param options Git command options (cwd, env, timeout).
 * @returns Result with `{ violations, safe }` lists, or an error if the
 *   git command itself failed.
 */
export async function inspectStagedFiles(
  options: GitCommandOptions = {},
): Promise<Result<InspectStagedResult>> {
  const result = await runGitCommand(
    ["diff", "--cached", "--name-only", "-z"],
    options,
  );
  if (!result.ok) return { ok: false, error: result.error };

  if (result.value.code !== 0) {
    const err = result.value.stderr.trim() || result.value.stdout.trim();
    return {
      ok: false,
      error: new Error(`git diff --cached failed: ${err}`),
    };
  }

  const paths = result.value.stdout.split("\0").filter((p) => p.length > 0);

  const violations: string[] = [];
  const safe: string[] = [];
  for (const path of paths) {
    if (classifyStagedPath(path) === "violation") {
      violations.push(path);
    } else {
      safe.push(path);
    }
  }
  return { ok: true, value: { violations, safe } };
}

/**
 * Refuse to proceed when any staged path violates the safety gate.
 *
 * Returns `Ok(void)` when every staged path is safe (including the empty
 * stage). Returns `Err` listing every offending path and the recovery
 * command (`git reset HEAD <file>`).
 *
 * @param options Git command options (cwd, env, timeout).
 */
export async function assertSafeToCommit(
  options: GitCommandOptions = {},
): Promise<Result<void>> {
  const inspection = await inspectStagedFiles(options);
  if (!inspection.ok) return { ok: false, error: inspection.error };

  if (inspection.value.violations.length === 0) {
    return { ok: true, value: undefined };
  }

  const list = inspection.value.violations.map((p) => `  - ${p}`).join("\n");
  return {
    ok: false,
    error: new Error(
      "Pre-commit safety gate refused commit (Issue #1758): the following " +
        "hidden or secret-bearing files are staged:\n" +
        `${list}\n\n` +
        "Remove each one with: git reset HEAD <file>",
    ),
  };
}
