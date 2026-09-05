/**
 * Per-repository configuration utilities (Issue #964).
 *
 * Migrated from issue_worker.sh shell functions that used jq queries
 * to native TypeScript using the typed RepoConfig interface.
 *
 * Functions in this module operate on the repo_config section of
 * the ConfigFile (.config.json), providing per-repo overrides for
 * quality checks, reviewers, custom instructions, and pre-setup commands.
 */

import type { CiProviderConfig, RepoConfig, Result } from "../types.ts";
import { DEFAULT_REPO_NICE } from "./config_defaults.ts";
import { compileCheckNamePattern } from "./ci_log_provider.ts";
import { buildQualityGateBudgetLines } from "./quality_gate_budget.ts";

// =============================================================================
// Per-repo config queries
// =============================================================================

/**
 * Fetch a per-repo configuration value.
 *
 * Equivalent to the shell `get_repo_config "org/repo" "key"` function
 * that used jq. Returns the value as a string (matching shell behaviour),
 * or empty string if the repo or key is not configured.
 *
 * @param repoConfigs - The repo_config map from ConfigFile
 * @param repo - Repository in "owner/repo" format
 * @param key - Configuration key (camelCase, matching RepoConfig fields)
 * @returns The value as a string, or empty string if not found
 */
export function getRepoConfig(
  repoConfigs: Record<string, RepoConfig> | undefined,
  repo: string,
  key: keyof RepoConfig,
): string {
  if (!repoConfigs) return "";
  const config = repoConfigs[repo];
  if (!config) return "";
  const value = config[key];
  if (value === undefined || value === null) return "";
  return String(value);
}

/**
 * Get custom Claude instructions for a repository.
 *
 * @param repoConfigs - The repo_config map from ConfigFile
 * @param repo - Repository in "owner/repo" format
 * @returns Custom instructions string, or empty string
 */
export function getCustomInstructions(
  repoConfigs: Record<string, RepoConfig> | undefined,
  repo: string,
): string {
  return getRepoConfig(repoConfigs, repo, "customInstructions");
}

/**
 * Resolve a repository's `nice` value (Issue #2772, part of #2771).
 *
 * Unix-`nice` semantics: **lower = worked sooner**. Returns the configured
 * integer when the repo sets a finite integer `nice`, otherwise the neutral
 * `DEFAULT_REPO_NICE` (`0`). Configuration arrives untrusted from
 * `.config.json`, so non-integer, non-finite, and wrong-type values are
 * guarded down to the default rather than propagated.
 *
 * This is a static operator preference and is deliberately independent of the
 * failure-based `isRepoDeprioritised` (`repo_failure_tracker.ts`), which is a
 * transient per-cycle penalty.
 *
 * @param repoConfigs - The repo_config map from ConfigFile
 * @param repo - Repository in "owner/repo" format
 * @returns The resolved integer `nice`, or `DEFAULT_REPO_NICE` when unset/invalid
 */
export function getRepoNice(
  repoConfigs: Record<string, RepoConfig> | undefined,
  repo: string,
): number {
  if (!repoConfigs) return DEFAULT_REPO_NICE;
  const config = repoConfigs[repo];
  if (!config) return DEFAULT_REPO_NICE;
  const value = (config as { nice?: unknown }).nice;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return DEFAULT_REPO_NICE;
  }
  return value;
}

// =============================================================================
// Quality instructions
// =============================================================================

