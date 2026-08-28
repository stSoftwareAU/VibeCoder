/**
 * PID-file guard helpers for unattended cron workers.
 *
 * Design goals:
 * - Safe by default: never kill unrelated processes (verify command line first).
 * - Cross-platform: macOS (BSD ps) + Ubuntu/Amazon Linux (procps ps).
 * - Fail-safe: on parsing/ps differences, do nothing rather than breaking runs.
 *
 * Migrated from worker/shared/pid_guard.sh (Issue #903).
 */

/** Result of a PID guard operation (e.g., checking an existing PID file). */
export interface PidGuardResult {
  /** Whether the guard check passed (i.e., safe to proceed). */
  canProceed: boolean;
  /** Human-readable summary message. */
  message: string;
  /** The existing PID from the file, if any. */
  existingPid?: number;
}

/** Result of a descendant termination operation. */
export interface TerminationResult {
  /** PIDs that were targeted for termination. */
  targetedPids: number[];
  /** Human-readable summary message. */
  message: string;
}

/**
 * Trim leading and trailing whitespace from a string.
 */
export function trim(s: string): string {
  return s.trim();
}

/**
 * Check if a process is running.
 *
 * @param pid - The process ID to check
 * @returns Whether the process is running
 */
export async function isRunning(pid: number): Promise<boolean> {
  try {
    const cmd = new Deno.Command("ps", {
      args: ["-p", String(pid)],
      stdout: "null",
      stderr: "null",
    });
    const output = await cmd.output();
    return output.success;
  } catch (err) {
    console.debug(
      `[pid-guard] Failed to check if PID ${pid} is running: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
}

/**
 * Get the full command line of a process.
 *
 * @param pid - The process ID to query
 * @returns The command string, or empty string if unavailable
 */
export async function getCommand(pid: number): Promise<string> {
  try {
    const cmd = new Deno.Command("ps", {
      args: ["-p", String(pid), "-o", "command="],
      stdout: "piped",
      stderr: "null",
    });
    const output = await cmd.output();
    if (!output.success) return "";
    return trim(new TextDecoder().decode(output.stdout));
  } catch (err) {
    console.debug(
      `[pid-guard] Failed to get command for PID ${pid}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return "";
  }
}

/**
 * Validate that a command line matches an expected worker-driver process.
 *
 * Used to verify we are not killing unrelated processes. The current runtime
 * driver is the Deno `run-entrypoint` command (Issue #3504): the container
 * `run.sh`/`run.ps1` launched `exec`s `deno run … worker/deno/mod.ts
 * run-entrypoint …`, so a previous run's PID belongs to that process. The legacy `worker/run_core.sh` /
 * `worker/.run_core.sh` bash patterns are retained so a host mid-upgrade — with
 * an old bash run still active — is still recognised and not double-run.
 *
 * @param command - The command line string to validate
 * @returns Whether the command matches an expected worker-driver process
 */
export function isExpectedRunCoreCommand(command: string): boolean {
  if (!command) return false;

  const patterns = [
    // Current Deno driver: `deno run … worker/deno/mod.ts run-entrypoint …`.
    /(\/)worker\/deno\/mod\.ts\s+run-entrypoint(\s|$)/,
    /(^|\s)mod\.ts\s+run-entrypoint(\s|$)/,
    // Legacy bash conductor (retained for mid-upgrade hosts).
    /(^|\s)(bash|\/bin\/bash)\s.*(\/)worker\/\.run_core\.sh(\s|$)/,
    /(^|\s)(bash|\/bin\/bash)\s.*(\/)worker\/run_core\.sh(\s|$)/,
    /(\/)worker\/\.run_core\.sh(\s|$)/,
    /(\/)worker\/run_core\.sh(\s|$)/,
    /(^)worker\/\.run_core\.sh(\s|$)/,
    /(^)worker\/run_core\.sh(\s|$)/,
  ];

  return patterns.some((p) => p.test(command));
}

/**
 * Parse elapsed time format to seconds.
 *
 * Supports formats:
 * - DAYS-HH:MM:SS
 * - HH:MM:SS
 * - MM:SS
 *
 * @param etimeRaw - Raw elapsed time string from `ps`
 * @returns Seconds, or null if unparseable
 */
export function parseEtimeToSeconds(etimeRaw: string): number | null {
  const etime = trim(etimeRaw);
  if (!etime) return null;

  // DAYS-HH:MM:SS
  const daysMatch = etime.match(/^(\d+)-(\d{1,2}):(\d{2}):(\d{2})$/);
  if (daysMatch) {
    const [, days, h, m, s] = daysMatch;
    return Number(days) * 86400 + Number(h) * 3600 + Number(m) * 60 + Number(s);
  }

  // HH:MM:SS
  const hmsMatch = etime.match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
  if (hmsMatch) {
    const [, h, m, s] = hmsMatch;
    return Number(h) * 3600 + Number(m) * 60 + Number(s);
  }

  // MM:SS
  const msMatch = etime.match(/^(\d{1,2}):(\d{2})$/);
  if (msMatch) {
    const [, m, s] = msMatch;
    return Number(m) * 60 + Number(s);
  }

  return null;
}

/**
 * Get elapsed seconds for a running process.
 *
 * Tries `etimes` format first (direct seconds), falls back to `etime` parsing.
 *
 * @param pid - The process ID to query
 * @returns Elapsed seconds, or null if unavailable
 */
export async function getElapsedSeconds(pid: number): Promise<number | null> {
  // Try etimes first (direct seconds format, available on Linux)
  try {
    const cmd = new Deno.Command("ps", {
      args: ["-p", String(pid), "-o", "etimes="],
      stdout: "piped",
      stderr: "null",
    });
    const output = await cmd.output();
    if (output.success) {
      const etimes = trim(new TextDecoder().decode(output.stdout));
      const seconds = parseInt(etimes, 10);
      if (!isNaN(seconds)) return seconds;
    }
  } catch (err) {
    console.debug(
      `[pid-guard] etimes lookup failed for PID ${pid}, falling back to etime: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  // Fall back to etime format
  try {
    const cmd = new Deno.Command("ps", {
      args: ["-p", String(pid), "-o", "etime="],
      stdout: "piped",
      stderr: "null",
    });
    const output = await cmd.output();
    if (output.success) {
      const etime = trim(new TextDecoder().decode(output.stdout));
      return parseEtimeToSeconds(etime);
    }
  } catch (err) {
    console.debug(
      `[pid-guard] etime lookup failed for PID ${pid}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  return null;
}

/**
 * Get all descendant PIDs of a process (children, grandchildren, etc.).
 *
 * Returns PIDs in bottom-up order (deepest descendants first) for safe
 * termination ordering.
 *
 * @param parentPid - The parent PID to find descendants of
 * @param depth - Internal recursion depth (default: 0, max: 20)
 * @returns Array of descendant PIDs in bottom-up order
 */
export async function getDescendants(
  parentPid: number,
  depth = 0,
): Promise<number[]> {
  const maxDepth = 20;

  if (depth >= maxDepth) return [];
  if (!(await isRunning(parentPid))) return [];

  // Get direct children
  let children: number[] = [];
  try {
    const cmd = new Deno.Command("pgrep", {
      args: ["-P", String(parentPid)],
      stdout: "piped",
      stderr: "null",
    });
    const output = await cmd.output();
    if (output.success) {
      const text = trim(new TextDecoder().decode(output.stdout));
      children = text
        .split("\n")
        .map((s) => parseInt(trim(s), 10))
        .filter((n) => !isNaN(n) && n > 0);
    }
  } catch (err) {
    console.debug(
      `[pid-guard] pgrep failed for parent PID ${parentPid}, falling back to ps: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    // Fallback: use ps to find processes with this PPID
    try {
      const cmd = new Deno.Command("ps", {
        args: ["-o", "pid=", "-o", "ppid="],
        stdout: "piped",
        stderr: "null",
      });
      const output = await cmd.output();
      if (output.success) {
        const text = new TextDecoder().decode(output.stdout);
        children = text
          .trim()
          .split("\n")
          .map((line) => {
            const parts = line.trim().split(/\s+/);
            return {
              pid: parseInt(parts[0] ?? "", 10),
              ppid: parseInt(parts[1] ?? "", 10),
            };
          })
          .filter((entry) => entry.ppid === parentPid && !isNaN(entry.pid))
          .map((entry) => entry.pid);
      }
    } catch (err) {
      console.debug(
        `[pid-guard] ps fallback failed for parent PID ${parentPid}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // Recursively get descendants (bottom-up order)
  const descendants: number[] = [];
  for (const child of children) {
    const grandchildren = await getDescendants(child, depth + 1);
    descendants.push(...grandchildren);
    descendants.push(child);
  }

  return descendants;
}

/**
 * Send a signal to a process (best-effort, ignores errors).
 */
async function sendSignal(pid: number, signal: string): Promise<void> {
  try {
    const cmd = new Deno.Command("kill", {
      args: [`-${signal}`, String(pid)],
      stdout: "null",
      stderr: "null",
    });
    await cmd.output();
  } catch (err) {
    console.debug(
      `[pid-guard] Failed to send signal ${signal} to PID ${pid}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Terminate all descendant processes of a given PID.
 *
 * Finds and terminates all descendant processes bottom-up (deepest children
 * first). Sends SIGTERM, waits for graceful termination, then escalates to
 * SIGKILL.
 *
 * @param parentPid - Parent PID whose descendants should be terminated
 * @param maxWaitSeconds - Max wait seconds before SIGKILL (default: 5)
 * @returns Termination result with targeted PIDs
 */
export async function terminateDescendants(
  parentPid: number,
  maxWaitSeconds = 5,
): Promise<TerminationResult> {
  const descendants = await getDescendants(parentPid);

  if (descendants.length === 0) {
    return { targetedPids: [], message: "No descendants found" };
  }

  // Send SIGTERM to all descendants
  for (const pid of descendants) {
    await sendSignal(pid, "TERM");
  }

  // Wait for graceful termination
  for (let i = 0; i < maxWaitSeconds; i++) {
    let anyRunning = false;
    for (const pid of descendants) {
      if (await isRunning(pid)) {
        anyRunning = true;
        break;
      }
    }
    if (!anyRunning) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  // Send SIGKILL to any remaining
  for (const pid of descendants) {
    if (await isRunning(pid)) {
      await sendSignal(pid, "KILL");
    }
  }

  return {
    targetedPids: descendants,
    message: `Terminated ${descendants.length} descendant process(es)`,
  };
}

/** Raw result of the `ps -o pgid=` lookup used by terminateProcessTree. */
export interface PgidCommandResult {
  /** Whether the underlying `ps` invocation succeeded. */
  success: boolean;
  /** Raw stdout from `ps` (the pgid line), still to be parsed. */
  stdout: string;
}

/**
 * Injectable seams for {@link terminateProcessTree}.
 *
 * Every seam defaults to a real OS-backed implementation; tests override them
 * to drive the pgid-parse branch and the TERM→KILL escalation without spawning
 * real processes or waiting real seconds.
 */
export interface TerminateProcessTreeDeps {
  /** Run `ps -p <pid> -o pgid=` and return its raw success/stdout. */
  runPgidCommand: (pid: number) => Promise<PgidCommandResult>;
  /**
   * This process's own pid (Issue #4369). A target that shares the
   * worker's process group is signalled by pid only — a group signal would
   * SIGTERM the worker itself (and, where the worker is a session leader's
   * child with pgid 1, every process on the box).
   */
  selfPid?: number;
  /** Send a signal to a PID (a negative PID targets the process group). */
  sendSignal: (pid: number, signal: string) => Promise<void>;
  /** Whether a PID is still running. */
  isRunning: (pid: number) => Promise<boolean>;
  /** Sleep for the given milliseconds between poll iterations. */
  sleep: (ms: number) => Promise<void>;
}

/** Default `ps -o pgid=` runner backed by the real `ps` command. */
async function defaultRunPgidCommand(pid: number): Promise<PgidCommandResult> {
  try {
    const cmd = new Deno.Command("ps", {
      args: ["-p", String(pid), "-o", "pgid="],
      stdout: "piped",
      stderr: "null",
    });
    const output = await cmd.output();
    return {
      success: output.success,
      stdout: new TextDecoder().decode(output.stdout),
    };
  } catch (err) {
    console.debug(
      `[pid-guard] Failed to get process group for PID ${pid}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return { success: false, stdout: "" };
  }
}

/** The pgid of this process, via the same seam (Issue #4369); null when unknown. */
async function ownProcessGroup(
  deps: TerminateProcessTreeDeps,
): Promise<number | null> {
  const selfPid = deps.selfPid ?? Deno.pid;
  try {
    const { success, stdout } = await deps.runPgidCommand(selfPid);
    if (!success) return null;
    const parsed = parseInt(trim(stdout), 10);
    return !isNaN(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

/** Production seams for {@link terminateProcessTree}. */
const defaultTerminateProcessTreeDeps: TerminateProcessTreeDeps = {
  runPgidCommand: defaultRunPgidCommand,
  sendSignal,
  isRunning,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Terminate a process and its process group (best-effort).
 *
 * Sends SIGTERM to the process group and the process itself, waits for
 * termination, then escalates to SIGKILL if needed.
 *
 * @param pid - The PID to terminate
 * @param maxWaitSeconds - Max wait seconds before SIGKILL (default: 30)
 * @param deps - Injectable seams (defaults to real OS-backed implementations)
 */
export async function terminateProcessTree(
  pid: number,
  maxWaitSeconds = 30,
  deps: TerminateProcessTreeDeps = defaultTerminateProcessTreeDeps,
): Promise<void> {
  // Get process group ID (parse stays here so the branch is observable).
  let pgid: number | null = null;
  try {
    const { success, stdout } = await deps.runPgidCommand(pid);
    if (success) {
      const parsed = parseInt(trim(stdout), 10);
      if (!isNaN(parsed) && parsed > 0) pgid = parsed;
    }
  } catch (err) {
    console.debug(
      `[pid-guard] Failed to get process group for PID ${pid}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  // Never signal our own process group (Issue #4369): a child spawned
  // without setsid shares the worker's pgid, and `kill -TERM -<pgid>` then
  // terminates the worker (observed as the test runner / a native worker
  // dying with the agent it was killing). Such a target gets the pid signal
  // only; its descendants are handled by terminateDescendants().
  //
  // An unknown own pgid fails SAFE (Issue #471): if `ps` cannot tell us which
  // group we are in, we cannot prove the target's group is not ours, and a
  // group signal sent on that assumption takes the worker — or a CI runner —
  // down with the agent. Unknown means pid-only, never "go ahead".
  if (pgid !== null) {
    const ownPgid = await ownProcessGroup(deps);
    if (ownPgid === null) {
      console.debug(
        `[pid-guard] own process group unknown — signalling PID ${pid} only, not group ${pgid}`,
      );
      pgid = null;
    } else if (ownPgid === pgid) {
      console.debug(
        `[pid-guard] PID ${pid} shares this process's group ${pgid} — signalling the pid only`,
      );
      pgid = null;
    }
  }

  // Send SIGTERM to process group and process
  if (pgid !== null) {
    await deps.sendSignal(-pgid, "TERM");
  }
  await deps.sendSignal(pid, "TERM");

  // Wait for termination
  for (let i = 0; i < maxWaitSeconds; i++) {
    if (!(await deps.isRunning(pid))) return;
    await deps.sleep(1000);
  }

  // Escalate to SIGKILL
  if (await deps.isRunning(pid)) {
    if (pgid !== null) {
      await deps.sendSignal(-pgid, "KILL");
    }
    await deps.sendSignal(pid, "KILL");
  }
}

/**
 * Check a PID file and determine if the worker can proceed.
 *
 * If the PID file exists and contains a running process, the worker
 * should not start (another instance is active).
 *
 * @param pidFilePath - Path to the PID file
 * @returns Guard result indicating whether the worker can proceed
 */
export async function checkPidFile(
  pidFilePath: string,
): Promise<PidGuardResult> {
  try {
    const content = await Deno.readTextFile(pidFilePath);
    const pidStr = trim(content.split("\n")[0] ?? "");
    const existingPid = parseInt(pidStr, 10);

    if (isNaN(existingPid) || existingPid <= 0) {
      return {
        canProceed: true,
        message: "PID file exists but contains invalid PID",
        existingPid: undefined,
      };
    }

    if (await isRunning(existingPid)) {
      return {
        canProceed: false,
        message: `Another instance is running (PID ${existingPid})`,
        existingPid,
      };
    }

    return {
      canProceed: true,
      message: `Stale PID file found (PID ${existingPid} is not running)`,
      existingPid,
    };
  } catch (err) {
    console.debug(
      `[pid-guard] Could not read PID file ${pidFilePath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return {
      canProceed: true,
      message: "No PID file found, safe to proceed",
    };
  }
}
