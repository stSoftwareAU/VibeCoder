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

import {
  isNonNegative,
  parseNumber,
  resolveSetting,
} from "./config_precedence.ts";
import { runWithTimeout } from "./subprocess_timeout.ts";
import {
  classifyWorkVolumeRatchet,
  describeWorkVolumeRatchet,
  type WorkVolumeRatchet,
} from "./work_volume_ratchet.ts";

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
  // No `quiet: true` (Issue #345): `quiet` sets `stdout: "null"` and returns
  // an empty string, so `parseDfKP` saw nothing and every reading came back
  // as "df unreadable" — the blind host-disk signal in the GRQ-23 outage.
  const result = await runWithTimeout("df", ["-kP", path], {
    timeoutMs: DF_TIMEOUT_MS,
  });
  if (!result.ok || result.value.timedOut || !result.value.success) {
    return null;
  }
  return parseDfKP(result.value.stdout);
}

/** Where one floor term's value came from (Issue #732). */
export type DiskFloorSource = "config" | "env" | "default";

/** The floors, and where each term came from. */
export interface DiskFloors {
  lowFloorGb: number;
  lowFloorPercent: number;
  /** Where `lowFloorGb` came from. */
  lowFloorGbSource: DiskFloorSource;
  /** Where `lowFloorPercent` came from. */
  lowFloorPercentSource: DiskFloorSource;
}

/**
 * The floor terms a deployment states in `.config.json` (Issue #732).
 *
 * Both optional: an unset term takes the environment override, and failing
 * that the default, so a host that configures neither behaves exactly as it
 * did before this was configurable.
 */
export interface ConfiguredDiskFloors {
  hostDiskLowFloorGb?: number;
  hostDiskLowFloorPercent?: number;
}