/**
 * Build quality check instruction text for a repository.
 *
 * Returns different instructions depending on repo configuration:
 * - If skip_quality_check is true: returns a skip notice
 * - If quality_command is set: uses the custom command
 * - Otherwise: uses the default ./quality.sh
 *
 * The guidance deliberately points the inner loop at the repo's *fast*
 * checks and reserves the full gate for one foreground run at the end
 * (Issue #399). The old "keep running it until it passes" wording sent
 * agents back to a multi-minute gate after every edit, and — because a gate
 * that prints nothing until it finishes looks indistinguishable from a hung
 * one — they backgrounded it and burned the rest of the execute budget in
 * `sleep`/`pgrep` poll loops. One agent sat at 38 tool calls for over seven
 * minutes doing exactly that.
 *
 * That single end-of-run gate is now conditional on the budget left to pay
 * for it (Issue #1138): the gate's median observed duration is 17 minutes
 * inside a roughly one-hour run, so an agent that starts it with ten minutes
 * left cannot finish it, cannot act on it, and loses the runway it needed to
 * push. `quality_gate_budget.ts` holds that rule for every prompt with a
 * `{{QUALITY_INSTRUCTIONS}}` placeholder, so no template can drift back to an
 * unconditional "run the gate before you push".
 *
 * @param repoConfigs - The repo_config map from ConfigFile
 * @param repo - Repository in "owner/repo" format
 * @param options - `typicalGateSeconds`: what the gate took on this repo this
 *   run (the baseline gate), so the guidance quotes a measurement instead of
 *   the fleet-wide assumption. `runBudgetSeconds`: the whole run's wall-clock
 *   budget, which settles the question outright for a gate that cannot fit
 *   inside it — the only budget signal the PR-side flows get, since no
 *   `.vibe-run-budget.md` is written for them
 * @returns Quality instruction text for inclusion in prompts
 */
export function buildQualityInstructions(
  repoConfigs: Record<string, RepoConfig> | undefined,
  repo: string,
  options: { typicalGateSeconds?: number; runBudgetSeconds?: number } = {},
): string {
  const skipQuality = getRepoConfig(repoConfigs, repo, "skipQualityCheck");
  if (skipQuality === "true") {
    return "Note: Quality checks are skipped for this repository.";
  }

  const customCommand = getRepoConfig(repoConfigs, repo, "qualityCommand");
  const command = customCommand || "./quality.sh";

  return [
    `   - While you iterate, use the repository's fast checks — formatter, linter, type check, and only the test files your change touches. Seconds, not minutes.`,
    ...buildQualityGateBudgetLines(
      command,
      options.typicalGateSeconds,
      options.runBudgetSeconds,
    ),
    `   - Never start ${command} in the background and poll for it. A \`sleep\`/\`pgrep\` wait loop spends the execute budget without making progress; run it in the foreground and watch each check report as it completes.`,
    `   - IMPORTANT: Always redirect stdin from /dev/null (< /dev/null) when running tests, quality checks, or build commands to prevent hanging on unattended machines.`,
  ].join("\n");
}

// =============================================================================
// Reviewer flags
// =============================================================================

/**
 * Build a comma-separated reviewer list for gh pr create --reviewer flag.
 *
 * @param prReviewers - Array of GitHub usernames
 * @returns Comma-separated string, or empty string if no reviewers
 */
export function buildReviewerFlags(prReviewers: string[]): string {
  return prReviewers.filter((r) => r !== "").join(",");
}

/**
 * Build reviewer flags with per-repo skip_reviewer_request override.
 *
 * @param repoConfigs - The repo_config map from ConfigFile
 * @param repo - Repository in "owner/repo" format
 * @param prReviewers - Array of GitHub usernames
 * @returns Comma-separated reviewer string, or empty if skipped
 */
export function buildReviewerFlagsForRepo(
  repoConfigs: Record<string, RepoConfig> | undefined,
  repo: string,
  prReviewers: string[],
): string {
  const skipReviewer = getRepoConfig(repoConfigs, repo, "skipReviewerRequest");
  if (skipReviewer === "true") return "";
  return buildReviewerFlags(prReviewers);
}

// =============================================================================
// Pre-setup command execution
// =============================================================================

/** Default timeout for pre-setup commands (in seconds). */
const DEFAULT_PRE_SETUP_TIMEOUT = 300;

/**
 * Execute a repository-specific pre-setup command (Issue #85).
 *
 * Runs the command in the repository directory with a timeout.
 * Uses Deno.Command with AbortController for timeout management.
 *
 * @param repo - Repository in "owner/repo" format
 * @param repoPath - Absolute path to the cloned repository
 * @param repoConfigs - The repo_config map from ConfigFile
 * @param timeoutSeconds - Timeout in seconds (default: 300)
 * @returns Result indicating success or failure with error message
 */
