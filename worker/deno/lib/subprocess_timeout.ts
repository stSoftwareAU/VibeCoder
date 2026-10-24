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
 * @param options - Settings. `timeoutMs` is required. Also cwd, quiet mode
 *   and environment.
 *   `quiet` suppresses stdout only — stderr is always piped and captured so
 *   failure diagnostics survive (Issue #1979). `clearEnv` starts the child
 *   from an empty environment so only `env` reaches it — the callback
 *   contract's credential boundary (Issue #806).
 * @returns Result containing the subprocess output or an error.
 */
export async function runWithTimeout(
  executable: string,
  args: string[],
  options: {
    cwd?: string;
    timeoutMs: number;
    quiet?: boolean;
    /** Environment entries to set on the child. */
    env?: Record<string, string>;
    /** Start from an empty environment rather than inheriting the worker's. */
    clearEnv?: boolean;
    /**
     * Return whatever the child printed before it was killed on timeout,
     * instead of empty streams (Issue #806).
     *
     * Off by default so every existing caller keeps the terse "Timed out
     * after Nms" stderr it already handles. The callback contract turns it
     * on because a hook's diagnostic output is exactly what an operator
     * needs when the hook is the thing that hung.
     */
    captureOutputOnTimeout?: boolean;
  },
): Promise<Result<SubprocessResult>> {
  const timeoutMs = options.timeoutMs;

  if (!(timeoutMs > 0)) {
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
      // (e.g. a repository's quality gate), producing empty-tail "Command
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
      const decode = (bytes: Uint8Array | null) =>
        bytes ? new TextDecoder().decode(bytes).trim() : "";
      const timedOutStderr = `Timed out after ${timeoutMs}ms`;
      const captured = options?.captureOutputOnTimeout
        ? decode(output.stderr)
        : "";
      return {
        ok: true,
        value: {
          success: false,
          code: 124,
          stdout: options?.captureOutputOnTimeout ? decode(output.stdout) : "",
          stderr: captured ? `${timedOutStderr}\n${captured}` : timedOutStderr,
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

/** True when `error` is a timeout raised by {@link commandOutputWithTimeout}. */
export function isCommandTimeoutError(error: unknown): error is Error {
  return error instanceof Error && error.message.includes("timed out after");
}

/** After a timeout, how long the child has to exit on SIGTERM before SIGKILL. */
const TIMEOUT_KILL_GRACE_MS = 5_000;

/** Read `reader` to its end. A cancelled reader ends early, keeping its bytes. */
async function drainReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    length += value.length;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

/**
 * Run `Deno.Command` and reject when it exceeds `timeoutMs`.
 *
 * A timeout of zero or less fails immediately and does not spawn. The thrown
 * error names the executable. Callers report that error as a timeout or a
 * failure; they do not turn it into a successful result.
 *
 * The bound holds even when the child leaves a grandchild behind: at the
 * timeout the pipes are cancelled rather than read to EOF, because a
 * grandchild that inherited them would otherwise keep `output()` waiting
 * for as long as it lives. A child that ignores SIGTERM gets SIGKILL after
 * a short grace.
 */
export async function commandOutputWithTimeout(
  executable: string,
  options: Deno.CommandOptions & { timeoutMs: number },
): Promise<Deno.CommandOutput> {
  const { timeoutMs, ...commandOptions } = options;
  if (!(timeoutMs > 0)) {
    throw new Error(`${executable} timed out after ${timeoutMs}ms`);
  }

  // `output()` pipes stdout and stderr unless told otherwise; `spawn()` does
  // not, so the defaults are restated here.
  const stdoutMode = commandOptions.stdout ?? "piped";
  const stderrMode = commandOptions.stderr ?? "piped";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  const onAbort = () => {
    for (const reader of readers) reader.cancel().catch(() => {});
    killTimer = setTimeout(() => {
      try {
        child?.kill("SIGKILL");
      } catch { /* already exited */ }
    }, TIMEOUT_KILL_GRACE_MS);
  };
  let child: Deno.ChildProcess | undefined;
  try {
    child = new Deno.Command(executable, {
      ...commandOptions,
      stdout: stdoutMode,
      stderr: stderrMode,
      signal: controller.signal,
    }).spawn();
    const empty = Promise.resolve(new Uint8Array(0));
    const collect = (stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader();
      readers.push(reader);
      return drainReader(reader);
    };
    const stdoutBytes = stdoutMode === "piped" ? collect(child.stdout) : empty;
    const stderrBytes = stderrMode === "piped" ? collect(child.stderr) : empty;
    controller.signal.addEventListener("abort", onAbort, { once: true });
    const [status, stdout, stderr] = await Promise.all([
      child.status,
      stdoutBytes,
      stderrBytes,
    ]);
    if (controller.signal.aborted) {
      throw new Error(`${executable} timed out after ${timeoutMs}ms`);
    }
    return { ...status, stdout, stderr };
  } catch (error) {
    if (
      controller.signal.aborted ||
      (error instanceof DOMException && error.name === "AbortError")
    ) {
      recordFaultEvent(
        "timeout",
        `Subprocess timed out after ${timeoutMs}ms: ${executable}`,
      );
      throw new Error(`${executable} timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    clearTimeout(killTimer);
    controller.signal.removeEventListener("abort", onAbort);
  }
}

/** A non-git, non-gh argv. Minutes. A timeout throws; it is not a zero exit. */
export const DIRECT_COMMAND_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Run an argv to completion with trimmed text output (Issue #4251).
 *
 * The non-git, non-gh branch of the injectable `RunCommand` seams. A
 * supplied `env` is passed as is: callers that overlay the parent's
 * environment build that overlay themselves.
 */
export async function runDirectCommand(
  cmd: string[],
  timeoutMs: number = DIRECT_COMMAND_TIMEOUT_MS,
  env?: Record<string, string>,
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  const output = await commandOutputWithTimeout(cmd[0] ?? "", {
    args: cmd.slice(1),
    stdout: "piped",
    stderr: "piped",
    ...(env ? { env } : {}),
    timeoutMs,
  });
  const decoder = new TextDecoder();
  return {
    success: output.success,
    stdout: decoder.decode(output.stdout).trim(),
    stderr: decoder.decode(output.stderr).trim(),
  };
}

/**
 * Spawn a streaming child that is signalled when `timeoutMs` elapses.
 *
 * A timeout of zero or less throws and does not spawn. The timer is cleared
 * when the child exits, so a finished process is not signalled later.
 */
export function spawnCommandWithTimeout(
  executable: string,
  options: Deno.CommandOptions & { timeoutMs: number },
): Deno.ChildProcess {
  const { timeoutMs, ...commandOptions } = options;
  if (!(timeoutMs > 0)) {
    throw new Error(`${executable} timed out after ${timeoutMs}ms`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const child = new Deno.Command(executable, {
      ...commandOptions,
      signal: controller.signal,
    }).spawn();
    child.status.finally(() => clearTimeout(timer));
    return child;
  } catch (error) {
    clearTimeout(timer);
    throw error;
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
