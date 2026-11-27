/**
 * Pre-started tag reaper for the guest memory floor (Issue #5638).
 *
 * On an exhausted guest the memory is held by the agent's descendants, such as
 * `ld` linkers under cargo, each in its own session, so a process-group kill
 * does not reach them. The leftover reaper needs `sh`, `pgrep` and `grep`, and
 * every spawn times out on a full guest. So this helper is started beside the
 * agent while memory is plentiful. It walks /proc with bash builtins only
 * (glob, read, kill, [ ], arithmetic: no fork, no exec), so it works when no
 * process can be started. Deno refuses /proc/<pid>/environ without
 * --allow-all, hence bash.
 *
 * Identity: a process is signalled only if its environ holds the exact entry.
 * This is a second copy of the rule `FIND_TAGGED_SCRIPT` applies with
 * `grep -z -x -F` in agent_leftover_reaper.ts, kept in step by a contract test.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { AGENT_SPAWN_TAG_ENV, TAG_PATTERN } from "./agent_leftover_reaper.ts";
import { spawnCommandWithTimeout } from "./subprocess_timeout.ts";

/** Bound on one sweep when the caller gives none. */
const DEFAULT_SWEEP_TIMEOUT_MS = 30_000;

/**
 * The helper's program. Builtins only: never add a command substitution, pipe
 * or external command. It reads commands on stdin, one per line, and answers
 * `sweep` with `signalled <n>`.
 */
const SCRIPT = [
  "entry=$1",
  "while IFS= read -r cmd; do",
  '  if [ "$cmd" != sweep ]; then echo "error unknown command"; continue; fi',
  '  seen=" "',
  "  for round in 1 2 3 4; do",
  "    found=0",
  "    for dir in /proc/[0-9]*; do",
  "      p=${dir#/proc/}",
  '      [ "$p" = "$$" ] && continue',
  '      case "$seen" in *" $p "*) continue ;; esac',
  "      while IFS= read -r -d '' e; do",
  '        if [ "$e" = "$entry" ]; then',
  '          if kill -KILL "$p" 2>/dev/null; then seen="$seen$p "; found=$((found + 1)); fi',
  "          break",
  "        fi",
  '      done 2>/dev/null < "$dir/environ"',
  "    done",
  '    [ "$found" -eq 0 ] && break',
  "  done",
  '  set -- $seen; echo "signalled $#"',
  '  set -- "$entry"',
  "done",
].join("\n");

/** The answer line a sweep must carry. */
const SIGNALLED_LINE = /^signalled (\d+)$/;

/** A pre-started reaper for one agent run's spawn tag. */
export interface GuestMemoryTagReaper {
  /** SIGKILL every process carrying the tag; resolves with how many were signalled. */
  sweep(): Promise<number>;
  /** Stop the helper; safe to call twice and after it died. */
  close(): Promise<void>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Start the helper for `tag`. Throws when the tag is malformed or the helper
 * cannot be spawned; the caller then runs without a tag sweep.
 */
export function startGuestMemoryTagReaper(
  tag: string,
  options: {
    /** The bash to run the helper with. Default `bash`. */
    bashPath?: string;
    /** Bound on one sweep. Default 30 s. */
    sweepTimeoutMs?: number;
    /** Backstop on the helper's own lifetime, as for the agent spawn. */
    spawnTimeoutMs: number;
  },
): GuestMemoryTagReaper {
  if (!TAG_PATTERN.test(tag)) {
    throw new Error(`guest memory tag reaper: malformed spawn tag "${tag}"`);
  }
  const sweepTimeoutMs = options.sweepTimeoutMs ?? DEFAULT_SWEEP_TIMEOUT_MS;
  const child = spawnCommandWithTimeout(options.bashPath ?? "bash", {
    args: [
      "--norc",
      "--noprofile",
      "-c",
      SCRIPT,
      "guest-memory-tag-reaper",
      `${AGENT_SPAWN_TAG_ENV}=${tag}`,
    ],
    clearEnv: true,
    env: {},
    stdin: "piped",
    stdout: "piped",
    stderr: "null",
    timeoutMs: options.spawnTimeoutMs,
  });

  const encoder = new TextEncoder();
  const writer = child.stdin.getWriter();
  const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
  let buffered = "";

  /** The next line from the helper, or null at end of stream. */
  const nextLine = async (): Promise<string | null> => {
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        return line;
      }
      const { value, done } = await reader.read();
      if (done) return null;
      buffered += value;
    }
  };

  /** Send one sweep and read its answer. */
  const answer = async (): Promise<number> => {
    try {
      await writer.write(encoder.encode("sweep\n"));
    } catch (error) {
      throw new Error(
        `the tag reaper exited before answering: ${errorText(error)}`,
      );
    }
    const line = await nextLine();
    if (line === null) {
      throw new Error("the tag reaper exited before answering");
    }
    const match = SIGNALLED_LINE.exec(line);
    if (match === null) {
      throw new Error(`the tag reaper answered unexpectedly: "${line}"`);
    }
    return Number(match[1]);
  };

  let closing: Promise<void> | undefined;

  const close = (): Promise<void> => {
    closing ??= (async () => {
      try {
        await writer.close();
      } catch (error) {
        // A broken pipe means the helper has already gone.
        if (!(error instanceof Deno.errors.BrokenPipe)) throw error;
      } finally {
        try {
          child.kill("SIGKILL");
        } catch (error) {
          // Deno throws a TypeError once the child has been reaped.
          if (
            !(error instanceof TypeError &&
              /already terminated/.test(error.message))
          ) throw error;
        }
        await child.status;
        await reader.cancel().catch(() => {});
      }
    })();
    return closing;
  };

  const sweepOnce = async (): Promise<number> => {
    if (closing !== undefined) {
      throw new Error("the guest memory tag reaper is closed");
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(`the tag reaper did not answer within ${sweepTimeoutMs}ms`),
        );
        // The late answer would be read as the next sweep's, so the helper is closed.
        close().catch(() => {});
      }, sweepTimeoutMs);
    });
    try {
      return await Promise.race([answer(), timedOut]);
    } finally {
      clearTimeout(timer);
    }
  };

  // Sweeps run one after another, so two concurrent calls never share the pipe.
  let queue: Promise<void> = Promise.resolve();
  const sweep = (): Promise<number> => {
    const run = queue.then(sweepOnce);
    queue = run.then(() => {}, () => {});
    return run;
  };

  return { sweep, close };
}
