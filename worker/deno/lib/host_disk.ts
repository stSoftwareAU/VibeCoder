/**
 * Host free-disk awareness for the worker (Issue #226).
 *
 * ## What went wrong
 *
 * Host GRQ-23 crashed with its data volume full on 2026-08-21. The
 * container store had grown 36 → 74 GB in 36 hours and the worker measured
 * nothing it could act on: inside the container `df` on the work volume
 * reports the *virtual* 504 GB volume image (8 % used), not the host
 * filesystem the image is thin-provisioned on — so the existing work-dir
 * disk check (`disk_space.ts`) saw a nearly empty disk while the host had
 * a few GB left. The worker claimed two issues, its log writes started
 * failing at 10:39Z while its GitHub heartbeats kept beating, the agents'
 * work was lost and the host went down.
 *
 * ## The design
 *
 * - The **launcher** measures the host filesystem (`df -kP`) once per
 *   launch and hands the reading in as `VIBE_HOST_DISK_AVAIL_BYTES` /
 *   `VIBE_HOST_DISK_TOTAL_BYTES`; it also refuses to launch below a hard
 *   floor (run.sh), after the store reclamation has had its chance.
 * - The **worker** keeps that baseline and estimates the host's current
 *   free space as `baseline − growth of the work volume since launch`
 *   (the volume image only grows on the host), re-probed on a bounded
 *   cadence. In native mode (no baseline) the work dir's own filesystem
 *   is the host, so `df` there is the truth.
 * - Below the **low floor** the worker stops claiming (the claim guard
 *   drains the pool exactly as the spend ceiling does) and reports
 *   `host-disk: degraded`; below the **hard floor** the launcher never
 *   starts it.
 *
 * Every probe is injectable; nothing here runs a subprocess in tests.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { runWithTimeout } from "./subprocess_timeout.ts";

/** Env the launcher sets from the host's `df` at launch. */
export const HOST_DISK_AVAIL_ENV = "VIBE_HOST_DISK_AVAIL_BYTES";
export const HOST_DISK_TOTAL_ENV = "VIBE_HOST_DISK_TOTAL_BYTES";
/** Operator overrides for the floors, in whole gigabytes / percent. */
export const HOST_DISK_LOW_FLOOR_GB_ENV = "VIBE_HOST_DISK_LOW_FLOOR_GB";
export const HOST_DISK_LOW_FLOOR_PERCENT_ENV =
  "VIBE_HOST_DISK_LOW_FLOOR_PERCENT";

/** Below this much free the worker stops claiming new work. */
export const DEFAULT_LOW_FLOOR_GB = 20;
/** …or below this percentage of the filesystem, whichever is larger. */
export const DEFAULT_LOW_FLOOR_PERCENT = 10;

const GIB = 1_073_741_824;
const DF_TIMEOUT_MS = 10_000;

/** One free-space reading of a filesystem. */
export interface DiskReading {
  /** Bytes available to this user. */
  availableBytes: number;
  /** Bytes used. */
  usedBytes: number;
  /** Filesystem size in bytes. */
  totalBytes: number;
}

/** What the worker believes about the host's disk right now. */
export interface HostDiskStatus {
  level: "ok" | "low" | "unknown";
  /** Estimated (or measured) host free bytes, when known. */
  availableBytes?: number;
  totalBytes?: number;
  /** Where the number came from. */
  source: "launch-baseline" | "native-df" | "none";
  /** Human-readable reason for the level. */
  detail: string;
}

/**
 * Parse POSIX `df -kP` output.
 *
 * The data line may wrap when the device name is long, so the numeric
 * columns are read from the last line: 1024-blocks, used, available.
 */
export function parseDfKP(text: string): DiskReading | null {
  const lines = text.trim().split("\n").map((l) => l.trim()).filter((l) =>
    l !== ""
  );
  if (lines.length < 2) return null;
  const numbers = lines[lines.length - 1]!.split(/\s+/)
    .map((f) => Number(f))
    .filter((n) => Number.isFinite(n));
  if (numbers.length < 3) return null;
  const total = numbers[0]! * 1024;
  const used = numbers[1]! * 1024;
  const available = numbers[2]! * 1024;
  if (total <= 0 || available < 0 || used < 0) return null;
  return { availableBytes: available, usedBytes: used, totalBytes: total };
}

