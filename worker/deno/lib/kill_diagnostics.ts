/**
 * Kill-time diagnostics (Issue #4382).
 *
 * When the agent dies from outside (SIGKILL, no watchdog of ours) the log
 * used to say only `raw_exit_code=137`. The question the operator asks is
 * "who was eating the VM at that moment?", so at the kill the runner
 * captures a bounded process table — the top processes by resident memory,
 * with the killed agent's own tree marked — and any kernel OOM lines it can
 * read, and carries them into the failure diagnostics beside the
 * memory-pressure reading (#4374).
 *
 * Portable: `ps -eo pid,ppid,rss,etime,args` on Linux and macOS (sorting is
 * done here, not by `ps`); `dmesg` is best-effort and usually unreadable
 * for an unprivileged user — its absence is reported, never fatal.
 *
 * **The argv is a secret sink (Issue #1217, SEC-1217-05).** `ps` reports the
 * full command line of every process on the host, and a credential handed to a
 * child on its command line is visible there to anyone who can run `ps`. This
 * table then reaches a public GitHub comment through `failure_message.ts`, so
 * each row is redacted **before** it is cut to the per-row budget: cutting first
 * splits a token, and every signature rule in `secret_redaction.ts` is anchored
 * on the credential's leading bytes, so the downstream pass would match nothing.
 * The `dmesg` capture is masked at its own source for the same reason, even
 * though its own cut is line-granular.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { redactSecrets } from "./secret_redaction.ts";

/** One `ps` row. */
export interface ProcessRow {
  pid: number;
  ppid: number;
  rssKb: number;
  elapsed: string;
  command: string;
}

/**
 * Parse `ps -eo pid,ppid,rss,etime,args` output (header tolerated).
 *
 * Redaction happens **here**, at the single point both consumers pass through
 * (the kill-time capture and the pre-kill memory-pressure warning), and before
 * {@link formatProcessTable} cuts each command to its per-row budget. A cut
 * lands mid-token, and every rule in `secret_redaction.ts` is anchored on the
 * credential's leading bytes, so redacting after the cut would match nothing
 * (Issue #1217, SEC-1217-05).
 *
 * @param text - Raw `ps` output, untruncated.
 * @returns One row per parseable line, with secret shapes already masked.
 */
export function parseProcessTable(text: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const raw of redactSecrets(text).split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const match = line.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!match) continue;
    const [, pid, ppid, rss, elapsed, command] = match;
    rows.push({
      pid: Number(pid),
      ppid: Number(ppid),
      rssKb: Number(rss),
      elapsed: elapsed ?? "",
      command: command ?? "",
    });
  }
  return rows;
}

/** Options for {@link formatProcessTable}. */
export interface FormatProcessTableOptions {
  /** The killed agent's pid — marked `[agent]`. */
  agentPid: number;
  /** Its known descendants (from the tracker snapshot) — marked `[agent-tree]`. */
  knownDescendants: readonly number[];
  /** Rows to keep (top by RSS). Default 8. */
  limit?: number;
  /** Command budget per row. Default 90. */
  maxCommandChars?: number;
}

function formatMib(rssKb: number): string {
  return `${Math.round(rssKb / 1024)} MiB`;
}

/** Top rows by RSS, one line each, bounded. */
export function formatProcessTable(
  rows: ProcessRow[],
  options: FormatProcessTableOptions,
): string {
  const limit = options.limit ?? 8;
  const maxCommandChars = options.maxCommandChars ?? 90;
  const known = new Set(options.knownDescendants);
  // Anything whose parent is a known member is part of the tree too.
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const inTree = (row: ProcessRow): boolean => {
    let cursor: ProcessRow | undefined = row;
    for (let hops = 0; cursor && hops < 32; hops++) {
      if (known.has(cursor.pid)) return true;
      if (cursor.pid === options.agentPid) return true;
      cursor = byPid.get(cursor.ppid);
      if (cursor && cursor.pid === cursor.ppid) break;
    }
    return false;
  };
  const top = [...rows]
    .sort((a, b) => b.rssKb - a.rssKb)
    .slice(0, limit);
  return top.map((row) => {
    const tag = row.pid === options.agentPid
      ? " [agent]"
      : inTree(row)
      ? " [agent-tree]"
      : "";
    const command = row.command.length > maxCommandChars
      ? `${row.command.slice(0, maxCommandChars - 1)}…`
      : row.command;
    return `pid=${row.pid} ppid=${row.ppid} rss=${formatMib(row.rssKb)} ` +
      `up=${row.elapsed}${tag} ${command}`;
  }).join("\n");
}

/** Injectable inputs for {@link captureKillDiagnostics}. */
export interface CaptureKillDiagnosticsOptions {
  agentPid: number;
  knownDescendants: readonly number[];
  /** `ps -eo pid,ppid,rss,etime,args`. Default: the real command. */
  runPs?: () => Promise<string>;
  /** `dmesg` tail. Default: the real command; unreadable → rejects. */
  readKernelLog?: () => Promise<string>;
  /** Read a small text file (cgroup accounting). Default: Deno.readTextFile. */
  readFile?: (path: string) => Promise<string>;
  limit?: number;
}

/**
 * The cgroup v2 memory files (Issue #4384) — inside the container VM these
 * are the definitive record: the limit the kill enforced, the peak usage
 * since boot, and how many OOM kills the kernel has performed.
 */
export const CGROUP_MEMORY_FILES = {
  max: "/sys/fs/cgroup/memory.max",
  current: "/sys/fs/cgroup/memory.current",
  peak: "/sys/fs/cgroup/memory.peak",
  events: "/sys/fs/cgroup/memory.events",
} as const;

