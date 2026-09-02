/**
 * Subprocess timeout utility for wrapping Deno.Command calls with
 * AbortController-based timeout protection (Issue #1168).
 *
 * Prevents indefinite hangs when subprocess calls (gh, git, df, etc.)
 * stall due to network issues, NFS mounts, or unresponsive services.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { recordFaultEvent } from "./fault_tolerance_counters.ts";

/** Default timeout for subprocess calls: 30 seconds. */
export const DEFAULT_SUBPROCESS_TIMEOUT_MS = 30_000;

/** Extended timeout for network-heavy operations: 60 seconds. */
export const EXTENDED_SUBPROCESS_TIMEOUT_MS = 60_000;

/** Result of a subprocess execution. */
export interface SubprocessResult {
  /** Whether the command completed successfully (exit code 0). */
  success: boolean;
  /** The raw exit code. */
  code: number;
  /** Decoded stdout content. */
  stdout: string;
  /** Decoded stderr content. */
  stderr: string;
  /** Whether the command was terminated due to timeout. */
  timedOut: boolean;
}

/**
 * Run a subprocess with timeout protection.
 *
 * Wraps Deno.Command with an AbortController that fires after the
 * specified timeout. If the process exceeds the timeout, it is
 * killed and the result indicates a timeout occurred.
 *
 * @param executable - The command to run (e.g., "gh", "git", "df").
 * @param args - Command-line arguments.
 * @param options - Optional settings: cwd, timeout, quiet mode, environment.
 *   `quiet` suppresses stdout only — stderr is always piped and captured so
 *   failure diagnostics survive (Issue #1979). `clearEnv` starts the child
 *   from an empty environment so only `env` reaches it — the callback
 *   contract's credential boundary (Issue #806).
 * @returns Result containing the subprocess output or an error.
 */
export async function runWithTimeout(
  executable: string,
  args: string[],
  options?: {
    cwd?: string;
    timeoutMs?: number;
    quiet?: boolean;
    /** Environment entries to set on the child. */
    env?: Record<string, string>;
    /** Start from an empty environment rather than inheriting the worker's. */
    clearEnv?: boolean;
  },
): Promise<Result<SubprocessResult>> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_SUBPROCESS_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let aborted = false;
  // Placeholder updated once the child process is spawned.
  let onAbort: () => void = () => {
    aborted = true;
  };

  try {
    // Use spawn() so we hold the ChildProcess handle and can kill it
    // explicitly on timeout. The `signal` option alone does not reliably
    // terminate a running process on all platforms.
    const command = new Deno.Command(executable, {
      args,
      cwd: options?.cwd,
      ...(options?.env ? { env: options.env } : {}),
      ...(options?.clearEnv ? { clearEnv: true } : {}),
      stdin: "null",
      stdout: options?.quiet ? "null" : "piped",
      // stderr is always piped + captured. Muting stderr at the OS
      // level discards exit-trap diagnostics from helper scripts
      // (e.g. private-repo-6's repos.sh), producing empty-tail "Command
      // failed with code 1: " messages that defeat operator
      // troubleshooting (Issue #1979).
      stderr: "piped",
    });

    const child = command.spawn();
    onAbort = () => {
      aborted = true;
      try {
        child.kill("SIGTERM");
      } catch { /* already exited */ }
    };
    controller.signal.addEventListener("abort", onAbort);

    const output = await child.output();
    clearTimeout(timer);

    if (aborted) {
      const cmdStr = `${executable} ${args.join(" ")}`;
      recordFaultEvent(
        "timeout",
        `Subprocess timed out after ${timeoutMs}ms: ${cmdStr}`,
      );
      return {
        ok: true,
        value: {
          success: false,
          code: 124,
          stdout: "",
          stderr: `Timed out after ${timeoutMs}ms`,
          timedOut: true,
        },
      };
    }

    return {
      ok: true,
      value: {
        success: output.success,
        code: output.code,
        stdout: options?.quiet
          ? ""
          : (output.stdout
            ? new TextDecoder().decode(output.stdout).trim()
            : ""),
        // stderr is always returned regardless of quiet — see comment above.
        stderr: output.stderr
          ? new TextDecoder().decode(output.stderr).trim()
          : "",
        timedOut: false,
      },
    };
  } catch (error: unknown) {
    clearTimeout(timer);

    if (
      aborted ||
      (error instanceof DOMException && error.name === "AbortError")
    ) {
      const cmdStr = `${executable} ${args.join(" ")}`;
      recordFaultEvent(
        "timeout",
        `Subprocess timed out after ${timeoutMs}ms: ${cmdStr}`,
      );
      return {
        ok: true,
        value: {
          success: false,
          code: 124,
          stdout: "",
          stderr: `Timed out after ${timeoutMs}ms`,
          timedOut: true,
        },
      };
    }

    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  } finally {
    controller.signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Run a fetch request with timeout protection.
 *
 * Wraps a fetch call with an AbortController that fires after the
 * specified timeout. Useful for API calls that may hang.
 *
 * @param url - The URL to fetch.
 * @param init - Standard fetch RequestInit options.
 * @param timeoutMs - Timeout in milliseconds (default: 30 seconds).
 * @returns The fetch Response.
 * @throws Error on timeout or network failure.
 */
export async function fetchWithTimeout(
  url: string | URL,
  init?: RequestInit,
  timeoutMs: number = DEFAULT_SUBPROCESS_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const mergedInit: RequestInit = {
    ...init,
    signal: controller.signal,
  };

  try {
    const response = await fetch(url, mergedInit);
    clearTimeout(timer);
    return response;
  } catch (error: unknown) {
    clearTimeout(timer);

    if (error instanceof DOMException && error.name === "AbortError") {
      recordFaultEvent(
        "timeout",
        `Fetch timed out after ${timeoutMs}ms: ${url}`,
      );
      throw new Error(
        `Request timed out after ${timeoutMs}ms: ${url}`,
      );
    }

    throw error;
  }
}
