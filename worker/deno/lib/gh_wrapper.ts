/**
 * GitHub CLI wrapper with timeout protection and rate limit circuit breaker.
 *
 * Provides a safe wrapper for `gh` CLI commands that:
 * - Applies configurable timeouts to prevent indefinite hangs (Issue #619)
 * - Implements a rate limit circuit breaker to short-circuit API calls (Issue #650)
 *
 * Migrated from worker/shared/gh_wrapper.sh (Issue #905).
 * Uses Australian English spelling throughout (behaviour, colour, organisation, etc.)
 */

import type { Result } from "../types.ts";
import { atomicWrite, readTextFileNoFollow } from "./file_utils.ts";
import { spawnGh } from "./gh_spawn.ts";
import {
  DEFAULT_GH_CLONE_TIMEOUT,
  DEFAULT_GH_COMMAND_TIMEOUT,
  GH_TIMEOUT_EXIT_CODE,
} from "./gh_timeout.ts";
import { defaultLogger } from "./logger.ts";
import {
  ensurePrivateDir,
  isSharedTmpPath,
  sharedTmpStateDir,
} from "./private_cache_dir.ts";

/** Default cooldown for rate limit circuit breaker (seconds). */
const DEFAULT_RATE_LIMIT_COOLDOWN = 300;

/** Exit code for rate limiting (matches retry.sh RATE_LIMIT_EXIT_CODE). */
export const RATE_LIMIT_EXIT_CODE = 223;

/** Exit code indicating a timeout. Shared with the `gh` chokepoint. */
export const TIMEOUT_EXIT_CODE = GH_TIMEOUT_EXIT_CODE;

/**
 * Configuration for the GH wrapper.
 */
export interface GhWrapperConfig {
  /** Timeout in seconds for gh commands (default: 60). */
  ghCommandTimeout?: number;
  /** Timeout in seconds for clone operations (default: 600). */
  ghCloneTimeout?: number;
  /** Cooldown in seconds before auto-resetting the circuit breaker (default: 300). */
  rateLimitCooldown?: number;
  /** Directory for the circuit breaker flag file. */
  rateLimitFlagDir?: string;
}

/**
 * Result of a gh CLI command execution.
 */
export interface GhCommandResult {
  /** The stdout output from the gh command. */
  stdout: string;
  /** The stderr output from the gh command. */
  stderr: string;
  /** The exit code. */
  exitCode: number;
  /** Whether the command timed out. */
  timedOut: boolean;
  /** Whether the command was rate limited. */
  rateLimited: boolean;
  /** Whether the command was short-circuited by the circuit breaker. */
  circuitBroken: boolean;
}

/** Name of the circuit breaker flag file inside its directory. */
const RATE_LIMIT_FLAG_NAME = ".gh_rate_limit_active";

/** Owner-only permissions for the flag file. */
const RATE_LIMIT_FLAG_MODE = 0o600;