function formatBytesShort(bytes: number): string {
  const gib = bytes / 1024 ** 3;
  if (gib >= 1) return `${gib.toFixed(1)} GiB`;
  return `${Math.round(bytes / 1024 ** 2)} MiB`;
}

/** One line of cgroup memory accounting, or `undefined` when unreadable. */
export async function describeCgroupMemory(
  readFile: (path: string) => Promise<string>,
): Promise<string | undefined> {
  const read = async (path: string): Promise<string | undefined> => {
    try {
      return (await readFile(path)).trim();
    } catch {
      return undefined;
    }
  };
  const max = await read(CGROUP_MEMORY_FILES.max);
  const current = await read(CGROUP_MEMORY_FILES.current);
  if (max === undefined && current === undefined) return undefined;
  const parts: string[] = [];
  const num = (v: string | undefined) =>
    v !== undefined && /^\d+$/.test(v) ? Number(v) : undefined;
  const cur = num(current);
  const mx = num(max);
  parts.push(
    `current=${cur !== undefined ? formatBytesShort(cur) : current ?? "?"}` +
      `/max=${mx !== undefined ? formatBytesShort(mx) : max ?? "?"}`,
  );
  const peak = num(await read(CGROUP_MEMORY_FILES.peak));
  if (peak !== undefined) parts.push(`peak=${formatBytesShort(peak)}`);
  const events = await read(CGROUP_MEMORY_FILES.events);
  if (events !== undefined) {
    const oomKill = events.match(/^oom_kill (\d+)$/m)?.[1];
    const oom = events.match(/^oom (\d+)$/m)?.[1];
    if (oomKill !== undefined) parts.push(`oom_kill=${oomKill}`);
    if (oom !== undefined) parts.push(`oom=${oom}`);
  }
  return parts.join(" ");
}

/** Options for {@link formatMemoryPressureWarning}. */
export interface MemoryPressureWarningOptions {
  reading: { level: string; totalBytes?: number; availableBytes?: number };
  rows: ProcessRow[];
  agentPid: number;
  knownDescendants: readonly number[];
  limit?: number;
  /** Cgroup accounting line, when known. */
  cgroup?: string;
}

/**
 * The pre-kill snapshot (Issue #4384): logged while the run is alive and the
 * pressure reads high, so the eventual victim is still in the table — the
 * post-kill table (#4382) only ever shows the survivors.
 */
export function formatMemoryPressureWarning(
  options: MemoryPressureWarningOptions,
): string {
  const r = options.reading;
  const numbers = r.availableBytes !== undefined && r.totalBytes !== undefined
    ? ` (${formatBytesShort(r.availableBytes)} of ${
      formatBytesShort(r.totalBytes)
    } available)`
    : "";
  const head = `Memory pressure ${r.level} during the agent run${numbers}` +
    (options.cgroup ? `; cgroup ${options.cgroup}` : "") +
    " — top processes by RSS (Issue #4384):";
  const table = formatProcessTable(options.rows, {
    agentPid: options.agentPid,
    knownDescendants: options.knownDescendants,
    limit: options.limit ?? 6,
  });
  return `${head}\n${table || "(none)"}`;
}

const OOM_LINE_RE = /out of memory|oom-kill|killed process|oom_reaper/i;

async function defaultRunPs(): Promise<string> {
  const out = await new Deno.Command("ps", {
    args: ["-eo", "pid,ppid,rss,etime,args"],
    stdout: "piped",
    stderr: "null",
  }).output();
  if (!out.success) throw new Error("ps failed");
  return new TextDecoder().decode(out.stdout);
}

async function defaultReadKernelLog(): Promise<string> {
  const out = await new Deno.Command("dmesg", {
    stdout: "piped",
    stderr: "null",
  }).output();
  if (!out.success) throw new Error("dmesg failed");
  // Masked at its own source (Issue #1217). This cut is line-granular so it
  // cannot split a token by itself, but the kernel ring buffer carries whatever
  // userspace logged into it, and redacting here keeps the captured text safe
  // whatever a later caller does with it.
  const text = redactSecrets(new TextDecoder().decode(out.stdout));
  // Keep the tail only — the OOM lines are the most recent.
  return text.split("\n").slice(-400).join("\n");
}

/**
 * Assemble the kill-time evidence as bounded text. Never throws: each
 * source that cannot be read says so in one line.
 */
export async function captureKillDiagnostics(
  options: CaptureKillDiagnosticsOptions,
): Promise<string> {
  const sections: string[] = [];
  try {
    const rows = parseProcessTable(await (options.runPs ?? defaultRunPs)());
    const table = formatProcessTable(rows, {
      agentPid: options.agentPid,
      knownDescendants: options.knownDescendants,
      limit: options.limit,
    });
    sections.push(
      `Top processes by RSS at the kill (${rows.length} total):\n${
        table || "(none)"
      }`,
    );
  } catch (err) {
    sections.push(
      `Top processes at the kill: process table unavailable (${
        err instanceof Error ? err.message : String(err)
      })`,
    );
  }
  const cgroup = await describeCgroupMemory(
    options.readFile ?? ((path) => Deno.readTextFile(path)),
  );
  sections.push(
    cgroup !== undefined
      ? `Cgroup memory: ${cgroup}`
      : "Cgroup memory: not readable here",
  );
  try {
    const log = await (options.readKernelLog ?? defaultReadKernelLog)();
    const oomLines = log.split("\n").filter((l) => OOM_LINE_RE.test(l))
      .slice(-5);
    if (oomLines.length > 0) {
      sections.push(`Kernel OOM lines:\n${oomLines.join("\n")}`);
    } else {
      sections.push("Kernel OOM lines: none in the readable dmesg tail");
    }
  } catch {
    sections.push("Kernel OOM lines: dmesg not readable here");
  }
  return sections.join("\n");
}
