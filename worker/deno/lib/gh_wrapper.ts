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
import { spawnGh } from "./gh_spawn.ts";

/** Default timeout for gh commands (seconds). */
const DEFAULT_GH_COMMAND_TIMEOUT = 60;

/** Default timeout for clone operations (seconds). */
const DEFAULT_GH_CLONE_TIMEOUT = 600;

/** Default cooldown for rate limit circuit breaker (seconds). */
const DEFAULT_RATE_LIMIT_COOLDOWN = 300;

/** Exit code for rate limiting (matches retry.sh RATE_LIMIT_EXIT_CODE). */
export const RATE_LIMIT_EXIT_CODE = 223;

/** Exit code indicating a timeout. */
export const TIMEOUT_EXIT_CODE = 124;

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

/**
 * Get the path to the rate limit circuit breaker flag file.
 */
function getRateLimitFlagPath(config: GhWrapperConfig): string {
  const dir = config.rateLimitFlagDir ??
    Deno.env.get("WORK_DIR") ??
    Deno.env.get("TMPDIR") ??
    "/tmp";
  return `${dir}/.gh_rate_limit_active`;
}

/**
 * Check if the rate limit circuit breaker is currently active.
 *
 * The breaker is active when a flag file exists containing a timestamp
 * that is within the cooldown window.
 *
 * @param config - Wrapper configuration
 * @returns true if the circuit breaker is active (should short-circuit)
 */
export async function isRateLimitActive(
  config: GhWrapperConfig,
): Promise<boolean> {
  const flagPath = getRateLimitFlagPath(config);
  const cooldown = config.rateLimitCooldown ?? DEFAULT_RATE_LIMIT_COOLDOWN;

  try {
    const content = await Deno.readTextFile(flagPath);
    const trippedAt = parseInt(content.trim(), 10);

    if (isNaN(trippedAt)) return false;

    const now = Math.floor(Date.now() / 1000);
    const elapsed = now - trippedAt;

    if (elapsed >= cooldown) {
      // Cooldown expired — auto-reset
      try {
        await Deno.remove(flagPath);
      } catch {
        // Ignore removal errors
      }
      return false;
    }

    return true;
  } catch {
    // File does not exist or cannot be read — breaker is not active
    return false;
  }
}

/**
 * Trip the rate limit circuit breaker.
 *
 * Records the current timestamp in the flag file.
 *
 * @param config - Wrapper configuration
 * @returns true if this was a fresh activation (not already active)
 */
export async function tripRateLimitBreaker(
  config: GhWrapperConfig,
): Promise<boolean> {
  const flagPath = getRateLimitFlagPath(config);
  let freshActivation = true;

  try {
    await Deno.stat(flagPath);
    freshActivation = false;
  } catch {
    // File does not exist — this is a fresh activation
  }

  const now = Math.floor(Date.now() / 1000);
  await Deno.writeTextFile(flagPath, String(now));

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

    // Trip the circuit breaker on rate limit detection
    if (rateLimited) {
      await tripRateLimitBreaker(config);
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
