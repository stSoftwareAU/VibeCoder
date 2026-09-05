/**
 * Start-of-run compression of prior worker logs (Issue #4027).
 *
 * `~/logs` accumulates one timestamp-named `worker-*.log` per run (#4227). The active run's log must
 * stay plain text (operators `tail -f` it), but every earlier run's log is
 * finished and only waiting for the age-based retention pass in
 * {@link ../lib/worker_log_cleanup.ts} to delete it. Compressing those at worker
 * start cuts the disk they occupy while they wait, and `zcat` still reads them.
 *
 * Behaviour:
 *
 *  - Only `worker-<digits>.log` files are compressed — rotated non-worker logs
 *    (`run_core.log.1`, `pull.log.1`, …) are left alone.
 *  - The current run's own log file is never touched.
 *  - Logs owned by a still-live PID are skipped, a cheap extra guard on top of
 *    the single-active-worker PID guard.
 *  - Header-only stubs below {@link DEFAULT_MIN_COMPRESS_BYTES} are skipped —
 *    gzip would grow them, and the retention pass deletes them anyway.
 *  - The `.gz` keeps the original's modification time, so age-based retention
 *    counts from the last write rather than from the compression.
 *
 * The summary names the directory it scanned and reconciles against it
 * (Issue #1021): `compressed 0, skipped 39` said nothing about which directory
 * held the 39 or why they were left, so an operator could not tell a genuine
 * backlog of header-only stubs from a miscount. It now reports the candidate
 * count and the disposition of every one of them, with each skip attributed to
 * its cause. A large `header-only stub(s) below the size floor` figure is the
 * signal it looks like: that many consecutive runs wrote nothing past their
 * header line, and they wait on the retention pass in
 * {@link ../lib/worker_log_cleanup.ts}, which deletes a stub older than an hour
 * from this same directory (in container mode the host's `$HOME/logs` is
 * bind-mounted to `/home/vibe/logs`, so there is one directory, not two).
 *
 * Fail-loud (Issue #3234): a compression failure leaves the source log intact,
 * removes the partial temporary file, and is reported in
 * {@link GzipWorkerLogsResult.failures} plus the summary message. Nothing is
 * swallowed, and no failure aborts worker start.
 *
 * Australian English spelling throughout (behaviour, organisation, authorised).
 */

/** Logs smaller than this many bytes are not worth compressing. */
export const DEFAULT_MIN_COMPRESS_BYTES = 200;

/**
 * Pattern matching both worker-log name shapes (not `.log.gz`): the
 * timestamp names of Issue #4227 (`worker-20260817-021352.log`, optional
 * `-<pid>` collision suffix) and the legacy `worker-<pid>.log`, so logs
 * written before the upgrade still compress and age out.
 */
const WORKER_LOG_PATTERN = /^worker-(\d+(?:-\d+)*)\.log$/;

/** Options controlling {@link gzipOldWorkerLogs}. */
export interface GzipWorkerLogsOptions {
  /**
   * The running worker's own log file (path or basename) — it stays plain
   * text. Keyed on the FILE, not the PID (Issue #4227): in container mode
   * every run is PID 1, so the PID key exempted the one accumulating file
   * that most needed compressing.
   */
  currentLogFile: string;
  /** Size floor below which a log is left uncompressed. */
  minCompressBytes?: number;
  /** Liveness probe for a log's owning PID (injectable for tests). */
  isRunning?: (pid: number) => Promise<boolean>;
}

/** A log that could not be compressed, with the reason. */
export interface GzipWorkerLogFailure {
  /** Absolute path of the source log. */
  path: string;
  /** Failure reason. */
  error: string;
}

/**
 * Why a candidate log was left uncompressed. The two reasons mean opposite
 * things — a stub is a run that logged nothing but its header, a live owner is
 * a log still being written — so one opaque total cannot serve both
 * (Issue #1021).
 */