/** Production `df -kP <path>` probe. */
export async function probeDiskReading(
  path: string,
): Promise<DiskReading | null> {
  const result = await runWithTimeout("df", ["-kP", path], {
    timeoutMs: DF_TIMEOUT_MS,
    quiet: true,
  });
  if (!result.ok || result.value.timedOut || !result.value.success) {
    return null;
  }
  return parseDfKP(result.value.stdout);
}

/** The floors, from env overrides or the defaults. */
export interface DiskFloors {
  lowFloorGb: number;
  lowFloorPercent: number;
}

/** A finite number from an env value, or null when unset/blank/garbage. */
function envNumber(value: string | undefined): number | null {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export function resolveDiskFloors(
  env: (name: string) => string | undefined,
): DiskFloors {
  const gb = envNumber(env(HOST_DISK_LOW_FLOOR_GB_ENV)) ?? NaN;
  const percent = envNumber(env(HOST_DISK_LOW_FLOOR_PERCENT_ENV)) ?? NaN;
  return {
    lowFloorGb: Number.isFinite(gb) && gb >= 0 ? gb : DEFAULT_LOW_FLOOR_GB,
    lowFloorPercent: Number.isFinite(percent) && percent >= 0 && percent <= 100
      ? percent
      : DEFAULT_LOW_FLOOR_PERCENT,
  };
}

/** The larger of the two floors, in bytes, for a filesystem of `totalBytes`. */
export function lowFloorBytes(totalBytes: number, floors: DiskFloors): number {
  return Math.max(
    floors.lowFloorGb * GIB,
    (floors.lowFloorPercent / 100) * totalBytes,
  );
}

/** The launch baseline the launcher passed in, if any. */
export interface HostDiskBaseline {
  availableBytes: number;
  totalBytes: number;
}

export function readHostDiskBaseline(
  env: (name: string) => string | undefined,
): HostDiskBaseline | null {
  const avail = envNumber(env(HOST_DISK_AVAIL_ENV));
  const total = envNumber(env(HOST_DISK_TOTAL_ENV));
  if (avail === null || total === null || avail < 0 || total <= 0) {
    return null;
  }
  return { availableBytes: avail, totalBytes: total };
}

export function formatGb(bytes: number): string {
  return `${(bytes / GIB).toFixed(1)} GB`;
}

/**
 * Estimate the host's free space from the launch baseline and the work
 * volume's growth since launch (Issue #226).
 *
 * The thin-provisioned volume image only grows on the host, so every byte
 * the work volume gained since launch is a byte the host lost. Shrinkage is
 * ignored (a freed block inside the volume does not come back to the host).
 */
export function estimateHostFree(
  baseline: HostDiskBaseline,
  volumeUsedAtLaunch: number | null,
  volumeUsedNow: number | null,
): number {
  if (volumeUsedAtLaunch === null || volumeUsedNow === null) {
    return baseline.availableBytes;
  }
  const growth = Math.max(0, volumeUsedNow - volumeUsedAtLaunch);
  return Math.max(0, baseline.availableBytes - growth);
}

/** Classify a free-space figure against the floors. */
export function classifyHostDisk(
  availableBytes: number,
  totalBytes: number,
  floors: DiskFloors,
): { level: "ok" | "low"; detail: string } {
  const floor = lowFloorBytes(totalBytes, floors);
  const percent = totalBytes > 0
    ? ((availableBytes / totalBytes) * 100).toFixed(1)
    : "?";
  const summary = `${formatGb(availableBytes)} free (${percent}%) of ${
    formatGb(totalBytes)
  }, floor ${formatGb(floor)}`;
  if (availableBytes < floor) {
    return { level: "low", detail: `${summary} — below the floor` };
  }
  return { level: "ok", detail: summary };
}

/** Injectable pieces of the monitor. */
export interface HostDiskMonitorOptions {
  /** Work directory whose filesystem is probed. */
  workDir: string;
  env?: (name: string) => string | undefined;
  probe?: (path: string) => Promise<DiskReading | null>;
  now?: () => number;
  /** Minimum milliseconds between probes. */
  sampleIntervalMs?: number;
  log?: (message: string) => void;
}

/**
 * Keeps the worker's view of the host disk current on a bounded cadence.
 */
export class HostDiskMonitor {
  private readonly workDir: string;
  private readonly env: (name: string) => string | undefined;
  private readonly probe: (path: string) => Promise<DiskReading | null>;
  private readonly now: () => number;
  private readonly sampleIntervalMs: number;
  private readonly log: (message: string) => void;
  private readonly floors: DiskFloors;
  private readonly baseline: HostDiskBaseline | null;
  private volumeUsedAtLaunch: number | null = null;
  private baselined = false;
  private lastSampleAt: number | undefined;
  private lastStatus: HostDiskStatus = {
    level: "unknown",
    source: "none",
    detail: "not probed yet",
  };
  private lastLevel: HostDiskStatus["level"] | undefined;

  constructor(options: HostDiskMonitorOptions) {
    this.workDir = options.workDir;
    this.env = options.env ?? ((name) => Deno.env.get(name));
    this.probe = options.probe ?? probeDiskReading;
    this.now = options.now ?? Date.now;
    this.sampleIntervalMs = options.sampleIntervalMs ?? 60_000;
    this.log = options.log ?? (() => {});
    this.floors = resolveDiskFloors(this.env);
    this.baseline = readHostDiskBaseline(this.env);
  }

  /** The most recent status without probing. */
  get status(): HostDiskStatus {
    return this.lastStatus;
  }

  /**
   * Bytes the host must get back to clear the low floor, from the last
   * status. Zero when the reading is `ok` or unknown — the reclaim
   * (Issue #242) sizes itself from this.
   */
  get shortfallBytes(): number {
    const status = this.lastStatus;
    if (
      status.level !== "low" || status.availableBytes === undefined ||
      status.totalBytes === undefined
    ) {
      return 0;
    }
    return Math.max(
      0,
      lowFloorBytes(status.totalBytes, this.floors) - status.availableBytes,
    );
  }

  /**
   * Probe if the cadence allows, then return the current status.
   *
   * `force` skips the cadence — the re-read after a reclaim (Issue #242)
   * must see the freed space, not the reading that triggered it.
   */
  async check(options: { force?: boolean } = {}): Promise<HostDiskStatus> {
    const t = this.now();
    if (
      options.force !== true &&
      this.lastSampleAt !== undefined &&
      t - this.lastSampleAt < this.sampleIntervalMs
    ) {
      return this.lastStatus;
    }
    this.lastSampleAt = t;

    let reading: DiskReading | null = null;
    try {
      reading = await this.probe(this.workDir);
    } catch {
      reading = null;
    }

    let status: HostDiskStatus;
    if (this.baseline !== null) {
      if (!this.baselined) {
        this.volumeUsedAtLaunch = reading?.usedBytes ?? null;
        this.baselined = true;
      }
      const available = estimateHostFree(
        this.baseline,
        this.volumeUsedAtLaunch,
        reading?.usedBytes ?? null,
      );
      const cls = classifyHostDisk(
        available,
        this.baseline.totalBytes,
        this.floors,
      );
      status = {
        level: cls.level,
        availableBytes: available,
        totalBytes: this.baseline.totalBytes,
        source: "launch-baseline",
        detail: `host (estimated from launch baseline) ${cls.detail}`,
      };
    } else if (reading !== null) {
      const cls = classifyHostDisk(
        reading.availableBytes,
        reading.totalBytes,
        this.floors,
      );
      status = {
        level: cls.level,
        availableBytes: reading.availableBytes,
        totalBytes: reading.totalBytes,
        source: "native-df",
        detail: `work dir filesystem ${cls.detail}`,
      };
    } else {
      status = {
        level: "unknown",
        source: "none",
        detail: "no launch baseline and df unreadable — not gating",
      };
    }

    if (status.level !== this.lastLevel) {
      this.log(`Host disk: ${status.level} — ${status.detail} (Issue #226)`);
      this.lastLevel = status.level;
    }
    this.lastStatus = status;
    return status;
  }
}
