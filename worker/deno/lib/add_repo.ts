/**
 * Runtime validation for add-repo targets (Issue #2576).
 *
 * When a candidate `owner/repo` is proposed for the monitored set, the worker
 * must confirm at runtime that the repo exists, that the worker account has
 * collaborator (triage) access, and what the repo's visibility is. This module
 * answers those questions and returns a structured outcome the orchestrator
 * (a separate sub-issue) can act on — it does NOT gate on visibility.
 *
 * The add request does not declare visibility — it is determined here at
 * runtime. All public-vs-private gating is deferred to #2571; this module only
 * detects and returns the visibility.
 *
 * Reuses existing helpers rather than re-rolling gh calls:
 * - {@link classifyRepoAccess} for the access/permission check.
 * - {@link getRepoVisibility} for visibility (REST, fail-safe to `private`).
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import type { Result } from "../types.ts";
import {
  classifyRepoAccess,
  type CommandOutput,
  type RunCommand,
} from "../setup/collaborator_precheck.ts";
import { getRepoVisibility, type RepoVisibility } from "./repo_visibility.ts";
import { REPO_SLUG_PATTERN } from "./config.ts";
import { atomicWrite } from "./file_utils.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Discriminated outcome of validating an add-repo target.
 *
 * `not_found` and `no_access` are returned (not thrown) so the orchestrator
 * can comment back and escalate rather than crashing.
 */
export type AddRepoTargetStatus =
  | { kind: "ok"; visibility: RepoVisibility }
  | { kind: "not_found" }
  | { kind: "no_access" };

/** Injected dependencies for {@link validateAddRepoTarget}. */
export interface AddRepoDeps {
  /** Injected `gh` command runner (overridable so tests script responses). */
  runCommand: RunCommand;
}

export type { CommandOutput };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate a candidate add-repo target.
 *
 * Confirms the repo exists and the worker has triage access, then determines
 * its visibility. Returns:
 * - `{ kind: "ok", visibility }` when readable with triage access.
 * - `{ kind: "not_found" }` when `gh api repos/{owner}/{repo}` reports the repo
 *   is missing/unreadable (404/403).
 * - `{ kind: "no_access" }` when the repo is visible but the worker lacks
 *   triage permission.
 *
 * Returns `Result.err` only when access is confirmed but the follow-up
 * visibility lookup itself fails (e.g. a transient gh/network error) — that is
 * the one case where we cannot honestly produce a status.
 *
 * @param repo - Repository in `"owner/repo"` format.
 * @param deps - Injected dependencies (the gh command runner).
 */
export async function validateAddRepoTarget(
  repo: string,
  deps: AddRepoDeps,
): Promise<Result<AddRepoTargetStatus, string>> {
  const access = await classifyRepoAccess(repo, deps.runCommand);

  if (access === "not_visible") {
    return { ok: true, value: { kind: "not_found" } };
  }
  if (access === "not_assignable") {
    return { ok: true, value: { kind: "no_access" } };
  }

  // access === "ok": repo is readable with triage access. Determine visibility.
  const visibility = await getRepoVisibility(repo, {
    runCommand: deps.runCommand,
  });
  if (!visibility.ok) {
    return { ok: false, error: visibility.error };
  }

  return { ok: true, value: { kind: "ok", visibility: visibility.value } };
}

// ---------------------------------------------------------------------------
// Add-repo title parsing + monitored-list mutation (Issue #2575)
// ---------------------------------------------------------------------------

/**
 * Title prefix that marks an issue as an add-repo request, e.g.
 * `add-repo: stSoftwareAU/private-repo-11`. Matched case-insensitively in the
 * same `.startsWith()` style as `IDLE_TASK_MILESTONE_PREFIX`.
 */
export const ADD_REPO_PREFIX = "add-repo:";

/**
 * Parse an `add-repo:`-prefixed issue title into a validated slug.
 *
 * Returns `{ repo }` when the title carries the prefix and the suffix is
 * a valid `owner/repo` slug. Returns `null` (never throws) for any title
 * without the prefix, with an empty slug, or with a slug failing
 * `REPO_SLUG_PATTERN`. The slug is untrusted input — strict validation
 * happens here before it can reach any `gh`/git call or the config file.
 *
 * @param title - The raw issue title.
 * @returns The parsed slug, or `null` when the title does not qualify.
 */
