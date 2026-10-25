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
import { getRunTimeline } from "./run_timeline.ts";

/** Default timeout for subprocess calls: 30 seconds. */
export const DEFAULT_SUBPROCESS_TIMEOUT_MS = 30_000;

/**
 * Milliseconds held back before the hard kill so wrap-up still runs
 * (Issue #4247). Past the finish deadline a spawn is clamped to this
 * reserve, not to the finish.
 */
export const HARD_KILL_WRAP_UP_RESERVE_MS = 300_000;

/** After SIGTERM, how long the child has to exit before the kill is given up. */
export const KILL_GRACE_MS = 5_000;

let chokepointNowForTests: (() => number) | undefined;
let killGraceMsForTests: number | undefined;

/** Pin the clock the deadline clamp reads. Tests only. */
export function _setChokepointNowForTests(now: () => number): void {
  chokepointNowForTests = now;
}

/** Restore the real clock. Tests only. */
export function _resetChokepointNowForTests(): void {
  chokepointNowForTests = undefined;
}

/** Shorten the post-SIGTERM grace. Tests only. */
export function _setKillGraceMsForTests(ms: number): void {
  killGraceMsForTests = ms;
}

/** Restore the production grace. Tests only. */
export function _resetKillGraceMsForTests(): void {
  killGraceMsForTests = undefined;
}

function chokepointNow(): number {
  return chokepointNowForTests ? chokepointNowForTests() : Date.now();
}

function currentKillGraceMs(): number {
  return killGraceMsForTests ?? KILL_GRACE_MS;
}

/** `git status` / `gh api user` — the name a refusal or kill log carries. */
export function subprocessCommandLabel(
  executable: string,
  args: readonly string[],
): string {
  return args.length === 0 ? executable : `${executable} ${args.join(" ")}`;
}

/**
 * Whole seconds when the budget is a whole number of seconds, otherwise the
 * decimal. `1000` stays `1`, so an existing `timed out after 1s` line holds.
 */
export function formatTimeoutSeconds(ms: number): string {
  const seconds = ms / 1000;
  return Number.isInteger(seconds) ? String(seconds) : String(seconds);
}

/**
 * Clamp a chokepoint budget to the run timeline (Issue #4247).
 *
 * With no timeline set, the budget is unchanged. Before the finish it is
 * capped at the time remaining. After the finish, when a hard kill is known,
 * it is capped at 300 s before that kill so wrap-up can still run. When no
 * hard kill is known, the requested budget is kept: nothing else can tell
 * wrap-up when to stop, and refusing the spawn would block the WIP push,
 * the claim release and the hooks. A result of 0 or less throws and names
 * `command`; the caller must not spawn.
 */
export function clampTimeoutToRunTimeline(
  requestedMs: number,
  command: string,
): number {
  const timeline = getRunTimeline();
  if (timeline === undefined) return requestedMs;

  const now = chokepointNow();
  const limit = timeline.pastFinish(now)
    ? timeline.hardKillMs === null
      ? requestedMs
      : timeline.hardKillMs - HARD_KILL_WRAP_UP_RESERVE_MS - now
    : timeline.remainingToFinishMs(now);
  const allowed = Math.min(requestedMs, limit);
  if (!(allowed > 0)) {
    throw new Error(
      `refusing to spawn ${command}: no time left before the run deadline`,
    );
  }
  return allowed;
}

/** What {@link waitForChildExit} observed. */
export type ChildExitOutcome =
  | { kind: "output"; output: Deno.CommandOutput }
  | { kind: "aborted" }
  | { kind: "kill-incomplete" };

/**
 * Wait for `child` to exit. Once `signal` aborts, SIGTERM is sent and the
 * wait is capped at the grace. A child still alive is logged and the wait
 * ends; it is not left running until it chooses to finish (Issue #4247).
 */
