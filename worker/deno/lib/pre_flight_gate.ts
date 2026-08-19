/**
 * Pre-flight enforcement gate (Issue #3577).
 *
 * Runs a repo's configured mandatory pre-flight commands in the working tree
 * immediately before the worker's automated commit, at the same chokepoint as
 * `assertSafeToCommit()`. The first non-zero exit blocks BOTH the commit and
 * the push — there is deliberately no override/force flag and no environment
 * escape hatch.
 *
 * Fail loud, never fail open: a command that is missing, not executable,
 * cannot be started, or times out is a **block**, not a pass. "Could not run
 * the check" is never reported as "check passed" (carried over from
 * private-repo-12#563, where a check exited 0 when a prerequisite was absent).
 *
 * The failure carries a distinct `reason` and the captured command output so
 * callers can surface the real compiler error to the retry/diagnosis path.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import type { Result } from "../types.ts";
import { TIMEOUT_EXIT_CODE } from "./git_timeout.ts";

/**
 * Default per-command timeout in seconds (Issue #3577).
 *
 * These builds legitimately take many minutes, so the default is generous
 * (30 minutes). A timeout is a **block**, never a pass. Override per-gate via
 * {@link PreFlightGateOptions.timeoutSeconds}.
 */
export const PRE_FLIGHT_DEFAULT_TIMEOUT_SECONDS = 1800;

/**
 * Distinct classification of a pre-flight failure. Assert on this (not just a
 * boolean) so a future refactor that swallows a spawn error into "passed"
 * fails a test.
 */
export type PreFlightFailureReason =
  /** The command ran to completion and exited non-zero ("check failed"). */
  | "non-zero-exit"
  /** The command could not be started (missing / not executable / unstartable). */
  | "not-started"
  /** The command exceeded its timeout before completing. */
  | "timeout";

/** Outcome of running a single pre-flight command. */
export interface PreFlightCommandResult {
  /** False when the command could not even be started (spawn failure). */
  started: boolean;
  /** Exit code. `TIMEOUT_EXIT_CODE` on timeout; `-1` when never started. */
  code: number;
  /** Captured standard output. */
  stdout: string;
  /** Captured standard error. */
  stderr: string;
  /** True when the command was aborted because it exceeded the timeout. */
  timedOut?: boolean;
}

/** Options for a single command run. */
export interface PreFlightRunOptions {
  /** Working directory the command runs in. */
  cwd?: string;
  /** Environment variables passed to the command. */
  env?: Record<string, string>;
  /** Per-command timeout in seconds. */
  timeoutSeconds: number;
}

/**
 * Runs a single pre-flight command. Injectable so tests can exercise the gate
 * without spawning real processes.
 */
export type PreFlightRunner = (
  command: string,
  options: PreFlightRunOptions,
) => Promise<PreFlightCommandResult>;

/** Options for {@link runPreFlightGate}. */
export interface PreFlightGateOptions {
  /** Working directory the commands run in (the repo working tree). */
  cwd?: string;
  /** Environment variables passed to each command. */
  env?: Record<string, string>;
  /** Per-command timeout in seconds. Defaults to {@link PRE_FLIGHT_DEFAULT_TIMEOUT_SECONDS}. */
  timeoutSeconds?: number;
  /** Command runner (defaults to the real subprocess runner). */
  runner?: PreFlightRunner;
}

/**
 * Error raised when the pre-flight gate blocks a commit/push (Issue #3577).
 *
 * Carries the distinct {@link reason}, the offending {@link command}, its exit
 * {@link exitCode}, and the captured {@link output} (stdout + stderr) so the
 * failure can be surfaced verbatim to the fixer.
 */
export class PreFlightGateError extends Error {
  readonly reason: PreFlightFailureReason;
  readonly command: string;
  readonly exitCode: number;
  readonly output: string;

  constructor(args: {
    reason: PreFlightFailureReason;
    command: string;
    exitCode: number;
    output: string;
    message: string;
  }) {
    super(args.message);
    this.name = "PreFlightGateError";
    this.reason = args.reason;
    this.command = args.command;
    this.exitCode = args.exitCode;
    this.output = args.output;
  }
}

/**
 * Tokenise a command string into a program and its arguments.
 *
 * Commands run **directly** (not through a shell), so a missing or
 * non-executable program surfaces as a spawn failure we can classify as
 * `not-started` — distinct from a shell's exit 127. Supports simple single-
 * and double-quoted segments; shell features (pipes, redirects, globs) are
 * not interpreted.
 */