export interface GzipWorkerLogsSkipReasons {
  /** Header-only stubs below the size floor; gzip would grow them. */
  belowSizeFloor: number;
  /** Legacy PID-named logs whose owning process is still running. */
  ownerStillRunning: number;
}

/** Result of a compression pass. */
export interface GzipWorkerLogsResult {
  /**
   * The directory that was scanned. Reported so the summary can be checked
   * against an `ls` of the same path (Issue #1021): `skipped 39` naming no
   * directory is unfalsifiable.
   */
  logDir: string;
  /**
   * Files matching the worker-log pattern that the pass saw, including the
   * current run's own log. Every candidate lands in exactly one of
   * {@link compressed}, {@link skipped}, {@link failures} or
   * {@link currentRunLogs}, so the arithmetic is auditable.
   */
  candidates: number;
  /** Absolute paths of the `.gz` files written. */
  compressed: string[];
  /** Count of candidate logs deliberately left uncompressed. */
  skipped: number;
  /** The {@link skipped} total broken down by cause (Issue #1021). */
  skippedByReason: GzipWorkerLogsSkipReasons;
  /** The current run's own log, left plain text (0 or 1). */
  currentRunLogs: number;
  /** Logs that failed to compress (source left intact). */
  failures: GzipWorkerLogFailure[];
  /** Human-readable summary. */
  message: string;
}

/**
 * Compress prior runs' `worker-<PID>.log` files in `logDir` to `.gz`.
 *
 * Safe to call on a missing or unreadable directory — it returns an empty
 * result rather than throwing.
 *
 * @param logDir - Directory holding worker logs (typically `~/logs`).
 * @param options - Current PID plus optional size floor / liveness probe.
 * @returns Which logs were compressed, skipped, or failed.
 */
