/**
 * Size-based log rotation for unbounded log files.
 *
 * The worker manages count-based rotation for worker-N.log files, but other
 * log files (run_core.log, pull.log, run_guard.log, launchagent-*.log) grow
 * unbounded. This module adds size-based rotation to prevent disk exhaustion
 * on long-running unattended machines.
 *
 * Rotation scheme:
 *   app.log      -> app.log.1  (most recent backup)
 *   app.log.1    -> app.log.2
 *   app.log.2    -> app.log.3
 *   app.log.3    -> deleted (exceeds maxRotations)
 *
 * Only the worker's **own** log files are rotated (Issue #1267) — see
 * {@link isRotatableLogName}.
 *
 * Migrated from worker/shared/log_rotation.sh (Issue #902).
 * Issue #469: Size-based log rotation for unbounded log files.
 */

/** Default maximum log size in megabytes before rotation. */
export const DEFAULT_LOG_MAX_SIZE_MB = 10;

/** Default number of rotated copies to keep. */
export const DEFAULT_LOG_MAX_ROTATIONS = 3;

/** Options for log rotation. */
export interface LogRotationOptions {
  /** Maximum size in megabytes before rotation. */
  maxSizeMb?: number;
  /** Maximum number of rotated copies to keep. */
  maxRotations?: number;
}

/** Result of rotating all logs in a directory. */
export interface RotateAllResult {
  /** Number of files that were rotated. */
  rotatedCount: number;
  /** Number of files that were skipped. */
  skippedCount: number;
  /** Human-readable summary message. */
  message: string;
}

/**
 * The log files this pass owns, by name (Issue #1267).
 *
 * The pass used to rotate **any** name ending `.log` or `.jsonl`, and rotation
 * is destructive: `rotateLogFile` unlinks the oldest generation and renames the
 * rest, so a file it does not own is renamed out from under its owner and its
 * `.3` generation deleted. `log_dir` is operator-set and
 * `normaliseConfiguredLogDir` explicitly accepts the bare value `"~"`
 * (`lib/log_dir.ts`), resolving the log directory to the operator's `$HOME`,
 * which `container_launch.ts` then bind-mounts read-write at the container's
 * `~/logs`. Under that configuration `run_housekeeping.ts` turned a
 * `postgres.log` into `postgres.log.1` on every worker start, unattended, with
 * no `--dry-run` and no report-only mode.
 *
 * So the pass now names what it rotates, the same allowlist discipline
 * `isForeignDebrisName` applies to the sibling cleanup sweep. Each pattern
 * anchors on `.log` / `.jsonl` exactly, which keeps rotated backups (`.log.1`)
 * and gzipped copies (`.log.gz`) out. `worker-*.log` is deliberately absent —
 * its retention belongs to `lib/worker_log_cleanup.ts`.
 */
const ROTATABLE_LOG_PATTERNS: readonly RegExp[] = [
  // Run driver and git-update logs (`lib/checkout_update.ts`, `run_core.sh`).
  /^run_core\.log$/,
  /^run_guard\.log$/,
  /^pull\.log$/,
  // Tabletop rehearsal run log (`lib/tabletop_container_runner.ts`).
  /^tabletop-run\.log$/,
  // Launcher logs, including the macOS LaunchAgent's stdout/stderr.
  /^launch-[A-Za-z0-9._-]*\.log$/,
  /^launchagent-[A-Za-z0-9._-]*\.log$/,
  // Structured event logs (`lib/self_heal_events.ts`).
  /^self-heal\.jsonl$/,
  // Agent stream-json transcripts (`lib/agent_transcript.ts`).
  /^agent-[A-Za-z0-9._-]*\.jsonl$/,
];

/**
 * Whether a file in the log directory is one this pass may rotate.
 *
 * Exported so the refusal is testable against literal filenames.
 *
 * @param name - The bare file name (no directory part).
 * @returns True only when the name is one the worker's own ecosystem writes.
 */
export function isRotatableLogName(name: string): boolean {
  return ROTATABLE_LOG_PATTERNS.some((pattern) => pattern.test(name));
}

/**
 * Get the size of a file in bytes.
 *
 * @returns File size in bytes, or 0 if the file does not exist.
 */
