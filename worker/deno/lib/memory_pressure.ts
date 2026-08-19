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
 * Linux-only by nature (`/proc/meminfo`); on any other platform, or when
 * the file is unreadable, the probe reports "unknown" and callers do
 * nothing — the probe is telemetry, never control flow.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

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

/** Parse the two fields the probe needs out of `/proc/meminfo` text. */
export function parseMemInfo(
  text: string,
): { totalBytes: number; availableBytes: number } | null {
  const total = /^MemTotal:\s+(\d+)\s+kB/m.exec(text);
  const available = /^MemAvailable:\s+(\d+)\s+kB/m.exec(text);
  if (!total || !available) return null;
  return {
    totalBytes: Number(total[1]) * 1024,
    availableBytes: Number(available[1]) * 1024,
  };
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

/**
 * Read `/proc/meminfo` and classify. Injectable reader for tests and
 * non-Linux hosts.
 */
export async function probeMemoryPressure(options: {
  readMemInfo?: () => Promise<string>;
  threshold?: number;
} = {}): Promise<MemoryPressureReading> {
  const read = options.readMemInfo ??
    (() => Deno.readTextFile("/proc/meminfo"));
  let text: string;
  try {
    text = await read();
  } catch {
    return { level: "unknown" };
  }
  const parsed = parseMemInfo(text);
  if (!parsed) return { level: "unknown" };
  return {
    level: classifyPressure(
      parsed.totalBytes,
      parsed.availableBytes,
      options.threshold,
    ),
    totalBytes: parsed.totalBytes,
    availableBytes: parsed.availableBytes,
  };
}

/**
 * Portable host probe for the slot governor (Issue #4179): `/proc/meminfo`
 * on Linux; `sysctl kern.memorystatus_vm_pressure_level` on macOS (1 =
 * normal, 2 = warn, 4 = critical — the same signal the kernel's own
 * memorystatus jetsam acts on); "unknown" anywhere else or when the signal
 * cannot be read. Never throws.
 */
export async function probeHostMemoryPressure(options: {
  os?: string;
  readMemInfo?: () => Promise<string>;
  readDarwinPressureLevel?: () => Promise<string>;
  threshold?: number;
} = {}): Promise<MemoryPressureReading> {
  const os = options.os ?? Deno.build.os;
  if (os === "linux") return await probeMemoryPressure(options);
  if (os === "darwin") {
    const read = options.readDarwinPressureLevel ?? readDarwinPressureLevel;
    try {
      const raw = (await read()).trim();
      const level = Number(raw);
      if (!Number.isFinite(level) || level <= 0) return { level: "unknown" };
      return { level: level >= 2 ? "high" : "ok" };
    } catch {
      return { level: "unknown" };
    }
  }
  return { level: "unknown" };
}

async function readDarwinPressureLevel(): Promise<string> {
  const out = await new Deno.Command("sysctl", {
    args: ["-n", "kern.memorystatus_vm_pressure_level"],
    stdout: "piped",
    stderr: "null",
  }).output();
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
