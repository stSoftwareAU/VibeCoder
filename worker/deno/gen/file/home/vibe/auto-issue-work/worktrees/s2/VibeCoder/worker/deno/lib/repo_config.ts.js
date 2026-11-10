/**
 * Per-repository configuration utilities (Issue #964).
 *
 * Migrated from issue_worker.sh shell functions that used jq queries
 * to native TypeScript using the typed RepoConfig interface.
 *
 * Functions in this module operate on the repo_config section of
 * the ConfigFile (.config.json), providing per-repo overrides for
 * quality checks, reviewers, custom instructions, and pre-setup commands.
 */ import { DEFAULT_REPO_NICE } from "./config_defaults.ts";
import { compileCheckNamePattern } from "./ci_log_provider.ts";
import { buildQualityGateBudgetLines } from "./quality_gate_budget.ts";
import { buildUntrustedCommandEnv } from "./untrusted_command_env.ts";
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
 */ export function getRepoConfig(repoConfigs, repo, key) {
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
 */ export function getCustomInstructions(repoConfigs, repo) {
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
 */ export function getRepoNice(repoConfigs, repo) {
  if (!repoConfigs) return DEFAULT_REPO_NICE;
  const config = repoConfigs[repo];
  if (!config) return DEFAULT_REPO_NICE;
  const value = config.nice;
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
 * minutes doing exactly that. The rule used to name only the gate command,
 * so on 2026-09-16 an agent backgrounded the full `deno task test` instead
 * and polled it with one-second `echo` turns — 731 tool calls in 35 minutes
 * on a swapping shared host, and no PR (Issue #2230). It now covers every
 * long-running command.
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
 *   inside it. `pushGuarantee`: what the worker or agent's push path checks
 *   (Issue #4876). The default `"full-gate"` is for issue completion; CI fixes,
 *   PR feedback, spelling fixes and custom PR prompts pass their own guarantee
 *   so a skip record describes the checks that path actually runs.
 * @returns Quality instruction text for inclusion in prompts
 */ export function buildQualityInstructions(repoConfigs, repo, options = {}) {
  const skipQuality = getRepoConfig(repoConfigs, repo, "skipQualityCheck");
  if (skipQuality === "true") {
    return "Note: Quality checks are skipped for this repository.";
  }
  const customCommand = getRepoConfig(repoConfigs, repo, "qualityCommand");
  const command = customCommand || "./quality.sh";
  return [
    `   - While you iterate, use the repository's fast checks — formatter, linter, type check, and only the test files your change touches. Seconds, not minutes.`,
    ...buildQualityGateBudgetLines(command, options.typicalGateSeconds, options.runBudgetSeconds, options.pushGuarantee),
    `   - Never start ${command}, the full test suite, a build, or any other long-running command in the background and poll for it. A \`sleep\`/\`pgrep\`/\`echo\` wait loop spends the execute budget, and a model turn per poll, without making progress (Issue #2230). Run one bounded foreground command instead — \`timeout <seconds> <command> < /dev/null\`, where \`<seconds>\` is sized to the gate's cost stated above, with margin — and read its result when it returns. If the shell tool takes its own timeout argument, set it to match. Run only the test files your change touches; the quality gate and CI run everything.`,
    `   - IMPORTANT: Always redirect stdin from /dev/null (< /dev/null) when running tests, quality checks, or build commands to prevent hanging on unattended machines.`
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
 */ export function buildReviewerFlags(prReviewers) {
  return prReviewers.filter((r)=>r !== "").join(",");
}
/**
 * Build reviewer flags with per-repo skip_reviewer_request override.
 *
 * @param repoConfigs - The repo_config map from ConfigFile
 * @param repo - Repository in "owner/repo" format
 * @param prReviewers - Array of GitHub usernames
 * @returns Comma-separated reviewer string, or empty if skipped
 */ export function buildReviewerFlagsForRepo(repoConfigs, repo, prReviewers) {
  const skipReviewer = getRepoConfig(repoConfigs, repo, "skipReviewerRequest");
  if (skipReviewer === "true") return "";
  return buildReviewerFlags(prReviewers);
}
// =============================================================================
// Pre-setup command execution
// =============================================================================
/** Default timeout for pre-setup commands (in seconds). */ const DEFAULT_PRE_SETUP_TIMEOUT = 300;
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
 */ export async function runPreSetupCommand(repo, repoPath, repoConfigs, timeoutSeconds = DEFAULT_PRE_SETUP_TIMEOUT) {
  const preSetupCmd = getRepoConfig(repoConfigs, repo, "preSetupCommand");
  if (!preSetupCmd) {
    return {
      ok: true,
      value: "no_command"
    };
  }
  try {
    const controller = new AbortController();
    let timedOut = false;
    const timeoutId = setTimeout(()=>{
      timedOut = true;
      controller.abort();
    }, timeoutSeconds * 1000);
    try {
      const command = new Deno.Command("bash", {
        args: [
          "-c",
          preSetupCmd
        ],
        cwd: repoPath,
        stdout: "piped",
        stderr: "piped",
        // The pre-setup command is the repository's own dependency setup, so
        // it runs that repository's install hooks — code the worker did not
        // write. Its environment is BUILT from the allowlist rather than
        // inherited (Issues #572, #1214, #1285): a postinstall script has no
        // credential in scope to echo. `REPO_PATH`/`REPO_NAME` are layered on
        // top, so the contract this command relies on is unchanged.
        env: buildUntrustedCommandEnv({
          overrides: {
            REPO_PATH: repoPath,
            REPO_NAME: repo
          }
        }),
        clearEnv: true,
        signal: controller.signal
      });
      const output = await command.output();
      clearTimeout(timeoutId);
      if (timedOut) {
        return {
          ok: false,
          error: new Error(`Pre-setup command timed out after ${timeoutSeconds} seconds`)
        };
      }
      if (!output.success) {
        const stderr = new TextDecoder().decode(output.stderr).trim();
        return {
          ok: false,
          error: new Error(`Pre-setup command failed with exit code ${output.code}: ${stderr}`)
        };
      }
      return {
        ok: true,
        value: "completed"
      };
    } catch (error) {
      clearTimeout(timeoutId);
      if (timedOut || error instanceof DOMException && error.name === "AbortError") {
        return {
          ok: false,
          error: new Error(`Pre-setup command timed out after ${timeoutSeconds} seconds`)
        };
      }
      throw error;
    }
  } catch (error) {
    return {
      ok: false,
      error: new Error(`Pre-setup command failed: ${error instanceof Error ? error.message : String(error)}`)
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
 */ export function parseCiProviders(raw) {
  if (raw === undefined || raw === null) {
    return {
      ok: true,
      value: []
    };
  }
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      error: "ciProviders must be an array"
    };
  }
  const parsed = [];
  for(let i = 0; i < raw.length; i++){
    const entry = raw[i];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return {
        ok: false,
        error: `ciProviders[${i}] must be an object`
      };
    }
    const obj = entry;
    const provider = obj.provider;
    if (typeof provider !== "string" || provider.length === 0) {
      return {
        ok: false,
        error: `ciProviders[${i}].provider must be a non-empty string`
      };
    }
    const checkNamePattern = obj.checkNamePattern;
    if (checkNamePattern !== undefined) {
      if (typeof checkNamePattern !== "string") {
        return {
          ok: false,
          error: `ciProviders[${i}].checkNamePattern must be a string`
        };
      }
      const compiled = compileCheckNamePattern(checkNamePattern, /.*/);
      if (!compiled.ok) {
        return {
          ok: false,
          error: `ciProviders[${i}].${compiled.error}`
        };
      }
    }
    const jobPath = obj.jobPath;
    if (jobPath !== undefined && typeof jobPath !== "string") {
      return {
        ok: false,
        error: `ciProviders[${i}].jobPath must be a string`
      };
    }
    // Whether a `jobPath` is required is the provider's business, not
    // core's (Issue #986): core does not know which providers exist, so it
    // cannot know which of them need one. A provider that needs one reports
    // its absence as an explicit dispatcher error.
    parsed.push({
      provider,
      ...typeof checkNamePattern === "string" ? {
        checkNamePattern
      } : {},
      ...typeof jobPath === "string" ? {
        jobPath
      } : {}
    });
  }
  return {
    ok: true,
    value: parsed
  };
}
/**
 * Return the CI log providers configured for a repository (Issue #3579).
 *
 * Malformed configuration is surfaced as a thrown error so the worker
 * fails fast rather than silently dropping a provider.
 */ export function getCiProviders(repoConfigs, repo) {
  if (!repoConfigs) return [];
  const config = repoConfigs[repo];
  if (!config) return [];
  const raw = config.ciProviders;
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
 */ export function parsePreFlightCommands(raw) {
  if (raw === undefined || raw === null) {
    return {
      ok: true,
      value: []
    };
  }
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      error: "pre-flight must be an array of command strings"
    };
  }
  const parsed = [];
  for(let i = 0; i < raw.length; i++){
    const entry = raw[i];
    if (typeof entry !== "string") {
      return {
        ok: false,
        error: `pre-flight[${i}] must be a string`
      };
    }
    if (entry.trim().length === 0) {
      return {
        ok: false,
        error: `pre-flight[${i}] must be a non-empty command string`
      };
    }
    parsed.push(entry);
  }
  return {
    ok: true,
    value: parsed
  };
}
/**
 * Return the parsed `preFlight` commands for a repository, or an empty
 * array when the repo has no configuration or the field is unset
 * (Issue #3577).
 *
 * Malformed configuration is surfaced as a thrown error so the worker fails
 * fast rather than silently dropping the gate. Callers that want to handle
 * the error inline should call `parsePreFlightCommands()` directly.
 */ export function getPreFlightCommands(repoConfigs, repo) {
  if (!repoConfigs) return [];
  const config = repoConfigs[repo];
  if (!config) return [];
  const raw = config.preFlight;
  if (raw === undefined) return [];
  const result = parsePreFlightCommands(raw);
  if (!result.ok) {
    throw new Error(`Invalid pre-flight for ${repo}: ${result.error}`);
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
 */ export function parseCiFailureLabels(raw) {
  if (raw === undefined || raw === null) {
    return {
      ok: true,
      value: []
    };
  }
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      error: "ciFailureLabels must be an array of label names"
    };
  }
  const parsed = [];
  for(let i = 0; i < raw.length; i++){
    const entry = raw[i];
    if (typeof entry !== "string") {
      return {
        ok: false,
        error: `ciFailureLabels[${i}] must be a string`
      };
    }
    if (entry.trim().length === 0) {
      return {
        ok: false,
        error: `ciFailureLabels[${i}] must be a non-empty label name`
      };
    }
    parsed.push(entry.trim());
  }
  return {
    ok: true,
    value: parsed
  };
}
/**
 * Return the configured CI-failure labels for a repository, or an empty
 * array when the repo has no configuration or the field is unset
 * (Issue #3581).
 *
 * Malformed configuration is surfaced as a thrown error so the worker fails
 * fast rather than silently skipping the log fetch.
 */ export function getCiFailureLabels(repoConfigs, repo) {
  if (!repoConfigs) return [];
  const config = repoConfigs[repo];
  if (!config) return [];
  const raw = config.ciFailureLabels;
  if (raw === undefined) return [];
  const result = parseCiFailureLabels(raw);
  if (!result.ok) {
    throw new Error(`Invalid ciFailureLabels for ${repo}: ${result.error}`);
  }
  return result.value;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9yZXBvX2NvbmZpZy50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIFBlci1yZXBvc2l0b3J5IGNvbmZpZ3VyYXRpb24gdXRpbGl0aWVzIChJc3N1ZSAjOTY0KS5cbiAqXG4gKiBNaWdyYXRlZCBmcm9tIGlzc3VlX3dvcmtlci5zaCBzaGVsbCBmdW5jdGlvbnMgdGhhdCB1c2VkIGpxIHF1ZXJpZXNcbiAqIHRvIG5hdGl2ZSBUeXBlU2NyaXB0IHVzaW5nIHRoZSB0eXBlZCBSZXBvQ29uZmlnIGludGVyZmFjZS5cbiAqXG4gKiBGdW5jdGlvbnMgaW4gdGhpcyBtb2R1bGUgb3BlcmF0ZSBvbiB0aGUgcmVwb19jb25maWcgc2VjdGlvbiBvZlxuICogdGhlIENvbmZpZ0ZpbGUgKC5jb25maWcuanNvbiksIHByb3ZpZGluZyBwZXItcmVwbyBvdmVycmlkZXMgZm9yXG4gKiBxdWFsaXR5IGNoZWNrcywgcmV2aWV3ZXJzLCBjdXN0b20gaW5zdHJ1Y3Rpb25zLCBhbmQgcHJlLXNldHVwIGNvbW1hbmRzLlxuICovXG5cbmltcG9ydCB0eXBlIHsgQ2lQcm92aWRlckNvbmZpZywgUmVwb0NvbmZpZywgUmVzdWx0IH0gZnJvbSBcIi4uL3R5cGVzLnRzXCI7XG5pbXBvcnQgeyBERUZBVUxUX1JFUE9fTklDRSB9IGZyb20gXCIuL2NvbmZpZ19kZWZhdWx0cy50c1wiO1xuaW1wb3J0IHsgY29tcGlsZUNoZWNrTmFtZVBhdHRlcm4gfSBmcm9tIFwiLi9jaV9sb2dfcHJvdmlkZXIudHNcIjtcbmltcG9ydCB7XG4gIGJ1aWxkUXVhbGl0eUdhdGVCdWRnZXRMaW5lcyxcbiAgdHlwZSBHYXRlUHVzaEd1YXJhbnRlZSxcbn0gZnJvbSBcIi4vcXVhbGl0eV9nYXRlX2J1ZGdldC50c1wiO1xuaW1wb3J0IHsgYnVpbGRVbnRydXN0ZWRDb21tYW5kRW52IH0gZnJvbSBcIi4vdW50cnVzdGVkX2NvbW1hbmRfZW52LnRzXCI7XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBQZXItcmVwbyBjb25maWcgcXVlcmllc1xuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuLyoqXG4gKiBGZXRjaCBhIHBlci1yZXBvIGNvbmZpZ3VyYXRpb24gdmFsdWUuXG4gKlxuICogRXF1aXZhbGVudCB0byB0aGUgc2hlbGwgYGdldF9yZXBvX2NvbmZpZyBcIm9yZy9yZXBvXCIgXCJrZXlcImAgZnVuY3Rpb25cbiAqIHRoYXQgdXNlZCBqcS4gUmV0dXJucyB0aGUgdmFsdWUgYXMgYSBzdHJpbmcgKG1hdGNoaW5nIHNoZWxsIGJlaGF2aW91ciksXG4gKiBvciBlbXB0eSBzdHJpbmcgaWYgdGhlIHJlcG8gb3Iga2V5IGlzIG5vdCBjb25maWd1cmVkLlxuICpcbiAqIEBwYXJhbSByZXBvQ29uZmlncyAtIFRoZSByZXBvX2NvbmZpZyBtYXAgZnJvbSBDb25maWdGaWxlXG4gKiBAcGFyYW0gcmVwbyAtIFJlcG9zaXRvcnkgaW4gXCJvd25lci9yZXBvXCIgZm9ybWF0XG4gKiBAcGFyYW0ga2V5IC0gQ29uZmlndXJhdGlvbiBrZXkgKGNhbWVsQ2FzZSwgbWF0Y2hpbmcgUmVwb0NvbmZpZyBmaWVsZHMpXG4gKiBAcmV0dXJucyBUaGUgdmFsdWUgYXMgYSBzdHJpbmcsIG9yIGVtcHR5IHN0cmluZyBpZiBub3QgZm91bmRcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGdldFJlcG9Db25maWcoXG4gIHJlcG9Db25maWdzOiBSZWNvcmQ8c3RyaW5nLCBSZXBvQ29uZmlnPiB8IHVuZGVmaW5lZCxcbiAgcmVwbzogc3RyaW5nLFxuICBrZXk6IGtleW9mIFJlcG9Db25maWcsXG4pOiBzdHJpbmcge1xuICBpZiAoIXJlcG9Db25maWdzKSByZXR1cm4gXCJcIjtcbiAgY29uc3QgY29uZmlnID0gcmVwb0NvbmZpZ3NbcmVwb107XG4gIGlmICghY29uZmlnKSByZXR1cm4gXCJcIjtcbiAgY29uc3QgdmFsdWUgPSBjb25maWdba2V5XTtcbiAgaWYgKHZhbHVlID09PSB1bmRlZmluZWQgfHwgdmFsdWUgPT09IG51bGwpIHJldHVybiBcIlwiO1xuICByZXR1cm4gU3RyaW5nKHZhbHVlKTtcbn1cblxuLyoqXG4gKiBHZXQgY3VzdG9tIENsYXVkZSBpbnN0cnVjdGlvbnMgZm9yIGEgcmVwb3NpdG9yeS5cbiAqXG4gKiBAcGFyYW0gcmVwb0NvbmZpZ3MgLSBUaGUgcmVwb19jb25maWcgbWFwIGZyb20gQ29uZmlnRmlsZVxuICogQHBhcmFtIHJlcG8gLSBSZXBvc2l0b3J5IGluIFwib3duZXIvcmVwb1wiIGZvcm1hdFxuICogQHJldHVybnMgQ3VzdG9tIGluc3RydWN0aW9ucyBzdHJpbmcsIG9yIGVtcHR5IHN0cmluZ1xuICovXG5leHBvcnQgZnVuY3Rpb24gZ2V0Q3VzdG9tSW5zdHJ1Y3Rpb25zKFxuICByZXBvQ29uZmlnczogUmVjb3JkPHN0cmluZywgUmVwb0NvbmZpZz4gfCB1bmRlZmluZWQsXG4gIHJlcG86IHN0cmluZyxcbik6IHN0cmluZyB7XG4gIHJldHVybiBnZXRSZXBvQ29uZmlnKHJlcG9Db25maWdzLCByZXBvLCBcImN1c3RvbUluc3RydWN0aW9uc1wiKTtcbn1cblxuLyoqXG4gKiBSZXNvbHZlIGEgcmVwb3NpdG9yeSdzIGBuaWNlYCB2YWx1ZSAoSXNzdWUgIzI3NzIsIHBhcnQgb2YgIzI3NzEpLlxuICpcbiAqIFVuaXgtYG5pY2VgIHNlbWFudGljczogKipsb3dlciA9IHdvcmtlZCBzb29uZXIqKi4gUmV0dXJucyB0aGUgY29uZmlndXJlZFxuICogaW50ZWdlciB3aGVuIHRoZSByZXBvIHNldHMgYSBmaW5pdGUgaW50ZWdlciBgbmljZWAsIG90aGVyd2lzZSB0aGUgbmV1dHJhbFxuICogYERFRkFVTFRfUkVQT19OSUNFYCAoYDBgKS4gQ29uZmlndXJhdGlvbiBhcnJpdmVzIHVudHJ1c3RlZCBmcm9tXG4gKiBgLmNvbmZpZy5qc29uYCwgc28gbm9uLWludGVnZXIsIG5vbi1maW5pdGUsIGFuZCB3cm9uZy10eXBlIHZhbHVlcyBhcmVcbiAqIGd1YXJkZWQgZG93biB0byB0aGUgZGVmYXVsdCByYXRoZXIgdGhhbiBwcm9wYWdhdGVkLlxuICpcbiAqIFRoaXMgaXMgYSBzdGF0aWMgb3BlcmF0b3IgcHJlZmVyZW5jZSBhbmQgaXMgZGVsaWJlcmF0ZWx5IGluZGVwZW5kZW50IG9mIHRoZVxuICogZmFpbHVyZS1iYXNlZCBgaXNSZXBvRGVwcmlvcml0aXNlZGAgKGByZXBvX2ZhaWx1cmVfdHJhY2tlci50c2ApLCB3aGljaCBpcyBhXG4gKiB0cmFuc2llbnQgcGVyLWN5Y2xlIHBlbmFsdHkuXG4gKlxuICogQHBhcmFtIHJlcG9Db25maWdzIC0gVGhlIHJlcG9fY29uZmlnIG1hcCBmcm9tIENvbmZpZ0ZpbGVcbiAqIEBwYXJhbSByZXBvIC0gUmVwb3NpdG9yeSBpbiBcIm93bmVyL3JlcG9cIiBmb3JtYXRcbiAqIEByZXR1cm5zIFRoZSByZXNvbHZlZCBpbnRlZ2VyIGBuaWNlYCwgb3IgYERFRkFVTFRfUkVQT19OSUNFYCB3aGVuIHVuc2V0L2ludmFsaWRcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGdldFJlcG9OaWNlKFxuICByZXBvQ29uZmlnczogUmVjb3JkPHN0cmluZywgUmVwb0NvbmZpZz4gfCB1bmRlZmluZWQsXG4gIHJlcG86IHN0cmluZyxcbik6IG51bWJlciB7XG4gIGlmICghcmVwb0NvbmZpZ3MpIHJldHVybiBERUZBVUxUX1JFUE9fTklDRTtcbiAgY29uc3QgY29uZmlnID0gcmVwb0NvbmZpZ3NbcmVwb107XG4gIGlmICghY29uZmlnKSByZXR1cm4gREVGQVVMVF9SRVBPX05JQ0U7XG4gIGNvbnN0IHZhbHVlID0gKGNvbmZpZyBhcyB7IG5pY2U/OiB1bmtub3duIH0pLm5pY2U7XG4gIGlmICh0eXBlb2YgdmFsdWUgIT09IFwibnVtYmVyXCIgfHwgIU51bWJlci5pc0ludGVnZXIodmFsdWUpKSB7XG4gICAgcmV0dXJuIERFRkFVTFRfUkVQT19OSUNFO1xuICB9XG4gIHJldHVybiB2YWx1ZTtcbn1cblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIFF1YWxpdHkgaW5zdHJ1Y3Rpb25zXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4vKipcbiAqIEJ1aWxkIHF1YWxpdHkgY2hlY2sgaW5zdHJ1Y3Rpb24gdGV4dCBmb3IgYSByZXBvc2l0b3J5LlxuICpcbiAqIFJldHVybnMgZGlmZmVyZW50IGluc3RydWN0aW9ucyBkZXBlbmRpbmcgb24gcmVwbyBjb25maWd1cmF0aW9uOlxuICogLSBJZiBza2lwX3F1YWxpdHlfY2hlY2sgaXMgdHJ1ZTogcmV0dXJucyBhIHNraXAgbm90aWNlXG4gKiAtIElmIHF1YWxpdHlfY29tbWFuZCBpcyBzZXQ6IHVzZXMgdGhlIGN1c3RvbSBjb21tYW5kXG4gKiAtIE90aGVyd2lzZTogdXNlcyB0aGUgZGVmYXVsdCAuL3F1YWxpdHkuc2hcbiAqXG4gKiBUaGUgZ3VpZGFuY2UgZGVsaWJlcmF0ZWx5IHBvaW50cyB0aGUgaW5uZXIgbG9vcCBhdCB0aGUgcmVwbydzICpmYXN0KlxuICogY2hlY2tzIGFuZCByZXNlcnZlcyB0aGUgZnVsbCBnYXRlIGZvciBvbmUgZm9yZWdyb3VuZCBydW4gYXQgdGhlIGVuZFxuICogKElzc3VlICMzOTkpLiBUaGUgb2xkIFwia2VlcCBydW5uaW5nIGl0IHVudGlsIGl0IHBhc3Nlc1wiIHdvcmRpbmcgc2VudFxuICogYWdlbnRzIGJhY2sgdG8gYSBtdWx0aS1taW51dGUgZ2F0ZSBhZnRlciBldmVyeSBlZGl0LCBhbmQg4oCUIGJlY2F1c2UgYSBnYXRlXG4gKiB0aGF0IHByaW50cyBub3RoaW5nIHVudGlsIGl0IGZpbmlzaGVzIGxvb2tzIGluZGlzdGluZ3Vpc2hhYmxlIGZyb20gYSBodW5nXG4gKiBvbmUg4oCUIHRoZXkgYmFja2dyb3VuZGVkIGl0IGFuZCBidXJuZWQgdGhlIHJlc3Qgb2YgdGhlIGV4ZWN1dGUgYnVkZ2V0IGluXG4gKiBgc2xlZXBgL2BwZ3JlcGAgcG9sbCBsb29wcy4gT25lIGFnZW50IHNhdCBhdCAzOCB0b29sIGNhbGxzIGZvciBvdmVyIHNldmVuXG4gKiBtaW51dGVzIGRvaW5nIGV4YWN0bHkgdGhhdC4gVGhlIHJ1bGUgdXNlZCB0byBuYW1lIG9ubHkgdGhlIGdhdGUgY29tbWFuZCxcbiAqIHNvIG9uIDIwMjYtMDktMTYgYW4gYWdlbnQgYmFja2dyb3VuZGVkIHRoZSBmdWxsIGBkZW5vIHRhc2sgdGVzdGAgaW5zdGVhZFxuICogYW5kIHBvbGxlZCBpdCB3aXRoIG9uZS1zZWNvbmQgYGVjaG9gIHR1cm5zIOKAlCA3MzEgdG9vbCBjYWxscyBpbiAzNSBtaW51dGVzXG4gKiBvbiBhIHN3YXBwaW5nIHNoYXJlZCBob3N0LCBhbmQgbm8gUFIgKElzc3VlICMyMjMwKS4gSXQgbm93IGNvdmVycyBldmVyeVxuICogbG9uZy1ydW5uaW5nIGNvbW1hbmQuXG4gKlxuICogVGhhdCBzaW5nbGUgZW5kLW9mLXJ1biBnYXRlIGlzIG5vdyBjb25kaXRpb25hbCBvbiB0aGUgYnVkZ2V0IGxlZnQgdG8gcGF5XG4gKiBmb3IgaXQgKElzc3VlICMxMTM4KTogdGhlIGdhdGUncyBtZWRpYW4gb2JzZXJ2ZWQgZHVyYXRpb24gaXMgMTcgbWludXRlc1xuICogaW5zaWRlIGEgcm91Z2hseSBvbmUtaG91ciBydW4sIHNvIGFuIGFnZW50IHRoYXQgc3RhcnRzIGl0IHdpdGggdGVuIG1pbnV0ZXNcbiAqIGxlZnQgY2Fubm90IGZpbmlzaCBpdCwgY2Fubm90IGFjdCBvbiBpdCwgYW5kIGxvc2VzIHRoZSBydW53YXkgaXQgbmVlZGVkIHRvXG4gKiBwdXNoLiBgcXVhbGl0eV9nYXRlX2J1ZGdldC50c2AgaG9sZHMgdGhhdCBydWxlIGZvciBldmVyeSBwcm9tcHQgd2l0aCBhXG4gKiBge3tRVUFMSVRZX0lOU1RSVUNUSU9OU319YCBwbGFjZWhvbGRlciwgc28gbm8gdGVtcGxhdGUgY2FuIGRyaWZ0IGJhY2sgdG8gYW5cbiAqIHVuY29uZGl0aW9uYWwgXCJydW4gdGhlIGdhdGUgYmVmb3JlIHlvdSBwdXNoXCIuXG4gKlxuICogQHBhcmFtIHJlcG9Db25maWdzIC0gVGhlIHJlcG9fY29uZmlnIG1hcCBmcm9tIENvbmZpZ0ZpbGVcbiAqIEBwYXJhbSByZXBvIC0gUmVwb3NpdG9yeSBpbiBcIm93bmVyL3JlcG9cIiBmb3JtYXRcbiAqIEBwYXJhbSBvcHRpb25zIC0gYHR5cGljYWxHYXRlU2Vjb25kc2A6IHdoYXQgdGhlIGdhdGUgdG9vayBvbiB0aGlzIHJlcG8gdGhpc1xuICogICBydW4gKHRoZSBiYXNlbGluZSBnYXRlKSwgc28gdGhlIGd1aWRhbmNlIHF1b3RlcyBhIG1lYXN1cmVtZW50IGluc3RlYWQgb2ZcbiAqICAgdGhlIGZsZWV0LXdpZGUgYXNzdW1wdGlvbi4gYHJ1bkJ1ZGdldFNlY29uZHNgOiB0aGUgd2hvbGUgcnVuJ3Mgd2FsbC1jbG9ja1xuICogICBidWRnZXQsIHdoaWNoIHNldHRsZXMgdGhlIHF1ZXN0aW9uIG91dHJpZ2h0IGZvciBhIGdhdGUgdGhhdCBjYW5ub3QgZml0XG4gKiAgIGluc2lkZSBpdC4gYHB1c2hHdWFyYW50ZWVgOiB3aGF0IHRoZSB3b3JrZXIgb3IgYWdlbnQncyBwdXNoIHBhdGggY2hlY2tzXG4gKiAgIChJc3N1ZSAjNDg3NikuIFRoZSBkZWZhdWx0IGBcImZ1bGwtZ2F0ZVwiYCBpcyBmb3IgaXNzdWUgY29tcGxldGlvbjsgQ0kgZml4ZXMsXG4gKiAgIFBSIGZlZWRiYWNrLCBzcGVsbGluZyBmaXhlcyBhbmQgY3VzdG9tIFBSIHByb21wdHMgcGFzcyB0aGVpciBvd24gZ3VhcmFudGVlXG4gKiAgIHNvIGEgc2tpcCByZWNvcmQgZGVzY3JpYmVzIHRoZSBjaGVja3MgdGhhdCBwYXRoIGFjdHVhbGx5IHJ1bnMuXG4gKiBAcmV0dXJucyBRdWFsaXR5IGluc3RydWN0aW9uIHRleHQgZm9yIGluY2x1c2lvbiBpbiBwcm9tcHRzXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBidWlsZFF1YWxpdHlJbnN0cnVjdGlvbnMoXG4gIHJlcG9Db25maWdzOiBSZWNvcmQ8c3RyaW5nLCBSZXBvQ29uZmlnPiB8IHVuZGVmaW5lZCxcbiAgcmVwbzogc3RyaW5nLFxuICBvcHRpb25zOiB7XG4gICAgdHlwaWNhbEdhdGVTZWNvbmRzPzogbnVtYmVyO1xuICAgIHJ1bkJ1ZGdldFNlY29uZHM/OiBudW1iZXI7XG4gICAgcHVzaEd1YXJhbnRlZT86IEdhdGVQdXNoR3VhcmFudGVlO1xuICB9ID0ge30sXG4pOiBzdHJpbmcge1xuICBjb25zdCBza2lwUXVhbGl0eSA9IGdldFJlcG9Db25maWcocmVwb0NvbmZpZ3MsIHJlcG8sIFwic2tpcFF1YWxpdHlDaGVja1wiKTtcbiAgaWYgKHNraXBRdWFsaXR5ID09PSBcInRydWVcIikge1xuICAgIHJldHVybiBcIk5vdGU6IFF1YWxpdHkgY2hlY2tzIGFyZSBza2lwcGVkIGZvciB0aGlzIHJlcG9zaXRvcnkuXCI7XG4gIH1cblxuICBjb25zdCBjdXN0b21Db21tYW5kID0gZ2V0UmVwb0NvbmZpZyhyZXBvQ29uZmlncywgcmVwbywgXCJxdWFsaXR5Q29tbWFuZFwiKTtcbiAgY29uc3QgY29tbWFuZCA9IGN1c3RvbUNvbW1hbmQgfHwgXCIuL3F1YWxpdHkuc2hcIjtcblxuICByZXR1cm4gW1xuICAgIGAgICAtIFdoaWxlIHlvdSBpdGVyYXRlLCB1c2UgdGhlIHJlcG9zaXRvcnkncyBmYXN0IGNoZWNrcyDigJQgZm9ybWF0dGVyLCBsaW50ZXIsIHR5cGUgY2hlY2ssIGFuZCBvbmx5IHRoZSB0ZXN0IGZpbGVzIHlvdXIgY2hhbmdlIHRvdWNoZXMuIFNlY29uZHMsIG5vdCBtaW51dGVzLmAsXG4gICAgLi4uYnVpbGRRdWFsaXR5R2F0ZUJ1ZGdldExpbmVzKFxuICAgICAgY29tbWFuZCxcbiAgICAgIG9wdGlvbnMudHlwaWNhbEdhdGVTZWNvbmRzLFxuICAgICAgb3B0aW9ucy5ydW5CdWRnZXRTZWNvbmRzLFxuICAgICAgb3B0aW9ucy5wdXNoR3VhcmFudGVlLFxuICAgICksXG4gICAgYCAgIC0gTmV2ZXIgc3RhcnQgJHtjb21tYW5kfSwgdGhlIGZ1bGwgdGVzdCBzdWl0ZSwgYSBidWlsZCwgb3IgYW55IG90aGVyIGxvbmctcnVubmluZyBjb21tYW5kIGluIHRoZSBiYWNrZ3JvdW5kIGFuZCBwb2xsIGZvciBpdC4gQSBcXGBzbGVlcFxcYC9cXGBwZ3JlcFxcYC9cXGBlY2hvXFxgIHdhaXQgbG9vcCBzcGVuZHMgdGhlIGV4ZWN1dGUgYnVkZ2V0LCBhbmQgYSBtb2RlbCB0dXJuIHBlciBwb2xsLCB3aXRob3V0IG1ha2luZyBwcm9ncmVzcyAoSXNzdWUgIzIyMzApLiBSdW4gb25lIGJvdW5kZWQgZm9yZWdyb3VuZCBjb21tYW5kIGluc3RlYWQg4oCUIFxcYHRpbWVvdXQgPHNlY29uZHM+IDxjb21tYW5kPiA8IC9kZXYvbnVsbFxcYCwgd2hlcmUgXFxgPHNlY29uZHM+XFxgIGlzIHNpemVkIHRvIHRoZSBnYXRlJ3MgY29zdCBzdGF0ZWQgYWJvdmUsIHdpdGggbWFyZ2luIOKAlCBhbmQgcmVhZCBpdHMgcmVzdWx0IHdoZW4gaXQgcmV0dXJucy4gSWYgdGhlIHNoZWxsIHRvb2wgdGFrZXMgaXRzIG93biB0aW1lb3V0IGFyZ3VtZW50LCBzZXQgaXQgdG8gbWF0Y2guIFJ1biBvbmx5IHRoZSB0ZXN0IGZpbGVzIHlvdXIgY2hhbmdlIHRvdWNoZXM7IHRoZSBxdWFsaXR5IGdhdGUgYW5kIENJIHJ1biBldmVyeXRoaW5nLmAsXG4gICAgYCAgIC0gSU1QT1JUQU5UOiBBbHdheXMgcmVkaXJlY3Qgc3RkaW4gZnJvbSAvZGV2L251bGwgKDwgL2Rldi9udWxsKSB3aGVuIHJ1bm5pbmcgdGVzdHMsIHF1YWxpdHkgY2hlY2tzLCBvciBidWlsZCBjb21tYW5kcyB0byBwcmV2ZW50IGhhbmdpbmcgb24gdW5hdHRlbmRlZCBtYWNoaW5lcy5gLFxuICBdLmpvaW4oXCJcXG5cIik7XG59XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBSZXZpZXdlciBmbGFnc1xuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuLyoqXG4gKiBCdWlsZCBhIGNvbW1hLXNlcGFyYXRlZCByZXZpZXdlciBsaXN0IGZvciBnaCBwciBjcmVhdGUgLS1yZXZpZXdlciBmbGFnLlxuICpcbiAqIEBwYXJhbSBwclJldmlld2VycyAtIEFycmF5IG9mIEdpdEh1YiB1c2VybmFtZXNcbiAqIEByZXR1cm5zIENvbW1hLXNlcGFyYXRlZCBzdHJpbmcsIG9yIGVtcHR5IHN0cmluZyBpZiBubyByZXZpZXdlcnNcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkUmV2aWV3ZXJGbGFncyhwclJldmlld2Vyczogc3RyaW5nW10pOiBzdHJpbmcge1xuICByZXR1cm4gcHJSZXZpZXdlcnMuZmlsdGVyKChyKSA9PiByICE9PSBcIlwiKS5qb2luKFwiLFwiKTtcbn1cblxuLyoqXG4gKiBCdWlsZCByZXZpZXdlciBmbGFncyB3aXRoIHBlci1yZXBvIHNraXBfcmV2aWV3ZXJfcmVxdWVzdCBvdmVycmlkZS5cbiAqXG4gKiBAcGFyYW0gcmVwb0NvbmZpZ3MgLSBUaGUgcmVwb19jb25maWcgbWFwIGZyb20gQ29uZmlnRmlsZVxuICogQHBhcmFtIHJlcG8gLSBSZXBvc2l0b3J5IGluIFwib3duZXIvcmVwb1wiIGZvcm1hdFxuICogQHBhcmFtIHByUmV2aWV3ZXJzIC0gQXJyYXkgb2YgR2l0SHViIHVzZXJuYW1lc1xuICogQHJldHVybnMgQ29tbWEtc2VwYXJhdGVkIHJldmlld2VyIHN0cmluZywgb3IgZW1wdHkgaWYgc2tpcHBlZFxuICovXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRSZXZpZXdlckZsYWdzRm9yUmVwbyhcbiAgcmVwb0NvbmZpZ3M6IFJlY29yZDxzdHJpbmcsIFJlcG9Db25maWc+IHwgdW5kZWZpbmVkLFxuICByZXBvOiBzdHJpbmcsXG4gIHByUmV2aWV3ZXJzOiBzdHJpbmdbXSxcbik6IHN0cmluZyB7XG4gIGNvbnN0IHNraXBSZXZpZXdlciA9IGdldFJlcG9Db25maWcocmVwb0NvbmZpZ3MsIHJlcG8sIFwic2tpcFJldmlld2VyUmVxdWVzdFwiKTtcbiAgaWYgKHNraXBSZXZpZXdlciA9PT0gXCJ0cnVlXCIpIHJldHVybiBcIlwiO1xuICByZXR1cm4gYnVpbGRSZXZpZXdlckZsYWdzKHByUmV2aWV3ZXJzKTtcbn1cblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIFByZS1zZXR1cCBjb21tYW5kIGV4ZWN1dGlvblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuLyoqIERlZmF1bHQgdGltZW91dCBmb3IgcHJlLXNldHVwIGNvbW1hbmRzIChpbiBzZWNvbmRzKS4gKi9cbmNvbnN0IERFRkFVTFRfUFJFX1NFVFVQX1RJTUVPVVQgPSAzMDA7XG5cbi8qKlxuICogRXhlY3V0ZSBhIHJlcG9zaXRvcnktc3BlY2lmaWMgcHJlLXNldHVwIGNvbW1hbmQgKElzc3VlICM4NSkuXG4gKlxuICogUnVucyB0aGUgY29tbWFuZCBpbiB0aGUgcmVwb3NpdG9yeSBkaXJlY3Rvcnkgd2l0aCBhIHRpbWVvdXQuXG4gKiBVc2VzIERlbm8uQ29tbWFuZCB3aXRoIEFib3J0Q29udHJvbGxlciBmb3IgdGltZW91dCBtYW5hZ2VtZW50LlxuICpcbiAqIEBwYXJhbSByZXBvIC0gUmVwb3NpdG9yeSBpbiBcIm93bmVyL3JlcG9cIiBmb3JtYXRcbiAqIEBwYXJhbSByZXBvUGF0aCAtIEFic29sdXRlIHBhdGggdG8gdGhlIGNsb25lZCByZXBvc2l0b3J5XG4gKiBAcGFyYW0gcmVwb0NvbmZpZ3MgLSBUaGUgcmVwb19jb25maWcgbWFwIGZyb20gQ29uZmlnRmlsZVxuICogQHBhcmFtIHRpbWVvdXRTZWNvbmRzIC0gVGltZW91dCBpbiBzZWNvbmRzIChkZWZhdWx0OiAzMDApXG4gKiBAcmV0dXJucyBSZXN1bHQgaW5kaWNhdGluZyBzdWNjZXNzIG9yIGZhaWx1cmUgd2l0aCBlcnJvciBtZXNzYWdlXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBydW5QcmVTZXR1cENvbW1hbmQoXG4gIHJlcG86IHN0cmluZyxcbiAgcmVwb1BhdGg6IHN0cmluZyxcbiAgcmVwb0NvbmZpZ3M6IFJlY29yZDxzdHJpbmcsIFJlcG9Db25maWc+IHwgdW5kZWZpbmVkLFxuICB0aW1lb3V0U2Vjb25kczogbnVtYmVyID0gREVGQVVMVF9QUkVfU0VUVVBfVElNRU9VVCxcbik6IFByb21pc2U8UmVzdWx0PHN0cmluZz4+IHtcbiAgY29uc3QgcHJlU2V0dXBDbWQgPSBnZXRSZXBvQ29uZmlnKHJlcG9Db25maWdzLCByZXBvLCBcInByZVNldHVwQ29tbWFuZFwiKTtcbiAgaWYgKCFwcmVTZXR1cENtZCkge1xuICAgIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogXCJub19jb21tYW5kXCIgfTtcbiAgfVxuXG4gIHRyeSB7XG4gICAgY29uc3QgY29udHJvbGxlciA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcbiAgICBsZXQgdGltZWRPdXQgPSBmYWxzZTtcbiAgICBjb25zdCB0aW1lb3V0SWQgPSBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICAgIHRpbWVkT3V0ID0gdHJ1ZTtcbiAgICAgIGNvbnRyb2xsZXIuYWJvcnQoKTtcbiAgICB9LCB0aW1lb3V0U2Vjb25kcyAqIDEwMDApO1xuXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGNvbW1hbmQgPSBuZXcgRGVuby5Db21tYW5kKFwiYmFzaFwiLCB7XG4gICAgICAgIGFyZ3M6IFtcIi1jXCIsIHByZVNldHVwQ21kXSxcbiAgICAgICAgY3dkOiByZXBvUGF0aCxcbiAgICAgICAgc3Rkb3V0OiBcInBpcGVkXCIsXG4gICAgICAgIHN0ZGVycjogXCJwaXBlZFwiLFxuICAgICAgICAvLyBUaGUgcHJlLXNldHVwIGNvbW1hbmQgaXMgdGhlIHJlcG9zaXRvcnkncyBvd24gZGVwZW5kZW5jeSBzZXR1cCwgc29cbiAgICAgICAgLy8gaXQgcnVucyB0aGF0IHJlcG9zaXRvcnkncyBpbnN0YWxsIGhvb2tzIOKAlCBjb2RlIHRoZSB3b3JrZXIgZGlkIG5vdFxuICAgICAgICAvLyB3cml0ZS4gSXRzIGVudmlyb25tZW50IGlzIEJVSUxUIGZyb20gdGhlIGFsbG93bGlzdCByYXRoZXIgdGhhblxuICAgICAgICAvLyBpbmhlcml0ZWQgKElzc3VlcyAjNTcyLCAjMTIxNCwgIzEyODUpOiBhIHBvc3RpbnN0YWxsIHNjcmlwdCBoYXMgbm9cbiAgICAgICAgLy8gY3JlZGVudGlhbCBpbiBzY29wZSB0byBlY2hvLiBgUkVQT19QQVRIYC9gUkVQT19OQU1FYCBhcmUgbGF5ZXJlZCBvblxuICAgICAgICAvLyB0b3AsIHNvIHRoZSBjb250cmFjdCB0aGlzIGNvbW1hbmQgcmVsaWVzIG9uIGlzIHVuY2hhbmdlZC5cbiAgICAgICAgZW52OiBidWlsZFVudHJ1c3RlZENvbW1hbmRFbnYoe1xuICAgICAgICAgIG92ZXJyaWRlczogeyBSRVBPX1BBVEg6IHJlcG9QYXRoLCBSRVBPX05BTUU6IHJlcG8gfSxcbiAgICAgICAgfSksXG4gICAgICAgIGNsZWFyRW52OiB0cnVlLFxuICAgICAgICBzaWduYWw6IGNvbnRyb2xsZXIuc2lnbmFsLFxuICAgICAgfSk7XG5cbiAgICAgIGNvbnN0IG91dHB1dCA9IGF3YWl0IGNvbW1hbmQub3V0cHV0KCk7XG4gICAgICBjbGVhclRpbWVvdXQodGltZW91dElkKTtcblxuICAgICAgaWYgKHRpbWVkT3V0KSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgb2s6IGZhbHNlLFxuICAgICAgICAgIGVycm9yOiBuZXcgRXJyb3IoXG4gICAgICAgICAgICBgUHJlLXNldHVwIGNvbW1hbmQgdGltZWQgb3V0IGFmdGVyICR7dGltZW91dFNlY29uZHN9IHNlY29uZHNgLFxuICAgICAgICAgICksXG4gICAgICAgIH07XG4gICAgICB9XG5cbiAgICAgIGlmICghb3V0cHV0LnN1Y2Nlc3MpIHtcbiAgICAgICAgY29uc3Qgc3RkZXJyID0gbmV3IFRleHREZWNvZGVyKCkuZGVjb2RlKG91dHB1dC5zdGRlcnIpLnRyaW0oKTtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBvazogZmFsc2UsXG4gICAgICAgICAgZXJyb3I6IG5ldyBFcnJvcihcbiAgICAgICAgICAgIGBQcmUtc2V0dXAgY29tbWFuZCBmYWlsZWQgd2l0aCBleGl0IGNvZGUgJHtvdXRwdXQuY29kZX06ICR7c3RkZXJyfWAsXG4gICAgICAgICAgKSxcbiAgICAgICAgfTtcbiAgICAgIH1cblxuICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiBcImNvbXBsZXRlZFwiIH07XG4gICAgfSBjYXRjaCAoZXJyb3I6IHVua25vd24pIHtcbiAgICAgIGNsZWFyVGltZW91dCh0aW1lb3V0SWQpO1xuXG4gICAgICBpZiAoXG4gICAgICAgIHRpbWVkT3V0IHx8XG4gICAgICAgIChlcnJvciBpbnN0YW5jZW9mIERPTUV4Y2VwdGlvbiAmJiBlcnJvci5uYW1lID09PSBcIkFib3J0RXJyb3JcIilcbiAgICAgICkge1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgICBlcnJvcjogbmV3IEVycm9yKFxuICAgICAgICAgICAgYFByZS1zZXR1cCBjb21tYW5kIHRpbWVkIG91dCBhZnRlciAke3RpbWVvdXRTZWNvbmRzfSBzZWNvbmRzYCxcbiAgICAgICAgICApLFxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgdGhyb3cgZXJyb3I7XG4gICAgfVxuICB9IGNhdGNoIChlcnJvcjogdW5rbm93bikge1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjogbmV3IEVycm9yKFxuICAgICAgICBgUHJlLXNldHVwIGNvbW1hbmQgZmFpbGVkOiAke1xuICAgICAgICAgIGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKVxuICAgICAgICB9YCxcbiAgICAgICksXG4gICAgfTtcbiAgfVxufVxuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gQ0kgbG9nIHByb3ZpZGVycyAoSXNzdWUgIzM1NzkpXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4vKipcbiAqIFBhcnNlIGFuZCB2YWxpZGF0ZSBhIHJhdyBgY2lQcm92aWRlcnNgIHZhbHVlIGxvYWRlZCBmcm9tIGAuY29uZmlnLmpzb25gXG4gKiBpbnRvIGEgdHlwZWQgYENpUHJvdmlkZXJDb25maWdbXWAgKElzc3VlICMzNTc5KS5cbiAqXG4gKiBSZXR1cm5zIGBSZXN1bHQub2tgIHdpdGggYW4gZW1wdHkgYXJyYXkgd2hlbiB0aGUgaW5wdXQgaXNcbiAqIGB1bmRlZmluZWRgL2BudWxsYCBzbyBjYWxsZXJzIGNhbiB0cmVhdCBcIm1pc3NpbmdcIiBhbmQgXCJlbXB0eVwiIHRoZSBzYW1lXG4gKiB3YXkuIEV2ZXJ5IHJlamVjdGlvbiBuYW1lcyB0aGUgb2ZmZW5kaW5nIGZpZWxkIHNvIGEgbWFsZm9ybWVkIGVudHJ5XG4gKiBmYWlscyBsb3VkbHkgcmF0aGVyIHRoYW4gYmVpbmcgc2lsZW50bHkgaWdub3JlZC5cbiAqXG4gKiBQcm92aWRlciBpZHMgYXJlIG5vdCBjaGVja2VkIGFnYWluc3QgdGhlIHJlZ2lzdHJ5IGhlcmUg4oCUIGV4dGVuc2lvbnNcbiAqIHJlZ2lzdGVyIGF0IHJ1bnRpbWUg4oCUIGJ1dCBhbiB1bmtub3duIGlkIGlzIHJlcG9ydGVkIGFzIGFuIGV4cGxpY2l0XG4gKiBkaXNwYXRjaGVyIGVycm9yLCBuZXZlciBhIHNpbGVudCBuby1vcC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlQ2lQcm92aWRlcnMoXG4gIHJhdzogdW5rbm93bixcbik6IFJlc3VsdDxDaVByb3ZpZGVyQ29uZmlnW10sIHN0cmluZz4ge1xuICBpZiAocmF3ID09PSB1bmRlZmluZWQgfHwgcmF3ID09PSBudWxsKSB7XG4gICAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiBbXSB9O1xuICB9XG4gIGlmICghQXJyYXkuaXNBcnJheShyYXcpKSB7XG4gICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogXCJjaVByb3ZpZGVycyBtdXN0IGJlIGFuIGFycmF5XCIgfTtcbiAgfVxuXG4gIGNvbnN0IHBhcnNlZDogQ2lQcm92aWRlckNvbmZpZ1tdID0gW107XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgcmF3Lmxlbmd0aDsgaSsrKSB7XG4gICAgY29uc3QgZW50cnkgPSByYXdbaV07XG4gICAgaWYgKGVudHJ5ID09PSBudWxsIHx8IHR5cGVvZiBlbnRyeSAhPT0gXCJvYmplY3RcIiB8fCBBcnJheS5pc0FycmF5KGVudHJ5KSkge1xuICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogYGNpUHJvdmlkZXJzWyR7aX1dIG11c3QgYmUgYW4gb2JqZWN0YCB9O1xuICAgIH1cbiAgICBjb25zdCBvYmogPSBlbnRyeSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcblxuICAgIGNvbnN0IHByb3ZpZGVyID0gb2JqLnByb3ZpZGVyO1xuICAgIGlmICh0eXBlb2YgcHJvdmlkZXIgIT09IFwic3RyaW5nXCIgfHwgcHJvdmlkZXIubGVuZ3RoID09PSAwKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBvazogZmFsc2UsXG4gICAgICAgIGVycm9yOiBgY2lQcm92aWRlcnNbJHtpfV0ucHJvdmlkZXIgbXVzdCBiZSBhIG5vbi1lbXB0eSBzdHJpbmdgLFxuICAgICAgfTtcbiAgICB9XG5cbiAgICBjb25zdCBjaGVja05hbWVQYXR0ZXJuID0gb2JqLmNoZWNrTmFtZVBhdHRlcm47XG4gICAgaWYgKGNoZWNrTmFtZVBhdHRlcm4gIT09IHVuZGVmaW5lZCkge1xuICAgICAgaWYgKHR5cGVvZiBjaGVja05hbWVQYXR0ZXJuICE9PSBcInN0cmluZ1wiKSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgb2s6IGZhbHNlLFxuICAgICAgICAgIGVycm9yOiBgY2lQcm92aWRlcnNbJHtpfV0uY2hlY2tOYW1lUGF0dGVybiBtdXN0IGJlIGEgc3RyaW5nYCxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IGNvbXBpbGVkID0gY29tcGlsZUNoZWNrTmFtZVBhdHRlcm4oY2hlY2tOYW1lUGF0dGVybiwgLy4qLyk7XG4gICAgICBpZiAoIWNvbXBpbGVkLm9rKSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgb2s6IGZhbHNlLFxuICAgICAgICAgIGVycm9yOiBgY2lQcm92aWRlcnNbJHtpfV0uJHtjb21waWxlZC5lcnJvcn1gLFxuICAgICAgICB9O1xuICAgICAgfVxuICAgIH1cblxuICAgIGNvbnN0IGpvYlBhdGggPSBvYmouam9iUGF0aDtcbiAgICBpZiAoam9iUGF0aCAhPT0gdW5kZWZpbmVkICYmIHR5cGVvZiBqb2JQYXRoICE9PSBcInN0cmluZ1wiKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBvazogZmFsc2UsXG4gICAgICAgIGVycm9yOiBgY2lQcm92aWRlcnNbJHtpfV0uam9iUGF0aCBtdXN0IGJlIGEgc3RyaW5nYCxcbiAgICAgIH07XG4gICAgfVxuICAgIC8vIFdoZXRoZXIgYSBgam9iUGF0aGAgaXMgcmVxdWlyZWQgaXMgdGhlIHByb3ZpZGVyJ3MgYnVzaW5lc3MsIG5vdFxuICAgIC8vIGNvcmUncyAoSXNzdWUgIzk4Nik6IGNvcmUgZG9lcyBub3Qga25vdyB3aGljaCBwcm92aWRlcnMgZXhpc3QsIHNvIGl0XG4gICAgLy8gY2Fubm90IGtub3cgd2hpY2ggb2YgdGhlbSBuZWVkIG9uZS4gQSBwcm92aWRlciB0aGF0IG5lZWRzIG9uZSByZXBvcnRzXG4gICAgLy8gaXRzIGFic2VuY2UgYXMgYW4gZXhwbGljaXQgZGlzcGF0Y2hlciBlcnJvci5cblxuICAgIHBhcnNlZC5wdXNoKHtcbiAgICAgIHByb3ZpZGVyLFxuICAgICAgLi4uKHR5cGVvZiBjaGVja05hbWVQYXR0ZXJuID09PSBcInN0cmluZ1wiID8geyBjaGVja05hbWVQYXR0ZXJuIH0gOiB7fSksXG4gICAgICAuLi4odHlwZW9mIGpvYlBhdGggPT09IFwic3RyaW5nXCIgPyB7IGpvYlBhdGggfSA6IHt9KSxcbiAgICB9KTtcbiAgfVxuXG4gIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogcGFyc2VkIH07XG59XG5cbi8qKlxuICogUmV0dXJuIHRoZSBDSSBsb2cgcHJvdmlkZXJzIGNvbmZpZ3VyZWQgZm9yIGEgcmVwb3NpdG9yeSAoSXNzdWUgIzM1NzkpLlxuICpcbiAqIE1hbGZvcm1lZCBjb25maWd1cmF0aW9uIGlzIHN1cmZhY2VkIGFzIGEgdGhyb3duIGVycm9yIHNvIHRoZSB3b3JrZXJcbiAqIGZhaWxzIGZhc3QgcmF0aGVyIHRoYW4gc2lsZW50bHkgZHJvcHBpbmcgYSBwcm92aWRlci5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGdldENpUHJvdmlkZXJzKFxuICByZXBvQ29uZmlnczogUmVjb3JkPHN0cmluZywgUmVwb0NvbmZpZz4gfCB1bmRlZmluZWQsXG4gIHJlcG86IHN0cmluZyxcbik6IENpUHJvdmlkZXJDb25maWdbXSB7XG4gIGlmICghcmVwb0NvbmZpZ3MpIHJldHVybiBbXTtcbiAgY29uc3QgY29uZmlnID0gcmVwb0NvbmZpZ3NbcmVwb107XG4gIGlmICghY29uZmlnKSByZXR1cm4gW107XG5cbiAgY29uc3QgcmF3ID0gKGNvbmZpZyBhcyB7IGNpUHJvdmlkZXJzPzogdW5rbm93biB9KS5jaVByb3ZpZGVycztcbiAgY29uc3QgcGFyc2VkID0gcGFyc2VDaVByb3ZpZGVycyhyYXcpO1xuICBpZiAoIXBhcnNlZC5vaykge1xuICAgIHRocm93IG5ldyBFcnJvcihgSW52YWxpZCBjaVByb3ZpZGVycyBmb3IgJHtyZXBvfTogJHtwYXJzZWQuZXJyb3J9YCk7XG4gIH1cblxuICByZXR1cm4gcGFyc2VkLnZhbHVlO1xufVxuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gUHJlLWZsaWdodCBnYXRlIGNvbW1hbmRzIChJc3N1ZSAjMzU3Nylcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbi8qKlxuICogUGFyc2UgYW5kIHZhbGlkYXRlIGEgcmF3IGBwcmVGbGlnaHRgIHZhbHVlIGxvYWRlZCBmcm9tIGAuY29uZmlnLmpzb25gXG4gKiBpbnRvIGEgdHlwZWQgYHN0cmluZ1tdYCAoSXNzdWUgIzM1NzcpLlxuICpcbiAqIEZvbGxvd3MgdGhlIGBwYXJzZVByRmFpbHVyZUFjdGlvbnMoKWAgcHJlY2VkZW50OiByZXR1cm5zIGBSZXN1bHQub2tgIHdpdGhcbiAqIGFuIGVtcHR5IGFycmF5IHdoZW4gdGhlIGlucHV0IGlzIGB1bmRlZmluZWRgL2BudWxsYCBzbyBjYWxsZXJzIGNhbiB0cmVhdFxuICogXCJtaXNzaW5nXCIgYW5kIFwiZW1wdHlcIiB0aGUgc2FtZSB3YXkgKG5vIGdhdGUpLiBSZXR1cm5zIGBSZXN1bHQuZXJyb3JgIHdpdGhcbiAqIGEgZGVzY3JpcHRpdmUgbWVzc2FnZSB3aGVuIHRoZSBpbnB1dCBpcyB0aGUgd3Jvbmcgc2hhcGUgb3IgY29udGFpbnMgYVxuICogbm9uLXN0cmluZyAvIGVtcHR5IC8gYmxhbmsgZW50cnksIHNvIGEgbWFsZm9ybWVkIGNvbmZpZ3VyYXRpb24gZmFpbHNcbiAqIGxvdWRseSByYXRoZXIgdGhhbiBzaWxlbnRseSBkaXNhYmxpbmcgdGhlIGdhdGUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZVByZUZsaWdodENvbW1hbmRzKFxuICByYXc6IHVua25vd24sXG4pOiBSZXN1bHQ8c3RyaW5nW10sIHN0cmluZz4ge1xuICBpZiAocmF3ID09PSB1bmRlZmluZWQgfHwgcmF3ID09PSBudWxsKSB7XG4gICAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiBbXSB9O1xuICB9XG4gIGlmICghQXJyYXkuaXNBcnJheShyYXcpKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBcInByZS1mbGlnaHQgbXVzdCBiZSBhbiBhcnJheSBvZiBjb21tYW5kIHN0cmluZ3NcIixcbiAgICB9O1xuICB9XG5cbiAgY29uc3QgcGFyc2VkOiBzdHJpbmdbXSA9IFtdO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IHJhdy5sZW5ndGg7IGkrKykge1xuICAgIGNvbnN0IGVudHJ5ID0gcmF3W2ldO1xuICAgIGlmICh0eXBlb2YgZW50cnkgIT09IFwic3RyaW5nXCIpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgZXJyb3I6IGBwcmUtZmxpZ2h0WyR7aX1dIG11c3QgYmUgYSBzdHJpbmdgLFxuICAgICAgfTtcbiAgICB9XG4gICAgaWYgKGVudHJ5LnRyaW0oKS5sZW5ndGggPT09IDApIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgZXJyb3I6IGBwcmUtZmxpZ2h0WyR7aX1dIG11c3QgYmUgYSBub24tZW1wdHkgY29tbWFuZCBzdHJpbmdgLFxuICAgICAgfTtcbiAgICB9XG4gICAgcGFyc2VkLnB1c2goZW50cnkpO1xuICB9XG5cbiAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiBwYXJzZWQgfTtcbn1cblxuLyoqXG4gKiBSZXR1cm4gdGhlIHBhcnNlZCBgcHJlRmxpZ2h0YCBjb21tYW5kcyBmb3IgYSByZXBvc2l0b3J5LCBvciBhbiBlbXB0eVxuICogYXJyYXkgd2hlbiB0aGUgcmVwbyBoYXMgbm8gY29uZmlndXJhdGlvbiBvciB0aGUgZmllbGQgaXMgdW5zZXRcbiAqIChJc3N1ZSAjMzU3NykuXG4gKlxuICogTWFsZm9ybWVkIGNvbmZpZ3VyYXRpb24gaXMgc3VyZmFjZWQgYXMgYSB0aHJvd24gZXJyb3Igc28gdGhlIHdvcmtlciBmYWlsc1xuICogZmFzdCByYXRoZXIgdGhhbiBzaWxlbnRseSBkcm9wcGluZyB0aGUgZ2F0ZS4gQ2FsbGVycyB0aGF0IHdhbnQgdG8gaGFuZGxlXG4gKiB0aGUgZXJyb3IgaW5saW5lIHNob3VsZCBjYWxsIGBwYXJzZVByZUZsaWdodENvbW1hbmRzKClgIGRpcmVjdGx5LlxuICovXG5leHBvcnQgZnVuY3Rpb24gZ2V0UHJlRmxpZ2h0Q29tbWFuZHMoXG4gIHJlcG9Db25maWdzOiBSZWNvcmQ8c3RyaW5nLCBSZXBvQ29uZmlnPiB8IHVuZGVmaW5lZCxcbiAgcmVwbzogc3RyaW5nLFxuKTogc3RyaW5nW10ge1xuICBpZiAoIXJlcG9Db25maWdzKSByZXR1cm4gW107XG4gIGNvbnN0IGNvbmZpZyA9IHJlcG9Db25maWdzW3JlcG9dO1xuICBpZiAoIWNvbmZpZykgcmV0dXJuIFtdO1xuICBjb25zdCByYXcgPSAoY29uZmlnIGFzIHsgcHJlRmxpZ2h0PzogdW5rbm93biB9KS5wcmVGbGlnaHQ7XG4gIGlmIChyYXcgPT09IHVuZGVmaW5lZCkgcmV0dXJuIFtdO1xuICBjb25zdCByZXN1bHQgPSBwYXJzZVByZUZsaWdodENvbW1hbmRzKHJhdyk7XG4gIGlmICghcmVzdWx0Lm9rKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYEludmFsaWQgcHJlLWZsaWdodCBmb3IgJHtyZXBvfTogJHtyZXN1bHQuZXJyb3J9YCxcbiAgICApO1xuICB9XG4gIHJldHVybiByZXN1bHQudmFsdWU7XG59XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBDSS1mYWlsdXJlIGlzc3VlIGxhYmVscyAoSXNzdWUgIzM1ODEpXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4vKipcbiAqIFBhcnNlIGFuZCB2YWxpZGF0ZSBhIHJhdyBgY2lGYWlsdXJlTGFiZWxzYCB2YWx1ZSBsb2FkZWQgZnJvbVxuICogYC5jb25maWcuanNvbmAgKElzc3VlICMzNTgxKS5cbiAqXG4gKiBGb2xsb3dzIHRoZSBgcGFyc2VQckZhaWx1cmVBY3Rpb25zKClgIHByZWNlZGVudDogYHVuZGVmaW5lZGAvYG51bGxgIHlpZWxkc1xuICogYW4gZW1wdHkgYXJyYXkgKGZlYXR1cmUgZGlzYWJsZWQpLCBhbmQgYSBtYWxmb3JtZWQgdmFsdWUgZmFpbHMgbG91ZGx5XG4gKiByYXRoZXIgdGhhbiBzaWxlbnRseSBkaXNhYmxpbmcgQ0ktZmFpbHVyZSBkZXRlY3Rpb24uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZUNpRmFpbHVyZUxhYmVscyhcbiAgcmF3OiB1bmtub3duLFxuKTogUmVzdWx0PHN0cmluZ1tdLCBzdHJpbmc+IHtcbiAgaWYgKHJhdyA9PT0gdW5kZWZpbmVkIHx8IHJhdyA9PT0gbnVsbCkge1xuICAgIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogW10gfTtcbiAgfVxuICBpZiAoIUFycmF5LmlzQXJyYXkocmF3KSkge1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjogXCJjaUZhaWx1cmVMYWJlbHMgbXVzdCBiZSBhbiBhcnJheSBvZiBsYWJlbCBuYW1lc1wiLFxuICAgIH07XG4gIH1cblxuICBjb25zdCBwYXJzZWQ6IHN0cmluZ1tdID0gW107XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgcmF3Lmxlbmd0aDsgaSsrKSB7XG4gICAgY29uc3QgZW50cnkgPSByYXdbaV07XG4gICAgaWYgKHR5cGVvZiBlbnRyeSAhPT0gXCJzdHJpbmdcIikge1xuICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogYGNpRmFpbHVyZUxhYmVsc1ske2l9XSBtdXN0IGJlIGEgc3RyaW5nYCB9O1xuICAgIH1cbiAgICBpZiAoZW50cnkudHJpbSgpLmxlbmd0aCA9PT0gMCkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgb2s6IGZhbHNlLFxuICAgICAgICBlcnJvcjogYGNpRmFpbHVyZUxhYmVsc1ske2l9XSBtdXN0IGJlIGEgbm9uLWVtcHR5IGxhYmVsIG5hbWVgLFxuICAgICAgfTtcbiAgICB9XG4gICAgcGFyc2VkLnB1c2goZW50cnkudHJpbSgpKTtcbiAgfVxuXG4gIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogcGFyc2VkIH07XG59XG5cbi8qKlxuICogUmV0dXJuIHRoZSBjb25maWd1cmVkIENJLWZhaWx1cmUgbGFiZWxzIGZvciBhIHJlcG9zaXRvcnksIG9yIGFuIGVtcHR5XG4gKiBhcnJheSB3aGVuIHRoZSByZXBvIGhhcyBubyBjb25maWd1cmF0aW9uIG9yIHRoZSBmaWVsZCBpcyB1bnNldFxuICogKElzc3VlICMzNTgxKS5cbiAqXG4gKiBNYWxmb3JtZWQgY29uZmlndXJhdGlvbiBpcyBzdXJmYWNlZCBhcyBhIHRocm93biBlcnJvciBzbyB0aGUgd29ya2VyIGZhaWxzXG4gKiBmYXN0IHJhdGhlciB0aGFuIHNpbGVudGx5IHNraXBwaW5nIHRoZSBsb2cgZmV0Y2guXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBnZXRDaUZhaWx1cmVMYWJlbHMoXG4gIHJlcG9Db25maWdzOiBSZWNvcmQ8c3RyaW5nLCBSZXBvQ29uZmlnPiB8IHVuZGVmaW5lZCxcbiAgcmVwbzogc3RyaW5nLFxuKTogc3RyaW5nW10ge1xuICBpZiAoIXJlcG9Db25maWdzKSByZXR1cm4gW107XG4gIGNvbnN0IGNvbmZpZyA9IHJlcG9Db25maWdzW3JlcG9dO1xuICBpZiAoIWNvbmZpZykgcmV0dXJuIFtdO1xuICBjb25zdCByYXcgPSAoY29uZmlnIGFzIHsgY2lGYWlsdXJlTGFiZWxzPzogdW5rbm93biB9KS5jaUZhaWx1cmVMYWJlbHM7XG4gIGlmIChyYXcgPT09IHVuZGVmaW5lZCkgcmV0dXJuIFtdO1xuICBjb25zdCByZXN1bHQgPSBwYXJzZUNpRmFpbHVyZUxhYmVscyhyYXcpO1xuICBpZiAoIXJlc3VsdC5vaykge1xuICAgIHRocm93IG5ldyBFcnJvcihgSW52YWxpZCBjaUZhaWx1cmVMYWJlbHMgZm9yICR7cmVwb306ICR7cmVzdWx0LmVycm9yfWApO1xuICB9XG4gIHJldHVybiByZXN1bHQudmFsdWU7XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7OztDQVNDLEdBR0QsU0FBUyxpQkFBaUIsUUFBUSx1QkFBdUI7QUFDekQsU0FBUyx1QkFBdUIsUUFBUSx1QkFBdUI7QUFDL0QsU0FDRSwyQkFBMkIsUUFFdEIsMkJBQTJCO0FBQ2xDLFNBQVMsd0JBQXdCLFFBQVEsNkJBQTZCO0FBRXRFLGdGQUFnRjtBQUNoRiwwQkFBMEI7QUFDMUIsZ0ZBQWdGO0FBRWhGOzs7Ozs7Ozs7OztDQVdDLEdBQ0QsT0FBTyxTQUFTLGNBQ2QsV0FBbUQsRUFDbkQsSUFBWSxFQUNaLEdBQXFCO0VBRXJCLElBQUksQ0FBQyxhQUFhLE9BQU87RUFDekIsTUFBTSxTQUFTLFdBQVcsQ0FBQyxLQUFLO0VBQ2hDLElBQUksQ0FBQyxRQUFRLE9BQU87RUFDcEIsTUFBTSxRQUFRLE1BQU0sQ0FBQyxJQUFJO0VBQ3pCLElBQUksVUFBVSxhQUFhLFVBQVUsTUFBTSxPQUFPO0VBQ2xELE9BQU8sT0FBTztBQUNoQjtBQUVBOzs7Ozs7Q0FNQyxHQUNELE9BQU8sU0FBUyxzQkFDZCxXQUFtRCxFQUNuRCxJQUFZO0VBRVosT0FBTyxjQUFjLGFBQWEsTUFBTTtBQUMxQztBQUVBOzs7Ozs7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
// denoCacheMetadata=12777249467734320350,14782701070156435741