/** Read an environment variable, tolerating a missing `--allow-env` grant. */
function envOrUndefined(key: string): string | undefined {
  try {
    return Deno.env.get(key) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Default directory for the circuit breaker flag file.
 *
 * `WORK_DIR` is the worker's own volume and is used as given. Without it the
 * flag lands under the host's shared temporary root, where
 * `${TMPDIR}/.gh_rate_limit_active` was the same path for every account on
 * the host — so {@link sharedTmpStateDir} composes a per-account directory
 * instead (Issue #1233, following Issue #1215).
 *
 * @param lookup - Environment reader, injectable for tests.
 */
export function defaultRateLimitFlagDir(
  lookup: (key: string) => string | undefined = envOrUndefined,
): string {
  return lookup("WORK_DIR") ?? sharedTmpStateDir("vibe-gh-rate-limit", lookup);
}

/** Directory holding the circuit breaker flag file. */
function getRateLimitFlagDir(config: GhWrapperConfig): string {
  return config.rateLimitFlagDir ?? defaultRateLimitFlagDir();
}

/**
 * Get the path to the rate limit circuit breaker flag file.
 */
function getRateLimitFlagPath(config: GhWrapperConfig): string {
  return `${getRateLimitFlagDir(config)}/${RATE_LIMIT_FLAG_NAME}`;
}

/**
 * Check if the rate limit circuit breaker is currently active.
 *
 * The breaker is active when a flag file exists containing a timestamp
 * that is within the cooldown window.
 *
 * Issue #1233: the timestamp is state on disk, so it is bounded on both
 * sides. A timestamp in the **future** — a clock jump, or a value planted by
 * anything that can write in the flag directory — gives a negative `elapsed`
 * that is always below the cooldown, which would wedge every `gh` call behind
 * exit 223 indefinitely. It is treated as expired, exactly as an old
 * timestamp is. The read refuses to follow a link at the flag path, so a
 * symlink planted there cannot supply the timestamp either.
 *
 * @param config - Wrapper configuration
 * @returns true if the circuit breaker is active (should short-circuit)
 */
export async function isRateLimitActive(
  config: GhWrapperConfig,
): Promise<boolean> {
  const flagPath = getRateLimitFlagPath(config);
  const cooldown = config.rateLimitCooldown ?? DEFAULT_RATE_LIMIT_COOLDOWN;

  const read = await readTextFileNoFollow(flagPath);
  if (!read.ok) {
    // A link or other non-regular file sits at the flag path: never a live
    // activation this worker wrote. Surface it rather than swallowing it,
    // and leave the breaker open.
    defaultLogger.warn(
      "Rate limit flag file is not a regular file — breaker treated as " +
        "inactive (Issue #1233)",
      { flagPath, reason: read.error.message },
    );
    return false;
  }
  if (read.value === null) return false;

  const trippedAt = parseInt(read.value.trim(), 10);
  if (isNaN(trippedAt)) return false;

  const now = Math.floor(Date.now() / 1000);
  const elapsed = now - trippedAt;

  if (elapsed < 0 || elapsed >= cooldown) {
    // Cooldown expired, or the timestamp is in the future — auto-reset.
    try {
      await Deno.remove(flagPath);
    } catch {
      // Ignore removal errors
    }
    return false;
  }

  return true;
}

/**
 * Trip the rate limit circuit breaker.
 *
 * Records the current timestamp in the flag file.
 *
 * Issue #1233: the write goes through {@link atomicWrite} — an `O_EXCL` temp
 * file created `0600` and renamed over the target — so a symlink planted at
 * the flag path is replaced rather than followed and truncated. The
 * `lstat`-then-write remains a TOCTOU, but its only consequence is the
 * `freshActivation` boolean.
 *
 * @param config - Wrapper configuration
 * @returns true if this was a fresh activation (not already active)
 * @throws Error if the flag file cannot be written — an unrecorded trip
 *   leaves the breaker open, so it must never pass silently.
 */
export async function tripRateLimitBreaker(
  config: GhWrapperConfig,
): Promise<boolean> {
  const dir = getRateLimitFlagDir(config);
  const flagPath = `${dir}/${RATE_LIMIT_FLAG_NAME}`;
  let freshActivation = true;

  try {
    // lstat, not stat: a dangling symlink at the path still counts as an
    // existing entry rather than a fresh activation.
    await Deno.lstat(flagPath);
    freshActivation = false;
  } catch {
    // File does not exist — this is a fresh activation
  }

  // A directory under the shared temporary root is created owner-only so no
  // other account on the host can plant the flag (Issue #1215).
  if (isSharedTmpPath(dir)) {
    await ensurePrivateDir(dir);
  }

  const now = Math.floor(Date.now() / 1000);
  const written = await atomicWrite({
    targetFile: flagPath,
    content: String(now),
    mode: RATE_LIMIT_FLAG_MODE,
  });
  if (!written.ok) {
    throw new Error(
      `Failed to record the gh rate limit circuit breaker at ${flagPath}: ${written.error.message}`,
    );
  }

  return freshActivation;
}

/**
 * Reset the rate limit circuit breaker.
 *
 * Removes the flag file, allowing fresh API calls.
 *
 * @param config - Wrapper configuration
 */
export async function resetRateLimitBreaker(
  config: GhWrapperConfig,
): Promise<void> {
  const flagPath = getRateLimitFlagPath(config);
  try {
    await Deno.remove(flagPath);
  } catch {
    // Ignore if file does not exist
  }
}

/**
 * Check if an exit code indicates a timeout.
 *
 * @param exitCode - The exit code to check
 * @returns true if the exit code indicates a timeout
 */
export function isGhTimeout(exitCode: number): boolean {
  return exitCode === TIMEOUT_EXIT_CODE;
}

/**
 * Execute a gh CLI command with timeout protection and rate limit
 * circuit breaker.
 *
 * First checks the rate limit circuit breaker. If active, returns
 * immediately with exit code 223. Otherwise, wraps the gh CLI
 * invocation with AbortSignal.timeout() to prevent indefinite hangs.
 * If the command returns exit code 223 (rate limit), the circuit
 * breaker is tripped.
 *
 * @param args - The gh subcommand and arguments
 * @param config - Wrapper configuration
 * @param runCommand - Optional command runner override for testing
 * @returns Result with command execution details
 */
export async function safeGhCommand(
  args: string[],
  config: GhWrapperConfig = {},
  runCommand?: (
    ghArgs: string[],
    timeoutMs: number,
  ) => Promise<{ code: number; stdout: string; stderr: string }>,
): Promise<Result<GhCommandResult>> {
  // Check rate limit circuit breaker before making the API call
  if (await isRateLimitActive(config)) {
    return {
      ok: true,
      value: {
        stdout: "",
        stderr: "",
        exitCode: RATE_LIMIT_EXIT_CODE,
        timedOut: false,
        rateLimited: true,
        circuitBroken: true,
      },
    };
  }

  // Determine timeout based on command type
  let timeoutSeconds = config.ghCommandTimeout ?? DEFAULT_GH_COMMAND_TIMEOUT;
  if (args[0] === "repo" && args[1] === "clone") {
    timeoutSeconds = config.ghCloneTimeout ?? DEFAULT_GH_CLONE_TIMEOUT;
  }
  const timeoutMs = timeoutSeconds * 1000;

  const runner = runCommand ?? defaultRunGhCommand;

  try {
    const { code, stdout, stderr } = await runner(args, timeoutMs);

    const timedOut = code === TIMEOUT_EXIT_CODE;
    const rateLimited = code === RATE_LIMIT_EXIT_CODE;

    // Trip the circuit breaker on rate limit detection. A flag file that
    // cannot be written is reported, never swallowed: the next call would
    // otherwise sail past a breaker that silently never tripped.
    if (rateLimited) {
      try {
        await tripRateLimitBreaker(config);
      } catch (err) {
        return {
          ok: false,
          error: new Error(
            `gh reported a rate limit but the circuit breaker could not be recorded: ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
        };
      }
    }

    return {
      ok: true,
      value: {
        stdout,
        stderr,
        exitCode: code,
        timedOut,
        rateLimited,
        circuitBroken: false,
      },
    };
  } catch (error: unknown) {
    // AbortError from timeout
    if (error instanceof DOMException && error.name === "AbortError") {
      return {
        ok: true,
        value: {
          stdout: "",
          stderr: `TIMEOUT: gh ${
            args.join(" ")
          } timed out after ${timeoutSeconds}s`,
          exitCode: TIMEOUT_EXIT_CODE,
          timedOut: true,
          rateLimited: false,
          circuitBroken: false,
        },
      };
    }

    const msg = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: new Error(`Failed to execute gh command: ${msg}`),
    };
  }
}

/**
 * Default implementation that runs `gh` with a timeout.
 *
 * Issue #3703: spawns via the shared chokepoint (`gh_spawn.ts`), which
 * enforces the write-repo allowlist, injects the GitHub App token
 * (Issue #959) and journals the mutation. The abort signal still surfaces as
 * an `AbortError` for {@link safeGhCommand} to convert into exit code 124.
 */
async function defaultRunGhCommand(
  args: string[],
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const { code, stdout, stderr } = await spawnGh(args, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { code, stdout, stderr };
}