export async function getFileSizeBytes(filePath: string): Promise<number> {
  try {
    const stat = await Deno.stat(filePath);
    return stat.size;
  } catch {
    return 0;
  }
}

/**
 * Rotate a single log file, shifting existing backups.
 *
 * 1. Deletes the oldest backup if it would exceed maxRotations
 * 2. Shifts all existing backups up by one (.1 -> .2, .2 -> .3, etc.)
 * 3. Moves the current file to .1
 *
 * No-op if the file does not exist.
 */
export async function rotateLogFile(
  filePath: string,
  maxRotations: number,
): Promise<void> {
  // Nothing to rotate if file does not exist
  try {
    await Deno.stat(filePath);
  } catch {
    return;
  }

  // Delete the oldest backup if it would be pushed beyond the limit
  try {
    await Deno.remove(`${filePath}.${maxRotations}`);
  } catch {
    // File may not exist — that is fine
  }

  // Shift existing backups up by one (N -> N+1, working from highest to lowest)
  for (let i = maxRotations - 1; i >= 1; i--) {
    try {
      await Deno.rename(`${filePath}.${i}`, `${filePath}.${i + 1}`);
    } catch {
      // Source file may not exist — skip
    }
  }

  // Move current file to .1
  try {
    await Deno.rename(filePath, `${filePath}.1`);
  } catch {
    // Best-effort — ignore errors
  }
}

/**
 * Check a single log file and rotate if it exceeds the size threshold.
 *
 * @returns true if the file was rotated.
 */
export async function checkAndRotateLog(
  filePath: string,
  maxSizeBytes: number,
  maxRotations: number,
): Promise<boolean> {
  const currentSize = await getFileSizeBytes(filePath);
  if (currentSize > maxSizeBytes) {
    await rotateLogFile(filePath, maxRotations);
    return true;
  }
  return false;
}

/**
 * Rotate all eligible log files in a directory.
 *
 * Scans the given directory and rotates any file the worker owns that exceeds
 * the size threshold. Skips:
 *   - Every name outside {@link isRotatableLogName}, which covers third-party
 *     files sharing the directory and `worker-*.log` (retained separately by
 *     `lib/worker_log_cleanup.ts`)
 *   - Symlinks (e.g., worker.log -> worker-PID.log)
 *   - Already-rotated and gzipped copies (`*.log.N`, `*.log.gz`)
 */
export async function rotateAllLogs(
  logDir: string,
  options: LogRotationOptions = {},
): Promise<RotateAllResult> {
  const maxSizeMb = options.maxSizeMb ?? DEFAULT_LOG_MAX_SIZE_MB;
  const maxRotations = options.maxRotations ?? DEFAULT_LOG_MAX_ROTATIONS;
  const maxSizeBytes = maxSizeMb * 1024 * 1024;

  let rotatedCount = 0;
  let skippedCount = 0;

  // Check directory exists
  try {
    const stat = await Deno.stat(logDir);
    if (!stat.isDirectory) {
      return {
        rotatedCount: 0,
        skippedCount: 0,
        message: `${logDir} is not a directory`,
      };
    }
  } catch {
    return {
      rotatedCount: 0,
      skippedCount: 0,
      message: `${logDir} does not exist`,
    };
  }

  for await (const entry of Deno.readDir(logDir)) {
    // Rotate only the worker's own log files (Issue #1267). A name this
    // ecosystem did not write is not this pass's business, however large it
    // grows — the directory is operator-set and can be their `$HOME`.
    // Rotated copies (`.log.1`) and gzipped ones (`.log.gz`) fall outside the
    // allowlist too, so a backup is never rotated again.
    if (!isRotatableLogName(entry.name)) {
      continue;
    }

    const fullPath = `${logDir}/${entry.name}`;

    // Skip symlinks (e.g., worker.log -> worker-PID.log)
    if (entry.isSymlink) {
      skippedCount++;
      continue;
    }

    const rotated = await checkAndRotateLog(
      fullPath,
      maxSizeBytes,
      maxRotations,
    );
    if (rotated) {
      rotatedCount++;
    } else {
      skippedCount++;
    }
  }

  return {
    rotatedCount,
    skippedCount,
    message: `Rotated ${rotatedCount} log file(s), skipped ${skippedCount}`,
  };
}
