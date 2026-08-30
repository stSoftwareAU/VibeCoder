/**
 * Git operation timeout management (Issue #619, #912).
 *
 * Wraps git commands with AbortController-based timeout protection to prevent
 * indefinite hangs when a git operation stalls (network issues, SSH prompts,
 * remote unresponsive).
 *
 * Migrated from worker/shared/git_timeout.sh.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import {
  ensureUsableGhConfigDir,
  gitGlobalConfigEntries,
  isGitAuthMissingFailure,
  mountedGitLogin,
} from "./gh_credential_stage.ts";
import { incrementCounter } from "./fault_tolerance_counters.ts";
import { auditGitMutation } from "./audit_hook.ts";

/** Default timeout in seconds for standard git operations. */
const DEFAULT_GIT_COMMAND_TIMEOUT = 60;

/** Default timeout in seconds for merge/rebase/pull operations. */
const DEFAULT_GIT_MERGE_TIMEOUT = 120;

/** Exit code returned when a git operation times out. */
import { noteGitOutputForVolumeFault } from "./work_volume_fault.ts";

export const TIMEOUT_EXIT_CODE = 124;

/** Result of running a git command. */
export interface GitCommandOutput {
  /** Exit code from the git process. */
  code: number;
  /** Standard output text. */
  stdout: string;
  /** Standard error text. */
  stderr: string;
}

/** Options for running a git command. */
export interface GitCommandOptions {
  /** Working directory for the git command. */
  cwd?: string;
  /** Override the default timeout in seconds. */
  timeoutSeconds?: number;
  /** Environment variables to pass to the git process. */
  env?: Record<string, string>;
}

/**
 * Determine the appropriate timeout for a git subcommand.
 *
 * Merge and rebase operations get a longer timeout because they involve more
 * computation. All other operations use the default command timeout.
 *
 * @param gitSubcommand - The first argument to git (e.g., fetch, push, merge)
 * @returns Timeout duration in seconds
 */
export function getTimeoutForOperation(gitSubcommand: string): number {
  const gitCommandTimeout = Number(
    Deno.env.get("GIT_COMMAND_TIMEOUT") ?? DEFAULT_GIT_COMMAND_TIMEOUT,
  );
  const gitMergeTimeout = Number(
    Deno.env.get("GIT_MERGE_TIMEOUT") ?? DEFAULT_GIT_MERGE_TIMEOUT,
  );

  switch (gitSubcommand) {
    case "merge":
    case "rebase":
    case "pull":
      return gitMergeTimeout;
    default:
      return gitCommandTimeout;
  }
}

/**
 * Check if an exit code indicates a timeout.
 *
 * @param exitCode - The exit code to check
 * @returns True if the exit code indicates a timeout
 */
export function isGitTimeout(exitCode: number): boolean {
  return exitCode === TIMEOUT_EXIT_CODE;
}

/**
 * Run a git command with timeout protection using AbortController.
 *
 * @param args - Arguments to pass to git (e.g., ["fetch", "origin"])
 * @param options - Options for the command execution
 * @returns Result containing the command output or an error
 */
/**
 * Git-auth repairs this process will perform (Issue #564).
 *
 * Bounded for the same reason as the `gh` re-stage: a credential that keeps
 * vanishing is a fault to report, and a genuinely revoked one must fail
 * rather than be rebuilt on every call for the rest of the run.
 */
export const MAX_GIT_AUTH_REPAIRS = 3;

let gitAuthRepairs = 0;

/** Reset the git-auth repair budget. Tests only. */
export function resetGitAuthRepairs(): void {
  gitAuthRepairs = 0;
}

/**
 * Rebuild the credential helper, HTTPS transport and identity from the mount.
 *
 * Writes through `git config --global`, so it lands wherever
 * `GIT_CONFIG_GLOBAL` points — the staged copy the container owns.
 *
 * @returns True when something was written and a retry is worth making.
 */
