/**
 * Repository visibility detection library.
 *
 * Detects whether a given GitHub repository is public or private so that
 * visibility-aware features (e.g. the dependency-review workflow, which
 * requires GHAS on private repos) can react to that fact.
 *
 * Uses the REST Contents API (`gh api repos/{owner}/{repo}`) rather than
 * GraphQL — REST has a separate, less-frequently exhausted rate limit
 * budget than GraphQL.
 *
 * Unknown or missing visibility values are treated as `"private"` so any
 * public-only feature stays disabled when the answer is uncertain.
 *
 * Issue #1752: Add repository visibility detection library.
 */

import type { Result } from "../types.ts";
import { spawnGh } from "./gh_spawn.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A repository's visibility classification. */
export type RepoVisibility = "public" | "private";

/** Output from a shell command. */
export interface CommandOutput {
  success: boolean;
  stdout: string;
  stderr: string;
}

/** Options for repository visibility detection. */
export interface RepoVisibilityOptions {
  /** Override for command execution (useful for testing). */
  runCommand?: (cmd: string[]) => Promise<CommandOutput>;
  /** Custom gh config directory (from .config.json gh_config_dir). */
  ghConfigDir?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Create the default command runner.
 *
 * Issue #1378: this module only ever runs `gh`, so the runner is the shared
 * chokepoint (`spawnGh`) rather than a `Deno.Command` built from `cmd[0]` —
 * an indirection that skipped the write-repo allowlist and the audit journal
 * while the quality gate's literal-string scan saw nothing. Any other binary
 * is refused loudly rather than spawned outside the chokepoint.
 */
function createDefaultRunCommand(
  ghConfigDir?: string,
): (cmd: string[]) => Promise<CommandOutput> {
  const env = ghConfigDir ? { GH_CONFIG_DIR: ghConfigDir } : undefined;
  return async (cmd: string[]): Promise<CommandOutput> => {
    if (cmd[0] !== "gh") {
      throw new Error(
        `repo_visibility only spawns gh through the chokepoint; ` +
          `refusing to run "${cmd[0] ?? ""}"`,
      );
    }
    const result = await spawnGh(cmd.slice(1), env ? { env } : {});
    return {
      success: result.success,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
    };
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get the visibility of a GitHub repository.
 *
 * Calls `gh api repos/{owner}/{repo} --jq .visibility` and maps the
 * result to the {@link RepoVisibility} union. Any unrecognised value
 * (including empty output) is treated as `"private"` so that public-only
 * features stay disabled when the answer is uncertain.
 *
 * @param repo - Repository in `"owner/repo"` format.
 * @param options - Optional configuration for command execution and gh identity.
 * @returns `Result.ok` with the visibility on success, `Result.err` if
 *   the `gh` call itself fails (e.g. network error, repo not found).
 */
export async function getRepoVisibility(
  repo: string,
  options: RepoVisibilityOptions = {},
): Promise<Result<RepoVisibility, string>> {
  const runner = options.runCommand ??
    createDefaultRunCommand(options.ghConfigDir);

  const result = await runner([
    "gh",
    "api",
    `repos/${repo}`,
    "--jq",
    ".visibility",
  ]);

  if (!result.success) {
    const detail = result.stderr.length > 0 ? result.stderr : "unknown error";
    return {
      ok: false,
      error: `Failed to fetch visibility for ${repo}: ${detail}`,
    };
  }

  const raw = result.stdout.trim().toLowerCase();
  if (raw === "public") {
    return { ok: true, value: "public" };
  }
  // Fail-safe: anything else — including "private", "internal", empty,
  // or unexpected — is treated as private.
  return { ok: true, value: "private" };
}
