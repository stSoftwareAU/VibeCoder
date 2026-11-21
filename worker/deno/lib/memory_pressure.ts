/**
 * Guest memory-pressure probe (Issue #4301).
 *
 * The container VM has a fixed memory budget and no swap (a swapfile needs
 * CAP_SYS_ADMIN, which the launch plan deliberately forbids), so a memory
 * peak inside the guest — the agent CLI plus a cargo-build quality gate —
 * becomes an exit-137 SIGKILL of the agent rather than a slowdown. Nothing
 * can be done about the kill itself from inside the boundary, but its
 * blast radius can be bounded: when available memory drops under a
 * threshold, the execute phase takes an out-of-band WIP checkpoint so the
 * kill loses at most the last few minutes (Issue #4170 machinery), and a
 * warning names the pressure so the sizing can be revisited.
 *
 * Linux reads `Deno.systemMemoryInfo()` (the driver grants
 * `--allow-sys=systemMemoryInfo`; Deno refuses `/proc/meminfo` to anything
 * short of `--allow-all`, Issue #5319). A refused or failed read is warned
 * once per cause and reads "unknown"; other platforms read "unknown" — callers
 * do nothing on "unknown", so the probe is telemetry, never control flow.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  commandOutputWithTimeout,
  isCommandTimeoutError,
} from "./subprocess_timeout.ts";

/** Darwin `sysctl` probe. Seconds. A timeout is not "pressure unknown". */
const MEMORY_PROBE_TIMEOUT_MS = 10_000;

/** Below this share of total memory available, pressure is "high". */
export const DEFAULT_PRESSURE_THRESHOLD = 0.10;

/** What the probe saw. */
export interface MemoryPressureReading {
  /** "high" when available/total is under the threshold; "unknown" when unreadable. */
  level: "ok" | "high" | "unknown";
  /** Total memory in bytes, when known. */
  totalBytes?: number;
  /** Available memory in bytes, when known. */
  availableBytes?: number;
}

/** Classify a reading against the threshold. */
export function classifyPressure(
  totalBytes: number,
  availableBytes: number,
  threshold: number = DEFAULT_PRESSURE_THRESHOLD,
): "ok" | "high" {
  if (totalBytes <= 0) return "ok";
  return availableBytes / totalBytes < threshold ? "high" : "ok";
}

/** Causes already warned about, so a refused read warns once per process. */
const warnedCauses = new Set<string>();

/**
 * Read system memory through `read`, validate and classify it. Throws on a
 * refused read or an implausible reading; callers decide how to report that.
 */
function readSystemMemory(
  read: () => { total: number; available: number },
  threshold?: number,
): MemoryPressureReading {
  const { total, available } = read();
  if (!(total > 0) || !(available >= 0)) {
    throw new Error(
      `systemMemoryInfo returned total=${total} available=${available}`,
    );
  }
  return {
    level: classifyPressure(total, available, threshold),
    totalBytes: total,
    availableBytes: available,
  };
}

/**
 * Read `Deno.systemMemoryInfo()` and classify (Linux only; any other platform
 * reads "unknown" silently). Not `/proc/meminfo`: Deno refuses that file to
 * anything short of `--allow-all` (`NotCapable: Requires all access to
 * "/proc/meminfo"`), whereas `systemMemoryInfo` needs only
 * `--allow-sys=systemMemoryInfo`. A refused or failed read still reads
 * "unknown" but is warned once per distinct cause (Issue #5319), so a
 * missing grant is visible rather than silently disabling the probe.
 */
export async function probeMemoryPressure(options: {
  os?: string;
  systemMemoryInfo?: () => { total: number; available: number };
  threshold?: number;
  warn?: (message: string) => void;
} = {}): Promise<MemoryPressureReading> {
  const os = options.os ?? Deno.build.os;
  if (os !== "linux") return { level: "unknown" };
  try {
    return await Promise.resolve(readSystemMemory(
      options.systemMemoryInfo ?? (() => Deno.systemMemoryInfo()),
      options.threshold,
    ));
  } catch (error) {
    const cause = error instanceof Error
      ? `${error.name}: ${error.message.split("\n")[0]}`
      : String(error);
    if (!warnedCauses.has(cause)) {
      warnedCauses.add(cause);
      (options.warn ?? ((m: string) => console.warn(m)))(
        `WARNING: memory-pressure probe cannot read Deno.systemMemoryInfo() (${cause}) — reporting "unknown" (Issue #5319)`,
      );
    }
    return { level: "unknown" };
  }
}

