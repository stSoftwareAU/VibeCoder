/**
 * Descendant-CPU progress probe (Issue #508, part of #4290).
 *
 * The progress-extension gate asked two questions — is the agent calling
 * tools, and is the checkout changing — and killed whenever the second
 * answer was no. That punishes the agent that is doing exactly the right
 * thing: supervising a job it started (a training run, an evolution sweep, a
 * build), polling it every few seconds and changing not one byte of the tree
 * while it waits. On `stSoftwareAU/GRQ` that became the dominant timeout
 * mode: four of five refusals read `working tree unchanged despite tool
 * activity 26s ago`.
 *
 * This module is the missing signal, standalone and reusable: **work that is
 * external to the checkout**. One `ps -eo pid=,ppid=,time=` read is walked
 * into the agent's descendant subtree, and the CPU time those descendants
 * have accumulated is compared with the previous read. CPU burnt between two
 * probes is work; a subtree that burns none — the classic `sleep 60` poll
 * loop with nothing behind it — is not.
 *
 * Three properties shape it, mirroring `worktree_progress.ts`:
 *
 *   - **Bounded.** The `ps` read goes through `runWithTimeout`, so a wedged
 *     process table can never hold the deadline check open.
 *   - **Fail-safe direction is explicit.** A read that fails yields
 *     `ok: false`, and comparing any failed snapshot yields `unknown` —
 *     deliberately distinct from `idle`. Neither earns an extension, so a
 *     signal that cannot be evaluated is never a way to buy time (Issue
 *     #4294's direction, kept).
 *   - **The agent's own CPU never counts.** The agent burns CPU on every tool
 *     call, so including it would make every run look busy and the gate would
 *     stop refusing anything. Only descendants count.
 *
 * Known limitation: a descendant detached from the agent's tree (a `nohup`ed
 * job re-parented to init) is no longer a descendant and is not seen — the
 * same blind spot `orphan_collector.ts` documents. An I/O-bound job that
 * burns no CPU is likewise invisible; the tree signal and the tool-activity
 * signal still cover their own ground.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { parseEtimeToSeconds } from "./pid_guard.ts";
import { runWithTimeout } from "./subprocess_timeout.ts";

/** Default timeout for the single `ps` read: 5 seconds. */
export const DEFAULT_CPU_PROBE_TIMEOUT_MS = 5_000;

/**
 * CPU seconds a descendant subtree must accumulate between two probes before
 * it counts as work.
 *
 * `ps` reports CPU time at one-second granularity on Linux, so anything under
 * a second is noise rather than evidence.
 */
export const DEFAULT_MIN_CPU_SECONDS_DELTA = 1;

/** How a descendant subtree looked between two probes. */
export type DescendantActivityOutcome = "active" | "idle" | "unknown";

/** One row of `ps -eo pid=,ppid=,time=`. */
export interface CpuTableRow {
  pid: number;
  ppid: number;
  /** CPU seconds this process has consumed since it started. */
  cpuSeconds: number;
}

/** A point-in-time reading of one agent's descendant subtree. */
export interface DescendantCpuSnapshot {
  /** Whether the read succeeded. False means the numbers are meaningless. */
  ok: boolean;
  /** CPU seconds accumulated by every live descendant, agent excluded. */
  cpuSeconds: number;
  /** How many live descendants were seen. */
  descendants: number;
  /** Epoch-ms at which the read was taken. */
  takenAtMs: number;
  /** Why the read failed, or "" when it succeeded. */
  reason: string;
}

/** Result of comparing two snapshots of the same agent's subtree. */
export interface DescendantActivityComparison {
  /**
   * `active` — the subtree burnt CPU between the two probes.
   * `idle` — both reads succeeded and no meaningful CPU was burnt.
   * `unknown` — at least one read failed; no conclusion is available.
   */
  outcome: DescendantActivityOutcome;
  /** CPU seconds accumulated between the probes; 0 when unknown. */
  cpuSecondsDelta: number;
  /** One line naming what decided the outcome. */
  reason: string;
}

/** Options for {@link probeDescendantCpu}. */
export interface DescendantProbeOptions {
  /** Process-table reader, injected so tests need no real workload. */
  runPs?: () => Promise<string>;
  /** Timeout for the `ps` read in ms. Defaults to {@link DEFAULT_CPU_PROBE_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Clock, injectable for tests. Returns epoch ms. */
  now?: () => number;
}

/** Options for {@link compareDescendantCpu}. */
export interface DescendantCompareOptions {
  /** CPU seconds that count as work. Defaults to {@link DEFAULT_MIN_CPU_SECONDS_DELTA}. */
  minCpuSecondsDelta?: number;
}

/**
 * Parse one `ps` CPU-time field into seconds.
 *
 * Accepts every shape `ps` prints: `[DD-]HH:MM:SS` and `MM:SS` (Linux), each
 * optionally carrying a fractional part (`0:00.50` on macOS).
 *
 * @param raw - The raw field.
 * @returns Seconds, or null when the field is not a CPU time.
 */
export function parseCpuSeconds(raw: string): number | null {
  const text = raw.trim();
  if (!text) return null;
  const fraction = text.match(/^(.*)\.(\d+)$/);
  const whole = fraction?.[1] ?? text;
  const seconds = parseEtimeToSeconds(whole);
  if (seconds === null) return null;
  return fraction ? seconds + Number(`0.${fraction[2]}`) : seconds;
}

