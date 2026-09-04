/**
 * Work-volume I/O fault detection (Issue #229).
 *
 * After host GRQ-23 crashed out of disk its work volume came back with
 * ext4 errors — `ls` answered "Structure needs cleaning" inside the work
 * root. Had that landed inside a clone, the symptom would have been a git
 * call failing with EIO mid-run, reported as an *issue* failure, counted
 * against the issue's cooldown, and retried on the same broken volume
 * every hour.
 *
 * Every git invocation passes through `runGitCommand`; this module lets it
 * recognise the filesystem-level errors in git's stderr and record a
 * process-wide fault. The claim guards consult it the same way they
 * consult the host-disk status (Issue #226): a faulted volume claims
 * nothing new, the feature report shows `work-volume: degraded`, and the
 * telemetry notes name it. The launcher's volume-init repairs or
 * recreates the volume on the next launch.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { recordFaultEvent } from "./fault_tolerance_counters.ts";

/** Filesystem-level failures as git (and libc) spell them. */
const IO_FAULT_PATTERNS: ReadonlyArray<RegExp> = [
  /Structure needs cleaning/i,
  /Input\/output error/i,
  /Read-only file system/i,
  /Stale file handle/i,
  /Bad message/i,
];

export interface WorkVolumeFault {
  /** First matching line, trimmed. */
  detail: string;
  /** The git argv that surfaced it. */
  command: string;
  /** Epoch milliseconds. */
  at: number;
}

let currentFault: WorkVolumeFault | null = null;

/** The first I/O-fault line in some output, or null. */
export function findIoFaultLine(text: string): string | null {
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    if (IO_FAULT_PATTERNS.some((re) => re.test(line))) return line;
  }
  return null;
}

/**
 * Inspect a git invocation's output; record a fault when it names one.
 * Only the first fault is kept — it is the one that matters, and a wedged
 * volume would otherwise flood the counters.
 */
export function noteGitOutputForVolumeFault(
  args: readonly string[],
  stderr: string,
  stdout = "",
  now: () => number = Date.now,
): WorkVolumeFault | null {
  const line = findIoFaultLine(stderr) ?? findIoFaultLine(stdout);
  if (line === null) return null;
  if (currentFault === null) {
    currentFault = {
      detail: line,
      command: `git ${args.join(" ")}`,
      at: now(),
    };
    recordFaultEvent(
      "catch_block_warning",
      `work-volume fault: ${line} (git ${args.join(" ")}) (Issue #229)`,
    );
  }
  return currentFault;
}

/** The recorded fault, if any. */
export function workVolumeFault(): WorkVolumeFault | null {
  return currentFault;
}

/** Test seam. */
export function __resetWorkVolumeFault(): void {
  currentFault = null;
}