/**
 * Portable host probe for the slot governor (Issue #4179): `Deno.systemMemoryInfo()`
 * on Linux; `sysctl kern.memorystatus_vm_pressure_level` on macOS (1 =
 * normal, 2 = warn, 4 = critical — the same signal the kernel's own
 * memorystatus jetsam acts on); "unknown" anywhere else or when the signal
 * cannot be read. A timeout throws; any other unreadable signal is "unknown".
 */
export async function probeHostMemoryPressure(options: {
  os?: string;
  systemMemoryInfo?: () => { total: number; available: number };
  warn?: (message: string) => void;
  readDarwinPressureLevel?: () => Promise<string>;
  threshold?: number;
} = {}): Promise<MemoryPressureReading> {
  const os = options.os ?? Deno.build.os;
  if (os === "linux") {
    return await probeMemoryPressure({
      os,
      systemMemoryInfo: options.systemMemoryInfo,
      threshold: options.threshold,
      warn: options.warn,
    });
  }
  if (os === "darwin") {
    const read = options.readDarwinPressureLevel ?? readDarwinPressureLevel;
    try {
      const raw = (await read()).trim();
      const level = Number(raw);
      if (!Number.isFinite(level) || level <= 0) return { level: "unknown" };
      return { level: level >= 2 ? "high" : "ok" };
    } catch (error) {
      if (isCommandTimeoutError(error)) throw error;
      return { level: "unknown" };
    }
  }
  return { level: "unknown" };
}

/**
 * Host probe for a record that must say why a reading is missing (Issue
 * #5250): on Linux it asks `Deno.systemMemoryInfo()` rather than reading
 * `/proc/meminfo`, because Deno refuses `/proc/meminfo` to anything short of
 * `--allow-all` while `systemMemoryInfo` needs only `--allow-sys`. Unlike
 * `probeMemoryPressure`, which warns once and reads `unknown`, a refused or
 * failed read throws, so the caller records the cause. Other platforms use
 * `probeHostMemoryPressure`.
 */
export async function probeHostMemoryPressureFromSystem(options: {
  os?: string;
  systemMemoryInfo?: () => { total: number; available: number };
  threshold?: number;
} = {}): Promise<MemoryPressureReading> {
  const os = options.os ?? Deno.build.os;
  if (os !== "linux") return await probeHostMemoryPressure({ os });
  return readSystemMemory(
    options.systemMemoryInfo ?? (() => Deno.systemMemoryInfo()),
    options.threshold,
  );
}

export async function readDarwinPressureLevel(
  timeoutMs: number = MEMORY_PROBE_TIMEOUT_MS,
): Promise<string> {
  const out = await commandOutputWithTimeout("sysctl", {
    args: ["-n", "kern.memorystatus_vm_pressure_level"],
    stdout: "piped",
    stderr: "null",
    timeoutMs,
  });
  if (!out.success) throw new Error("sysctl failed");
  return new TextDecoder().decode(out.stdout);
}

/** Render a byte count as MiB below 1 GiB, otherwise GiB to one decimal. */
export function formatMemoryBytes(bytes: number): string {
  const gib = bytes / 1024 ** 3;
  if (gib >= 1) return `${gib.toFixed(1)} GiB`;
  return `${Math.round(bytes / 1024 ** 2)} MiB`;
}

/**
 * Human wording for a reading (Issue #4374): `high (400 MiB of 16.0 GiB
 * available)`, `ok (8.0 GiB of 16.0 GiB available)`, or bare `unknown` /
 * `high` when the probe had no numbers (the macOS pressure level).
 */
export function describeMemoryPressure(reading: MemoryPressureReading): string {
  if (
    reading.availableBytes === undefined || reading.totalBytes === undefined
  ) {
    return reading.level;
  }
  return `${reading.level} (${formatMemoryBytes(reading.availableBytes)} of ${
    formatMemoryBytes(reading.totalBytes)
  } available)`;
}

/**
 * `key=value` fields for a security log line (Issue #4374):
 * `memory_pressure=high available_mib=400 total_mib=16384`; the numbers are
 * omitted when the probe had none.
 */
export function memoryPressureLogFields(
  reading: MemoryPressureReading,
): string {
  const parts = [`memory_pressure=${reading.level}`];
  if (reading.availableBytes !== undefined) {
    parts.push(
      `available_mib=${Math.round(reading.availableBytes / 1024 ** 2)}`,
    );
  }
  if (reading.totalBytes !== undefined) {
    parts.push(`total_mib=${Math.round(reading.totalBytes / 1024 ** 2)}`);
  }
  return parts.join(" ");
}