export async function gzipOldWorkerLogs(
  logDir: string,
  options: GzipWorkerLogsOptions,
): Promise<GzipWorkerLogsResult> {
  const minBytes = options.minCompressBytes ?? DEFAULT_MIN_COMPRESS_BYTES;
  const isRunning = options.isRunning ?? createLivePidProbe();

  const candidates: {
    path: string;
    name: string;
    legacyPid: number | null;
    size: number;
  }[] = [];
  try {
    for await (const entry of Deno.readDir(logDir)) {
      if (!entry.isFile) continue;
      const match = WORKER_LOG_PATTERN.exec(entry.name);
      if (!match) continue;
      // A legacy all-digit name is a PID and gets the liveness guard; a
      // timestamp name (Issue #4227) has no owning PID to probe.
      const legacyPid = /^\d+$/.test(match[1]!) ? Number(match[1]) : null;
      const path = `${logDir}/${entry.name}`;
      try {
        const stat = await Deno.stat(path);
        candidates.push({ path, name: entry.name, legacyPid, size: stat.size });
      } catch {
        // Vanished between readDir and stat — nothing to compress.
      }
    }
  } catch {
    return {
      logDir,
      candidates: 0,
      compressed: [],
      skipped: 0,
      skippedByReason: { belowSizeFloor: 0, ownerStillRunning: 0 },
      currentRunLogs: 0,
      failures: [],
      message:
        `worker log gzip: ${logDir}: log directory missing or unreadable`,
    };
  }

  const compressed: string[] = [];
  const failures: GzipWorkerLogFailure[] = [];
  const skippedByReason: GzipWorkerLogsSkipReasons = {
    belowSizeFloor: 0,
    ownerStillRunning: 0,
  };
  let currentRunLogs = 0;

  const currentName = options.currentLogFile.split("/").pop();
  for (const candidate of candidates) {
    // The running worker's own log stays plain text — matched by file, so
    // container mode's every-run-is-PID-1 world exempts exactly one file
    // (Issue #4227). Counted rather than silently passed over, so the totals
    // add up to the files on disk (Issue #1021).
    if (candidate.name === currentName) {
      currentRunLogs++;
      continue;
    }
    if (candidate.size < minBytes) {
      skippedByReason.belowSizeFloor++;
      continue;
    }
    if (candidate.legacyPid !== null && await isRunning(candidate.legacyPid)) {
      skippedByReason.ownerStillRunning++;
      continue;
    }
    try {
      await compressFile(candidate.path);
      compressed.push(`${candidate.path}.gz`);
    } catch (err) {
      failures.push({
        path: candidate.path,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const skipped = skippedByReason.belowSizeFloor +
    skippedByReason.ownerStillRunning;

  // The summary reconciles against the directory itself: candidate count on
  // one side, every disposition on the other, and each skip named by cause
  // (Issue #1021). A rising "below the size floor" figure is then legible for
  // what it is — that many consecutive runs wrote nothing but a header line.
  let message = `worker log gzip: ${logDir}: ${candidates.length} worker ` +
    `log(s) present = compressed ${compressed.length} + skipped ${skipped} + ` +
    `failed ${failures.length} + current ${currentRunLogs}; skipped: ` +
    `${skippedByReason.belowSizeFloor} header-only stub(s) below the ` +
    `${minBytes}-byte size floor, ${skippedByReason.ownerStillRunning} owned ` +
    `by a live PID`;
  if (failures.length > 0) {
    message += `; failures: ${
      failures.map((f) => `${f.path}: ${f.error}`).join("; ")
    }`;
  }

  return {
    logDir,
    candidates: candidates.length,
    compressed,
    skipped,
    skippedByReason,
    currentRunLogs,
    failures,
    message,
  };
}

/**
 * Gzip a single file to `<path>.gz`, preserving its modification time, then
 * remove the source. Writes via a temporary file so an interrupted run never
 * leaves a truncated `.gz` in place of a real log.
 */
async function compressFile(path: string): Promise<void> {
  const tmpPath = `${path}.gz.tmp`;
  const gzPath = `${path}.gz`;
  const stat = await Deno.stat(path);
  const mtime = stat.mtime ?? new Date();

  try {
    const source = await Deno.open(path, { read: true });
    const dest = await Deno.create(tmpPath);
    await source.readable
      .pipeThrough(new CompressionStream("gzip"))
      .pipeTo(dest.writable);
    await Deno.utime(tmpPath, stat.atime ?? mtime, mtime);
    await Deno.rename(tmpPath, gzPath);
  } catch (err) {
    try {
      await Deno.remove(tmpPath);
    } catch {
      // Nothing to clean up — the temporary file was never created.
    }
    throw err;
  }

  await Deno.remove(path);
}

/**
 * Build a liveness probe backed by a single `ps` snapshot, so a directory of
 * hundreds of logs costs one process spawn rather than one per file.
 *
 * When `ps` is unavailable (e.g. the native Windows runtime) the snapshot is
 * `null` and every PID reads as not running: the single-active-worker PID guard
 * is then the only protection, which is the same guarantee the caller already
 * relies on for the current run's log.
 */
function createLivePidProbe(): (pid: number) => Promise<boolean> {
  let snapshot: Promise<Set<number> | null> | undefined;
  return async (pid) => {
    snapshot ??= listLivePids();
    const pids = await snapshot;
    return pids?.has(pid) ?? false;
  };
}

/** Snapshot every live PID, or `null` when the process table is unreadable. */
async function listLivePids(): Promise<Set<number> | null> {
  try {
    const output = await new Deno.Command("ps", {
      args: ["-A", "-o", "pid="],
      stdout: "piped",
      stderr: "null",
    }).output();
    if (!output.success) return null;
    const pids = new Set<number>();
    for (const line of new TextDecoder().decode(output.stdout).split("\n")) {
      const pid = parseInt(line.trim(), 10);
      if (!Number.isNaN(pid)) pids.add(pid);
    }
    return pids;
  } catch {
    return null;
  }
}
