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
 * Scans the given directory for .log files and rotates any that exceed
 * the size threshold. Skips:
 *   - worker-*.log files (managed separately by cleanup_old_logs)
 *   - Symlinks (e.g., worker.log -> worker-PID.log)
 *   - Already-rotated files (only processes *.log, not *.log.N)
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
    // Process .log and .jsonl files. Rotated copies (e.g. .log.1) are
    // excluded by the extension check below — we only match files that
    // end with `.log` or `.jsonl` directly. .jsonl coverage added for
    // structured event logs such as self-heal.jsonl (Issue #1497).
    const isLog = entry.name.endsWith(".log");
    const isJsonl = entry.name.endsWith(".jsonl");
    if (!isLog && !isJsonl) {
      continue;
    }

    const fullPath = `${logDir}/${entry.name}`;

    // Skip symlinks (e.g., worker.log -> worker-PID.log)
    if (entry.isSymlink) {
      skippedCount++;
      continue;
    }

    // Skip worker-PID log files (managed by cleanup_old_logs in run_core.sh)
    if (/^worker-\d+\.log$/.test(entry.name)) {
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
