/**
 * One-shot live-state diagnostic for the Vibe Coder worker (Issue #1905).
 *
 * Gathers data that an operator would otherwise assemble by hand —
 * supervisor processes, the active worker, recent log activity, GitHub
 * rate-limit quota, open work, and the recent merge histogram — and
 * formats it into a single terminal screen.
 *
 * Pure functions live here so the formatting layer can be unit-tested
 * with mocked data-gathering deps. The command wrapper in
 * `commands/diagnose.ts` wires up real `ps`/`gh`/filesystem calls.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.).
 */

/** Information about a `loop.sh` supervisor process. */
export interface SupervisorInfo {
  pid: number;
  ppid: number;
  /** `etime` string from ps (e.g. `40:23` or `01-15:32:10`). */
  elapsed: string;
  command: string;
  /** True when ppid===1 — the parent terminal has gone (Issue #1901). */
  orphan: boolean;
}

/** Information about the active worker process. */
export interface WorkerInfo {
  pidFile: string;
  /** The PID recorded in the file, or undefined if missing/invalid. */
  pidFromFile?: number;
  /** Whether the recorded PID is still running. */
  pidAlive: boolean;
  /** Path of the latest worker log (selected by mtime). */
  logPath?: string;
  /** Last-write age in seconds, or undefined when no log is available. */
  logAgeSeconds?: number;
  /** Last few lines of the worker log. */
  logTail: string[];
}

/** GitHub rate-limit quota. */
export interface RateLimitInfo {
  graphql?: { remaining: number; limit: number; resetEpoch: number };
  rest?: { remaining: number; limit: number; resetEpoch: number };
}

/** Counts of outstanding worker work. */
export interface OutstandingWork {
  openPRs: number;
  openIssues: number;
}

/** Recent merge histogram — count of merged PRs per UTC hour. */
export interface MergeHistogram {
  /** Keyed by `DDTHH` (e.g. `10T07`); values are merge counts. */
  buckets: Record<string, number>;
  /** Total merges in window. */
  total: number;
  /** Largest gap between merges, in hours. */
  largestGapHours: number;
  /** Start/end (UTC `DDTHH`) of the largest gap, if any. */
  largestGapRange?: { start: string; end: string };
}

/** Full diagnostic snapshot ready for formatting. */
export interface DiagnoseData {
  /** Time the diagnostic was collected (ISO 8601 UTC). */
  collectedAt: string;
  /** Hostname for orientation across machines. */
  hostname: string;
  supervisors: SupervisorInfo[];
  worker: WorkerInfo;
  rateLimit: RateLimitInfo;
  rateLimitSignal?: { active: boolean; remainingSeconds: number };
  outstanding?: OutstandingWork;
  merges: MergeHistogram;
}

/** Dependency injection for `gatherDiagnostics` — every external read goes through here. */
export interface DiagnoseDeps {
  /** Working directory where the run_core PID file lives. */
  pidFile: string;
  /** Directory containing worker-*.log files. */
  logDir: string;
  /** Current worker user (for `gh search` filters). */
  githubUser: string;
  /** Inject a clock so tests are deterministic. */
  now: () => Date;
  hostname: () => Promise<string>;
  /** Returns the raw multi-line `ps` output to parse. */
  psSupervisors: () => Promise<string>;
  /** True when the given PID is alive. */
  isRunning: (pid: number) => Promise<boolean>;
  /** Read the PID file contents (returns undefined on missing/empty). */
  readPidFile: (path: string) => Promise<string | undefined>;
  /** List worker-*.log files with their mtimes. */
  listLogs: (dir: string) => Promise<Array<{ path: string; mtime: Date }>>;
  /** Tail the last N lines of a log. */
  tailLog: (path: string, lines: number) => Promise<string[]>;
  /** Run `gh api rate_limit` and return the JSON body. */
  rateLimitJson: () => Promise<string>;
  /** Active rate-limit signal status, if any. */
  rateLimitSignal: () => Promise<
    { active: boolean; remainingSeconds: number } | undefined
  >;
  /** Counts of open PRs/issues authored/assigned to the worker. */
  outstandingWork: (user: string) => Promise<OutstandingWork | undefined>;
  /** Returns merged-at ISO timestamps for the worker over the last 24h. */
  recentMergedTimestamps: (user: string, since: Date) => Promise<string[]>;
}