export async function runPreSetupCommand(
  repo: string,
  repoPath: string,
  repoConfigs: Record<string, RepoConfig> | undefined,
  timeoutSeconds: number = DEFAULT_PRE_SETUP_TIMEOUT,
): Promise<Result<string>> {
  const preSetupCmd = getRepoConfig(repoConfigs, repo, "preSetupCommand");
  if (!preSetupCmd) {
    return { ok: true, value: "no_command" };
  }

  try {
    const controller = new AbortController();
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutSeconds * 1000);

    try {
      const command = new Deno.Command("bash", {
        args: ["-c", preSetupCmd],
        cwd: repoPath,
        stdout: "piped",
        stderr: "piped",
        env: {
          ...Deno.env.toObject(),
          REPO_PATH: repoPath,
          REPO_NAME: repo,
        },
        signal: controller.signal,
      });

      const output = await command.output();
      clearTimeout(timeoutId);

      if (timedOut) {
        return {
          ok: false,
          error: new Error(
            `Pre-setup command timed out after ${timeoutSeconds} seconds`,
          ),
        };
      }

      if (!output.success) {
        const stderr = new TextDecoder().decode(output.stderr).trim();
        return {
          ok: false,
          error: new Error(
            `Pre-setup command failed with exit code ${output.code}: ${stderr}`,
          ),
        };
      }

      return { ok: true, value: "completed" };
    } catch (error: unknown) {
      clearTimeout(timeoutId);

      if (
        timedOut ||
        (error instanceof DOMException && error.name === "AbortError")
      ) {
        return {
          ok: false,
          error: new Error(
            `Pre-setup command timed out after ${timeoutSeconds} seconds`,
          ),
        };
      }
      throw error;
    }
  } catch (error: unknown) {
    return {
      ok: false,
      error: new Error(
        `Pre-setup command failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    };
  }
}

// =============================================================================
// CI log providers (Issue #3579)
// =============================================================================

/**
 * Parse and validate a raw `ciProviders` value loaded from `.config.json`
 * into a typed `CiProviderConfig[]` (Issue #3579).
 *
 * Returns `Result.ok` with an empty array when the input is
 * `undefined`/`null` so callers can treat "missing" and "empty" the same
 * way. Every rejection names the offending field so a malformed entry
 * fails loudly rather than being silently ignored.
 *
 * Provider ids are not checked against the registry here — extensions
 * register at runtime — but an unknown id is reported as an explicit
 * dispatcher error, never a silent no-op.
 */
export function parseCiProviders(
  raw: unknown,
): Result<CiProviderConfig[], string> {
  if (raw === undefined || raw === null) {
    return { ok: true, value: [] };
  }
  if (!Array.isArray(raw)) {
    return { ok: false, error: "ciProviders must be an array" };
  }

  const parsed: CiProviderConfig[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, error: `ciProviders[${i}] must be an object` };
    }
    const obj = entry as Record<string, unknown>;

    const provider = obj.provider;
    if (typeof provider !== "string" || provider.length === 0) {
      return {
        ok: false,
        error: `ciProviders[${i}].provider must be a non-empty string`,
      };
    }

    const checkNamePattern = obj.checkNamePattern;
    if (checkNamePattern !== undefined) {
      if (typeof checkNamePattern !== "string") {
        return {
          ok: false,
          error: `ciProviders[${i}].checkNamePattern must be a string`,
        };
      }
      const compiled = compileCheckNamePattern(checkNamePattern, /.*/);
      if (!compiled.ok) {
        return {
          ok: false,
          error: `ciProviders[${i}].${compiled.error}`,
        };
      }
    }

    const jobPath = obj.jobPath;
    if (jobPath !== undefined && typeof jobPath !== "string") {
      return {
        ok: false,
        error: `ciProviders[${i}].jobPath must be a string`,
      };
    }
    // Whether a `jobPath` is required is the provider's business, not
    // core's (Issue #986): core does not know which providers exist, so it
    // cannot know which of them need one. A provider that needs one reports
    // its absence as an explicit dispatcher error.

    parsed.push({
      provider,
      ...(typeof checkNamePattern === "string" ? { checkNamePattern } : {}),
      ...(typeof jobPath === "string" ? { jobPath } : {}),
    });
  }

  return { ok: true, value: parsed };
}

/**
 * Return the CI log providers configured for a repository (Issue #3579).
 *
 * Malformed configuration is surfaced as a thrown error so the worker
 * fails fast rather than silently dropping a provider.
 */
export function getCiProviders(
  repoConfigs: Record<string, RepoConfig> | undefined,
  repo: string,
): CiProviderConfig[] {
  if (!repoConfigs) return [];
  const config = repoConfigs[repo];
  if (!config) return [];

  const raw = (config as { ciProviders?: unknown }).ciProviders;
  const parsed = parseCiProviders(raw);
  if (!parsed.ok) {
    throw new Error(`Invalid ciProviders for ${repo}: ${parsed.error}`);
  }

  return parsed.value;
}

// =============================================================================
// Pre-flight gate commands (Issue #3577)
// =============================================================================

/**
 * Parse and validate a raw `preFlight` value loaded from `.config.json`
 * into a typed `string[]` (Issue #3577).
 *
 * Follows the `parsePrFailureActions()` precedent: returns `Result.ok` with
 * an empty array when the input is `undefined`/`null` so callers can treat
 * "missing" and "empty" the same way (no gate). Returns `Result.error` with
 * a descriptive message when the input is the wrong shape or contains a
 * non-string / empty / blank entry, so a malformed configuration fails
 * loudly rather than silently disabling the gate.
 */
export function parsePreFlightCommands(
  raw: unknown,
): Result<string[], string> {
  if (raw === undefined || raw === null) {
    return { ok: true, value: [] };
  }
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      error: "pre-flight must be an array of command strings",
    };
  }

  const parsed: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (typeof entry !== "string") {
      return {
        ok: false,
        error: `pre-flight[${i}] must be a string`,
      };
    }
    if (entry.trim().length === 0) {
      return {
        ok: false,
        error: `pre-flight[${i}] must be a non-empty command string`,
      };
    }
    parsed.push(entry);
  }

  return { ok: true, value: parsed };
}

/**
 * Return the parsed `preFlight` commands for a repository, or an empty
 * array when the repo has no configuration or the field is unset
 * (Issue #3577).
 *
 * Malformed configuration is surfaced as a thrown error so the worker fails
 * fast rather than silently dropping the gate. Callers that want to handle
 * the error inline should call `parsePreFlightCommands()` directly.
 */
export function getPreFlightCommands(
  repoConfigs: Record<string, RepoConfig> | undefined,
  repo: string,
): string[] {
  if (!repoConfigs) return [];
  const config = repoConfigs[repo];
  if (!config) return [];
  const raw = (config as { preFlight?: unknown }).preFlight;
  if (raw === undefined) return [];
  const result = parsePreFlightCommands(raw);
  if (!result.ok) {
    throw new Error(
      `Invalid pre-flight for ${repo}: ${result.error}`,
    );
  }
  return result.value;
}

// =============================================================================
// CI-failure issue labels (Issue #3581)
// =============================================================================

/**
 * Parse and validate a raw `ciFailureLabels` value loaded from
 * `.config.json` (Issue #3581).
 *
 * Follows the `parsePrFailureActions()` precedent: `undefined`/`null` yields
 * an empty array (feature disabled), and a malformed value fails loudly
 * rather than silently disabling CI-failure detection.
 */
export function parseCiFailureLabels(
  raw: unknown,
): Result<string[], string> {
  if (raw === undefined || raw === null) {
    return { ok: true, value: [] };
  }
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      error: "ciFailureLabels must be an array of label names",
    };
  }

  const parsed: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (typeof entry !== "string") {
      return { ok: false, error: `ciFailureLabels[${i}] must be a string` };
    }
    if (entry.trim().length === 0) {
      return {
        ok: false,
        error: `ciFailureLabels[${i}] must be a non-empty label name`,
      };
    }
    parsed.push(entry.trim());
  }

  return { ok: true, value: parsed };
}

/**
 * Return the configured CI-failure labels for a repository, or an empty
 * array when the repo has no configuration or the field is unset
 * (Issue #3581).
 *
 * Malformed configuration is surfaced as a thrown error so the worker fails
 * fast rather than silently skipping the log fetch.
 */
export function getCiFailureLabels(
  repoConfigs: Record<string, RepoConfig> | undefined,
  repo: string,
): string[] {
  if (!repoConfigs) return [];
  const config = repoConfigs[repo];
  if (!config) return [];
  const raw = (config as { ciFailureLabels?: unknown }).ciFailureLabels;
  if (raw === undefined) return [];
  const result = parseCiFailureLabels(raw);
  if (!result.ok) {
    throw new Error(`Invalid ciFailureLabels for ${repo}: ${result.error}`);
  }
  return result.value;
}