export async function waitForChildExit(
  child: Deno.ChildProcess,
  signal: AbortSignal,
  command: string,
): Promise<ChildExitOutcome> {
  const grace = currentKillGraceMs();
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let removeAbort = () => {};

  const outputPromise = child.output().then(
    (output) => ({ kind: "output" as const, output }),
    (error: unknown) => {
      if (error instanceof DOMException && error.name === "AbortError") {
        return { kind: "aborted" as const };
      }
      throw error;
    },
  );

  const giveUp = new Promise<{ kind: "kill-incomplete" }>((resolve) => {
    const arm = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        // The child has already exited.
      }
      graceTimer = setTimeout(() => {
        console.error(
          `kill of ${command} did not complete within ${grace / 1000}s`,
        );
        try {
          child.kill("SIGKILL");
        } catch {
          // The child has already exited.
        }
        resolve({ kind: "kill-incomplete" });
      }, grace);
    };
    if (signal.aborted) {
      arm();
      return;
    }
    signal.addEventListener("abort", arm, { once: true });
    removeAbort = () => signal.removeEventListener("abort", arm);
  });

  try {
    const outcome = await Promise.race([outputPromise, giveUp]);
    if (outcome.kind === "kill-incomplete") {
      // SIGKILL has been sent. Reap if it exits promptly; never block on a
      // child that is still alive after the grace.
      await reapAfterKill(child);
    }
    return outcome;
  } finally {
    if (graceTimer !== undefined) clearTimeout(graceTimer);
    removeAbort();
  }
}

/** Bound the post-SIGKILL reap so a stuck child cannot hold the caller. */
async function reapAfterKill(child: Deno.ChildProcess): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, 1_000);
  });
  await Promise.race([
    child.status.then(() => {}, () => {}),
    cap,
  ]);
  if (timer !== undefined) clearTimeout(timer);
}

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
  const requestedMs = options.timeoutMs;

  // A caller-supplied non-positive budget is today's timeout result. The
  // deadline clamp below is what refuses a positive budget that shrinks to
  // nothing (Issue #4247). A timeout stays a failure: success is false.
  if (!(requestedMs > 0)) {
    return {
      ok: true,
      value: {
        success: false,
        code: 124,
        stdout: "",
        stderr: `Timed out after ${requestedMs}ms`,
        timedOut: true,
      },
    };
  }

  const commandLabel = subprocessCommandLabel(executable, args);
  const timeoutMs = clampTimeoutToRunTimeline(requestedMs, commandLabel);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

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
    const outcome = await waitForChildExit(
      child,
      controller.signal,
      commandLabel,
    );
    // Drop the timer before reading the signal, so a command that has already
    // finished is not reported as a timeout.
    clearTimeout(timer);

    if (outcome.kind === "kill-incomplete" || controller.signal.aborted) {
      recordFaultEvent(
        "timeout",
        `Subprocess timed out after ${timeoutMs}ms: ${commandLabel}`,
      );
      const decode = (bytes: Uint8Array | null) =>
        bytes ? new TextDecoder().decode(bytes).trim() : "";
      const timedOutStderr = `Timed out after ${timeoutMs}ms`;
      const captured = outcome.kind === "output" &&
          options?.captureOutputOnTimeout
        ? decode(outcome.output.stderr)
        : "";
      return {
        ok: true,
        value: {
          success: false,
          code: 124,
          stdout: outcome.kind === "output" && options?.captureOutputOnTimeout
            ? decode(outcome.output.stdout)
            : "",
          stderr: captured ? `${timedOutStderr}\n${captured}` : timedOutStderr,
          timedOut: true,
        },
      };
    }

    if (outcome.kind !== "output") {
      recordFaultEvent(
        "timeout",
        `Subprocess timed out after ${timeoutMs}ms: ${commandLabel}`,
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

    const output = outcome.output;
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
    if (error instanceof DOMException && error.name === "AbortError") {
      recordFaultEvent(
        "timeout",
        `Subprocess timed out after ${timeoutMs}ms: ${commandLabel}`,
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
    clearTimeout(timer);
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
