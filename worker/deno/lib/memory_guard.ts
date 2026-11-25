/**
 * In-guest early-OOM guard for the agent run (Issue #5529).
 *
 * The container guest has no swap, and the kernel does not OOM-kill before
 * it thrashes. A heavy build in one agent run's tree (six `/usr/bin/ld`
 * linkers at about 1.9 GiB each in a 15.7 GiB guest) drove available memory
 * from 1.1 GiB to 168 MiB in ten seconds. The guest then stopped answering
 * `container exec`, and the launcher reaped every lane. The guard acts before
 * that point: when available memory is below a floor, it SIGKILLs the largest
 * process in the agent run's own tree, so the agent's work fails alone and the
 * guest survives.
 *
 * The floor and the victim choice are pure. {@link killMemoryGuardVictim}
 * sends the one signal, and only to a pid it can prove is still the process it
 * chose and still in the agent run's tree (CODING-STANDARDS.md, "Never signal
 * a pid you cannot prove is still yours"). The runner's memory watch
 * (`claude_runner.ts`) owns the probe, the process table and the log lines. A
 * reading that carries no byte counts (the darwin pressure level, or an
 * unknown reading) never triggers the guard.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  agentTreeMembership,
  formatBytesShort,
  parseProcessTable,
  type ProcessRow,
} from "./kill_diagnostics.ts";
import type { MemoryPressureReading } from "./memory_pressure.ts";
import {
  captureProcessIdentity,
  getStartTime,
  isSameProcess,
  type ProcessIdentity,
} from "./pid_guard.ts";

/** The floor as a share of total guest memory. */
export const MEMORY_GUARD_FLOOR_FRACTION = 0.03;

/** The floor never drops below this, so a small guest still has headroom. */
export const MEMORY_GUARD_FLOOR_MIN_BYTES = 256 * 1024 * 1024;

/**
 * The smallest process the guard will kill. A tree whose largest member is
 * smaller than this is not what is wedging the guest, so nothing is killed.
 */
export const MEMORY_GUARD_MIN_VICTIM_RSS_KB = 256 * 1024;

/** The command cut for the kill line, in characters (ellipsis included). */
const KILL_LINE_COMMAND_CHARS = 90;

/** The guard's floor for a guest of `totalBytes`: 3%, but never under 256 MiB. */
export function memoryGuardFloorBytes(totalBytes: number): number {
  return Math.max(
    MEMORY_GUARD_FLOOR_FRACTION * totalBytes,
    MEMORY_GUARD_FLOOR_MIN_BYTES,
  );
}

/**
 * Whether a reading is below the guard's floor. Only a reading with numeric
 * `totalBytes` and `availableBytes` can be below it; anything else (darwin,
 * unknown) is not.
 */
export function isBelowMemoryGuardFloor(
  reading: MemoryPressureReading,
): boolean {
  const { totalBytes, availableBytes } = reading;
  if (typeof totalBytes !== "number" || typeof availableBytes !== "number") {
    return false;
  }
  if (!Number.isFinite(totalBytes) || !Number.isFinite(availableBytes)) {
    return false;
  }
  return availableBytes < memoryGuardFloorBytes(totalBytes);
}

/** Inputs for {@link selectMemoryGuardVictim}. */
export interface MemoryGuardVictimOptions {
  reading: MemoryPressureReading;
  /** The `ps` table, parsed. */
  rows: readonly ProcessRow[];
  /** The agent run's pid. It is never chosen, only its descendants are. */
  agentPid: number;
  /** The worker's own pid, never chosen. Defaults to `Deno.pid`. */
  selfPid?: number;
}

/**
 * The process the guard kills, or undefined when there is nothing to kill.
 *
 * Undefined unless the reading is below the floor. Otherwise it is the
 * largest-RSS row whose live parent chain in `rows` reaches the agent, is not
 * the agent itself, is not the worker, and is at least
 * {@link MEMORY_GUARD_MIN_VICTIM_RSS_KB}.
 *
 * The descendant snapshot (Issue #4382) is deliberately not used here. A
 * snapshot pid with no live chain to the agent may have been reaped and
 * reissued to a stranger since the snapshot, and nothing in the table can
 * prove otherwise, so the guard never chooses it.
 */
export function selectMemoryGuardVictim(
  options: MemoryGuardVictimOptions,
): ProcessRow | undefined {
  if (!isBelowMemoryGuardFloor(options.reading)) return undefined;
  const selfPid = options.selfPid ?? Deno.pid;
  const inTree = agentTreeMembership(options.rows, options.agentPid, []);
  let victim: ProcessRow | undefined;
  for (const row of options.rows) {
    if (row.pid === options.agentPid || row.pid === selfPid) continue;
    if (row.rssKb < MEMORY_GUARD_MIN_VICTIM_RSS_KB) continue;
    if (!inTree(row)) continue;
    if (victim === undefined || row.rssKb > victim.rssKb) victim = row;
  }
  return victim;
}