export function parseAddRepoTitle(title: string): { repo: string } | null {
  const trimmed = title.trim();
  if (!trimmed.toLowerCase().startsWith(ADD_REPO_PREFIX)) {
    return null;
  }
  const slug = trimmed.slice(ADD_REPO_PREFIX.length).trim();
  if (slug.length === 0) {
    return null;
  }
  if (!REPO_SLUG_PATTERN.test(slug)) {
    return null;
  }
  return { repo: slug };
}

/**
 * Filesystem functions injected into {@link addRepoToMonitoredList} so
 * tests need no real filesystem. Defaults to the real Deno calls.
 */
export interface AddRepoFsDeps {
  readTextFile: (path: string) => Promise<string>;
  writeTextFile: (path: string, data: string) => Promise<void>;
}

/** Owner-only permissions for the credential-bearing `.config.json`. */
const CONFIG_FILE_MODE = 0o600;

/**
 * The path {@link atomicWrite} should be handed for a config file.
 *
 * `atomicWrite` derives the target directory from the last `/`, so a bare
 * relative filename — the production default `.config.json` — would yield an
 * empty directory and fail. Prefixing `./` names the current directory
 * explicitly; a path that already has a `/` is passed through untouched.
 *
 * @param path - The config path as the caller supplied it.
 */
export function configWriteTarget(path: string): string {
  return path.includes("/") ? path : `./${path}`;
}

/**
 * Write `.config.json` with owner-only permissions (Issue #1241).
 *
 * `.config.json` is credential-bearing — `imgbb_api_key`, the GitHub App
 * identifiers, and the per-repo `repo_config` block — so it must never be
 * left world-readable. The plain `Deno.writeTextFile` this replaced created
 * the file at the process umask default (0o644) and left a pre-existing
 * 0o644 copy untightened. Writing through {@link atomicWrite} at mode 0o600
 * matches the canonical writer in `setup/config_setup.ts` and tightens an
 * already-loose file, because the 0o600 temp file is renamed over it.
 *
 * @param path - Path to the config file.
 * @param data - The serialised config to write.
 * @throws When the write fails — callers convert this into a `Result` error
 *   rather than letting a config that was not written look like one that was.
 */
async function writeConfigSecurely(path: string, data: string): Promise<void> {
  const result = await atomicWrite({
    targetFile: configWriteTarget(path),
    content: data,
    mode: CONFIG_FILE_MODE,
  });
  if (!result.ok) {
    throw result.error;
  }
}

/**
 * Production filesystem deps: reads directly, writes owner-only.
 *
 * Exported so every caller that wires its own deps (e.g.
 * `commands/process_add_repo.ts`) inherits the hardened write rather than
 * re-rolling a bare `Deno.writeTextFile`.
 */
export const defaultAddRepoFsDeps: AddRepoFsDeps = {
  readTextFile: (path) => Deno.readTextFile(path),
  writeTextFile: (path, data) => writeConfigSecurely(path, data),
};

/**
 * Idempotently append a validated `owner/repo` slug to the monitored
 * `repos` list in `.config.json`.
 *
 * The whole config object is read, merged, and written back so unknown
 * keys (phase overrides, idle-task weights, etc.) are preserved — unlike
 * `writeConfigFile`, which strips any key outside the known `SetupConfig`
 * shape. The merge uses the `[...new Set([...existing, repo])]` dedup
 * approach from `config_setup.ts`'s `VIBE_ADD_REPOS` block, so a repo
 * already present yields `{ added: false }` and no duplicate is written.
 *
 * @param repo - The `owner/repo` slug to add (untrusted; re-validated).
 * @param configPath - Path to the `.config.json` file.
 * @param deps - Injected filesystem functions (defaults to real Deno I/O).
 * @returns `Result` carrying `{ added }` — `true` when newly appended,
 *   `false` when already present.
 */
export async function addRepoToMonitoredList(
  repo: string,
  configPath: string,
  deps: AddRepoFsDeps = defaultAddRepoFsDeps,
): Promise<Result<{ added: boolean }>> {
  const slug = repo.trim();

  // Untrusted input — reject anything not in strict owner/repo form
  // before it reaches the config file.
  if (!REPO_SLUG_PATTERN.test(slug)) {
    return {
      ok: false,
      error: new Error(
        `Invalid repository slug "${repo}": expected owner/repo format.`,
      ),
    };
  }

  // Read the existing config. A missing file is treated as an empty
  // config so the first add bootstraps the repos list.
  let raw = "";
  try {
    raw = await deps.readTextFile(configPath);
  } catch {
    raw = "";
  }

  let config: Record<string, unknown> = {};
  if (raw.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {
        ok: false,
        error: new Error(`Config file ${configPath} contains invalid JSON.`),
      };
    }
    if (
      typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
    ) {
      return {
        ok: false,
        error: new Error(`Config file ${configPath} is not a JSON object.`),
      };
    }
    config = parsed as Record<string, unknown>;
  }

  const existing = Array.isArray(config.repos)
    ? (config.repos as unknown[]).filter(
      (r): r is string => typeof r === "string",
    )
    : [];

  // Idempotent: already present means no rewrite and no duplicate.
  if (existing.includes(slug)) {
    return { ok: true, value: { added: false } };
  }

  config.repos = [...new Set([...existing, slug])];

  try {
    await deps.writeTextFile(
      configPath,
      JSON.stringify(config, null, 2) + "\n",
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: new Error(`Failed to write ${configPath}: ${message}`),
    };
  }

  return { ok: true, value: { added: true } };
}

