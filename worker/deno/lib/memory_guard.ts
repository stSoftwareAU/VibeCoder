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
 * The functions here are pure. The runner's memory watch (`claude_runner.ts`)
 * owns the probe, the process table, the kill and the log line. A reading that
 * carries no byte counts (the darwin pressure level, or an unknown reading)
 * never triggers the guard.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  agentTreeMembership,
  formatBytesShort,
  type ProcessRow,
} from "./kill_diagnostics.ts";
import type { MemoryPressureReading } from "./memory_pressure.ts";

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
  /** The descendant snapshot taken while the agent ran (Issue #4382). */
  knownDescendants: readonly number[];
  /** The worker's own pid, never chosen. Defaults to `Deno.pid`. */
  selfPid?: number;
}

/**
 * The process the guard kills, or undefined when there is nothing to kill.
 *
 * Undefined unless the reading is below the floor. Otherwise it is the
 * largest-RSS row that is in the agent run's tree, is not the agent itself,
 * is not the worker, and is at least {@link MEMORY_GUARD_MIN_VICTIM_RSS_KB}.
 */
export function selectMemoryGuardVictim(
  options: MemoryGuardVictimOptions,
): ProcessRow | undefined {
  if (!isBelowMemoryGuardFloor(options.reading)) return undefined;
  const selfPid = options.selfPid ?? Deno.pid;
  const inTree = agentTreeMembership(
    options.rows,
    options.agentPid,
    options.knownDescendants,
  );
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