export function tokeniseCommand(command: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(command)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return tokens;
}

/** Default runner: spawn the command directly with timeout protection. */
async function defaultPreFlightRunner(
  command: string,
  options: PreFlightRunOptions,
): Promise<PreFlightCommandResult> {
  const tokens = tokeniseCommand(command);
  const program = tokens[0];
  if (program === undefined) {
    return {
      started: false,
      code: -1,
      stdout: "",
      stderr: "empty command string",
    };
  }

  const args = tokens.slice(1);
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutSeconds * 1000,
  );

  try {
    const cmd = new Deno.Command(program, {
      args,
      cwd: options.cwd,
      env: options.env,
      stdout: "piped",
      stderr: "piped",
      signal: controller.signal,
    });
    const out = await cmd.output();
    clearTimeout(timer);
    return {
      started: true,
      code: out.code,
      stdout: new TextDecoder().decode(out.stdout),
      stderr: new TextDecoder().decode(out.stderr),
    };
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof DOMException && err.name === "AbortError") {
      // Aborted by the timeout — a BLOCK, never a pass.
      return {
        started: true,
        code: TIMEOUT_EXIT_CODE,
        stdout: "",
        stderr: `timed out after ${options.timeoutSeconds}s`,
        timedOut: true,
      };
    }
    // Deno.errors.NotFound / PermissionDenied / any other spawn failure —
    // the command could not be started, so this is a BLOCK.
    return {
      started: false,
      code: -1,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Trim and join stdout/stderr for surfacing to the fixer. */
function combineOutput(result: PreFlightCommandResult): string {
  return [result.stdout, result.stderr]
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join("\n");
}

/**
 * Run a repo's pre-flight commands in listed order, stopping at the first
 * failure (Issue #3577).
 *
 * - Empty `commands` → `Ok` immediately, no runner invoked (zero added
 *   latency for repos with no gate).
 * - A command that cannot be started → `Err` with reason `not-started` and a
 *   message distinct from "check failed".
 * - A command that times out → `Err` with reason `timeout`.
 * - A command that exits non-zero → `Err` with reason `non-zero-exit`.
 *
 * @param commands Commands to run (from `getPreFlightCommands`).
 * @param options Working tree, env, timeout, and injectable runner.
 * @returns `Ok(void)` when every command passed; a `PreFlightGateError`
 *   otherwise.
 */
export async function runPreFlightGate(
  commands: readonly string[],
  options: PreFlightGateOptions = {},
): Promise<Result<void, PreFlightGateError>> {
  if (commands.length === 0) {
    return { ok: true, value: undefined };
  }

  const runner = options.runner ?? defaultPreFlightRunner;
  const timeoutSeconds = options.timeoutSeconds ??
    PRE_FLIGHT_DEFAULT_TIMEOUT_SECONDS;

  for (const command of commands) {
    const result = await runner(command, {
      cwd: options.cwd,
      env: options.env,
      timeoutSeconds,
    });
    const output = combineOutput(result);

    if (!result.started) {
      return {
        ok: false,
        error: new PreFlightGateError({
          reason: "not-started",
          command,
          exitCode: result.code,
          output,
          message:
            `Pre-flight gate BLOCK (Issue #3577): command \`${command}\` ` +
            `could not be started (missing, not executable, or unstartable). ` +
            `"Could not run the check" is treated as a block, never a pass.` +
            (output ? `\n\n${output}` : ""),
        }),
      };
    }

    if (result.timedOut || result.code === TIMEOUT_EXIT_CODE) {
      return {
        ok: false,
        error: new PreFlightGateError({
          reason: "timeout",
          command,
          exitCode: TIMEOUT_EXIT_CODE,
          output,
          message:
            `Pre-flight gate BLOCK (Issue #3577): command \`${command}\` ` +
            `timed out after ${timeoutSeconds}s. A timeout is a block, ` +
            `never a pass.` + (output ? `\n\n${output}` : ""),
        }),
      };
    }

    if (result.code !== 0) {
      return {
        ok: false,
        error: new PreFlightGateError({
          reason: "non-zero-exit",
          command,
          exitCode: result.code,
          output,
          message:
            `Pre-flight gate BLOCK (Issue #3577): command \`${command}\` ` +
            `failed with exit code ${result.code}. Fix the failure and retry ` +
            `— the commit and push are blocked.` +
            (output ? `\n\n${output}` : ""),
        }),
      };
    }
  }

  return { ok: true, value: undefined };
}