/** Inputs for {@link formatMemoryGuardKill}. */
export interface MemoryGuardKillOptions {
  reading: MemoryPressureReading;
  /** The process the guard killed. */
  victim: ProcessRow;
  /** The floor the reading fell below, in bytes. */
  floorBytes: number;
}

/**
 * The one-line evidence for a guard kill (Issue #5529). The command is already
 * redacted by `parseProcessTable`; it is cut here to
 * {@link KILL_LINE_COMMAND_CHARS} characters, ellipsis included.
 */
export function formatMemoryGuardKill(options: MemoryGuardKillOptions): string {
  const { reading, victim, floorBytes } = options;
  const available = reading.availableBytes === undefined
    ? "unknown"
    : formatBytesShort(reading.availableBytes);
  const total = reading.totalBytes === undefined
    ? "unknown"
    : formatBytesShort(reading.totalBytes);
  const command = victim.command.length > KILL_LINE_COMMAND_CHARS
    ? `${victim.command.slice(0, KILL_LINE_COMMAND_CHARS - 1)}…`
    : victim.command;
  const rssMib = Math.round(victim.rssKb / 1024);
  return `Guest memory critically low (${available} of ${total} available, ` +
    `floor ${formatBytesShort(floorBytes)}) — killed pid=${victim.pid} ` +
    `rss=${rssMib} MiB ${command}, the largest process in this agent run's ` +
    `tree, so the guest does not wedge (Issue #5529)`;
}

/** Injectable seams for {@link killMemoryGuardVictim}. */
export interface MemoryGuardKillDeps {
  /** A process's absolute start time; "" when the pid holds nothing. */
  readStartTime?: (pid: number) => Promise<string>;
  /** `ps -eo pid,ppid,rss,etime,args`, re-read to prove tree membership. */
  runPs: () => Promise<string>;
  /** The SIGKILL itself. May throw; the caller logs the failure. */
  kill: (pid: number) => void;
}

/** Inputs for {@link killMemoryGuardVictim}. */
export interface KillMemoryGuardVictimOptions {
  /** The process {@link selectMemoryGuardVictim} chose. */
  victim: ProcessRow;
  /** The agent run's pid, the root of the tree the victim must be in. */
  agentPid: number;
  /**
   * The agent's fingerprint, taken at spawn. `null` (it could not be taken)
   * means the tree's root is unproven, so nothing is signalled.
   */
  agentIdentity: ProcessIdentity | null;
}

/** What {@link killMemoryGuardVictim} did. */
export type MemoryGuardKillOutcome =
  | { killed: true }
  | { killed: false; reason: string };

/**
 * SIGKILL the chosen victim, but only when it is provably still the process
 * that was chosen and still in the agent run's tree (Issue #5529).
 *
 * The order is what makes the proof hold. The victim is fingerprinted first,
 * then the process table is re-read and its live parent chain must reach the
 * agent, then the agent and the victim are both re-verified against their
 * fingerprints immediately before the signal. A victim whose start time is
 * unchanged across that span is the same process the re-read placed in the
 * tree, and an agent whose start time still matches its spawn fingerprint is
 * still our child. Anything unproven is left alone, never signalled.
 *
 * A `runPs` or `kill` that throws propagates, so the caller can log it.
 */
export async function killMemoryGuardVictim(
  options: KillMemoryGuardVictimOptions,
  deps: MemoryGuardKillDeps,
): Promise<MemoryGuardKillOutcome> {
  const { victim, agentPid, agentIdentity } = options;
  const readStartTime = deps.readStartTime ?? getStartTime;
  if (agentIdentity === null) {
    return { killed: false, reason: "the agent could not be fingerprinted" };
  }
  const identity = await captureProcessIdentity(victim.pid, readStartTime);
  if (identity === null) {
    return { killed: false, reason: "it no longer holds a process" };
  }
  const rows = parseProcessTable(await deps.runPs());
  const inTree = agentTreeMembership(rows, agentPid, []);
  const row = rows.find((r) => r.pid === victim.pid);
  if (row === undefined || row.pid === agentPid || !inTree(row)) {
    return {
      killed: false,
      reason: "the re-read process table does not place it in this agent " +
        "run's tree",
    };
  }
  if (!(await isSameProcess(agentIdentity, readStartTime))) {
    return {
      killed: false,
      reason: "the agent's pid no longer holds the agent",
    };
  }
  if (!(await isSameProcess(identity, readStartTime))) {
    return {
      killed: false,
      reason: "the pid changed hands between selection and the kill",
    };
  }
  deps.kill(victim.pid);
  return { killed: true };
}
