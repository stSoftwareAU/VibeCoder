/**
 * Memory-pressure governor for the concurrent issue-slot pool (Issue #4179,
 * part of #4168).
 *
 * N concurrent agent subprocesses multiply the heap-DEFER risk hosts have
 * already hit, so the pool asks this governor how many slots it may run
 * right now: the EFFECTIVE count is `min(configured, pressure-derived
 * ceiling)`. The rule from #4168 — auto-reduce only ever LOWERS the count,
 * never above `maxConcurrentIssues` — and it reduces by not starting slots
 * or letting idle ones stop before their next claim; a running slot is
 * never cancelled by pressure alone (that would burn a billed run and
 * leave a half-finished branch).
 *
 * Policy: a "high" reading halves the ceiling (floor 1); each "ok" reading
 * raises it by one, back toward the configured value; "unknown" (no
 * signal on this platform, unreadable, or a probe that threw) means no
 * reduction — the probe is advisory, never a reason to idle a host. The
 * probe runs on a bounded cadence (`sampleIntervalMs`), so per-claim
 * consultation is cheap. Every change is logged with the reading.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { MemoryPressureReading } from "./memory_pressure.ts";

export interface SlotGovernorOptions {
  /** Pressure probe; must be cheap. Errors are caught and warned once. */
  probe: () => Promise<MemoryPressureReading>;
  /** Clock (epoch ms). */
  now?: () => number;
  /** Minimum interval between probes. Default 30 s. */
  sampleIntervalMs?: number;
  /** Where transitions and the one-off probe warning go. */
  log?: (message: string) => void;
}

/** Interface the pool depends on (production: SlotGovernor). */
export interface SlotCeiling {
  effectiveSlots(configured: number): Promise<number>;
}

const MIB = 1024 * 1024;

function describe(reading: MemoryPressureReading): string {
  if (
    reading.totalBytes !== undefined && reading.availableBytes !== undefined
  ) {
    return `${reading.level}, available ${
      Math.round(reading.availableBytes / MIB)
    }/${Math.round(reading.totalBytes / MIB)} MiB`;
  }
  return reading.level;
}

export class SlotGovernor implements SlotCeiling {
  private readonly probe: () => Promise<MemoryPressureReading>;
  private readonly now: () => number;
  private readonly sampleIntervalMs: number;
  private readonly log: (message: string) => void;
  private lastSampleAt: number | undefined;
  private lastReading: MemoryPressureReading = { level: "unknown" };
  private ceiling: number | undefined;
  private warnedProbe = false;

  constructor(options: SlotGovernorOptions) {
    this.probe = options.probe;
    this.now = options.now ?? Date.now;
    this.sampleIntervalMs = options.sampleIntervalMs ?? 30_000;
    this.log = options.log ?? (() => {});
  }

  /** The most recent reading (for status lines). */
  get reading(): MemoryPressureReading {
    return this.lastReading;
  }

  /**
   * How many slots may run right now: never above `configured`; at least
   * 1 when configured is.
   */
  async effectiveSlots(configured: number): Promise<number> {
    if (configured <= 1) return configured;
    const current = Math.min(this.ceiling ?? configured, configured);
    if (!(await this.maybeSample())) {
      // Between samples the ceiling holds: no step in either direction
      // until the next probe.
      this.ceiling = current;
      return current;
    }
    let next = current;
    switch (this.lastReading.level) {
      case "high":
        next = Math.max(1, Math.floor(current / 2));
        break;
      case "ok":
        next = Math.min(configured, current + 1);
        break;
      case "unknown":
        next = configured;
        break;
    }
    if (next !== current) {
      this.log(
        `Slot ceiling ${current} → ${next} of ${configured} configured (memory pressure ${
          describe(this.lastReading)
        }) (Issue #4179)`,
      );
    }
    this.ceiling = next;
    return next;
  }

  /** Probe when the cadence allows; true when a fresh sample was taken. */
  private async maybeSample(): Promise<boolean> {
    const t = this.now();
    if (
      this.lastSampleAt !== undefined &&
      t - this.lastSampleAt < this.sampleIntervalMs
    ) {
      return false;
    }
    this.lastSampleAt = t;
    try {
      this.lastReading = await this.probe();
    } catch (err) {
      if (!this.warnedProbe) {
        this.warnedProbe = true;
        this.log(
          `Memory-pressure probe failed — running the configured slot count: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      this.lastReading = { level: "unknown" };
    }
    return true;
  }
}