/**
 * Parse `ps -eo pid=,ppid=,time=` output.
 *
 * Tolerant by design — a header line, a blank line or a row in an
 * unrecognised CPU-time format is skipped rather than failing the read.
 *
 * @param text - Raw `ps` stdout.
 * @returns One row per parseable process.
 */
export function parseCpuTable(text: string): CpuTableRow[] {
  const rows: CpuTableRow[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const match = line.match(/^(\d+)\s+(\d+)\s+(\S+)$/);
    if (!match) continue;
    const cpuSeconds = parseCpuSeconds(match[3] ?? "");
    if (cpuSeconds === null) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      cpuSeconds,
    });
  }
  return rows;
}

/**
 * Sum the CPU time of every descendant of `agentPid`.
 *
 * The agent's own row is excluded: it burns CPU on every tool call, so
 * counting it would make a spinning run indistinguishable from a supervising
 * one — the very confusion this signal exists to resolve.
 *
 * @param rows - Parsed process table.
 * @param agentPid - The agent process whose subtree is summed.
 * @returns Descendant count and their total CPU seconds.
 */
export function sumDescendantCpu(
  rows: readonly CpuTableRow[],
  agentPid: number,
): { cpuSeconds: number; descendants: number } {
  const children = new Map<number, CpuTableRow[]>();
  for (const row of rows) {
    const siblings = children.get(row.ppid);
    if (siblings) siblings.push(row);
    else children.set(row.ppid, [row]);
  }

  let cpuSeconds = 0;
  let descendants = 0;
  const seen = new Set<number>([agentPid]);
  const queue = [agentPid];
  while (queue.length > 0) {
    const parent = queue.shift() as number;
    for (const child of children.get(parent) ?? []) {
      // A cycle in the reported table (or a pid that is its own parent) must
      // never spin this walk.
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      descendants++;
      cpuSeconds += child.cpuSeconds;
      queue.push(child.pid);
    }
  }
  return { cpuSeconds, descendants };
}

/** Read the process table with a bounded `ps`. */
async function defaultRunPs(timeoutMs: number): Promise<string> {
  const result = await runWithTimeout(
    "ps",
    ["-eo", "pid=,ppid=,time="],
    { timeoutMs },
  );
  if (!result.ok) throw new Error(`ps failed: ${result.error.message}`);
  if (result.value.timedOut) {
    throw new Error(`ps timed out after ${timeoutMs}ms`);
  }
  if (!result.value.success) {
    throw new Error(`ps exited ${result.value.code}`);
  }
  return result.value.stdout;
}

/**
 * Read the CPU time accumulated by one agent's descendant subtree.
 *
 * Never throws: a `ps` that cannot be run, times out or returns nothing
 * usable comes back as `ok: false`, which {@link compareDescendantCpu} turns
 * into `unknown`.
 *
 * @param agentPid - The agent process whose descendants are measured.
 * @param options - Reader, timeout and clock overrides.
 * @returns The snapshot, successful or not.
 */
export async function probeDescendantCpu(
  agentPid: number,
  options?: DescendantProbeOptions,
): Promise<DescendantCpuSnapshot> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_CPU_PROBE_TIMEOUT_MS;
  const now = options?.now ?? Date.now;
  const takenAtMs = now();
  const failed = (reason: string): DescendantCpuSnapshot => ({
    ok: false,
    cpuSeconds: 0,
    descendants: 0,
    takenAtMs,
    reason,
  });

  let stdout: string;
  try {
    stdout = options?.runPs
      ? await options.runPs()
      : await defaultRunPs(timeoutMs);
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }

  const rows = parseCpuTable(stdout);
  if (rows.length === 0) {
    // The agent and this worker are both in the table, so an empty parse is
    // a broken read — never "the agent has no descendants".
    return failed("ps returned no parseable rows");
  }

  const summed = sumDescendantCpu(rows, agentPid);
  return {
    ok: true,
    cpuSeconds: summed.cpuSeconds,
    descendants: summed.descendants,
    takenAtMs,
    reason: "",
  };
}

/**
 * Compare two snapshots of the same agent's descendant subtree.
 *
 * @param previous - The earlier snapshot.
 * @param current - The snapshot just taken.
 * @param options - Minimum CPU delta that counts as work.
 * @returns Whether external work happened between the two reads.
 */
export function compareDescendantCpu(
  previous: DescendantCpuSnapshot,
  current: DescendantCpuSnapshot,
  options?: DescendantCompareOptions,
): DescendantActivityComparison {
  if (!previous.ok || !current.ok) {
    const reason = (!current.ok ? current.reason : previous.reason) ||
      "descendant probe unavailable";
    return { outcome: "unknown", cpuSecondsDelta: 0, reason };
  }

  const cpuSecondsDelta = current.cpuSeconds - previous.cpuSeconds;
  const minDelta = options?.minCpuSecondsDelta ?? DEFAULT_MIN_CPU_SECONDS_DELTA;
  if (cpuSecondsDelta >= minDelta) {
    return {
      outcome: "active",
      cpuSecondsDelta,
      reason: `${current.descendants} live descendant(s) burnt ` +
        `${Math.round(cpuSecondsDelta)}s of CPU since the last check`,
    };
  }

  return {
    outcome: "idle",
    cpuSecondsDelta: Math.max(0, cpuSecondsDelta),
    reason: current.descendants === 0
      ? "no live descendant of the agent"
      : `${current.descendants} live descendant(s) burnt no CPU since the ` +
        `last check`,
  };
}