/**
 * Parse `ps -axo pid=,etime=,ppid=,command=` output.
 *
 * Selects rows whose command line references `loop.sh`. Each row is
 * whitespace-delimited (the command field may itself contain spaces and
 * is the remainder of the line).
 */
export function parseSupervisors(psOutput: string): SupervisorInfo[] {
  const out: SupervisorInfo[] = [];
  for (const raw of psOutput.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    // Split into 4 fields: pid, etime, ppid, command-rest
    const match = line.match(/^(\d+)\s+(\S+)\s+(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = parseInt(match[1]!, 10);
    const elapsed = match[2]!;
    const ppid = parseInt(match[3]!, 10);
    const command = match[4]!;
    if (!/loop\.sh\b/.test(command)) continue;
    // Skip the diagnose process itself and any grep helpers.
    if (/\bgrep\b/.test(command)) continue;
    out.push({ pid, ppid, elapsed, command, orphan: ppid === 1 });
  }
  // Stable ordering: oldest first (ps `etime` parsing is non-trivial,
  // so fall back to PID ascending).
  out.sort((a, b) => a.pid - b.pid);
  return out;
}

/** Parse the JSON returned by `gh api rate_limit` into the subset we display. */
export function parseRateLimit(json: string): RateLimitInfo {
  try {
    const parsed = JSON.parse(json) as {
      resources?: {
        graphql?: { limit: number; remaining: number; reset: number };
        core?: { limit: number; remaining: number; reset: number };
      };
    };
    const info: RateLimitInfo = {};
    const g = parsed.resources?.graphql;
    if (g && typeof g.remaining === "number") {
      info.graphql = {
        remaining: g.remaining,
        limit: g.limit,
        resetEpoch: g.reset,
      };
    }
    const c = parsed.resources?.core;
    if (c && typeof c.remaining === "number") {
      info.rest = {
        remaining: c.remaining,
        limit: c.limit,
        resetEpoch: c.reset,
      };
    }
    return info;
  } catch {
    return {};
  }
}

/**
 * Build an hourly UTC histogram from a list of ISO merge timestamps,
 * keyed by `DDTHH` so the formatter can render `10T07=6` style buckets.
 */
export function buildMergeHistogram(
  timestamps: string[],
  now: Date,
): MergeHistogram {
  const windowMs = 24 * 3600 * 1000;
  const cutoff = now.getTime() - windowMs;
  const buckets: Record<string, number> = {};
  const filled = new Set<string>();
  for (const ts of timestamps) {
    const t = Date.parse(ts);
    if (!Number.isFinite(t) || t < cutoff || t > now.getTime()) continue;
    const d = new Date(t);
    const key = `${pad2(d.getUTCDate())}T${pad2(d.getUTCHours())}`;
    buckets[key] = (buckets[key] ?? 0) + 1;
    filled.add(key);
  }
  // Walk the 24 1-hour buckets in the window to detect the largest gap.
  let largestGap = 0;
  let gapStart = "";
  let gapEnd = "";
  let curGap = 0;
  let curGapStartIdx = -1;
  const ordered: Array<{ key: string; filled: boolean }> = [];
  for (let i = 24; i >= 1; i--) {
    const d = new Date(now.getTime() - i * 3600 * 1000);
    const key = `${pad2(d.getUTCDate())}T${pad2(d.getUTCHours())}`;
    ordered.push({ key, filled: filled.has(key) });
  }
  for (let i = 0; i < ordered.length; i++) {
    const slot = ordered[i];
    if (slot === undefined) continue;
    if (!slot.filled) {
      if (curGap === 0) curGapStartIdx = i;
      curGap++;
      if (curGap > largestGap) {
        largestGap = curGap;
        const startSlot = ordered[curGapStartIdx];
        gapStart = startSlot !== undefined ? startSlot.key : "";
        gapEnd = slot.key;
      }
    } else {
      curGap = 0;
      curGapStartIdx = -1;
    }
  }
  const total = Object.values(buckets).reduce((a, b) => a + b, 0);
  const result: MergeHistogram = {
    buckets,
    total,
    largestGapHours: largestGap,
  };
  if (largestGap > 0) result.largestGapRange = { start: gapStart, end: gapEnd };
  return result;
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

/**
 * Format a Unix epoch (seconds) as ISO 8601 UTC (e.g. `23:11:13Z`).
 */
export function formatResetTime(epoch: number): string {
  if (!Number.isFinite(epoch) || epoch <= 0) return "n/a";
  const d = new Date(epoch * 1000);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${
    pad2(d.getUTCSeconds())
  }Z`;
}

/**
 * Render a duration in seconds as `Nm`, `Nh Mm`, or `Nd` for human reading.
 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "n/a";
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  return `${Math.floor(seconds / 86400)}d`;
}

/**
 * Render the diagnostic snapshot as a single ~30-line terminal screen.
 *
 * Sections that have no data degrade to a single line (e.g. `n/a`)
 * rather than disappearing — operators benefit from knowing which
 * probes returned nothing.
 */
export function formatDiagnostics(data: DiagnoseData): string {
  const lines: string[] = [];
  lines.push(
    `Vibe-Coder worker diagnostic — ${data.collectedAt} (current host: ${data.hostname})`,
  );
  lines.push("");

  // Supervisors
  lines.push("Supervisors (loop.sh):");
  if (data.supervisors.length === 0) {
    lines.push("  (none running)");
  } else {
    lines.push("  PID       ELAPSED        PPID   STATUS");
    for (const s of data.supervisors) {
      const status = s.orphan
        ? "ORPHAN — survived terminal close (#1901)"
        : "active";
      lines.push(
        `  ${String(s.pid).padEnd(9)} ${s.elapsed.padEnd(14)} ${
          String(s.ppid).padEnd(6)
        } ${status}`,
      );
    }
  }
  lines.push("");

  // Worker
  lines.push("Worker:");
  if (data.worker.pidFromFile && data.worker.pidAlive) {
    lines.push(`  Active PID:    ${data.worker.pidFromFile}`);
  } else if (data.worker.pidFromFile) {
    lines.push(
      `  Active PID:    ${data.worker.pidFromFile} (stale — not running)`,
    );
  } else {
    lines.push(`  Active PID:    n/a`);
  }
  lines.push(`  PID file:      ${data.worker.pidFile}`);
  if (data.worker.logPath) {
    const ageStr = data.worker.logAgeSeconds !== undefined
      ? `last write ${formatDuration(data.worker.logAgeSeconds)} ago`
      : "last write n/a";
    lines.push(`  Log:           ${data.worker.logPath} (${ageStr})`);
  } else {
    lines.push(`  Log:           n/a`);
  }
  lines.push("");

  // Last activity
  lines.push("Last activity:");
  if (data.worker.logTail.length === 0) {
    lines.push("  (no log content available)");
  } else {
    for (const line of data.worker.logTail) {
      lines.push(`  ${line}`);
    }
  }
  lines.push("");

  // Rate limit
  lines.push("GitHub rate limit:");
  if (data.rateLimit.graphql) {
    const g = data.rateLimit.graphql;
    lines.push(
      `  GraphQL: ${g.remaining} / ${g.limit} remaining, reset ${
        formatResetTime(g.resetEpoch)
      }`,
    );
  } else {
    lines.push(`  GraphQL: n/a`);
  }
  if (data.rateLimit.rest) {
    const r = data.rateLimit.rest;
    lines.push(
      `  REST:    ${r.remaining} / ${r.limit} remaining, reset ${
        formatResetTime(r.resetEpoch)
      }`,
    );
  } else {
    lines.push(`  REST:    n/a`);
  }
  if (data.rateLimitSignal && data.rateLimitSignal.active) {
    lines.push(
      `  Signal:  ACTIVE — worker paused for ${
        formatDuration(data.rateLimitSignal.remainingSeconds)
      } (#1903)`,
    );
  }
  lines.push("");

  // Outstanding work
  if (data.outstanding) {
    lines.push(
      `Worker has ${data.outstanding.openPRs} open PRs and ${data.outstanding.openIssues} open self-assigned issues. See \`gh search prs --author ${
        quoteForShell(data.worker, data)
      } --state open\`.`,
    );
  } else {
    lines.push("Worker outstanding work: n/a");
  }
  lines.push("");

  // Merge histogram
  lines.push("Recent merges by worker (last 24h, by hour UTC):");
  const keys = Object.keys(data.merges.buckets).sort();
  if (keys.length === 0) {
    lines.push("  (no merges in last 24h)");
  } else {
    const cells = keys.map((k) => `${k}=${data.merges.buckets[k]}`);
    // Wrap at ~70 chars per line for readability.
    let row = "  ";
    for (const cell of cells) {
      if ((row + cell).length > 72) {
        lines.push(row.trimEnd());
        row = "  ";
      }
      row += cell + "  ";
    }
    if (row.trim().length > 0) lines.push(row.trimEnd());
  }

  if (
    data.merges.total > 0 &&
    data.merges.largestGapHours >= 3 &&
    data.merges.largestGapRange
  ) {
    lines.push("");
    lines.push(
      `⚠ ${data.merges.largestGapHours}-hour merge gap detected between ${data.merges.largestGapRange.start} and ${data.merges.largestGapRange.end} — worker may have stalled. Inspect worker-*.log.`,
    );
  }

  return lines.join("\n");
}

/** Render the worker's gh username — falls back to a placeholder when unknown. */
function quoteForShell(_w: WorkerInfo, data: DiagnoseData): string {
  // Stored on the data so the formatter does not need its own dep.
  return (data as DiagnoseData & { _user?: string })._user ?? "<worker>";
}

/**
 * Gather diagnostic data using the injected deps. Every external call is
 * wrapped so a single failure degrades that section to `n/a` rather than
 * aborting the whole report — the diagnostic is meant to *summarise*
 * partial state.
 */
export async function gatherDiagnostics(
  deps: DiagnoseDeps,
): Promise<DiagnoseData> {
  const now = deps.now();
  const collectedAt = now.toISOString().replace(/\.\d{3}Z$/, "Z");

  const hostname = await safe(() => deps.hostname(), "unknown-host");

  const supervisors = parseSupervisors(
    await safe(() => deps.psSupervisors(), ""),
  );

  // Worker info
  const pidRaw = await safe(() => deps.readPidFile(deps.pidFile), undefined);
  let pidFromFile: number | undefined;
  if (pidRaw) {
    const n = parseInt(pidRaw.trim().split(/\s+/)[0] ?? "", 10);
    if (Number.isFinite(n) && n > 0) pidFromFile = n;
  }
  const pidAlive = pidFromFile !== undefined
    ? await safe(() => deps.isRunning(pidFromFile!), false)
    : false;

  const logs = await safe(() => deps.listLogs(deps.logDir), []);
  logs.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  const latest = logs[0];
  let logTail: string[] = [];
  let logAgeSeconds: number | undefined;
  if (latest) {
    logTail = await safe(() => deps.tailLog(latest.path, 4), []);
    logAgeSeconds = Math.max(
      0,
      Math.floor((now.getTime() - latest.mtime.getTime()) / 1000),
    );
  }

  const worker: WorkerInfo = {
    pidFile: deps.pidFile,
    pidAlive,
    logTail,
    ...(pidFromFile !== undefined ? { pidFromFile } : {}),
    ...(latest ? { logPath: latest.path } : {}),
    ...(logAgeSeconds !== undefined ? { logAgeSeconds } : {}),
  };

  const rateLimit = parseRateLimit(
    await safe(() => deps.rateLimitJson(), "{}"),
  );
  const rateLimitSignal = await safe(() => deps.rateLimitSignal(), undefined);

  const outstanding = await safe(
    () => deps.outstandingWork(deps.githubUser),
    undefined,
  );

  const since = new Date(now.getTime() - 24 * 3600 * 1000);
  const merges = buildMergeHistogram(
    await safe(() => deps.recentMergedTimestamps(deps.githubUser, since), []),
    now,
  );

  const data: DiagnoseData = {
    collectedAt,
    hostname,
    supervisors,
    worker,
    rateLimit,
    merges,
    ...(rateLimitSignal ? { rateLimitSignal } : {}),
    ...(outstanding ? { outstanding } : {}),
  };
  // Stash the user so the formatter can echo the gh hint without an extra
  // arg — keeps the public signature `formatDiagnostics(data)` simple.
  (data as DiagnoseData & { _user?: string })._user = deps.githubUser;
  return data;
}

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}
