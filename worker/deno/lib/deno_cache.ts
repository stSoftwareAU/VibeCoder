/**
 * Deno cache cleanup utility for self-healing on low-disk machines.
 *
 * Wraps `deno clean` (https://docs.deno.com/runtime/reference/cli/clean/)
 * which removes the Deno download cache (DENO_DIR). The cache is
 * automatically re-populated on next use, so cleaning it is a safe
 * recovery action when disk space is constrained.
 *
 * Issue #1489: Clean Deno cache when low on disk space.
 */

import { recordFaultEvent } from "./fault_tolerance_counters.ts";
import { runWithTimeout } from "./subprocess_timeout.ts";

/** Default timeout for `deno clean`: 60 seconds (large caches can take time). */
export const DEFAULT_DENO_CLEAN_TIMEOUT_MS = 60_000;

/** Result of a Deno cache cleanup attempt. */
export interface DenoCacheCleanResult {
  /** Whether `deno clean` exited successfully. */
  success: boolean;
  /** Whether the command was terminated by the timeout. */
  timedOut: boolean;
  /** Human-readable summary message. */
  message: string;
}

/** Options for {@link cleanDenoCache}. */
export interface DenoCacheCleanOptions {
  /** Pass `--dry-run` to `deno clean` (used for tests and audits). */
  dryRun?: boolean;
  /** Timeout in milliseconds. Defaults to {@link DEFAULT_DENO_CLEAN_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Override the executable name. Defaults to `"deno"`. Used by tests. */
  executable?: string;
}

/**
 * Run `deno clean` to remove the Deno download cache (DENO_DIR).
 *
 * Best-effort: failures are reported via the returned result and a
 * fault-tolerance event, but never thrown. The cache is re-populated
 * automatically on next use.
 */
export async function cleanDenoCache(
  options: DenoCacheCleanOptions = {},
): Promise<DenoCacheCleanResult> {
  const {
    dryRun = false,
    timeoutMs = DEFAULT_DENO_CLEAN_TIMEOUT_MS,
    executable = "deno",
  } = options;

  const args = ["clean", "--quiet"];
  if (dryRun) args.push("--dry-run");

  const result = await runWithTimeout(executable, args, {
    timeoutMs,
    quiet: true,
  });

  if (!result.ok) {
    recordFaultEvent(
      "disk_space_cleanup",
      `deno clean failed to start: ${result.error.message}`,
    );
    return {
      success: false,
      timedOut: false,
      message: `deno clean failed to start: ${result.error.message}`,
    };
  }

  if (result.value.timedOut) {
    return {
      success: false,
      timedOut: true,
      message: `deno clean timed out after ${timeoutMs} ms`,
    };
  }

  if (!result.value.success) {
    // Include stderr so operators can diagnose the failure — Issue #1979.
    const stderrSuffix = result.value.stderr ? `: ${result.value.stderr}` : "";
    recordFaultEvent(
      "disk_space_cleanup",
      `deno clean exited ${result.value.code}${stderrSuffix}`,
    );
    return {
      success: false,
      timedOut: false,
      message:
        `deno clean exited with code ${result.value.code}${stderrSuffix}`,
    };
  }

  const verb = dryRun ? "would clean" : "cleaned";
  return {
    success: true,
    timedOut: false,
    message: `deno clean succeeded (${verb} Deno cache)`,
  };
}