/**
 * Remove a repository from the monitored list (Issue #672).
 *
 * The counterpart to {@link addRepoToMonitoredList}. Adding was automated
 * years before removing was, because adding arrives as an `add-repo:` issue
 * and removing only ever arrived as an operator editing JSON by hand — which
 * is exactly the asymmetry that made the list drift.
 *
 * Also drops the repository's `repo_config` entry, if it has one. Leaving it
 * behind would accumulate settings for repositories nobody monitors, and the
 * next reader cannot tell a deliberate parked entry from forgotten debris.
 *
 * Idempotent: removing a repository that is not listed reports
 * `{ removed: false }` and rewrites nothing.
 *
 * @param repo - The `owner/repo` slug to remove (untrusted; re-validated).
 * @param configPath - Path to the `.config.json` file.
 * @param deps - Injected filesystem functions (defaults to real Deno I/O).
 */
export async function removeRepoFromMonitoredList(
  repo: string,
  configPath: string,
  deps: AddRepoFsDeps = defaultAddRepoFsDeps,
): Promise<Result<{ removed: boolean; repoConfigRemoved: boolean }>> {
  const slug = repo.trim();

  if (!REPO_SLUG_PATTERN.test(slug)) {
    return {
      ok: false,
      error: new Error(
        `Invalid repository slug "${repo}": expected owner/repo format.`,
      ),
    };
  }

  let raw = "";
  try {
    raw = await deps.readTextFile(configPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Unlike add, a missing config is NOT benign here: there is no list to
    // remove from, and silently reporting success would tell the operator
    // their repository is gone when nothing was ever read.
    return {
      ok: false,
      error: new Error(`Failed to read ${configPath}: ${message}`),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      error: new Error(`Config file ${configPath} contains invalid JSON.`),
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      error: new Error(`Config file ${configPath} is not a JSON object.`),
    };
  }
  const config = parsed as Record<string, unknown>;

  const existing = Array.isArray(config.repos)
    ? (config.repos as unknown[]).filter(
      (r): r is string => typeof r === "string",
    )
    : [];

  if (!existing.includes(slug)) {
    return { ok: true, value: { removed: false, repoConfigRemoved: false } };
  }

  config.repos = existing.filter((r) => r !== slug);

  let repoConfigRemoved = false;
  const repoConfig = config.repo_config;
  if (
    typeof repoConfig === "object" && repoConfig !== null &&
    !Array.isArray(repoConfig) &&
    Object.hasOwn(repoConfig as Record<string, unknown>, slug)
  ) {
    delete (repoConfig as Record<string, unknown>)[slug];
    repoConfigRemoved = true;
  }

  try {
    await deps.writeTextFile(
      configPath,
      JSON.stringify(config, null, 2) + "\n",
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: new Error(`Failed to write ${configPath}: ${message}`),
    };
  }

  return { ok: true, value: { removed: true, repoConfigRemoved } };
}

/**
 * The monitored repositories, in config order (Issue #672).
 *
 * Read-only: `--list-repos` exists so an operator can see what they are about
 * to change without opening the file, which is the step the old flow skipped.
 */
export async function listMonitoredRepos(
  configPath: string,
  deps: AddRepoFsDeps = defaultAddRepoFsDeps,
): Promise<Result<string[]>> {
  let raw = "";
  try {
    raw = await deps.readTextFile(configPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: new Error(`Failed to read ${configPath}: ${message}`),
    };
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const repos = Array.isArray(parsed.repos)
      ? (parsed.repos as unknown[]).filter(
        (r): r is string => typeof r === "string",
      )
      : [];
    return { ok: true, value: repos };
  } catch {
    return {
      ok: false,
      error: new Error(`Config file ${configPath} contains invalid JSON.`),
    };
  }
}