/** A finite number from an env value, or null when unset/blank/garbage. */
function envNumber(value: string | undefined): number | null {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Resolve the claiming floor's two terms, and say where each came from.
 *
 * Precedence, per the rule Issue #289 set for every other knob: **the
 * `.config.json` key always wins over the environment variable**, and the
 * default applies only when neither states a usable value. The terms resolve
 * independently, so a deployment may pin the percentage in its configuration
 * and still raise the gigabyte term for one launch from the environment.
 *
 * The floor is the *larger* of the two ({@link lowFloorBytes}), which on a
 * 1.875 TB filesystem makes the 10 % term ≈ 187 GB — the reading that refused
 * work on a host with 37.5 GB free (Issue #732). The default formula is
 * unchanged; what changed is that a deployment can now state its own, in the
 * file the rest of its configuration lives in.
 *
 * @param env - Environment reader (injectable for tests)
 * @param configured - The deployment's `.config.json` floor terms, if any
 * @returns Both terms and the origin of each
 */
export function resolveDiskFloors(
  env: (name: string) => string | undefined,
  configured: ConfiguredDiskFloors = {},
): DiskFloors {
  // The rule itself now lives in config_precedence.ts (Issue #874), so this
  // site states which sources it has rather than re-deciding which one wins.
  // Behaviour is unchanged: config, then environment, then default, with an
  // unusable value in either treated as absent.
  const gb = resolveSetting<number>({
    configKey: "host_disk_low_floor_gb",
    envVar: HOST_DISK_LOW_FLOOR_GB_ENV,
    env,
    configured: configured.hostDiskLowFloorGb,
    fallback: DEFAULT_LOW_FLOOR_GB,
    parse: parseNumber,
    accept: isNonNegative,
  });
  const percent = resolveSetting<number>({
    configKey: "host_disk_low_floor_percent",
    envVar: HOST_DISK_LOW_FLOOR_PERCENT_ENV,
    env,
    configured: configured.hostDiskLowFloorPercent,
    fallback: DEFAULT_LOW_FLOOR_PERCENT,
    parse: parseNumber,
    accept: (value) => isNonNegative(value) && value <= 100,
  });

  return {
    lowFloorGb: gb.value,
    lowFloorGbSource: gb.source,
    lowFloorPercent: percent.value,
    lowFloorPercentSource: percent.source,
  };
}

/**
 * Read the deployment's floor terms out of its `.config.json` (Issue #732).
 *
 * Used by the launcher, which resolves the floor before any worker has loaded
 * a configuration. Absent file → no terms stated, which is what an
 * unconfigured host has always had. A file that exists but cannot be read or
 * parsed is **not** silently treated as unconfigured: it throws, because
 * quietly claiming at a different floor than the operator wrote is the class
 * of fault this issue is about.
 *
 * @param configFile - Host path of the worker configuration file
 * @returns The stated terms; empty when the file states none
 * @throws When the file exists but is unreadable or is not a JSON object
 */
export async function readConfiguredDiskFloors(
  configFile: string,
): Promise<ConfiguredDiskFloors> {
  let text: string;
  try {
    text = await Deno.readTextFile(configFile);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return {};
    throw new Error(
      `Cannot read the host disk floor: ${configFile} is unreadable ` +
        `(${(error as Error).message}).`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Cannot read the host disk floor: ${configFile} is not valid JSON ` +
        `(${(error as Error).message}).`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `Cannot read the host disk floor: ${configFile} is not a JSON object.`,
    );
  }

  const record = parsed as Record<string, unknown>;
  const gb = record["host_disk_low_floor_gb"];
  const percent = record["host_disk_low_floor_percent"];
  return {
    ...(typeof gb === "number" ? { hostDiskLowFloorGb: gb } : {}),
    ...(typeof percent === "number"
      ? { hostDiskLowFloorPercent: percent }
      : {}),
  };
}

/**
 * The origin of each term, in the compact form the launch plan carries.
 *
 * The launcher prints it beside the free-space reading, so a refused claim
 * says which knob would move it (Issue #732).
 *
 * @param floors - The resolved floors
 * @returns e.g. `gb=env,percent=config`
 */
export function diskFloorOrigin(floors: DiskFloors): string {
  return `gb=${floors.lowFloorGbSource},percent=${floors.lowFloorPercentSource}`;
}

/**
 * One line naming the resolved floor and where each term came from.
 *
 * @param floors - The resolved floors
 * @param totalBytes - Size of the filesystem the floor is taken against
 * @returns A human-readable description
 */
export function describeDiskFloors(
  floors: DiskFloors,
  totalBytes: number,
): string {
  const byGb = floors.lowFloorGb * GIB;
  const byPercent = (floors.lowFloorPercent / 100) * totalBytes;
  const winner = byGb >= byPercent ? "the GB term" : "the percent term";
  return `${
    Math.round(lowFloorBytes(totalBytes, floors) / GIB * 10) / 10
  } GB ` +
    `(${winner}: ${floors.lowFloorGb} GB [${floors.lowFloorGbSource}] vs ` +
    `${floors.lowFloorPercent}% [${floors.lowFloorPercentSource}] of ` +
    `${Math.round(totalBytes / GIB)} GB)`;
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
 *
 * Issue #384: the third argument is therefore the volume's **high-water
 * mark**, not its current usage. Passing the current reading made a
 * guest-side sweep look like host free space — the tier reclaim deleted
 * 18 GB inside the guest, the estimate rose by 18 GB the host never got, and
 * `healed` came back true while `df` on the host had not moved a byte.
 */
export function estimateHostFree(
  baseline: HostDiskBaseline,
  volumeUsedAtLaunch: number | null,
  volumeUsedPeak: number | null,
): number {
  if (volumeUsedAtLaunch === null || volumeUsedPeak === null) {
    return baseline.availableBytes;
  }
  const growth = Math.max(0, volumeUsedPeak - volumeUsedAtLaunch);
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
  /**
   * The deployment's `.config.json` floor terms (Issue #732). Omitted → the
   * environment and the defaults decide, exactly as before.
   */
  floors?: ConfiguredDiskFloors;
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
  /** Highest volume usage seen this run — what the host has lost (#384). */
  private volumeUsedPeak: number | null = null;
  /** Most recent volume usage, for the ratchet split (#384). */
  private volumeUsedNow: number | null = null;
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
    this.floors = resolveDiskFloors(this.env, options.floors ?? {});
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
   * How much of the host's loss is space the guest has already freed but the
   * volume image still holds (Issue #384).
   *
   * Only meaningful in container mode: on a native host `df` measures the
   * host itself, so freed space is genuinely free and there is no ratchet to
   * claim.
   */
  get workVolumeRatchet(): WorkVolumeRatchet {
    if (this.baseline === null) return classifyWorkVolumeRatchet(null, null);
    return classifyWorkVolumeRatchet(this.volumeUsedNow, this.volumeUsedPeak);
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
    // Issue #852: a launch baseline is an estimate that can only ever fall —
    // `estimateHostFree` subtracts volume growth from a figure captured once,
    // so space freed on the host mid-run is structurally invisible and the
    // fleet stays gated until the next launch. When the probe reports the
    // same total size as the baseline, the work dir is on the very filesystem
    // the launcher measured: `df` there *is* the host, and a live reading is
    // strictly better information than an estimate derived from it.
    const probeIsHostFilesystem = this.baseline !== null &&
      reading !== null &&
      reading.totalBytes === this.baseline.totalBytes;
    if (this.baseline !== null && !probeIsHostFilesystem) {
      if (!this.baselined) {
        this.volumeUsedAtLaunch = reading?.usedBytes ?? null;
        this.baselined = true;
      }
      // Issue #384: the host lost every byte the volume ever grew to, and a
      // guest-side delete does not hand those blocks back — the estimate
      // tracks the high-water mark, and the gap below it is named as what
      // it is: dead space inside the volume image.
      this.volumeUsedNow = reading?.usedBytes ?? this.volumeUsedNow;
      if (reading?.usedBytes !== undefined) {
        this.volumeUsedPeak = this.volumeUsedPeak === null
          ? reading.usedBytes
          : Math.max(this.volumeUsedPeak, reading.usedBytes);
      }
      const available = estimateHostFree(
        this.baseline,
        this.volumeUsedAtLaunch,
        this.volumeUsedPeak,
      );
      const cls = classifyHostDisk(
        available,
        this.baseline.totalBytes,
        this.floors,
      );
      const ratchet = describeWorkVolumeRatchet(this.workVolumeRatchet);
      status = {
        level: cls.level,
        availableBytes: available,
        totalBytes: this.baseline.totalBytes,
        source: "launch-baseline",
        detail: `host (estimated from launch baseline) ${cls.detail}${
          ratchet === "" ? "" : ` — ${ratchet}`
        }`,
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
        detail: probeIsHostFilesystem
          ? `host filesystem (measured, same volume as the launch baseline) ${cls.detail}`
          : `work dir filesystem ${cls.detail}`,
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