async function repairGitAuthEnvironment(): Promise<boolean> {
  // The helper shells out to `gh`, so its configuration has to be sound too.
  ensureUsableGhConfigDir();

  const home = Deno.env.get("HOME") ?? "";
  const login = mountedGitLogin(home);
  let wrote = false;
  for (const entry of gitGlobalConfigEntries(login)) {
    try {
      const command = new Deno.Command("git", {
        args: ["config", ...entry.args],
        stdout: "null",
        stderr: "null",
      });
      const result = await command.output();
      if (result.code === 0) wrote = true;
    } catch {
      // Best-effort: the caller's own failure stays the loud one.
    }
  }
  if (wrote) {
    console.error(
      "[SECURITY] git lost its credential helper or identity — rebuilt from " +
        "the read-only credential mount (Issue #564)",
    );
  }
  return wrote;
}

export async function runGitCommand(
  args: string[],
  options: GitCommandOptions = {},
): Promise<Result<GitCommandOutput>> {
  const gitSubcommand = args[0] ?? "";
  const timeoutSeconds = options.timeoutSeconds ??
    getTimeoutForOperation(gitSubcommand);
  const timeoutMs = timeoutSeconds * 1000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const command = new Deno.Command("git", {
      args,
      cwd: options.cwd,
      env: options.env,
      stdout: "piped",
      stderr: "piped",
      signal: controller.signal,
    });

    const process = await command.output();
    clearTimeout(timer);

    const stdout = new TextDecoder().decode(process.stdout);
    const stderr = new TextDecoder().decode(process.stderr);

    // Issue #229: a filesystem-level failure in git's output is a host
    // fault, not this call's — record it once so the claim guards stop new
    // work on the broken volume.
    if (process.code !== 0) {
      noteGitOutputForVolumeFault(args, stderr, stdout);
    }

    // Issue #564: git lost its credential helper and identity mid-run while
    // `gh` still worked — the staged global config had been reduced to its
    // `safe.directory` line. Rebuild both from the read-only mount and retry
    // once. A call that failed for want of credentials did nothing, so the
    // retry is safe, and every git caller inherits the recovery.
    if (
      isGitAuthMissingFailure({ code: process.code, stderr }) &&
      gitAuthRepairs < MAX_GIT_AUTH_REPAIRS
    ) {
      gitAuthRepairs++;
      if (await repairGitAuthEnvironment()) {
        const retry = await runGitCommand(args, options);
        if (retry.ok) {
          await auditGitMutation(args, retry.value.code);
          return retry;
        }
      }
    }

    // Issue #2380: journal `git push` mutations to the audit log.
    // Best-effort — never lets journalling alter or abort the git call.
    await auditGitMutation(args, process.code);

    return {
      ok: true,
      value: { code: process.code, stdout, stderr },
    };
  } catch (error: unknown) {
    clearTimeout(timer);

    if (error instanceof DOMException && error.name === "AbortError") {
      incrementCounter("timeouts");
      return {
        ok: true,
        value: {
          code: TIMEOUT_EXIT_CODE,
          stdout: "",
          stderr: `TIMEOUT: git ${
            args.join(" ")
          } timed out after ${timeoutSeconds}s (Issue #619)`,
        },
      };
    }

    return {
      ok: false,
      error: new Error(
        `Failed to execute git ${args.join(" ")}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    };
  }
}

/**
 * Run a git command and return success/failure based on exit code.
 *
 * Convenience wrapper around runGitCommand that checks the exit code.
 *
 * @param args - Arguments to pass to git
 * @param options - Options for the command execution
 * @returns Result with stdout on success, error message on failure
 */
export async function runGitCommandChecked(
  args: string[],
  options: GitCommandOptions = {},
): Promise<Result<string>> {
  const result = await runGitCommand(args, options);

  if (!result.ok) {
    return result;
  }

  const { code, stdout, stderr } = result.value;

  if (code !== 0) {
    if (isGitTimeout(code)) {
      return {
        ok: false,
        error: new Error(
          `TIMEOUT: git ${args.join(" ")} timed out (Issue #619)`,
        ),
      };
    }
    return {
      ok: false,
      error: new Error(
        `git ${args.join(" ")} failed (exit code ${code}): ${
          stderr.trim() || stdout.trim()
        }`,
      ),
    };
  }

  return { ok: true, value: stdout };
}
