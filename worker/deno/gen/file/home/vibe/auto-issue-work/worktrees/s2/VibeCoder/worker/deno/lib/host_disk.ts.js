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
 * - The **launcher keeps measuring** (Issue #1550). It runs every few
 *   minutes from launchd/cron and, when a worker is already up, writes the
 *   fresh `df` reading to `host-disk.json` in the worker log directory —
 *   the one host path the container mounts read-write. The worker adopts a
 *   reading that is newer than what it holds and not stale, and re-bases
 *   the growth term at that moment. A baseline taken once could only ever
 *   fall: on GRQ-25 the host freed 26 GB mid-run and the worker stayed
 *   parked below the floor for the hour (39 GB estimated, 66 GB real), and
 *   five hours later another account wrote 21 GB the estimate could not see
 *   (37 GB estimated, 23 GB real). Only a host-side measurement can move
 *   the figure either way, and that is the only thing that does.
 * - Below the **low floor** the worker stops claiming (the claim guard
 *   drains the pool exactly as the spend ceiling does) and reports
 *   `host-disk: degraded`; below the **hard floor** the launcher never
 *   starts it.
 *
 * Every probe is injectable; nothing here runs a subprocess in tests.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */ import { isNonNegative, parseNumber, resolveSetting } from "./config_precedence.ts";
import { runWithTimeout } from "./subprocess_timeout.ts";
import { classifyWorkVolumeRatchet, describeWorkVolumeRatchet } from "./work_volume_ratchet.ts";
/** Env the launcher sets from the host's `df` at launch. */ export const HOST_DISK_AVAIL_ENV = "VIBE_HOST_DISK_AVAIL_BYTES";
export const HOST_DISK_TOTAL_ENV = "VIBE_HOST_DISK_TOTAL_BYTES";
/** Operator overrides for the floors, in whole gigabytes / percent. */ export const HOST_DISK_LOW_FLOOR_GB_ENV = "VIBE_HOST_DISK_LOW_FLOOR_GB";
export const HOST_DISK_LOW_FLOOR_PERCENT_ENV = "VIBE_HOST_DISK_LOW_FLOOR_PERCENT";
/** Below this much free the worker stops claiming new work. */ export const DEFAULT_LOW_FLOOR_GB = 20;
/** …or below this percentage of the filesystem, whichever is larger. */ export const DEFAULT_LOW_FLOOR_PERCENT = 10;
const GIB = 1_073_741_824;
const DF_TIMEOUT_MS = 10_000;
/**
 * Parse POSIX `df -kP` output.
 *
 * The data line may wrap when the device name is long, so the numeric
 * columns are read from the last line: 1024-blocks, used, available.
 */ export function parseDfKP(text) {
  const lines = text.trim().split("\n").map((l)=>l.trim()).filter((l)=>l !== "");
  if (lines.length < 2) return null;
  const numbers = lines[lines.length - 1].split(/\s+/).map((f)=>Number(f)).filter((n)=>Number.isFinite(n));
  if (numbers.length < 3) return null;
  const total = numbers[0] * 1024;
  const used = numbers[1] * 1024;
  const available = numbers[2] * 1024;
  if (total <= 0 || available < 0 || used < 0) return null;
  return {
    availableBytes: available,
    usedBytes: used,
    totalBytes: total
  };
}
/** Production `df -kP <path>` probe. */ export async function probeDiskReading(path) {
  // No `quiet: true` (Issue #345): `quiet` sets `stdout: "null"` and returns
  // an empty string, so `parseDfKP` saw nothing and every reading came back
  // as "df unreadable" — the blind host-disk signal in the GRQ-23 outage.
  const result = await runWithTimeout("df", [
    "-kP",
    path
  ], {
    timeoutMs: DF_TIMEOUT_MS
  });
  if (!result.ok || result.value.timedOut || !result.value.success) {
    return null;
  }
  return parseDfKP(result.value.stdout);
}
/** A finite number from an env value, or null when unset/blank/garbage. */ function envNumber(value) {
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
 */ export function resolveDiskFloors(env, configured = {}) {
  // The rule itself now lives in config_precedence.ts (Issue #874), so this
  // site states which sources it has rather than re-deciding which one wins.
  // Behaviour is unchanged: config, then environment, then default, with an
  // unusable value in either treated as absent.
  const gb = resolveSetting({
    configKey: "host_disk_low_floor_gb",
    envVar: HOST_DISK_LOW_FLOOR_GB_ENV,
    env,
    configured: configured.hostDiskLowFloorGb,
    fallback: DEFAULT_LOW_FLOOR_GB,
    parse: parseNumber,
    accept: isNonNegative
  });
  const percent = resolveSetting({
    configKey: "host_disk_low_floor_percent",
    envVar: HOST_DISK_LOW_FLOOR_PERCENT_ENV,
    env,
    configured: configured.hostDiskLowFloorPercent,
    fallback: DEFAULT_LOW_FLOOR_PERCENT,
    parse: parseNumber,
    accept: (value)=>isNonNegative(value) && value <= 100
  });
  return {
    lowFloorGb: gb.value,
    lowFloorGbSource: gb.source,
    lowFloorPercent: percent.value,
    lowFloorPercentSource: percent.source
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
 */ export async function readConfiguredDiskFloors(configFile) {
  let text;
  try {
    text = await Deno.readTextFile(configFile);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return {};
    throw new Error(`Cannot read the host disk floor: ${configFile} is unreadable ` + `(${error.message}).`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Cannot read the host disk floor: ${configFile} is not valid JSON ` + `(${error.message}).`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Cannot read the host disk floor: ${configFile} is not a JSON object.`);
  }
  const record = parsed;
  const gb = record["host_disk_low_floor_gb"];
  const percent = record["host_disk_low_floor_percent"];
  return {
    ...typeof gb === "number" ? {
      hostDiskLowFloorGb: gb
    } : {},
    ...typeof percent === "number" ? {
      hostDiskLowFloorPercent: percent
    } : {}
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
 */ export function diskFloorOrigin(floors) {
  return `gb=${floors.lowFloorGbSource},percent=${floors.lowFloorPercentSource}`;
}
/**
 * One line naming the resolved floor and where each term came from.
 *
 * @param floors - The resolved floors
 * @param totalBytes - Size of the filesystem the floor is taken against
 * @returns A human-readable description
 */ export function describeDiskFloors(floors, totalBytes) {
  const byGb = floors.lowFloorGb * GIB;
  const byPercent = floors.lowFloorPercent / 100 * totalBytes;
  const winner = byGb >= byPercent ? "the GB term" : "the percent term";
  return `${Math.round(lowFloorBytes(totalBytes, floors) / GIB * 10) / 10} GB ` + `(${winner}: ${floors.lowFloorGb} GB [${floors.lowFloorGbSource}] vs ` + `${floors.lowFloorPercent}% [${floors.lowFloorPercentSource}] of ` + `${Math.round(totalBytes / GIB)} GB)`;
}
/** The larger of the two floors, in bytes, for a filesystem of `totalBytes`. */ export function lowFloorBytes(totalBytes, floors) {
  return Math.max(floors.lowFloorGb * GIB, floors.lowFloorPercent / 100 * totalBytes);
}
/**
 * The launcher's per-tick reading, as written to the worker log directory
 * (Issue #1550): `<log dir>/host-disk.json`, host-side
 * `${RUN_CORE_LOG_DIR}/host-disk.json`, guest-side `${HOME}/logs/host-disk.json`.
 */ export const HOST_DISK_REFRESH_FILE = "host-disk.json";
/**
 * Launcher-side override of the refresh interval (Issue #1691), read by
 * `run.sh` as `HOST_DISK_REFRESH_SECONDS` while it sits attached to its
 * container. The launcher rewrites the file itself every five minutes for as
 * long as the container runs, because a scheduler that never overlaps a
 * still-running job (launchd's `StartInterval`) gives it no second tick to
 * do so from. Tests set this to a second or two; production leaves it unset.
 */ export const HOST_DISK_REFRESH_INTERVAL_ENV = "VIBE_HOST_DISK_REFRESH_SECONDS";
/**
 * How old a launcher reading may be and still be adopted. The launcher
 * refreshes every 300 s — from its scheduler tick, or from the attached
 * launcher itself while the container runs (Issue #1691); three missed
 * refreshes means it is not running, and a figure from a dead launcher is not
 * fresher than what the worker holds.
 */ export const DEFAULT_REFRESH_MAX_AGE_MS = 15 * 60_000;
/** The longest `largestHostDirectories` text the worker keeps. */ export const MAX_LARGEST_HOST_DIRECTORIES_CHARS = 2000;
/**
 * Make the launcher's directory text safe to render on one log line: every
 * control character (newlines included) becomes a space, the ends are trimmed,
 * and the result is capped. Blank after that reads as absent.
 */ function sanitiseLargestHostDirectories(text) {
  const flat = text// Control characters are the point: they must not reach a log line.
  // deno-lint-ignore no-control-regex
  .replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, " ").trim().slice(0, MAX_LARGEST_HOST_DIRECTORIES_CHARS).trim();
  return flat === "" ? undefined : flat;
}
/** Parse a `host-disk.json` body; anything malformed reads as no reading. */ export function parseHostDiskRefresh(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch  {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const o = parsed;
  const avail = o.availableBytes;
  const total = o.totalBytes;
  const at = o.measuredAt;
  if (typeof avail !== "number" || typeof total !== "number" || typeof at !== "number" || !Number.isFinite(avail) || !Number.isFinite(total) || !Number.isFinite(at) || avail < 0 || total <= 0 || at <= 0) {
    return null;
  }
  const refused = o.workVolumeTrimRefused;
  if (refused !== undefined && typeof refused !== "boolean") return null;
  const declined = o.workVolumeRecreateDeclined;
  if (declined !== undefined && typeof declined !== "boolean") return null;
  const unrecovered = o.workVolumeRecreateUnrecovered;
  if (unrecovered !== undefined && typeof unrecovered !== "boolean") {
    return null;
  }
  const dirs = o.largestHostDirectories;
  if (dirs !== undefined && typeof dirs !== "string") return null;
  const largest = dirs === undefined ? undefined : sanitiseLargestHostDirectories(dirs);
  return {
    availableBytes: avail,
    totalBytes: total,
    measuredAt: at,
    ...refused === undefined ? {} : {
      workVolumeTrimRefused: refused
    },
    ...declined === undefined ? {} : {
      workVolumeRecreateDeclined: declined
    },
    ...unrecovered === undefined ? {} : {
      workVolumeRecreateUnrecovered: unrecovered
    },
    ...largest === undefined ? {} : {
      largestHostDirectories: largest
    }
  };
}
/** Read the launcher's reading file; missing or unreadable is no reading. */ export async function readHostDiskRefreshFile(path) {
  try {
    return parseHostDiskRefresh(await Deno.readTextFile(path));
  } catch  {
    return null;
  }
}
export function readHostDiskBaseline(env) {
  const avail = envNumber(env(HOST_DISK_AVAIL_ENV));
  const total = envNumber(env(HOST_DISK_TOTAL_ENV));
  if (avail === null || total === null || avail < 0 || total <= 0) {
    return null;
  }
  return {
    availableBytes: avail,
    totalBytes: total
  };
}
export function formatGb(bytes) {
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
 */ export function estimateHostFree(baseline, volumeUsedAtLaunch, volumeUsedPeak) {
  if (volumeUsedAtLaunch === null || volumeUsedPeak === null) {
    return baseline.availableBytes;
  }
  const growth = Math.max(0, volumeUsedPeak - volumeUsedAtLaunch);
  return Math.max(0, baseline.availableBytes - growth);
}
/** Classify a free-space figure against the floors. */ export function classifyHostDisk(availableBytes, totalBytes, floors) {
  const floor = lowFloorBytes(totalBytes, floors);
  const percent = totalBytes > 0 ? (availableBytes / totalBytes * 100).toFixed(1) : "?";
  const summary = `${formatGb(availableBytes)} free (${percent}%) of ${formatGb(totalBytes)}, floor ${formatGb(floor)}`;
  if (availableBytes < floor) {
    return {
      level: "low",
      detail: `${summary} — below the floor`
    };
  }
  return {
    level: "ok",
    detail: summary
  };
}
/**
 * Keeps the worker's view of the host disk current on a bounded cadence.
 */ export class HostDiskMonitor {
  workDir;
  env;
  probe;
  now;
  sampleIntervalMs;
  log;
  floors;
  /** The launch baseline, re-based by each adopted launcher reading. */ baseline;
  refreshFile;
  readRefresh;
  refreshMaxAgeMs;
  /** When the figure the estimate rests on was measured (Issue #1550). */ adoptedMeasuredAtMs;
  /** Age of the adopted launcher reading at the last check, if any. */ refreshAgeMs;
  volumeUsedAtLaunch = null;
  /** Highest volume usage seen this run — what the host has lost (#384). */ volumeUsedPeak = null;
  /** Most recent volume usage, for the ratchet split (#384). */ volumeUsedNow = null;
  /** The launcher's word that the runtime refused the trim (#2080). */ trimRefused = false;
  /** The launcher's word that it declined to recreate the work volume. */ recreateDeclined = false;
  /** The launcher's word that a recreate ran and left the host short. */ recreateUnrecovered = false;
  /** The launcher's largest-host-directories text, if it wrote one. */ largestDirs = undefined;
  baselined = false;
  lastSampleAt;
  lastStatus = {
    level: "unknown",
    source: "none",
    detail: "not probed yet"
  };
  lastLevel;
  constructor(options){
    this.workDir = options.workDir;
    this.env = options.env ?? ((name)=>Deno.env.get(name));
    this.probe = options.probe ?? probeDiskReading;
    this.now = options.now ?? Date.now;
    this.sampleIntervalMs = options.sampleIntervalMs ?? 60_000;
    this.log = options.log ?? (()=>{});
    this.floors = resolveDiskFloors(this.env, options.floors ?? {});
    this.baseline = readHostDiskBaseline(this.env);
    this.refreshFile = options.refreshFile;
    this.readRefresh = options.readRefresh ?? readHostDiskRefreshFile;
    this.refreshMaxAgeMs = options.refreshMaxAgeMs ?? DEFAULT_REFRESH_MAX_AGE_MS;
    // The environment baseline was measured by the launch plan BEFORE the
    // image build and the volume heal, and the launcher writes its reading
    // file again after them, seconds before this process starts (Issue
    // #2115: a volume reset returned 78 GB, the baseline still said 29, and
    // the worker claimed nothing for fifteen minutes). So any reading within
    // the refresh window is newer than the baseline in the sense that
    // matters and is adopted on the first check; the baseline is only what
    // stands until a file arrives.
    this.adoptedMeasuredAtMs = this.now() - this.refreshMaxAgeMs;
  }
  /**
   * Adopt the launcher's latest reading when it is newer than the figure the
   * estimate rests on and not stale (Issue #1550). The growth term is
   * re-based at the same moment: a host reading already counts everything
   * the volume held when it was taken, so only growth since then is
   * subtracted — the #384 rule, restarted from a truer origin.
   */ async adoptLauncherReading(reading, t) {
    if (this.refreshFile === undefined || this.baseline === null) return;
    let refresh = null;
    try {
      refresh = await this.readRefresh(this.refreshFile);
    } catch  {
      refresh = null;
    }
    if (refresh === null) return;
    // Taken from any reading the launcher wrote, before the recency rules
    // below: the flag is a property of this launch, not of one sample.
    this.trimRefused = refresh.workVolumeTrimRefused === true;
    this.recreateDeclined = refresh.workVolumeRecreateDeclined === true;
    this.recreateUnrecovered = refresh.workVolumeRecreateUnrecovered === true;
    this.largestDirs = refresh.largestHostDirectories;
    const measuredMs = refresh.measuredAt * 1000;
    if (measuredMs <= this.adoptedMeasuredAtMs) return;
    if (t - measuredMs > this.refreshMaxAgeMs) return;
    this.baseline = {
      availableBytes: refresh.availableBytes,
      totalBytes: refresh.totalBytes
    };
    this.adoptedMeasuredAtMs = measuredMs;
    this.refreshAgeMs = t - measuredMs;
    this.volumeUsedAtLaunch = reading?.usedBytes ?? null;
    this.volumeUsedPeak = reading?.usedBytes ?? null;
    this.baselined = reading !== null;
    this.log(`Host disk: adopted the launcher's reading — ${formatGb(refresh.availableBytes)} free of ${formatGb(refresh.totalBytes)}, measured ${Math.round(this.refreshAgeMs / 1000)}s ago (Issue #1550)`);
  }
  /** The most recent status without probing. */ get status() {
    return this.lastStatus;
  }
  /**
   * Bytes the host must get back to clear the low floor, from the last
   * status. Zero when the reading is `ok` or unknown — the reclaim
   * (Issue #242) sizes itself from this.
   */ get shortfallBytes() {
    const status = this.lastStatus;
    if (status.level !== "low" || status.availableBytes === undefined || status.totalBytes === undefined) {
      return 0;
    }
    return Math.max(0, lowFloorBytes(status.totalBytes, this.floors) - status.availableBytes);
  }
  /**
   * How much of the host's loss is space the guest has already freed but the
   * volume image still holds (Issue #384).
   *
   * Only meaningful in container mode: on a native host `df` measures the
   * host itself, so freed space is genuinely free and there is no ratchet to
   * claim.
   */ /**
   * Did the launcher report that the runtime refused to trim the work volume
   * this launch (Issue #2080)? When it did, nothing the guest frees reaches
   * the host.
   */ get workVolumeTrimRefused() {
    return this.trimRefused;
  }
  /**
   * Did the launcher decline to recreate the work volume this launch, because
   * recreating it would not return the missing space to the host? Absent
   * reads as `false` (Issue #4498).
   */ get workVolumeRecreateDeclined() {
    return this.recreateDeclined;
  }
  /**
   * Did the launcher recreate the work volume this launch and find the host
   * still below its floor? The next launch will not recreate it again until
   * the free-space reading moves. Absent reads as `false` (Issue #4498).
   */ get workVolumeRecreateUnrecovered() {
    return this.recreateUnrecovered;
  }
  /**
   * The largest host directories the launcher reported, for the stop reason
   * (Issue #4498). Undefined when the launcher wrote none.
   */ get largestHostDirectories() {
    return this.largestDirs;
  }
  /**
   * The floor in bytes for a filesystem of `totalBytes`, under this
   * monitor's resolved floors — what the heavy-build gate compares against
   * (Issue #3178), so it and the claim gate share one floor.
   */ floorBytesFor(totalBytes) {
    return lowFloorBytes(totalBytes, this.floors);
  }
  get workVolumeRatchet() {
    if (this.baseline === null) return classifyWorkVolumeRatchet(null, null);
    return classifyWorkVolumeRatchet(this.volumeUsedNow, this.volumeUsedPeak);
  }
  /**
   * Probe if the cadence allows, then return the current status.
   *
   * `force` skips the cadence — the re-read after a reclaim (Issue #242)
   * must see the freed space, not the reading that triggered it.
   */ async check(options = {}) {
    const t = this.now();
    if (options.force !== true && this.lastSampleAt !== undefined && t - this.lastSampleAt < this.sampleIntervalMs) {
      return this.lastStatus;
    }
    this.lastSampleAt = t;
    let reading = null;
    try {
      reading = await this.probe(this.workDir);
    } catch  {
      reading = null;
    }
    let status;
    // Issue #852: a launch baseline is an estimate that can only ever fall —
    // `estimateHostFree` subtracts volume growth from a figure captured once,
    // so space freed on the host mid-run is structurally invisible and the
    // fleet stays gated until the next launch. When the probe reports the
    // same total size as the baseline, the work dir is on the very filesystem
    // the launcher measured: `df` there *is* the host, and a live reading is
    // strictly better information than an estimate derived from it.
    const probeIsHostFilesystem = this.baseline !== null && reading !== null && reading.totalBytes === this.baseline.totalBytes;
    if (this.baseline !== null && !probeIsHostFilesystem) {
      await this.adoptLauncherReading(reading, t);
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
        this.volumeUsedPeak = this.volumeUsedPeak === null ? reading.usedBytes : Math.max(this.volumeUsedPeak, reading.usedBytes);
      }
      const available = estimateHostFree(this.baseline, this.volumeUsedAtLaunch, this.volumeUsedPeak);
      const cls = classifyHostDisk(available, this.baseline.totalBytes, this.floors);
      const ratchet = describeWorkVolumeRatchet(this.workVolumeRatchet);
      const origin = this.refreshAgeMs === undefined ? "estimated from launch baseline" : `estimated from the launcher's reading ${Math.round((t - this.adoptedMeasuredAtMs) / 60_000)} min ago`;
      status = {
        level: cls.level,
        availableBytes: available,
        totalBytes: this.baseline.totalBytes,
        source: "launch-baseline",
        detail: `host (${origin}) ${cls.detail}${ratchet === "" ? "" : ` — ${ratchet}`}`
      };
    } else if (reading !== null) {
      const cls = classifyHostDisk(reading.availableBytes, reading.totalBytes, this.floors);
      status = {
        level: cls.level,
        availableBytes: reading.availableBytes,
        totalBytes: reading.totalBytes,
        source: "native-df",
        detail: probeIsHostFilesystem ? `host filesystem (measured, same volume as the launch baseline) ${cls.detail}` : `work dir filesystem ${cls.detail}`
      };
    } else {
      status = {
        level: "unknown",
        source: "none",
        detail: "no launch baseline and df unreadable — not gating"
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9ob3N0X2Rpc2sudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBIb3N0IGZyZWUtZGlzayBhd2FyZW5lc3MgZm9yIHRoZSB3b3JrZXIgKElzc3VlICMyMjYpLlxuICpcbiAqICMjIFdoYXQgd2VudCB3cm9uZ1xuICpcbiAqIEhvc3QgR1JRLTIzIGNyYXNoZWQgd2l0aCBpdHMgZGF0YSB2b2x1bWUgZnVsbCBvbiAyMDI2LTA4LTIxLiBUaGVcbiAqIGNvbnRhaW5lciBzdG9yZSBoYWQgZ3Jvd24gMzYg4oaSIDc0IEdCIGluIDM2IGhvdXJzIGFuZCB0aGUgd29ya2VyIG1lYXN1cmVkXG4gKiBub3RoaW5nIGl0IGNvdWxkIGFjdCBvbjogaW5zaWRlIHRoZSBjb250YWluZXIgYGRmYCBvbiB0aGUgd29yayB2b2x1bWVcbiAqIHJlcG9ydHMgdGhlICp2aXJ0dWFsKiA1MDQgR0Igdm9sdW1lIGltYWdlICg4ICUgdXNlZCksIG5vdCB0aGUgaG9zdFxuICogZmlsZXN5c3RlbSB0aGUgaW1hZ2UgaXMgdGhpbi1wcm92aXNpb25lZCBvbiDigJQgc28gdGhlIGV4aXN0aW5nIHdvcmstZGlyXG4gKiBkaXNrIGNoZWNrIChgZGlza19zcGFjZS50c2ApIHNhdyBhIG5lYXJseSBlbXB0eSBkaXNrIHdoaWxlIHRoZSBob3N0IGhhZFxuICogYSBmZXcgR0IgbGVmdC4gVGhlIHdvcmtlciBjbGFpbWVkIHR3byBpc3N1ZXMsIGl0cyBsb2cgd3JpdGVzIHN0YXJ0ZWRcbiAqIGZhaWxpbmcgYXQgMTA6MzlaIHdoaWxlIGl0cyBHaXRIdWIgaGVhcnRiZWF0cyBrZXB0IGJlYXRpbmcsIHRoZSBhZ2VudHMnXG4gKiB3b3JrIHdhcyBsb3N0IGFuZCB0aGUgaG9zdCB3ZW50IGRvd24uXG4gKlxuICogIyMgVGhlIGRlc2lnblxuICpcbiAqIC0gVGhlICoqbGF1bmNoZXIqKiBtZWFzdXJlcyB0aGUgaG9zdCBmaWxlc3lzdGVtIChgZGYgLWtQYCkgb25jZSBwZXJcbiAqICAgbGF1bmNoIGFuZCBoYW5kcyB0aGUgcmVhZGluZyBpbiBhcyBgVklCRV9IT1NUX0RJU0tfQVZBSUxfQllURVNgIC9cbiAqICAgYFZJQkVfSE9TVF9ESVNLX1RPVEFMX0JZVEVTYDsgaXQgYWxzbyByZWZ1c2VzIHRvIGxhdW5jaCBiZWxvdyBhIGhhcmRcbiAqICAgZmxvb3IgKHJ1bi5zaCksIGFmdGVyIHRoZSBzdG9yZSByZWNsYW1hdGlvbiBoYXMgaGFkIGl0cyBjaGFuY2UuXG4gKiAtIFRoZSAqKndvcmtlcioqIGtlZXBzIHRoYXQgYmFzZWxpbmUgYW5kIGVzdGltYXRlcyB0aGUgaG9zdCdzIGN1cnJlbnRcbiAqICAgZnJlZSBzcGFjZSBhcyBgYmFzZWxpbmUg4oiSIGdyb3d0aCBvZiB0aGUgd29yayB2b2x1bWUgc2luY2UgbGF1bmNoYFxuICogICAodGhlIHZvbHVtZSBpbWFnZSBvbmx5IGdyb3dzIG9uIHRoZSBob3N0KSwgcmUtcHJvYmVkIG9uIGEgYm91bmRlZFxuICogICBjYWRlbmNlLiBJbiBuYXRpdmUgbW9kZSAobm8gYmFzZWxpbmUpIHRoZSB3b3JrIGRpcidzIG93biBmaWxlc3lzdGVtXG4gKiAgIGlzIHRoZSBob3N0LCBzbyBgZGZgIHRoZXJlIGlzIHRoZSB0cnV0aC5cbiAqIC0gVGhlICoqbGF1bmNoZXIga2VlcHMgbWVhc3VyaW5nKiogKElzc3VlICMxNTUwKS4gSXQgcnVucyBldmVyeSBmZXdcbiAqICAgbWludXRlcyBmcm9tIGxhdW5jaGQvY3JvbiBhbmQsIHdoZW4gYSB3b3JrZXIgaXMgYWxyZWFkeSB1cCwgd3JpdGVzIHRoZVxuICogICBmcmVzaCBgZGZgIHJlYWRpbmcgdG8gYGhvc3QtZGlzay5qc29uYCBpbiB0aGUgd29ya2VyIGxvZyBkaXJlY3Rvcnkg4oCUXG4gKiAgIHRoZSBvbmUgaG9zdCBwYXRoIHRoZSBjb250YWluZXIgbW91bnRzIHJlYWQtd3JpdGUuIFRoZSB3b3JrZXIgYWRvcHRzIGFcbiAqICAgcmVhZGluZyB0aGF0IGlzIG5ld2VyIHRoYW4gd2hhdCBpdCBob2xkcyBhbmQgbm90IHN0YWxlLCBhbmQgcmUtYmFzZXNcbiAqICAgdGhlIGdyb3d0aCB0ZXJtIGF0IHRoYXQgbW9tZW50LiBBIGJhc2VsaW5lIHRha2VuIG9uY2UgY291bGQgb25seSBldmVyXG4gKiAgIGZhbGw6IG9uIEdSUS0yNSB0aGUgaG9zdCBmcmVlZCAyNiBHQiBtaWQtcnVuIGFuZCB0aGUgd29ya2VyIHN0YXllZFxuICogICBwYXJrZWQgYmVsb3cgdGhlIGZsb29yIGZvciB0aGUgaG91ciAoMzkgR0IgZXN0aW1hdGVkLCA2NiBHQiByZWFsKSwgYW5kXG4gKiAgIGZpdmUgaG91cnMgbGF0ZXIgYW5vdGhlciBhY2NvdW50IHdyb3RlIDIxIEdCIHRoZSBlc3RpbWF0ZSBjb3VsZCBub3Qgc2VlXG4gKiAgICgzNyBHQiBlc3RpbWF0ZWQsIDIzIEdCIHJlYWwpLiBPbmx5IGEgaG9zdC1zaWRlIG1lYXN1cmVtZW50IGNhbiBtb3ZlXG4gKiAgIHRoZSBmaWd1cmUgZWl0aGVyIHdheSwgYW5kIHRoYXQgaXMgdGhlIG9ubHkgdGhpbmcgdGhhdCBkb2VzLlxuICogLSBCZWxvdyB0aGUgKipsb3cgZmxvb3IqKiB0aGUgd29ya2VyIHN0b3BzIGNsYWltaW5nICh0aGUgY2xhaW0gZ3VhcmRcbiAqICAgZHJhaW5zIHRoZSBwb29sIGV4YWN0bHkgYXMgdGhlIHNwZW5kIGNlaWxpbmcgZG9lcykgYW5kIHJlcG9ydHNcbiAqICAgYGhvc3QtZGlzazogZGVncmFkZWRgOyBiZWxvdyB0aGUgKipoYXJkIGZsb29yKiogdGhlIGxhdW5jaGVyIG5ldmVyXG4gKiAgIHN0YXJ0cyBpdC5cbiAqXG4gKiBFdmVyeSBwcm9iZSBpcyBpbmplY3RhYmxlOyBub3RoaW5nIGhlcmUgcnVucyBhIHN1YnByb2Nlc3MgaW4gdGVzdHMuXG4gKlxuICogQXVzdHJhbGlhbiBFbmdsaXNoIHNwZWxsaW5nIHRocm91Z2hvdXQgKGJlaGF2aW91ciwgY29sb3VyLCBvcmdhbmlzYXRpb24pLlxuICovXG5cbmltcG9ydCB7XG4gIGlzTm9uTmVnYXRpdmUsXG4gIHBhcnNlTnVtYmVyLFxuICByZXNvbHZlU2V0dGluZyxcbn0gZnJvbSBcIi4vY29uZmlnX3ByZWNlZGVuY2UudHNcIjtcbmltcG9ydCB7IHJ1bldpdGhUaW1lb3V0IH0gZnJvbSBcIi4vc3VicHJvY2Vzc190aW1lb3V0LnRzXCI7XG5pbXBvcnQge1xuICBjbGFzc2lmeVdvcmtWb2x1bWVSYXRjaGV0LFxuICBkZXNjcmliZVdvcmtWb2x1bWVSYXRjaGV0LFxuICB0eXBlIFdvcmtWb2x1bWVSYXRjaGV0LFxufSBmcm9tIFwiLi93b3JrX3ZvbHVtZV9yYXRjaGV0LnRzXCI7XG5cbi8qKiBFbnYgdGhlIGxhdW5jaGVyIHNldHMgZnJvbSB0aGUgaG9zdCdzIGBkZmAgYXQgbGF1bmNoLiAqL1xuZXhwb3J0IGNvbnN0IEhPU1RfRElTS19BVkFJTF9FTlYgPSBcIlZJQkVfSE9TVF9ESVNLX0FWQUlMX0JZVEVTXCI7XG5leHBvcnQgY29uc3QgSE9TVF9ESVNLX1RPVEFMX0VOViA9IFwiVklCRV9IT1NUX0RJU0tfVE9UQUxfQllURVNcIjtcbi8qKiBPcGVyYXRvciBvdmVycmlkZXMgZm9yIHRoZSBmbG9vcnMsIGluIHdob2xlIGdpZ2FieXRlcyAvIHBlcmNlbnQuICovXG5leHBvcnQgY29uc3QgSE9TVF9ESVNLX0xPV19GTE9PUl9HQl9FTlYgPSBcIlZJQkVfSE9TVF9ESVNLX0xPV19GTE9PUl9HQlwiO1xuZXhwb3J0IGNvbnN0IEhPU1RfRElTS19MT1dfRkxPT1JfUEVSQ0VOVF9FTlYgPVxuICBcIlZJQkVfSE9TVF9ESVNLX0xPV19GTE9PUl9QRVJDRU5UXCI7XG5cbi8qKiBCZWxvdyB0aGlzIG11Y2ggZnJlZSB0aGUgd29ya2VyIHN0b3BzIGNsYWltaW5nIG5ldyB3b3JrLiAqL1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfTE9XX0ZMT09SX0dCID0gMjA7XG4vKiog4oCmb3IgYmVsb3cgdGhpcyBwZXJjZW50YWdlIG9mIHRoZSBmaWxlc3lzdGVtLCB3aGljaGV2ZXIgaXMgbGFyZ2VyLiAqL1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfTE9XX0ZMT09SX1BFUkNFTlQgPSAxMDtcblxuY29uc3QgR0lCID0gMV8wNzNfNzQxXzgyNDtcbmNvbnN0IERGX1RJTUVPVVRfTVMgPSAxMF8wMDA7XG5cbi8qKiBPbmUgZnJlZS1zcGFjZSByZWFkaW5nIG9mIGEgZmlsZXN5c3RlbS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgRGlza1JlYWRpbmcge1xuICAvKiogQnl0ZXMgYXZhaWxhYmxlIHRvIHRoaXMgdXNlci4gKi9cbiAgYXZhaWxhYmxlQnl0ZXM6IG51bWJlcjtcbiAgLyoqIEJ5dGVzIHVzZWQuICovXG4gIHVzZWRCeXRlczogbnVtYmVyO1xuICAvKiogRmlsZXN5c3RlbSBzaXplIGluIGJ5dGVzLiAqL1xuICB0b3RhbEJ5dGVzOiBudW1iZXI7XG59XG5cbi8qKiBXaGF0IHRoZSB3b3JrZXIgYmVsaWV2ZXMgYWJvdXQgdGhlIGhvc3QncyBkaXNrIHJpZ2h0IG5vdy4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgSG9zdERpc2tTdGF0dXMge1xuICBsZXZlbDogXCJva1wiIHwgXCJsb3dcIiB8IFwidW5rbm93blwiO1xuICAvKiogRXN0aW1hdGVkIChvciBtZWFzdXJlZCkgaG9zdCBmcmVlIGJ5dGVzLCB3aGVuIGtub3duLiAqL1xuICBhdmFpbGFibGVCeXRlcz86IG51bWJlcjtcbiAgdG90YWxCeXRlcz86IG51bWJlcjtcbiAgLyoqIFdoZXJlIHRoZSBudW1iZXIgY2FtZSBmcm9tLiAqL1xuICBzb3VyY2U6IFwibGF1bmNoLWJhc2VsaW5lXCIgfCBcIm5hdGl2ZS1kZlwiIHwgXCJub25lXCI7XG4gIC8qKiBIdW1hbi1yZWFkYWJsZSByZWFzb24gZm9yIHRoZSBsZXZlbC4gKi9cbiAgZGV0YWlsOiBzdHJpbmc7XG59XG5cbi8qKlxuICogUGFyc2UgUE9TSVggYGRmIC1rUGAgb3V0cHV0LlxuICpcbiAqIFRoZSBkYXRhIGxpbmUgbWF5IHdyYXAgd2hlbiB0aGUgZGV2aWNlIG5hbWUgaXMgbG9uZywgc28gdGhlIG51bWVyaWNcbiAqIGNvbHVtbnMgYXJlIHJlYWQgZnJvbSB0aGUgbGFzdCBsaW5lOiAxMDI0LWJsb2NrcywgdXNlZCwgYXZhaWxhYmxlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VEZktQKHRleHQ6IHN0cmluZyk6IERpc2tSZWFkaW5nIHwgbnVsbCB7XG4gIGNvbnN0IGxpbmVzID0gdGV4dC50cmltKCkuc3BsaXQoXCJcXG5cIikubWFwKChsKSA9PiBsLnRyaW0oKSkuZmlsdGVyKChsKSA9PlxuICAgIGwgIT09IFwiXCJcbiAgKTtcbiAgaWYgKGxpbmVzLmxlbmd0aCA8IDIpIHJldHVybiBudWxsO1xuICBjb25zdCBudW1iZXJzID0gbGluZXNbbGluZXMubGVuZ3RoIC0gMV0hLnNwbGl0KC9cXHMrLylcbiAgICAubWFwKChmKSA9PiBOdW1iZXIoZikpXG4gICAgLmZpbHRlcigobikgPT4gTnVtYmVyLmlzRmluaXRlKG4pKTtcbiAgaWYgKG51bWJlcnMubGVuZ3RoIDwgMykgcmV0dXJuIG51bGw7XG4gIGNvbnN0IHRvdGFsID0gbnVtYmVyc1swXSEgKiAxMDI0O1xuICBjb25zdCB1c2VkID0gbnVtYmVyc1sxXSEgKiAxMDI0O1xuICBjb25zdCBhdmFpbGFibGUgPSBudW1iZXJzWzJdISAqIDEwMjQ7XG4gIGlmICh0b3RhbCA8PSAwIHx8IGF2YWlsYWJsZSA8IDAgfHwgdXNlZCA8IDApIHJldHVybiBudWxsO1xuICByZXR1cm4geyBhdmFpbGFibGVCeXRlczogYXZhaWxhYmxlLCB1c2VkQnl0ZXM6IHVzZWQsIHRvdGFsQnl0ZXM6IHRvdGFsIH07XG59XG5cbi8qKiBQcm9kdWN0aW9uIGBkZiAta1AgPHBhdGg+YCBwcm9iZS4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBwcm9iZURpc2tSZWFkaW5nKFxuICBwYXRoOiBzdHJpbmcsXG4pOiBQcm9taXNlPERpc2tSZWFkaW5nIHwgbnVsbD4ge1xuICAvLyBObyBgcXVpZXQ6IHRydWVgIChJc3N1ZSAjMzQ1KTogYHF1aWV0YCBzZXRzIGBzdGRvdXQ6IFwibnVsbFwiYCBhbmQgcmV0dXJuc1xuICAvLyBhbiBlbXB0eSBzdHJpbmcsIHNvIGBwYXJzZURmS1BgIHNhdyBub3RoaW5nIGFuZCBldmVyeSByZWFkaW5nIGNhbWUgYmFja1xuICAvLyBhcyBcImRmIHVucmVhZGFibGVcIiDigJQgdGhlIGJsaW5kIGhvc3QtZGlzayBzaWduYWwgaW4gdGhlIEdSUS0yMyBvdXRhZ2UuXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1bldpdGhUaW1lb3V0KFwiZGZcIiwgW1wiLWtQXCIsIHBhdGhdLCB7XG4gICAgdGltZW91dE1zOiBERl9USU1FT1VUX01TLFxuICB9KTtcbiAgaWYgKCFyZXN1bHQub2sgfHwgcmVzdWx0LnZhbHVlLnRpbWVkT3V0IHx8ICFyZXN1bHQudmFsdWUuc3VjY2Vzcykge1xuICAgIHJldHVybiBudWxsO1xuICB9XG4gIHJldHVybiBwYXJzZURmS1AocmVzdWx0LnZhbHVlLnN0ZG91dCk7XG59XG5cbi8qKiBXaGVyZSBvbmUgZmxvb3IgdGVybSdzIHZhbHVlIGNhbWUgZnJvbSAoSXNzdWUgIzczMikuICovXG5leHBvcnQgdHlwZSBEaXNrRmxvb3JTb3VyY2UgPSBcImNvbmZpZ1wiIHwgXCJlbnZcIiB8IFwiZGVmYXVsdFwiO1xuXG4vKiogVGhlIGZsb29ycywgYW5kIHdoZXJlIGVhY2ggdGVybSBjYW1lIGZyb20uICovXG5leHBvcnQgaW50ZXJmYWNlIERpc2tGbG9vcnMge1xuICBsb3dGbG9vckdiOiBudW1iZXI7XG4gIGxvd0Zsb29yUGVyY2VudDogbnVtYmVyO1xuICAvKiogV2hlcmUgYGxvd0Zsb29yR2JgIGNhbWUgZnJvbS4gKi9cbiAgbG93Rmxvb3JHYlNvdXJjZTogRGlza0Zsb29yU291cmNlO1xuICAvKiogV2hlcmUgYGxvd0Zsb29yUGVyY2VudGAgY2FtZSBmcm9tLiAqL1xuICBsb3dGbG9vclBlcmNlbnRTb3VyY2U6IERpc2tGbG9vclNvdXJjZTtcbn1cblxuLyoqXG4gKiBUaGUgZmxvb3IgdGVybXMgYSBkZXBsb3ltZW50IHN0YXRlcyBpbiBgLmNvbmZpZy5qc29uYCAoSXNzdWUgIzczMikuXG4gKlxuICogQm90aCBvcHRpb25hbDogYW4gdW5zZXQgdGVybSB0YWtlcyB0aGUgZW52aXJvbm1lbnQgb3ZlcnJpZGUsIGFuZCBmYWlsaW5nXG4gKiB0aGF0IHRoZSBkZWZhdWx0LCBzbyBhIGhvc3QgdGhhdCBjb25maWd1cmVzIG5laXRoZXIgYmVoYXZlcyBleGFjdGx5IGFzIGl0XG4gKiBkaWQgYmVmb3JlIHRoaXMgd2FzIGNvbmZpZ3VyYWJsZS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBDb25maWd1cmVkRGlza0Zsb29ycyB7XG4gIGhvc3REaXNrTG93Rmxvb3JHYj86IG51bWJlcjtcbiAgaG9zdERpc2tMb3dGbG9vclBlcmNlbnQ/OiBudW1iZXI7XG59XG5cbi8qKiBBIGZpbml0ZSBudW1iZXIgZnJvbSBhbiBlbnYgdmFsdWUsIG9yIG51bGwgd2hlbiB1bnNldC9ibGFuay9nYXJiYWdlLiAqL1xuZnVuY3Rpb24gZW52TnVtYmVyKHZhbHVlOiBzdHJpbmcgfCB1bmRlZmluZWQpOiBudW1iZXIgfCBudWxsIHtcbiAgY29uc3QgdHJpbW1lZCA9IHZhbHVlPy50cmltKCkgPz8gXCJcIjtcbiAgaWYgKHRyaW1tZWQgPT09IFwiXCIpIHJldHVybiBudWxsO1xuICBjb25zdCBwYXJzZWQgPSBOdW1iZXIodHJpbW1lZCk7XG4gIHJldHVybiBOdW1iZXIuaXNGaW5pdGUocGFyc2VkKSA/IHBhcnNlZCA6IG51bGw7XG59XG5cbi8qKlxuICogUmVzb2x2ZSB0aGUgY2xhaW1pbmcgZmxvb3IncyB0d28gdGVybXMsIGFuZCBzYXkgd2hlcmUgZWFjaCBjYW1lIGZyb20uXG4gKlxuICogUHJlY2VkZW5jZSwgcGVyIHRoZSBydWxlIElzc3VlICMyODkgc2V0IGZvciBldmVyeSBvdGhlciBrbm9iOiAqKnRoZVxuICogYC5jb25maWcuanNvbmAga2V5IGFsd2F5cyB3aW5zIG92ZXIgdGhlIGVudmlyb25tZW50IHZhcmlhYmxlKiosIGFuZCB0aGVcbiAqIGRlZmF1bHQgYXBwbGllcyBvbmx5IHdoZW4gbmVpdGhlciBzdGF0ZXMgYSB1c2FibGUgdmFsdWUuIFRoZSB0ZXJtcyByZXNvbHZlXG4gKiBpbmRlcGVuZGVudGx5LCBzbyBhIGRlcGxveW1lbnQgbWF5IHBpbiB0aGUgcGVyY2VudGFnZSBpbiBpdHMgY29uZmlndXJhdGlvblxuICogYW5kIHN0aWxsIHJhaXNlIHRoZSBnaWdhYnl0ZSB0ZXJtIGZvciBvbmUgbGF1bmNoIGZyb20gdGhlIGVudmlyb25tZW50LlxuICpcbiAqIFRoZSBmbG9vciBpcyB0aGUgKmxhcmdlciogb2YgdGhlIHR3byAoe0BsaW5rIGxvd0Zsb29yQnl0ZXN9KSwgd2hpY2ggb24gYVxuICogMS44NzUgVEIgZmlsZXN5c3RlbSBtYWtlcyB0aGUgMTAgJSB0ZXJtIOKJiCAxODcgR0Ig4oCUIHRoZSByZWFkaW5nIHRoYXQgcmVmdXNlZFxuICogd29yayBvbiBhIGhvc3Qgd2l0aCAzNy41IEdCIGZyZWUgKElzc3VlICM3MzIpLiBUaGUgZGVmYXVsdCBmb3JtdWxhIGlzXG4gKiB1bmNoYW5nZWQ7IHdoYXQgY2hhbmdlZCBpcyB0aGF0IGEgZGVwbG95bWVudCBjYW4gbm93IHN0YXRlIGl0cyBvd24sIGluIHRoZVxuICogZmlsZSB0aGUgcmVzdCBvZiBpdHMgY29uZmlndXJhdGlvbiBsaXZlcyBpbi5cbiAqXG4gKiBAcGFyYW0gZW52IC0gRW52aXJvbm1lbnQgcmVhZGVyIChpbmplY3RhYmxlIGZvciB0ZXN0cylcbiAqIEBwYXJhbSBjb25maWd1cmVkIC0gVGhlIGRlcGxveW1lbnQncyBgLmNvbmZpZy5qc29uYCBmbG9vciB0ZXJtcywgaWYgYW55XG4gKiBAcmV0dXJucyBCb3RoIHRlcm1zIGFuZCB0aGUgb3JpZ2luIG9mIGVhY2hcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVEaXNrRmxvb3JzKFxuICBlbnY6IChuYW1lOiBzdHJpbmcpID0+IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgY29uZmlndXJlZDogQ29uZmlndXJlZERpc2tGbG9vcnMgPSB7fSxcbik6IERpc2tGbG9vcnMge1xuICAvLyBUaGUgcnVsZSBpdHNlbGYgbm93IGxpdmVzIGluIGNvbmZpZ19wcmVjZWRlbmNlLnRzIChJc3N1ZSAjODc0KSwgc28gdGhpc1xuICAvLyBzaXRlIHN0YXRlcyB3aGljaCBzb3VyY2VzIGl0IGhhcyByYXRoZXIgdGhhbiByZS1kZWNpZGluZyB3aGljaCBvbmUgd2lucy5cbiAgLy8gQmVoYXZpb3VyIGlzIHVuY2hhbmdlZDogY29uZmlnLCB0aGVuIGVudmlyb25tZW50LCB0aGVuIGRlZmF1bHQsIHdpdGggYW5cbiAgLy8gdW51c2FibGUgdmFsdWUgaW4gZWl0aGVyIHRyZWF0ZWQgYXMgYWJzZW50LlxuICBjb25zdCBnYiA9IHJlc29sdmVTZXR0aW5nPG51bWJlcj4oe1xuICAgIGNvbmZpZ0tleTogXCJob3N0X2Rpc2tfbG93X2Zsb29yX2diXCIsXG4gICAgZW52VmFyOiBIT1NUX0RJU0tfTE9XX0ZMT09SX0dCX0VOVixcbiAgICBlbnYsXG4gICAgY29uZmlndXJlZDogY29uZmlndXJlZC5ob3N0RGlza0xvd0Zsb29yR2IsXG4gICAgZmFsbGJhY2s6IERFRkFVTFRfTE9XX0ZMT09SX0dCLFxuICAgIHBhcnNlOiBwYXJzZU51bWJlcixcbiAgICBhY2NlcHQ6IGlzTm9uTmVnYXRpdmUsXG4gIH0pO1xuICBjb25zdCBwZXJjZW50ID0gcmVzb2x2ZVNldHRpbmc8bnVtYmVyPih7XG4gICAgY29uZmlnS2V5OiBcImhvc3RfZGlza19sb3dfZmxvb3JfcGVyY2VudFwiLFxuICAgIGVudlZhcjogSE9TVF9ESVNLX0xPV19GTE9PUl9QRVJDRU5UX0VOVixcbiAgICBlbnYsXG4gICAgY29uZmlndXJlZDogY29uZmlndXJlZC5ob3N0RGlza0xvd0Zsb29yUGVyY2VudCxcbiAgICBmYWxsYmFjazogREVGQVVMVF9MT1dfRkxPT1JfUEVSQ0VOVCxcbiAgICBwYXJzZTogcGFyc2VOdW1iZXIsXG4gICAgYWNjZXB0OiAodmFsdWUpID0+IGlzTm9uTmVnYXRpdmUodmFsdWUpICYmIHZhbHVlIDw9IDEwMCxcbiAgfSk7XG5cbiAgcmV0dXJuIHtcbiAgICBsb3dGbG9vckdiOiBnYi52YWx1ZSxcbiAgICBsb3dGbG9vckdiU291cmNlOiBnYi5zb3VyY2UsXG4gICAgbG93Rmxvb3JQZXJjZW50OiBwZXJjZW50LnZhbHVlLFxuICAgIGxvd0Zsb29yUGVyY2VudFNvdXJjZTogcGVyY2VudC5zb3VyY2UsXG4gIH07XG59XG5cbi8qKlxuICogUmVhZCB0aGUgZGVwbG95bWVudCdzIGZsb29yIHRlcm1zIG91dCBvZiBpdHMgYC5jb25maWcuanNvbmAgKElzc3VlICM3MzIpLlxuICpcbiAqIFVzZWQgYnkgdGhlIGxhdW5jaGVyLCB3aGljaCByZXNvbHZlcyB0aGUgZmxvb3IgYmVmb3JlIGFueSB3b3JrZXIgaGFzIGxvYWRlZFxuICogYSBjb25maWd1cmF0aW9uLiBBYnNlbnQgZmlsZSDihpIgbm8gdGVybXMgc3RhdGVkLCB3aGljaCBpcyB3aGF0IGFuXG4gKiB1bmNvbmZpZ3VyZWQgaG9zdCBoYXMgYWx3YXlzIGhhZC4gQSBmaWxlIHRoYXQgZXhpc3RzIGJ1dCBjYW5ub3QgYmUgcmVhZCBvclxuICogcGFyc2VkIGlzICoqbm90Kiogc2lsZW50bHkgdHJlYXRlZCBhcyB1bmNvbmZpZ3VyZWQ6IGl0IHRocm93cywgYmVjYXVzZVxuICogcXVpZXRseSBjbGFpbWluZyBhdCBhIGRpZmZlcmVudCBmbG9vciB0aGFuIHRoZSBvcGVyYXRvciB3cm90ZSBpcyB0aGUgY2xhc3NcbiAqIG9mIGZhdWx0IHRoaXMgaXNzdWUgaXMgYWJvdXQuXG4gKlxuICogQHBhcmFtIGNvbmZpZ0ZpbGUgLSBIb3N0IHBhdGggb2YgdGhlIHdvcmtlciBjb25maWd1cmF0aW9uIGZpbGVcbiAqIEByZXR1cm5zIFRoZSBzdGF0ZWQgdGVybXM7IGVtcHR5IHdoZW4gdGhlIGZpbGUgc3RhdGVzIG5vbmVcbiAqIEB0aHJvd3MgV2hlbiB0aGUgZmlsZSBleGlzdHMgYnV0IGlzIHVucmVhZGFibGUgb3IgaXMgbm90IGEgSlNPTiBvYmplY3RcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJlYWRDb25maWd1cmVkRGlza0Zsb29ycyhcbiAgY29uZmlnRmlsZTogc3RyaW5nLFxuKTogUHJvbWlzZTxDb25maWd1cmVkRGlza0Zsb29ycz4ge1xuICBsZXQgdGV4dDogc3RyaW5nO1xuICB0cnkge1xuICAgIHRleHQgPSBhd2FpdCBEZW5vLnJlYWRUZXh0RmlsZShjb25maWdGaWxlKTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBpZiAoZXJyb3IgaW5zdGFuY2VvZiBEZW5vLmVycm9ycy5Ob3RGb3VuZCkgcmV0dXJuIHt9O1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBDYW5ub3QgcmVhZCB0aGUgaG9zdCBkaXNrIGZsb29yOiAke2NvbmZpZ0ZpbGV9IGlzIHVucmVhZGFibGUgYCArXG4gICAgICAgIGAoJHsoZXJyb3IgYXMgRXJyb3IpLm1lc3NhZ2V9KS5gLFxuICAgICk7XG4gIH1cblxuICBsZXQgcGFyc2VkOiB1bmtub3duO1xuICB0cnkge1xuICAgIHBhcnNlZCA9IEpTT04ucGFyc2UodGV4dCk7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYENhbm5vdCByZWFkIHRoZSBob3N0IGRpc2sgZmxvb3I6ICR7Y29uZmlnRmlsZX0gaXMgbm90IHZhbGlkIEpTT04gYCArXG4gICAgICAgIGAoJHsoZXJyb3IgYXMgRXJyb3IpLm1lc3NhZ2V9KS5gLFxuICAgICk7XG4gIH1cbiAgaWYgKHBhcnNlZCA9PT0gbnVsbCB8fCB0eXBlb2YgcGFyc2VkICE9PSBcIm9iamVjdFwiIHx8IEFycmF5LmlzQXJyYXkocGFyc2VkKSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBDYW5ub3QgcmVhZCB0aGUgaG9zdCBkaXNrIGZsb29yOiAke2NvbmZpZ0ZpbGV9IGlzIG5vdCBhIEpTT04gb2JqZWN0LmAsXG4gICAgKTtcbiAgfVxuXG4gIGNvbnN0IHJlY29yZCA9IHBhcnNlZCBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgY29uc3QgZ2IgPSByZWNvcmRbXCJob3N0X2Rpc2tfbG93X2Zsb29yX2diXCJdO1xuICBjb25zdCBwZXJjZW50ID0gcmVjb3JkW1wiaG9zdF9kaXNrX2xvd19mbG9vcl9wZXJjZW50XCJdO1xuICByZXR1cm4ge1xuICAgIC4uLih0eXBlb2YgZ2IgPT09IFwibnVtYmVyXCIgPyB7IGhvc3REaXNrTG93Rmxvb3JHYjogZ2IgfSA6IHt9KSxcbiAgICAuLi4odHlwZW9mIHBlcmNlbnQgPT09IFwibnVtYmVyXCJcbiAgICAgID8geyBob3N0RGlza0xvd0Zsb29yUGVyY2VudDogcGVyY2VudCB9XG4gICAgICA6IHt9KSxcbiAgfTtcbn1cblxuLyoqXG4gKiBUaGUgb3JpZ2luIG9mIGVhY2ggdGVybSwgaW4gdGhlIGNvbXBhY3QgZm9ybSB0aGUgbGF1bmNoIHBsYW4gY2Fycmllcy5cbiAqXG4gKiBUaGUgbGF1bmNoZXIgcHJpbnRzIGl0IGJlc2lkZSB0aGUgZnJlZS1zcGFjZSByZWFkaW5nLCBzbyBhIHJlZnVzZWQgY2xhaW1cbiAqIHNheXMgd2hpY2gga25vYiB3b3VsZCBtb3ZlIGl0IChJc3N1ZSAjNzMyKS5cbiAqXG4gKiBAcGFyYW0gZmxvb3JzIC0gVGhlIHJlc29sdmVkIGZsb29yc1xuICogQHJldHVybnMgZS5nLiBgZ2I9ZW52LHBlcmNlbnQ9Y29uZmlnYFxuICovXG5leHBvcnQgZnVuY3Rpb24gZGlza0Zsb29yT3JpZ2luKGZsb29yczogRGlza0Zsb29ycyk6IHN0cmluZyB7XG4gIHJldHVybiBgZ2I9JHtmbG9vcnMubG93Rmxvb3JHYlNvdXJjZX0scGVyY2VudD0ke2Zsb29ycy5sb3dGbG9vclBlcmNlbnRTb3VyY2V9YDtcbn1cblxuLyoqXG4gKiBPbmUgbGluZSBuYW1pbmcgdGhlIHJlc29sdmVkIGZsb29yIGFuZCB3aGVyZSBlYWNoIHRlcm0gY2FtZSBmcm9tLlxuICpcbiAqIEBwYXJhbSBmbG9vcnMgLSBUaGUgcmVzb2x2ZWQgZmxvb3JzXG4gKiBAcGFyYW0gdG90YWxCeXRlcyAtIFNpemUgb2YgdGhlIGZpbGVzeXN0ZW0gdGhlIGZsb29yIGlzIHRha2VuIGFnYWluc3RcbiAqIEByZXR1cm5zIEEgaHVtYW4tcmVhZGFibGUgZGVzY3JpcHRpb25cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRlc2NyaWJlRGlza0Zsb29ycyhcbiAgZmxvb3JzOiBEaXNrRmxvb3JzLFxuICB0b3RhbEJ5dGVzOiBudW1iZXIsXG4pOiBzdHJpbmcge1xuICBjb25zdCBieUdiID0gZmxvb3JzLmxvd0Zsb29yR2IgKiBHSUI7XG4gIGNvbnN0IGJ5UGVyY2VudCA9IChmbG9vcnMubG93Rmxvb3JQZXJjZW50IC8gMTAwKSAqIHRvdGFsQnl0ZXM7XG4gIGNvbnN0IHdpbm5lciA9IGJ5R2IgPj0gYnlQZXJjZW50ID8gXCJ0aGUgR0IgdGVybVwiIDogXCJ0aGUgcGVyY2VudCB0ZXJtXCI7XG4gIHJldHVybiBgJHtcbiAgICBNYXRoLnJvdW5kKGxvd0Zsb29yQnl0ZXModG90YWxCeXRlcywgZmxvb3JzKSAvIEdJQiAqIDEwKSAvIDEwXG4gIH0gR0IgYCArXG4gICAgYCgke3dpbm5lcn06ICR7Zmxvb3JzLmxvd0Zsb29yR2J9IEdCIFske2Zsb29ycy5sb3dGbG9vckdiU291cmNlfV0gdnMgYCArXG4gICAgYCR7Zmxvb3JzLmxvd0Zsb29yUGVyY2VudH0lIFske2Zsb29ycy5sb3dGbG9vclBlcmNlbnRTb3VyY2V9XSBvZiBgICtcbiAgICBgJHtNYXRoLnJvdW5kKHRvdGFsQnl0ZXMgLyBHSUIpfSBHQilgO1xufVxuXG4vKiogVGhlIGxhcmdlciBvZiB0aGUgdHdvIGZsb29ycywgaW4gYnl0ZXMsIGZvciBhIGZpbGVzeXN0ZW0gb2YgYHRvdGFsQnl0ZXNgLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGxvd0Zsb29yQnl0ZXModG90YWxCeXRlczogbnVtYmVyLCBmbG9vcnM6IERpc2tGbG9vcnMpOiBudW1iZXIge1xuICByZXR1cm4gTWF0aC5tYXgoXG4gICAgZmxvb3JzLmxvd0Zsb29yR2IgKiBHSUIsXG4gICAgKGZsb29ycy5sb3dGbG9vclBlcmNlbnQgLyAxMDApICogdG90YWxCeXRlcyxcbiAgKTtcbn1cblxuLyoqXG4gKiBUaGUgbGF1bmNoZXIncyBwZXItdGljayByZWFkaW5nLCBhcyB3cml0dGVuIHRvIHRoZSB3b3JrZXIgbG9nIGRpcmVjdG9yeVxuICogKElzc3VlICMxNTUwKTogYDxsb2cgZGlyPi9ob3N0LWRpc2suanNvbmAsIGhvc3Qtc2lkZVxuICogYCR7UlVOX0NPUkVfTE9HX0RJUn0vaG9zdC1kaXNrLmpzb25gLCBndWVzdC1zaWRlIGAke0hPTUV9L2xvZ3MvaG9zdC1kaXNrLmpzb25gLlxuICovXG5leHBvcnQgY29uc3QgSE9TVF9ESVNLX1JFRlJFU0hfRklMRSA9IFwiaG9zdC1kaXNrLmpzb25cIjtcblxuLyoqXG4gKiBMYXVuY2hlci1zaWRlIG92ZXJyaWRlIG9mIHRoZSByZWZyZXNoIGludGVydmFsIChJc3N1ZSAjMTY5MSksIHJlYWQgYnlcbiAqIGBydW4uc2hgIGFzIGBIT1NUX0RJU0tfUkVGUkVTSF9TRUNPTkRTYCB3aGlsZSBpdCBzaXRzIGF0dGFjaGVkIHRvIGl0c1xuICogY29udGFpbmVyLiBUaGUgbGF1bmNoZXIgcmV3cml0ZXMgdGhlIGZpbGUgaXRzZWxmIGV2ZXJ5IGZpdmUgbWludXRlcyBmb3IgYXNcbiAqIGxvbmcgYXMgdGhlIGNvbnRhaW5lciBydW5zLCBiZWNhdXNlIGEgc2NoZWR1bGVyIHRoYXQgbmV2ZXIgb3ZlcmxhcHMgYVxuICogc3RpbGwtcnVubmluZyBqb2IgKGxhdW5jaGQncyBgU3RhcnRJbnRlcnZhbGApIGdpdmVzIGl0IG5vIHNlY29uZCB0aWNrIHRvXG4gKiBkbyBzbyBmcm9tLiBUZXN0cyBzZXQgdGhpcyB0byBhIHNlY29uZCBvciB0d287IHByb2R1Y3Rpb24gbGVhdmVzIGl0IHVuc2V0LlxuICovXG5leHBvcnQgY29uc3QgSE9TVF9ESVNLX1JFRlJFU0hfSU5URVJWQUxfRU5WID0gXCJWSUJFX0hPU1RfRElTS19SRUZSRVNIX1NFQ09ORFNcIjtcblxuLyoqXG4gKiBIb3cgb2xkIGEgbGF1bmNoZXIgcmVhZGluZyBtYXkgYmUgYW5kIHN0aWxsIGJlIGFkb3B0ZWQuIFRoZSBsYXVuY2hlclxuICogcmVmcmVzaGVzIGV2ZXJ5IDMwMCBzIOKAlCBmcm9tIGl0cyBzY2hlZHVsZXIgdGljaywgb3IgZnJvbSB0aGUgYXR0YWNoZWRcbiAqIGxhdW5jaGVyIGl0c2VsZiB3aGlsZSB0aGUgY29udGFpbmVyIHJ1bnMgKElzc3VlICMxNjkxKTsgdGhyZWUgbWlzc2VkXG4gKiByZWZyZXNoZXMgbWVhbnMgaXQgaXMgbm90IHJ1bm5pbmcsIGFuZCBhIGZpZ3VyZSBmcm9tIGEgZGVhZCBsYXVuY2hlciBpcyBub3RcbiAqIGZyZXNoZXIgdGhhbiB3aGF0IHRoZSB3b3JrZXIgaG9sZHMuXG4gKi9cbmV4cG9ydCBjb25zdCBERUZBVUxUX1JFRlJFU0hfTUFYX0FHRV9NUyA9IDE1ICogNjBfMDAwO1xuXG4vKiogT25lIHJlYWRpbmcgdGhlIGxhdW5jaGVyIHRvb2sgb2YgdGhlIGhvc3QgZmlsZXN5c3RlbSAoSXNzdWUgIzE1NTApLiAqL1xuZXhwb3J0IGludGVyZmFjZSBIb3N0RGlza1JlZnJlc2gge1xuICBhdmFpbGFibGVCeXRlczogbnVtYmVyO1xuICB0b3RhbEJ5dGVzOiBudW1iZXI7XG4gIC8qKiBXaGVuIHRoZSBsYXVuY2hlciBtZWFzdXJlZCwgVW5peCBzZWNvbmRzLiAqL1xuICBtZWFzdXJlZEF0OiBudW1iZXI7XG4gIC8qKlxuICAgKiBXaGV0aGVyIHRoZSBydW50aW1lIHJlZnVzZWQgdG8gdHJpbSB0aGUgd29yayB2b2x1bWUgdGhpcyBsYXVuY2hcbiAgICogKElzc3VlICMyMDgwKS4gQWJzZW50IGZyb20gb2xkZXIgbGF1bmNoZXJzLCB3aGljaCByZWFkcyBhcyBgZmFsc2VgLlxuICAgKi9cbiAgd29ya1ZvbHVtZVRyaW1SZWZ1c2VkPzogYm9vbGVhbjtcbiAgLyoqXG4gICAqIFdoZXRoZXIgdGhlIGxhdW5jaGVyIGRlY2xpbmVkIHRvIHJlY3JlYXRlIHRoZSB3b3JrIHZvbHVtZSB0aGlzIGxhdW5jaCxcbiAgICogYmVjYXVzZSByZWNyZWF0aW5nIGl0IHdvdWxkIG5vdCByZXR1cm4gdGhlIG1pc3Npbmcgc3BhY2UgdG8gdGhlIGhvc3RcbiAgICogKGBbV09SS19WT0xVTUVfVU5SRUNPVkVSRURdYCkuIEFic2VudCBmcm9tIG9sZGVyIGxhdW5jaGVycywgd2hpY2ggcmVhZHMgYXNcbiAgICogYGZhbHNlYC5cbiAgICovXG4gIHdvcmtWb2x1bWVSZWNyZWF0ZURlY2xpbmVkPzogYm9vbGVhbjtcbiAgLyoqXG4gICAqIFdoZXRoZXIgdGhlIGxhdW5jaGVyIHJlY3JlYXRlZCB0aGUgd29yayB2b2x1bWUgdGhpcyBsYXVuY2ggYW5kIHRoZSBob3N0XG4gICAqIHdhcyBzdGlsbCBiZWxvdyBpdHMgZmxvb3IgYWZ0ZXJ3YXJkcywgd2l0aCB0aGF0IHJlYWRpbmcgcmVjb3JkZWQgc28gdGhlXG4gICAqIG5leHQgbGF1bmNoIGRlY2xpbmVzIGFnYWluc3QgaXQgaW5zdGVhZCBvZiByZWNyZWF0aW5nIGFnYWluIChJc3N1ZSAjNDQ5OCkuXG4gICAqIEFic2VudCBmcm9tIG9sZGVyIGxhdW5jaGVycywgd2hpY2ggcmVhZHMgYXMgYGZhbHNlYC5cbiAgICovXG4gIHdvcmtWb2x1bWVSZWNyZWF0ZVVucmVjb3ZlcmVkPzogYm9vbGVhbjtcbiAgLyoqXG4gICAqIFRoZSB0ZXh0IG9mIHRoZSBsYXJnZXN0IGhvc3QgZGlyZWN0b3JpZXMgbGluZSB0aGUgbGF1bmNoZXIgbG9nZ2VkLCBmb3JcbiAgICogdGhlIHN0b3AgcmVhc29uLiBDb250cm9sIGNoYXJhY3RlcnMgYXJlIHN0cmlwcGVkIGFuZCB0aGUgbGVuZ3RoIGNhcHBlZFxuICAgKiAoc2VlIHtAbGluayBNQVhfTEFSR0VTVF9IT1NUX0RJUkVDVE9SSUVTX0NIQVJTfSk7IGFic2VudCBvciBibGFuayByZWFkcyBhc1xuICAgKiBub25lLlxuICAgKi9cbiAgbGFyZ2VzdEhvc3REaXJlY3Rvcmllcz86IHN0cmluZztcbn1cblxuLyoqIFRoZSBsb25nZXN0IGBsYXJnZXN0SG9zdERpcmVjdG9yaWVzYCB0ZXh0IHRoZSB3b3JrZXIga2VlcHMuICovXG5leHBvcnQgY29uc3QgTUFYX0xBUkdFU1RfSE9TVF9ESVJFQ1RPUklFU19DSEFSUyA9IDIwMDA7XG5cbi8qKlxuICogTWFrZSB0aGUgbGF1bmNoZXIncyBkaXJlY3RvcnkgdGV4dCBzYWZlIHRvIHJlbmRlciBvbiBvbmUgbG9nIGxpbmU6IGV2ZXJ5XG4gKiBjb250cm9sIGNoYXJhY3RlciAobmV3bGluZXMgaW5jbHVkZWQpIGJlY29tZXMgYSBzcGFjZSwgdGhlIGVuZHMgYXJlIHRyaW1tZWQsXG4gKiBhbmQgdGhlIHJlc3VsdCBpcyBjYXBwZWQuIEJsYW5rIGFmdGVyIHRoYXQgcmVhZHMgYXMgYWJzZW50LlxuICovXG5mdW5jdGlvbiBzYW5pdGlzZUxhcmdlc3RIb3N0RGlyZWN0b3JpZXModGV4dDogc3RyaW5nKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgY29uc3QgZmxhdCA9IHRleHRcbiAgICAvLyBDb250cm9sIGNoYXJhY3RlcnMgYXJlIHRoZSBwb2ludDogdGhleSBtdXN0IG5vdCByZWFjaCBhIGxvZyBsaW5lLlxuICAgIC8vIGRlbm8tbGludC1pZ25vcmUgbm8tY29udHJvbC1yZWdleFxuICAgIC5yZXBsYWNlKC9bXFx1MDAwMC1cXHUwMDFGXFx1MDA3Ri1cXHUwMDlGXFx1MjAyOFxcdTIwMjldL2csIFwiIFwiKVxuICAgIC50cmltKClcbiAgICAuc2xpY2UoMCwgTUFYX0xBUkdFU1RfSE9TVF9ESVJFQ1RPUklFU19DSEFSUylcbiAgICAudHJpbSgpO1xuICByZXR1cm4gZmxhdCA9PT0gXCJcIiA/IHVuZGVmaW5lZCA6IGZsYXQ7XG59XG5cbi8qKiBQYXJzZSBhIGBob3N0LWRpc2suanNvbmAgYm9keTsgYW55dGhpbmcgbWFsZm9ybWVkIHJlYWRzIGFzIG5vIHJlYWRpbmcuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VIb3N0RGlza1JlZnJlc2godGV4dDogc3RyaW5nKTogSG9zdERpc2tSZWZyZXNoIHwgbnVsbCB7XG4gIGxldCBwYXJzZWQ6IHVua25vd247XG4gIHRyeSB7XG4gICAgcGFyc2VkID0gSlNPTi5wYXJzZSh0ZXh0KTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbiAgaWYgKHR5cGVvZiBwYXJzZWQgIT09IFwib2JqZWN0XCIgfHwgcGFyc2VkID09PSBudWxsKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgbyA9IHBhcnNlZCBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgY29uc3QgYXZhaWwgPSBvLmF2YWlsYWJsZUJ5dGVzO1xuICBjb25zdCB0b3RhbCA9IG8udG90YWxCeXRlcztcbiAgY29uc3QgYXQgPSBvLm1lYXN1cmVkQXQ7XG4gIGlmIChcbiAgICB0eXBlb2YgYXZhaWwgIT09IFwibnVtYmVyXCIgfHwgdHlwZW9mIHRvdGFsICE9PSBcIm51bWJlclwiIHx8XG4gICAgdHlwZW9mIGF0ICE9PSBcIm51bWJlclwiIHx8ICFOdW1iZXIuaXNGaW5pdGUoYXZhaWwpIHx8XG4gICAgIU51bWJlci5pc0Zpbml0ZSh0b3RhbCkgfHwgIU51bWJlci5pc0Zpbml0ZShhdCkgfHwgYXZhaWwgPCAwIHx8XG4gICAgdG90YWwgPD0gMCB8fCBhdCA8PSAwXG4gICkge1xuICAgIHJldHVybiBudWxsO1xuICB9XG4gIGNvbnN0IHJlZnVzZWQgPSBvLndvcmtWb2x1bWVUcmltUmVmdXNlZDtcbiAgaWYgKHJlZnVzZWQgIT09IHVuZGVmaW5lZCAmJiB0eXBlb2YgcmVmdXNlZCAhPT0gXCJib29sZWFuXCIpIHJldHVybiBudWxsO1xuICBjb25zdCBkZWNsaW5lZCA9IG8ud29ya1ZvbHVtZVJlY3JlYXRlRGVjbGluZWQ7XG4gIGlmIChkZWNsaW5lZCAhPT0gdW5kZWZpbmVkICYmIHR5cGVvZiBkZWNsaW5lZCAhPT0gXCJib29sZWFuXCIpIHJldHVybiBudWxsO1xuICBjb25zdCB1bnJlY292ZXJlZCA9IG8ud29ya1ZvbHVtZVJlY3JlYXRlVW5yZWNvdmVyZWQ7XG4gIGlmICh1bnJlY292ZXJlZCAhPT0gdW5kZWZpbmVkICYmIHR5cGVvZiB1bnJlY292ZXJlZCAhPT0gXCJib29sZWFuXCIpIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuICBjb25zdCBkaXJzID0gby5sYXJnZXN0SG9zdERpcmVjdG9yaWVzO1xuICBpZiAoZGlycyAhPT0gdW5kZWZpbmVkICYmIHR5cGVvZiBkaXJzICE9PSBcInN0cmluZ1wiKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgbGFyZ2VzdCA9IGRpcnMgPT09IHVuZGVmaW5lZFxuICAgID8gdW5kZWZpbmVkXG4gICAgOiBzYW5pdGlzZUxhcmdlc3RIb3N0RGlyZWN0b3JpZXMoZGlycyk7XG4gIHJldHVybiB7XG4gICAgYXZhaWxhYmxlQnl0ZXM6IGF2YWlsLFxuICAgIHRvdGFsQnl0ZXM6IHRvdGFsLFxuICAgIG1lYXN1cmVkQXQ6IGF0LFxuICAgIC4uLihyZWZ1c2VkID09PSB1bmRlZmluZWQgPyB7fSA6IHsgd29ya1ZvbHVtZVRyaW1SZWZ1c2VkOiByZWZ1c2VkIH0pLFxuICAgIC4uLihkZWNsaW5lZCA9PT0gdW5kZWZpbmVkID8ge30gOiB7IHdvcmtWb2x1bWVSZWNyZWF0ZURlY2xpbmVkOiBkZWNsaW5lZCB9KSxcbiAgICAuLi4odW5yZWNvdmVyZWQgPT09IHVuZGVmaW5lZFxuICAgICAgPyB7fVxuICAgICAgOiB7IHdvcmtWb2x1bWVSZWNyZWF0ZVVucmVjb3ZlcmVkOiB1bnJlY292ZXJlZCB9KSxcbiAgICAuLi4obGFyZ2VzdCA9PT0gdW5kZWZpbmVkID8ge30gOiB7IGxhcmdlc3RIb3N0RGlyZWN0b3JpZXM6IGxhcmdlc3QgfSksXG4gIH07XG59XG5cbi8qKiBSZWFkIHRoZSBsYXVuY2hlcidzIHJlYWRpbmcgZmlsZTsgbWlzc2luZyBvciB1bnJlYWRhYmxlIGlzIG5vIHJlYWRpbmcuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcmVhZEhvc3REaXNrUmVmcmVzaEZpbGUoXG4gIHBhdGg6IHN0cmluZyxcbik6IFByb21pc2U8SG9zdERpc2tSZWZyZXNoIHwgbnVsbD4ge1xuICB0cnkge1xuICAgIHJldHVybiBwYXJzZUhvc3REaXNrUmVmcmVzaChhd2FpdCBEZW5vLnJlYWRUZXh0RmlsZShwYXRoKSk7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbi8qKiBUaGUgbGF1bmNoIGJhc2VsaW5lIHRoZSBsYXVuY2hlciBwYXNzZWQgaW4sIGlmIGFueS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgSG9zdERpc2tCYXNlbGluZSB7XG4gIGF2YWlsYWJsZUJ5dGVzOiBudW1iZXI7XG4gIHRvdGFsQnl0ZXM6IG51bWJlcjtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJlYWRIb3N0RGlza0Jhc2VsaW5lKFxuICBlbnY6IChuYW1lOiBzdHJpbmcpID0+IHN0cmluZyB8IHVuZGVmaW5lZCxcbik6IEhvc3REaXNrQmFzZWxpbmUgfCBudWxsIHtcbiAgY29uc3QgYXZhaWwgPSBlbnZOdW1iZXIoZW52KEhPU1RfRElTS19BVkFJTF9FTlYpKTtcbiAgY29uc3QgdG90YWwgPSBlbnZOdW1iZXIoZW52KEhPU1RfRElTS19UT1RBTF9FTlYpKTtcbiAgaWYgKGF2YWlsID09PSBudWxsIHx8IHRvdGFsID09PSBudWxsIHx8IGF2YWlsIDwgMCB8fCB0b3RhbCA8PSAwKSB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbiAgcmV0dXJuIHsgYXZhaWxhYmxlQnl0ZXM6IGF2YWlsLCB0b3RhbEJ5dGVzOiB0b3RhbCB9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZm9ybWF0R2IoYnl0ZXM6IG51bWJlcik6IHN0cmluZyB7XG4gIHJldHVybiBgJHsoYnl0ZXMgLyBHSUIpLnRvRml4ZWQoMSl9IEdCYDtcbn1cblxuLyoqXG4gKiBFc3RpbWF0ZSB0aGUgaG9zdCdzIGZyZWUgc3BhY2UgZnJvbSB0aGUgbGF1bmNoIGJhc2VsaW5lIGFuZCB0aGUgd29ya1xuICogdm9sdW1lJ3MgZ3Jvd3RoIHNpbmNlIGxhdW5jaCAoSXNzdWUgIzIyNikuXG4gKlxuICogVGhlIHRoaW4tcHJvdmlzaW9uZWQgdm9sdW1lIGltYWdlIG9ubHkgZ3Jvd3Mgb24gdGhlIGhvc3QsIHNvIGV2ZXJ5IGJ5dGVcbiAqIHRoZSB3b3JrIHZvbHVtZSBnYWluZWQgc2luY2UgbGF1bmNoIGlzIGEgYnl0ZSB0aGUgaG9zdCBsb3N0LiBTaHJpbmthZ2UgaXNcbiAqIGlnbm9yZWQgKGEgZnJlZWQgYmxvY2sgaW5zaWRlIHRoZSB2b2x1bWUgZG9lcyBub3QgY29tZSBiYWNrIHRvIHRoZSBob3N0KS5cbiAqXG4gKiBJc3N1ZSAjMzg0OiB0aGUgdGhpcmQgYXJndW1lbnQgaXMgdGhlcmVmb3JlIHRoZSB2b2x1bWUncyAqKmhpZ2gtd2F0ZXJcbiAqIG1hcmsqKiwgbm90IGl0cyBjdXJyZW50IHVzYWdlLiBQYXNzaW5nIHRoZSBjdXJyZW50IHJlYWRpbmcgbWFkZSBhXG4gKiBndWVzdC1zaWRlIHN3ZWVwIGxvb2sgbGlrZSBob3N0IGZyZWUgc3BhY2Ug4oCUIHRoZSB0aWVyIHJlY2xhaW0gZGVsZXRlZFxuICogMTggR0IgaW5zaWRlIHRoZSBndWVzdCwgdGhlIGVzdGltYXRlIHJvc2UgYnkgMTggR0IgdGhlIGhvc3QgbmV2ZXIgZ290LCBhbmRcbiAqIGBoZWFsZWRgIGNhbWUgYmFjayB0cnVlIHdoaWxlIGBkZmAgb24gdGhlIGhvc3QgaGFkIG5vdCBtb3ZlZCBhIGJ5dGUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBlc3RpbWF0ZUhvc3RGcmVlKFxuICBiYXNlbGluZTogSG9zdERpc2tCYXNlbGluZSxcbiAgdm9sdW1lVXNlZEF0TGF1bmNoOiBudW1iZXIgfCBudWxsLFxuICB2b2x1bWVVc2VkUGVhazogbnVtYmVyIHwgbnVsbCxcbik6IG51bWJlciB7XG4gIGlmICh2b2x1bWVVc2VkQXRMYXVuY2ggPT09IG51bGwgfHwgdm9sdW1lVXNlZFBlYWsgPT09IG51bGwpIHtcbiAgICByZXR1cm4gYmFzZWxpbmUuYXZhaWxhYmxlQnl0ZXM7XG4gIH1cbiAgY29uc3QgZ3Jvd3RoID0gTWF0aC5tYXgoMCwgdm9sdW1lVXNlZFBlYWsgLSB2b2x1bWVVc2VkQXRMYXVuY2gpO1xuICByZXR1cm4gTWF0aC5tYXgoMCwgYmFzZWxpbmUuYXZhaWxhYmxlQnl0ZXMgLSBncm93dGgpO1xufVxuXG4vKiogQ2xhc3NpZnkgYSBmcmVlLXNwYWNlIGZpZ3VyZSBhZ2FpbnN0IHRoZSBmbG9vcnMuICovXG5leHBvcnQgZnVuY3Rpb24gY2xhc3NpZnlIb3N0RGlzayhcbiAgYXZhaWxhYmxlQnl0ZXM6IG51bWJlcixcbiAgdG90YWxCeXRlczogbnVtYmVyLFxuICBmbG9vcnM6IERpc2tGbG9vcnMsXG4pOiB7IGxldmVsOiBcIm9rXCIgfCBcImxvd1wiOyBkZXRhaWw6IHN0cmluZyB9IHtcbiAgY29uc3QgZmxvb3IgPSBsb3dGbG9vckJ5dGVzKHRvdGFsQnl0ZXMsIGZsb29ycyk7XG4gIGNvbnN0IHBlcmNlbnQgPSB0b3RhbEJ5dGVzID4gMFxuICAgID8gKChhdmFpbGFibGVCeXRlcyAvIHRvdGFsQnl0ZXMpICogMTAwKS50b0ZpeGVkKDEpXG4gICAgOiBcIj9cIjtcbiAgY29uc3Qgc3VtbWFyeSA9IGAke2Zvcm1hdEdiKGF2YWlsYWJsZUJ5dGVzKX0gZnJlZSAoJHtwZXJjZW50fSUpIG9mICR7XG4gICAgZm9ybWF0R2IodG90YWxCeXRlcylcbiAgfSwgZmxvb3IgJHtmb3JtYXRHYihmbG9vcil9YDtcbiAgaWYgKGF2YWlsYWJsZUJ5dGVzIDwgZmxvb3IpIHtcbiAgICByZXR1cm4geyBsZXZlbDogXCJsb3dcIiwgZGV0YWlsOiBgJHtzdW1tYXJ5fSDigJQgYmVsb3cgdGhlIGZsb29yYCB9O1xuICB9XG4gIHJldHVybiB7IGxldmVsOiBcIm9rXCIsIGRldGFpbDogc3VtbWFyeSB9O1xufVxuXG4vKiogSW5qZWN0YWJsZSBwaWVjZXMgb2YgdGhlIG1vbml0b3IuICovXG5leHBvcnQgaW50ZXJmYWNlIEhvc3REaXNrTW9uaXRvck9wdGlvbnMge1xuICAvKiogV29yayBkaXJlY3Rvcnkgd2hvc2UgZmlsZXN5c3RlbSBpcyBwcm9iZWQuICovXG4gIHdvcmtEaXI6IHN0cmluZztcbiAgZW52PzogKG5hbWU6IHN0cmluZykgPT4gc3RyaW5nIHwgdW5kZWZpbmVkO1xuICBwcm9iZT86IChwYXRoOiBzdHJpbmcpID0+IFByb21pc2U8RGlza1JlYWRpbmcgfCBudWxsPjtcbiAgbm93PzogKCkgPT4gbnVtYmVyO1xuICAvKiogTWluaW11bSBtaWxsaXNlY29uZHMgYmV0d2VlbiBwcm9iZXMuICovXG4gIHNhbXBsZUludGVydmFsTXM/OiBudW1iZXI7XG4gIGxvZz86IChtZXNzYWdlOiBzdHJpbmcpID0+IHZvaWQ7XG4gIC8qKlxuICAgKiBUaGUgZGVwbG95bWVudCdzIGAuY29uZmlnLmpzb25gIGZsb29yIHRlcm1zIChJc3N1ZSAjNzMyKS4gT21pdHRlZCDihpIgdGhlXG4gICAqIGVudmlyb25tZW50IGFuZCB0aGUgZGVmYXVsdHMgZGVjaWRlLCBleGFjdGx5IGFzIGJlZm9yZS5cbiAgICovXG4gIGZsb29ycz86IENvbmZpZ3VyZWREaXNrRmxvb3JzO1xuICAvKipcbiAgICogVGhlIGxhdW5jaGVyJ3MgcGVyLXRpY2sgcmVhZGluZyBmaWxlIChJc3N1ZSAjMTU1MCkuIE9taXR0ZWQg4oaSIHRoZVxuICAgKiBsYXVuY2ggYmFzZWxpbmUgc3RhbmRzIGZvciB0aGUgd2hvbGUgcnVuLCBleGFjdGx5IGFzIGJlZm9yZS5cbiAgICovXG4gIHJlZnJlc2hGaWxlPzogc3RyaW5nO1xuICAvKiogUmVhZHMgdGhlIHJlZnJlc2ggZmlsZSAoaW5qZWN0YWJsZSBmb3IgdGVzdHMpLiAqL1xuICByZWFkUmVmcmVzaD86IChwYXRoOiBzdHJpbmcpID0+IFByb21pc2U8SG9zdERpc2tSZWZyZXNoIHwgbnVsbD47XG4gIC8qKiBBIHJlYWRpbmcgb2xkZXIgdGhhbiB0aGlzIGlzIGlnbm9yZWQuICovXG4gIHJlZnJlc2hNYXhBZ2VNcz86IG51bWJlcjtcbn1cblxuLyoqXG4gKiBLZWVwcyB0aGUgd29ya2VyJ3MgdmlldyBvZiB0aGUgaG9zdCBkaXNrIGN1cnJlbnQgb24gYSBib3VuZGVkIGNhZGVuY2UuXG4gKi9cbmV4cG9ydCBjbGFzcyBIb3N0RGlza01vbml0b3Ige1xuICBwcml2YXRlIHJlYWRvbmx5IHdvcmtEaXI6IHN0cmluZztcbiAgcHJpdmF0ZSByZWFkb25seSBlbnY6IChuYW1lOiBzdHJpbmcpID0+IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgcHJpdmF0ZSByZWFkb25seSBwcm9iZTogKHBhdGg6IHN0cmluZykgPT4gUHJvbWlzZTxEaXNrUmVhZGluZyB8IG51bGw+O1xuICBwcml2YXRlIHJlYWRvbmx5IG5vdzogKCkgPT4gbnVtYmVyO1xuICBwcml2YXRlIHJlYWRvbmx5IHNhbXBsZUludGVydmFsTXM6IG51bWJlcjtcbiAgcHJpdmF0ZSByZWFkb25seSBsb2c6IChtZXNzYWdlOiBzdHJpbmcpID0+IHZvaWQ7XG4gIHByaXZhdGUgcmVhZG9ubHkgZmxvb3JzOiBEaXNrRmxvb3JzO1xuICAvKiogVGhlIGxhdW5jaCBiYXNlbGluZSwgcmUtYmFzZWQgYnkgZWFjaCBhZG9wdGVkIGxhdW5jaGVyIHJlYWRpbmcuICovXG4gIHByaXZhdGUgYmFzZWxpbmU6IEhvc3REaXNrQmFzZWxpbmUgfCBudWxsO1xuICBwcml2YXRlIHJlYWRvbmx5IHJlZnJlc2hGaWxlOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gIHByaXZhdGUgcmVhZG9ubHkgcmVhZFJlZnJlc2g6IChcbiAgICBwYXRoOiBzdHJpbmcsXG4gICkgPT4gUHJvbWlzZTxIb3N0RGlza1JlZnJlc2ggfCBudWxsPjtcbiAgcHJpdmF0ZSByZWFkb25seSByZWZyZXNoTWF4QWdlTXM6IG51bWJlcjtcbiAgLyoqIFdoZW4gdGhlIGZpZ3VyZSB0aGUgZXN0aW1hdGUgcmVzdHMgb24gd2FzIG1lYXN1cmVkIChJc3N1ZSAjMTU1MCkuICovXG4gIHByaXZhdGUgYWRvcHRlZE1lYXN1cmVkQXRNczogbnVtYmVyO1xuICAvKiogQWdlIG9mIHRoZSBhZG9wdGVkIGxhdW5jaGVyIHJlYWRpbmcgYXQgdGhlIGxhc3QgY2hlY2ssIGlmIGFueS4gKi9cbiAgcHJpdmF0ZSByZWZyZXNoQWdlTXM6IG51bWJlciB8IHVuZGVmaW5lZDtcbiAgcHJpdmF0ZSB2b2x1bWVVc2VkQXRMYXVuY2g6IG51bWJlciB8IG51bGwgPSBudWxsO1xuICAvKiogSGlnaGVzdCB2b2x1bWUgdXNhZ2Ugc2VlbiB0aGlzIHJ1biDigJQgd2hhdCB0aGUgaG9zdCBoYXMgbG9zdCAoIzM4NCkuICovXG4gIHByaXZhdGUgdm9sdW1lVXNlZFBlYWs6IG51bWJlciB8IG51bGwgPSBudWxsO1xuICAvKiogTW9zdCByZWNlbnQgdm9sdW1lIHVzYWdlLCBmb3IgdGhlIHJhdGNoZXQgc3BsaXQgKCMzODQpLiAqL1xuICBwcml2YXRlIHZvbHVtZVVzZWROb3c6IG51bWJlciB8IG51bGwgPSBudWxsO1xuICAvKiogVGhlIGxhdW5jaGVyJ3Mgd29yZCB0aGF0IHRoZSBydW50aW1lIHJlZnVzZWQgdGhlIHRyaW0gKCMyMDgwKS4gKi9cbiAgcHJpdmF0ZSB0cmltUmVmdXNlZCA9IGZhbHNlO1xuICAvKiogVGhlIGxhdW5jaGVyJ3Mgd29yZCB0aGF0IGl0IGRlY2xpbmVkIHRvIHJlY3JlYXRlIHRoZSB3b3JrIHZvbHVtZS4gKi9cbiAgcHJpdmF0ZSByZWNyZWF0ZURlY2xpbmVkID0gZmFsc2U7XG4gIC8qKiBUaGUgbGF1bmNoZXIncyB3b3JkIHRoYXQgYSByZWNyZWF0ZSByYW4gYW5kIGxlZnQgdGhlIGhvc3Qgc2hvcnQuICovXG4gIHByaXZhdGUgcmVjcmVhdGVVbnJlY292ZXJlZCA9IGZhbHNlO1xuICAvKiogVGhlIGxhdW5jaGVyJ3MgbGFyZ2VzdC1ob3N0LWRpcmVjdG9yaWVzIHRleHQsIGlmIGl0IHdyb3RlIG9uZS4gKi9cbiAgcHJpdmF0ZSBsYXJnZXN0RGlyczogc3RyaW5nIHwgdW5kZWZpbmVkID0gdW5kZWZpbmVkO1xuICBwcml2YXRlIGJhc2VsaW5lZCA9IGZhbHNlO1xuICBwcml2YXRlIGxhc3RTYW1wbGVBdDogbnVtYmVyIHwgdW5kZWZpbmVkO1xuICBwcml2YXRlIGxhc3RTdGF0dXM6IEhvc3REaXNrU3RhdHVzID0ge1xuICAgIGxldmVsOiBcInVua25vd25cIixcbiAgICBzb3VyY2U6IFwibm9uZVwiLFxuICAgIGRldGFpbDogXCJub3QgcHJvYmVkIHlldFwiLFxuICB9O1xuICBwcml2YXRlIGxhc3RMZXZlbDogSG9zdERpc2tTdGF0dXNbXCJsZXZlbFwiXSB8IHVuZGVmaW5lZDtcblxuICBjb25zdHJ1Y3RvcihvcHRpb25zOiBIb3N0RGlza01vbml0b3JPcHRpb25zKSB7XG4gICAgdGhpcy53b3JrRGlyID0gb3B0aW9ucy53b3JrRGlyO1xuICAgIHRoaXMuZW52ID0gb3B0aW9ucy5lbnYgPz8gKChuYW1lKSA9PiBEZW5vLmVudi5nZXQobmFtZSkpO1xuICAgIHRoaXMucHJvYmUgPSBvcHRpb25zLnByb2JlID8/IHByb2JlRGlza1JlYWRpbmc7XG4gICAgdGhpcy5ub3cgPSBvcHRpb25zLm5vdyA/PyBEYXRlLm5vdztcbiAgICB0aGlzLnNhbXBsZUludGVydmFsTXMgPSBvcHRpb25zLnNhbXBsZUludGVydmFsTXMgPz8gNjBfMDAwO1xuICAgIHRoaXMubG9nID0gb3B0aW9ucy5sb2cgPz8gKCgpID0+IHt9KTtcbiAgICB0aGlzLmZsb29ycyA9IHJlc29sdmVEaXNrRmxvb3JzKHRoaXMuZW52LCBvcHRpb25zLmZsb29ycyA/PyB7fSk7XG4gICAgdGhpcy5iYXNlbGluZSA9IHJlYWRIb3N0RGlza0Jhc2VsaW5lKHRoaXMuZW52KTtcbiAgICB0aGlzLnJlZnJlc2hGaWxlID0gb3B0aW9ucy5yZWZyZXNoRmlsZTtcbiAgICB0aGlzLnJlYWRSZWZyZXNoID0gb3B0aW9ucy5yZWFkUmVmcmVzaCA/PyByZWFkSG9zdERpc2tSZWZyZXNoRmlsZTtcbiAgICB0aGlzLnJlZnJlc2hNYXhBZ2VNcyA9IG9wdGlvbnMucmVmcmVzaE1heEFnZU1zID8/XG4gICAgICBERUZBVUxUX1JFRlJFU0hfTUFYX0FHRV9NUztcbiAgICAvLyBUaGUgZW52aXJvbm1lbnQgYmFzZWxpbmUgd2FzIG1lYXN1cmVkIGJ5IHRoZSBsYXVuY2ggcGxhbiBCRUZPUkUgdGhlXG4gICAgLy8gaW1hZ2UgYnVpbGQgYW5kIHRoZSB2b2x1bWUgaGVhbCwgYW5kIHRoZSBsYXVuY2hlciB3cml0ZXMgaXRzIHJlYWRpbmdcbiAgICAvLyBmaWxlIGFnYWluIGFmdGVyIHRoZW0sIHNlY29uZHMgYmVmb3JlIHRoaXMgcHJvY2VzcyBzdGFydHMgKElzc3VlXG4gICAgLy8gIzIxMTU6IGEgdm9sdW1lIHJlc2V0IHJldHVybmVkIDc4IEdCLCB0aGUgYmFzZWxpbmUgc3RpbGwgc2FpZCAyOSwgYW5kXG4gICAgLy8gdGhlIHdvcmtlciBjbGFpbWVkIG5vdGhpbmcgZm9yIGZpZnRlZW4gbWludXRlcykuIFNvIGFueSByZWFkaW5nIHdpdGhpblxuICAgIC8vIHRoZSByZWZyZXNoIHdpbmRvdyBpcyBuZXdlciB0aGFuIHRoZSBiYXNlbGluZSBpbiB0aGUgc2Vuc2UgdGhhdFxuICAgIC8vIG1hdHRlcnMgYW5kIGlzIGFkb3B0ZWQgb24gdGhlIGZpcnN0IGNoZWNrOyB0aGUgYmFzZWxpbmUgaXMgb25seSB3aGF0XG4gICAgLy8gc3RhbmRzIHVudGlsIGEgZmlsZSBhcnJpdmVzLlxuICAgIHRoaXMuYWRvcHRlZE1lYXN1cmVkQXRNcyA9IHRoaXMubm93KCkgLSB0aGlzLnJlZnJlc2hNYXhBZ2VNcztcbiAgfVxuXG4gIC8qKlxuICAgKiBBZG9wdCB0aGUgbGF1bmNoZXIncyBsYXRlc3QgcmVhZGluZyB3aGVuIGl0IGlzIG5ld2VyIHRoYW4gdGhlIGZpZ3VyZSB0aGVcbiAgICogZXN0aW1hdGUgcmVzdHMgb24gYW5kIG5vdCBzdGFsZSAoSXNzdWUgIzE1NTApLiBUaGUgZ3Jvd3RoIHRlcm0gaXNcbiAgICogcmUtYmFzZWQgYXQgdGhlIHNhbWUgbW9tZW50OiBhIGhvc3QgcmVhZGluZyBhbHJlYWR5IGNvdW50cyBldmVyeXRoaW5nXG4gICAqIHRoZSB2b2x1bWUgaGVsZCB3aGVuIGl0IHdhcyB0YWtlbiwgc28gb25seSBncm93dGggc2luY2UgdGhlbiBpc1xuICAgKiBzdWJ0cmFjdGVkIOKAlCB0aGUgIzM4NCBydWxlLCByZXN0YXJ0ZWQgZnJvbSBhIHRydWVyIG9yaWdpbi5cbiAgICovXG4gIHByaXZhdGUgYXN5bmMgYWRvcHRMYXVuY2hlclJlYWRpbmcoXG4gICAgcmVhZGluZzogRGlza1JlYWRpbmcgfCBudWxsLFxuICAgIHQ6IG51bWJlcixcbiAgKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgaWYgKHRoaXMucmVmcmVzaEZpbGUgPT09IHVuZGVmaW5lZCB8fCB0aGlzLmJhc2VsaW5lID09PSBudWxsKSByZXR1cm47XG4gICAgbGV0IHJlZnJlc2g6IEhvc3REaXNrUmVmcmVzaCB8IG51bGwgPSBudWxsO1xuICAgIHRyeSB7XG4gICAgICByZWZyZXNoID0gYXdhaXQgdGhpcy5yZWFkUmVmcmVzaCh0aGlzLnJlZnJlc2hGaWxlKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHJlZnJlc2ggPSBudWxsO1xuICAgIH1cbiAgICBpZiAocmVmcmVzaCA9PT0gbnVsbCkgcmV0dXJuO1xuICAgIC8vIFRha2VuIGZyb20gYW55IHJlYWRpbmcgdGhlIGxhdW5jaGVyIHdyb3RlLCBiZWZvcmUgdGhlIHJlY2VuY3kgcnVsZXNcbiAgICAvLyBiZWxvdzogdGhlIGZsYWcgaXMgYSBwcm9wZXJ0eSBvZiB0aGlzIGxhdW5jaCwgbm90IG9mIG9uZSBzYW1wbGUuXG4gICAgdGhpcy50cmltUmVmdXNlZCA9IHJlZnJlc2gud29ya1ZvbHVtZVRyaW1SZWZ1c2VkID09PSB0cnVlO1xuICAgIHRoaXMucmVjcmVhdGVEZWNsaW5lZCA9IHJlZnJlc2gud29ya1ZvbHVtZVJlY3JlYXRlRGVjbGluZWQgPT09IHRydWU7XG4gICAgdGhpcy5yZWNyZWF0ZVVucmVjb3ZlcmVkID0gcmVmcmVzaC53b3JrVm9sdW1lUmVjcmVhdGVVbnJlY292ZXJlZCA9PT0gdHJ1ZTtcbiAgICB0aGlzLmxhcmdlc3REaXJzID0gcmVmcmVzaC5sYXJnZXN0SG9zdERpcmVjdG9yaWVzO1xuICAgIGNvbnN0IG1lYXN1cmVkTXMgPSByZWZyZXNoLm1lYXN1cmVkQXQgKiAxMDAwO1xuICAgIGlmIChtZWFzdXJlZE1zIDw9IHRoaXMuYWRvcHRlZE1lYXN1cmVkQXRNcykgcmV0dXJuO1xuICAgIGlmICh0IC0gbWVhc3VyZWRNcyA+IHRoaXMucmVmcmVzaE1heEFnZU1zKSByZXR1cm47XG4gICAgdGhpcy5iYXNlbGluZSA9IHtcbiAgICAgIGF2YWlsYWJsZUJ5dGVzOiByZWZyZXNoLmF2YWlsYWJsZUJ5dGVzLFxuICAgICAgdG90YWxCeXRlczogcmVmcmVzaC50b3RhbEJ5dGVzLFxuICAgIH07XG4gICAgdGhpcy5hZG9wdGVkTWVhc3VyZWRBdE1zID0gbWVhc3VyZWRNcztcbiAgICB0aGlzLnJlZnJlc2hBZ2VNcyA9IHQgLSBtZWFzdXJlZE1zO1xuICAgIHRoaXMudm9sdW1lVXNlZEF0TGF1bmNoID0gcmVhZGluZz8udXNlZEJ5dGVzID8/IG51bGw7XG4gICAgdGhpcy52b2x1bWVVc2VkUGVhayA9IHJlYWRpbmc/LnVzZWRCeXRlcyA/PyBudWxsO1xuICAgIHRoaXMuYmFzZWxpbmVkID0gcmVhZGluZyAhPT0gbnVsbDtcbiAgICB0aGlzLmxvZyhcbiAgICAgIGBIb3N0IGRpc2s6IGFkb3B0ZWQgdGhlIGxhdW5jaGVyJ3MgcmVhZGluZyDigJQgJHtcbiAgICAgICAgZm9ybWF0R2IocmVmcmVzaC5hdmFpbGFibGVCeXRlcylcbiAgICAgIH0gZnJlZSBvZiAke2Zvcm1hdEdiKHJlZnJlc2gudG90YWxCeXRlcyl9LCBtZWFzdXJlZCAke1xuICAgICAgICBNYXRoLnJvdW5kKHRoaXMucmVmcmVzaEFnZU1zIC8gMTAwMClcbiAgICAgIH1zIGFnbyAoSXNzdWUgIzE1NTApYCxcbiAgICApO1xuICB9XG5cbiAgLyoqIFRoZSBtb3N0IHJlY2VudCBzdGF0dXMgd2l0aG91dCBwcm9iaW5nLiAqL1xuICBnZXQgc3RhdHVzKCk6IEhvc3REaXNrU3RhdHVzIHtcbiAgICByZXR1cm4gdGhpcy5sYXN0U3RhdHVzO1xuICB9XG5cbiAgLyoqXG4gICAqIEJ5dGVzIHRoZSBob3N0IG11c3QgZ2V0IGJhY2sgdG8gY2xlYXIgdGhlIGxvdyBmbG9vciwgZnJvbSB0aGUgbGFzdFxuICAgKiBzdGF0dXMuIFplcm8gd2hlbiB0aGUgcmVhZGluZyBpcyBgb2tgIG9yIHVua25vd24g4oCUIHRoZSByZWNsYWltXG4gICAqIChJc3N1ZSAjMjQyKSBzaXplcyBpdHNlbGYgZnJvbSB0aGlzLlxuICAgKi9cbiAgZ2V0IHNob3J0ZmFsbEJ5dGVzKCk6IG51bWJlciB7XG4gICAgY29uc3Qgc3RhdHVzID0gdGhpcy5sYXN0U3RhdHVzO1xuICAgIGlmIChcbiAgICAgIHN0YXR1cy5sZXZlbCAhPT0gXCJsb3dcIiB8fCBzdGF0dXMuYXZhaWxhYmxlQnl0ZXMgPT09IHVuZGVmaW5lZCB8fFxuICAgICAgc3RhdHVzLnRvdGFsQnl0ZXMgPT09IHVuZGVmaW5lZFxuICAgICkge1xuICAgICAgcmV0dXJuIDA7XG4gICAgfVxuICAgIHJldHVybiBNYXRoLm1heChcbiAgICAgIDAsXG4gICAgICBsb3dGbG9vckJ5dGVzKHN0YXR1cy50b3RhbEJ5dGVzLCB0aGlzLmZsb29ycykgLSBzdGF0dXMuYXZhaWxhYmxlQnl0ZXMsXG4gICAgKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBIb3cgbXVjaCBvZiB0aGUgaG9zdCdzIGxvc3MgaXMgc3BhY2UgdGhlIGd1ZXN0IGhhcyBhbHJlYWR5IGZyZWVkIGJ1dCB0aGVcbiAgICogdm9sdW1lIGltYWdlIHN0aWxsIGhvbGRzIChJc3N1ZSAjMzg0KS5cbiAgICpcbiAgICogT25seSBtZWFuaW5nZnVsIGluIGNvbnRhaW5lciBtb2RlOiBvbiBhIG5hdGl2ZSBob3N0IGBkZmAgbWVhc3VyZXMgdGhlXG4gICAqIGhvc3QgaXRzZWxmLCBzbyBmcmVlZCBzcGFjZSBpcyBnZW51aW5lbHkgZnJlZSBhbmQgdGhlcmUgaXMgbm8gcmF0Y2hldCB0b1xuICAgKiBjbGFpbS5cbiAgICovXG4gIC8qKlxuICAgKiBEaWQgdGhlIGxhdW5jaGVyIHJlcG9ydCB0aGF0IHRoZSBydW50aW1lIHJlZnVzZWQgdG8gdHJpbSB0aGUgd29yayB2b2x1bWVcbiAgICogdGhpcyBsYXVuY2ggKElzc3VlICMyMDgwKT8gV2hlbiBpdCBkaWQsIG5vdGhpbmcgdGhlIGd1ZXN0IGZyZWVzIHJlYWNoZXNcbiAgICogdGhlIGhvc3QuXG4gICAqL1xuICBnZXQgd29ya1ZvbHVtZVRyaW1SZWZ1c2VkKCk6IGJvb2xlYW4ge1xuICAgIHJldHVybiB0aGlzLnRyaW1SZWZ1c2VkO1xuICB9XG5cbiAgLyoqXG4gICAqIERpZCB0aGUgbGF1bmNoZXIgZGVjbGluZSB0byByZWNyZWF0ZSB0aGUgd29yayB2b2x1bWUgdGhpcyBsYXVuY2gsIGJlY2F1c2VcbiAgICogcmVjcmVhdGluZyBpdCB3b3VsZCBub3QgcmV0dXJuIHRoZSBtaXNzaW5nIHNwYWNlIHRvIHRoZSBob3N0PyBBYnNlbnRcbiAgICogcmVhZHMgYXMgYGZhbHNlYCAoSXNzdWUgIzQ0OTgpLlxuICAgKi9cbiAgZ2V0IHdvcmtWb2x1bWVSZWNyZWF0ZURlY2xpbmVkKCk6IGJvb2xlYW4ge1xuICAgIHJldHVybiB0aGlzLnJlY3JlYXRlRGVjbGluZWQ7XG4gIH1cblxuICAvKipcbiAgICogRGlkIHRoZSBsYXVuY2hlciByZWNyZWF0ZSB0aGUgd29yayB2b2x1bWUgdGhpcyBsYXVuY2ggYW5kIGZpbmQgdGhlIGhvc3RcbiAgICogc3RpbGwgYmVsb3cgaXRzIGZsb29yPyBUaGUgbmV4dCBsYXVuY2ggd2lsbCBub3QgcmVjcmVhdGUgaXQgYWdhaW4gdW50aWxcbiAgICogdGhlIGZyZWUtc3BhY2UgcmVhZGluZyBtb3Zlcy4gQWJzZW50IHJlYWRzIGFzIGBmYWxzZWAgKElzc3VlICM0NDk4KS5cbiAgICovXG4gIGdldCB3b3JrVm9sdW1lUmVjcmVhdGVVbnJlY292ZXJlZCgpOiBib29sZWFuIHtcbiAgICByZXR1cm4gdGhpcy5yZWNyZWF0ZVVucmVjb3ZlcmVkO1xuICB9XG5cbiAgLyoqXG4gICAqIFRoZSBsYXJnZXN0IGhvc3QgZGlyZWN0b3JpZXMgdGhlIGxhdW5jaGVyIHJlcG9ydGVkLCBmb3IgdGhlIHN0b3AgcmVhc29uXG4gICAqIChJc3N1ZSAjNDQ5OCkuIFVuZGVmaW5lZCB3aGVuIHRoZSBsYXVuY2hlciB3cm90ZSBub25lLlxuICAgKi9cbiAgZ2V0IGxhcmdlc3RIb3N0RGlyZWN0b3JpZXMoKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgICByZXR1cm4gdGhpcy5sYXJnZXN0RGlycztcbiAgfVxuXG4gIC8qKlxuICAgKiBUaGUgZmxvb3IgaW4gYnl0ZXMgZm9yIGEgZmlsZXN5c3RlbSBvZiBgdG90YWxCeXRlc2AsIHVuZGVyIHRoaXNcbiAgICogbW9uaXRvcidzIHJlc29sdmVkIGZsb29ycyDigJQgd2hhdCB0aGUgaGVhdnktYnVpbGQgZ2F0ZSBjb21wYXJlcyBhZ2FpbnN0XG4gICAqIChJc3N1ZSAjMzE3OCksIHNvIGl0IGFuZCB0aGUgY2xhaW0gZ2F0ZSBzaGFyZSBvbmUgZmxvb3IuXG4gICAqL1xuICBmbG9vckJ5dGVzRm9yKHRvdGFsQnl0ZXM6IG51bWJlcik6IG51bWJlciB7XG4gICAgcmV0dXJuIGxvd0Zsb29yQnl0ZXModG90YWxCeXRlcywgdGhpcy5mbG9vcnMpO1xuICB9XG5cbiAgZ2V0IHdvcmtWb2x1bWVSYXRjaGV0KCk6IFdvcmtWb2x1bWVSYXRjaGV0IHtcbiAgICBpZiAodGhpcy5iYXNlbGluZSA9PT0gbnVsbCkgcmV0dXJuIGNsYXNzaWZ5V29ya1ZvbHVtZVJhdGNoZXQobnVsbCwgbnVsbCk7XG4gICAgcmV0dXJuIGNsYXNzaWZ5V29ya1ZvbHVtZVJhdGNoZXQodGhpcy52b2x1bWVVc2VkTm93LCB0aGlzLnZvbHVtZVVzZWRQZWFrKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBQcm9iZSBpZiB0aGUgY2FkZW5jZSBhbGxvd3MsIHRoZW4gcmV0dXJuIHRoZSBjdXJyZW50IHN0YXR1cy5cbiAgICpcbiAgICogYGZvcmNlYCBza2lwcyB0aGUgY2FkZW5jZSDigJQgdGhlIHJlLXJlYWQgYWZ0ZXIgYSByZWNsYWltIChJc3N1ZSAjMjQyKVxuICAgKiBtdXN0IHNlZSB0aGUgZnJlZWQgc3BhY2UsIG5vdCB0aGUgcmVhZGluZyB0aGF0IHRyaWdnZXJlZCBpdC5cbiAgICovXG4gIGFzeW5jIGNoZWNrKG9wdGlvbnM6IHsgZm9yY2U/OiBib29sZWFuIH0gPSB7fSk6IFByb21pc2U8SG9zdERpc2tTdGF0dXM+IHtcbiAgICBjb25zdCB0ID0gdGhpcy5ub3coKTtcbiAgICBpZiAoXG4gICAgICBvcHRpb25zLmZvcmNlICE9PSB0cnVlICYmXG4gICAgICB0aGlzLmxhc3RTYW1wbGVBdCAhPT0gdW5kZWZpbmVkICYmXG4gICAgICB0IC0gdGhpcy5sYXN0U2FtcGxlQXQgPCB0aGlzLnNhbXBsZUludGVydmFsTXNcbiAgICApIHtcbiAgICAgIHJldHVybiB0aGlzLmxhc3RTdGF0dXM7XG4gICAgfVxuICAgIHRoaXMubGFzdFNhbXBsZUF0ID0gdDtcblxuICAgIGxldCByZWFkaW5nOiBEaXNrUmVhZGluZyB8IG51bGwgPSBudWxsO1xuICAgIHRyeSB7XG4gICAgICByZWFkaW5nID0gYXdhaXQgdGhpcy5wcm9iZSh0aGlzLndvcmtEaXIpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgcmVhZGluZyA9IG51bGw7XG4gICAgfVxuXG4gICAgbGV0IHN0YXR1czogSG9zdERpc2tTdGF0dXM7XG4gICAgLy8gSXNzdWUgIzg1MjogYSBsYXVuY2ggYmFzZWxpbmUgaXMgYW4gZXN0aW1hdGUgdGhhdCBjYW4gb25seSBldmVyIGZhbGwg4oCUXG4gICAgLy8gYGVzdGltYXRlSG9zdEZyZWVgIHN1YnRyYWN0cyB2b2x1bWUgZ3Jvd3RoIGZyb20gYSBmaWd1cmUgY2FwdHVyZWQgb25jZSxcbiAgICAvLyBzbyBzcGFjZSBmcmVlZCBvbiB0aGUgaG9zdCBtaWQtcnVuIGlzIHN0cnVjdHVyYWxseSBpbnZpc2libGUgYW5kIHRoZVxuICAgIC8vIGZsZWV0IHN0YXlzIGdhdGVkIHVudGlsIHRoZSBuZXh0IGxhdW5jaC4gV2hlbiB0aGUgcHJvYmUgcmVwb3J0cyB0aGVcbiAgICAvLyBzYW1lIHRvdGFsIHNpemUgYXMgdGhlIGJhc2VsaW5lLCB0aGUgd29yayBkaXIgaXMgb24gdGhlIHZlcnkgZmlsZXN5c3RlbVxuICAgIC8vIHRoZSBsYXVuY2hlciBtZWFzdXJlZDogYGRmYCB0aGVyZSAqaXMqIHRoZSBob3N0LCBhbmQgYSBsaXZlIHJlYWRpbmcgaXNcbiAgICAvLyBzdHJpY3RseSBiZXR0ZXIgaW5mb3JtYXRpb24gdGhhbiBhbiBlc3RpbWF0ZSBkZXJpdmVkIGZyb20gaXQuXG4gICAgY29uc3QgcHJvYmVJc0hvc3RGaWxlc3lzdGVtID0gdGhpcy5iYXNlbGluZSAhPT0gbnVsbCAmJlxuICAgICAgcmVhZGluZyAhPT0gbnVsbCAmJlxuICAgICAgcmVhZGluZy50b3RhbEJ5dGVzID09PSB0aGlzLmJhc2VsaW5lLnRvdGFsQnl0ZXM7XG4gICAgaWYgKHRoaXMuYmFzZWxpbmUgIT09IG51bGwgJiYgIXByb2JlSXNIb3N0RmlsZXN5c3RlbSkge1xuICAgICAgYXdhaXQgdGhpcy5hZG9wdExhdW5jaGVyUmVhZGluZyhyZWFkaW5nLCB0KTtcbiAgICAgIGlmICghdGhpcy5iYXNlbGluZWQpIHtcbiAgICAgICAgdGhpcy52b2x1bWVVc2VkQXRMYXVuY2ggPSByZWFkaW5nPy51c2VkQnl0ZXMgPz8gbnVsbDtcbiAgICAgICAgdGhpcy5iYXNlbGluZWQgPSB0cnVlO1xuICAgICAgfVxuICAgICAgLy8gSXNzdWUgIzM4NDogdGhlIGhvc3QgbG9zdCBldmVyeSBieXRlIHRoZSB2b2x1bWUgZXZlciBncmV3IHRvLCBhbmQgYVxuICAgICAgLy8gZ3Vlc3Qtc2lkZSBkZWxldGUgZG9lcyBub3QgaGFuZCB0aG9zZSBibG9ja3MgYmFjayDigJQgdGhlIGVzdGltYXRlXG4gICAgICAvLyB0cmFja3MgdGhlIGhpZ2gtd2F0ZXIgbWFyaywgYW5kIHRoZSBnYXAgYmVsb3cgaXQgaXMgbmFtZWQgYXMgd2hhdFxuICAgICAgLy8gaXQgaXM6IGRlYWQgc3BhY2UgaW5zaWRlIHRoZSB2b2x1bWUgaW1hZ2UuXG4gICAgICB0aGlzLnZvbHVtZVVzZWROb3cgPSByZWFkaW5nPy51c2VkQnl0ZXMgPz8gdGhpcy52b2x1bWVVc2VkTm93O1xuICAgICAgaWYgKHJlYWRpbmc/LnVzZWRCeXRlcyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIHRoaXMudm9sdW1lVXNlZFBlYWsgPSB0aGlzLnZvbHVtZVVzZWRQZWFrID09PSBudWxsXG4gICAgICAgICAgPyByZWFkaW5nLnVzZWRCeXRlc1xuICAgICAgICAgIDogTWF0aC5tYXgodGhpcy52b2x1bWVVc2VkUGVhaywgcmVhZGluZy51c2VkQnl0ZXMpO1xuICAgICAgfVxuICAgICAgY29uc3QgYXZhaWxhYmxlID0gZXN0aW1hdGVIb3N0RnJlZShcbiAgICAgICAgdGhpcy5iYXNlbGluZSxcbiAgICAgICAgdGhpcy52b2x1bWVVc2VkQXRMYXVuY2gsXG4gICAgICAgIHRoaXMudm9sdW1lVXNlZFBlYWssXG4gICAgICApO1xuICAgICAgY29uc3QgY2xzID0gY2xhc3NpZnlIb3N0RGlzayhcbiAgICAgICAgYXZhaWxhYmxlLFxuICAgICAgICB0aGlzLmJhc2VsaW5lLnRvdGFsQnl0ZXMsXG4gICAgICAgIHRoaXMuZmxvb3JzLFxuICAgICAgKTtcbiAgICAgIGNvbnN0IHJhdGNoZXQgPSBkZXNjcmliZVdvcmtWb2x1bWVSYXRjaGV0KHRoaXMud29ya1ZvbHVtZVJhdGNoZXQpO1xuICAgICAgY29uc3Qgb3JpZ2luID0gdGhpcy5yZWZyZXNoQWdlTXMgPT09IHVuZGVmaW5lZFxuICAgICAgICA/IFwiZXN0aW1hdGVkIGZyb20gbGF1bmNoIGJhc2VsaW5lXCJcbiAgICAgICAgOiBgZXN0aW1hdGVkIGZyb20gdGhlIGxhdW5jaGVyJ3MgcmVhZGluZyAke1xuICAgICAgICAgIE1hdGgucm91bmQoKHQgLSB0aGlzLmFkb3B0ZWRNZWFzdXJlZEF0TXMpIC8gNjBfMDAwKVxuICAgICAgICB9IG1pbiBhZ29gO1xuICAgICAgc3RhdHVzID0ge1xuICAgICAgICBsZXZlbDogY2xzLmxldmVsLFxuICAgICAgICBhdmFpbGFibGVCeXRlczogYXZhaWxhYmxlLFxuICAgICAgICB0b3RhbEJ5dGVzOiB0aGlzLmJhc2VsaW5lLnRvdGFsQnl0ZXMsXG4gICAgICAgIHNvdXJjZTogXCJsYXVuY2gtYmFzZWxpbmVcIixcbiAgICAgICAgZGV0YWlsOiBgaG9zdCAoJHtvcmlnaW59KSAke2Nscy5kZXRhaWx9JHtcbiAgICAgICAgICByYXRjaGV0ID09PSBcIlwiID8gXCJcIiA6IGAg4oCUICR7cmF0Y2hldH1gXG4gICAgICAgIH1gLFxuICAgICAgfTtcbiAgICB9IGVsc2UgaWYgKHJlYWRpbmcgIT09IG51bGwpIHtcbiAgICAgIGNvbnN0IGNscyA9IGNsYXNzaWZ5SG9zdERpc2soXG4gICAgICAgIHJlYWRpbmcuYXZhaWxhYmxlQnl0ZXMsXG4gICAgICAgIHJlYWRpbmcudG90YWxCeXRlcyxcbiAgICAgICAgdGhpcy5mbG9vcnMsXG4gICAgICApO1xuICAgICAgc3RhdHVzID0ge1xuICAgICAgICBsZXZlbDogY2xzLmxldmVsLFxuICAgICAgICBhdmFpbGFibGVCeXRlczogcmVhZGluZy5hdmFpbGFibGVCeXRlcyxcbiAgICAgICAgdG90YWxCeXRlczogcmVhZGluZy50b3RhbEJ5dGVzLFxuICAgICAgICBzb3VyY2U6IFwibmF0aXZlLWRmXCIsXG4gICAgICAgIGRldGFpbDogcHJvYmVJc0hvc3RGaWxlc3lzdGVtXG4gICAgICAgICAgPyBgaG9zdCBmaWxlc3lzdGVtIChtZWFzdXJlZCwgc2FtZSB2b2x1bWUgYXMgdGhlIGxhdW5jaCBiYXNlbGluZSkgJHtjbHMuZGV0YWlsfWBcbiAgICAgICAgICA6IGB3b3JrIGRpciBmaWxlc3lzdGVtICR7Y2xzLmRldGFpbH1gLFxuICAgICAgfTtcbiAgICB9IGVsc2Uge1xuICAgICAgc3RhdHVzID0ge1xuICAgICAgICBsZXZlbDogXCJ1bmtub3duXCIsXG4gICAgICAgIHNvdXJjZTogXCJub25lXCIsXG4gICAgICAgIGRldGFpbDogXCJubyBsYXVuY2ggYmFzZWxpbmUgYW5kIGRmIHVucmVhZGFibGUg4oCUIG5vdCBnYXRpbmdcIixcbiAgICAgIH07XG4gICAgfVxuXG4gICAgaWYgKHN0YXR1cy5sZXZlbCAhPT0gdGhpcy5sYXN0TGV2ZWwpIHtcbiAgICAgIHRoaXMubG9nKGBIb3N0IGRpc2s6ICR7c3RhdHVzLmxldmVsfSDigJQgJHtzdGF0dXMuZGV0YWlsfSAoSXNzdWUgIzIyNilgKTtcbiAgICAgIHRoaXMubGFzdExldmVsID0gc3RhdHVzLmxldmVsO1xuICAgIH1cbiAgICB0aGlzLmxhc3RTdGF0dXMgPSBzdGF0dXM7XG4gICAgcmV0dXJuIHN0YXR1cztcbiAgfVxufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0E2Q0MsR0FFRCxTQUNFLGFBQWEsRUFDYixXQUFXLEVBQ1gsY0FBYyxRQUNULHlCQUF5QjtBQUNoQyxTQUFTLGNBQWMsUUFBUSwwQkFBMEI7QUFDekQsU0FDRSx5QkFBeUIsRUFDekIseUJBQXlCLFFBRXBCLDJCQUEyQjtBQUVsQywwREFBMEQsR0FDMUQsT0FBTyxNQUFNLHNCQUFzQiw2QkFBNkI7QUFDaEUsT0FBTyxNQUFNLHNCQUFzQiw2QkFBNkI7QUFDaEUscUVBQXFFLEdBQ3JFLE9BQU8sTUFBTSw2QkFBNkIsOEJBQThCO0FBQ3hFLE9BQU8sTUFBTSxrQ0FDWCxtQ0FBbUM7QUFFckMsNkRBQTZELEdBQzdELE9BQU8sTUFBTSx1QkFBdUIsR0FBRztBQUN2QyxzRUFBc0UsR0FDdEUsT0FBTyxNQUFNLDRCQUE0QixHQUFHO0FBRTVDLE1BQU0sTUFBTTtBQUNaLE1BQU0sZ0JBQWdCO0FBd0J0Qjs7Ozs7Q0FLQyxHQUNELE9BQU8sU0FBUyxVQUFVLElBQVk7RUFDcEMsTUFBTSxRQUFRLEtBQUssSUFBSSxHQUFH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
// denoCacheMetadata=5752668271724503808,12694740684095418051