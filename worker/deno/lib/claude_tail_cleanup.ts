/**
 * Orphaned-Claude-tail cleanup (Issue #1906).
 *
 * Claude Code spawns `tail -f /private/tmp/claude-${uid}/.../tasks/<id>.output`
 * subprocesses to monitor task output. When the worker exits unexpectedly
 * (e.g. `kill -9` from the user) those tails get reparented to PID 1 and
 * survive indefinitely — holding file descriptors on long-deleted task
 * output files. This module finds them and kills them, restricting the
 * sweep to processes with PPID 1 so concurrent worker instances are not
 * disturbed.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/**
 * Match a Claude task-output path:
 *   /(private/)?tmp/claude-<uid>/.../tasks/<id>.output
 *
 * Anchored so unrelated paths containing the same substrings cannot
 * match — the path must start at `/tmp` or `/private/tmp` and end at
 * `.output`.
 */
const CLAUDE_TASKS_PATH_RE =
  /(?:\/private)?\/tmp\/claude-\d+\/[^\s]*\/tasks\/[^\s]+\.output$/;

/**
 * Match the command portion: `tail -f`, `tail -F`, or `tail --follow`,
 * optionally with additional arguments before the path. The path is
 * captured (group 1) so we can re-validate against `CLAUDE_TASKS_PATH_RE`.
 */
const TAIL_FOLLOW_RE =
  /^tail\s+(?:[^-\s][^\s]*\s+|-[fF][^\s]*\s+|--follow(?:=[^\s]+)?\s+)+?(\/[^\s]+)\s*$/;

/**
 * Parse a `ps`-style line of the form `PID PPID COMMAND` and return the
 * PID when the line represents an orphaned (`PPID == 1`) `tail -f` of a
 * Claude task output file. Returns `null` otherwise.
 *
 * Exported for unit testing — see `claude_tail_cleanup_test.ts`.
 */
export function isOrphanedClaudeTailLine(line: string): number | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;

  // The header row from `ps` starts with non-numeric column labels.
  const match = trimmed.match(/^(\d+)\s+(\d+)\s+(.+)$/);
  if (!match) return null;

  const pid = parseInt(match[1] ?? "", 10);
  const ppid = parseInt(match[2] ?? "", 10);
  const command = (match[3] ?? "").trim();

  if (!Number.isFinite(pid) || pid <= 0) return null;
  if (ppid !== 1) return null;

  const tailMatch = command.match(TAIL_FOLLOW_RE);
  if (!tailMatch) return null;
  const path = tailMatch[1] ?? "";

  if (!CLAUDE_TASKS_PATH_RE.test(path)) return null;
  return pid;
}

/** Dependencies for {@link cleanupOrphanedClaudeTails} (injectable for tests). */
export interface CleanupDeps {
  /** Run `ps -eo pid=,ppid=,command=` and return the raw stdout. */
  runPs: () => Promise<string>;
  /** Send SIGKILL to a PID. Throws on failure (caller catches). */
  kill: (pid: number) => Promise<void>;
}

/** Outcome of a cleanup sweep. */
export interface CleanupResult {
  /** PIDs that were successfully killed. */
  killed: number[];
  /** PIDs that were targeted but whose kill threw. */
  failed: Array<{ pid: number; error: string }>;
}

/**
 * Find orphaned Claude `tail -f` processes and SIGKILL them. Returns the
 * PIDs that were killed plus any kill failures. `ps` failures are
 * swallowed (best-effort cleanup).
 */
export async function cleanupOrphanedClaudeTails(
  deps: CleanupDeps,
): Promise<CleanupResult> {
  let raw: string;
  try {
    raw = await deps.runPs();
  } catch {
    return { killed: [], failed: [] };
  }

  const candidates: number[] = [];
  for (const line of raw.split("\n")) {
    const pid = isOrphanedClaudeTailLine(line);
    if (pid !== null) candidates.push(pid);
  }

  const killed: number[] = [];
  const failed: CleanupResult["failed"] = [];
  for (const pid of candidates) {
    try {
      await deps.kill(pid);
      killed.push(pid);
    } catch (err) {
      failed.push({
        pid,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { killed, failed };
}

/**
 * Production-flavoured wrapper that wires {@link cleanupOrphanedClaudeTails}
 * to the real `ps` and `kill` commands. Returns the same result shape.
 */
export async function cleanupOrphanedClaudeTailsProd(): Promise<CleanupResult> {
  return await cleanupOrphanedClaudeTails({
    runPs: async () => {
      const cmd = new Deno.Command("ps", {
        args: ["-eo", "pid=,ppid=,command="],
        stdout: "piped",
        stderr: "null",
      });
      const output = await cmd.output();
      if (!output.success) {
        throw new Error(`ps exited with code ${output.code}`);
      }
      return new TextDecoder().decode(output.stdout);
    },
    kill: async (pid) => {
      try {
        Deno.kill(pid, "SIGKILL");
      } catch (err) {
        throw err instanceof Error ? err : new Error(String(err));
      }
      return await Promise.resolve();
    },
  });
}
