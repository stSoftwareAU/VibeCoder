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
 * Issue #4225: the per-cycle `[liveness] tick` line also carries the
 * resource picture — `MemAvailable` plus the kernel's pressure-stall
 * information (PSI, `/proc/pressure/{memory,cpu}`) — so a guest that
 * freezes under a heavy build leaves its memory and CPU pressure in the
 * log even when no OOM kill fires. See {@link probeLivenessResources} and
 * {@link livenessResourceLogFields}. Every value there is best-effort:
 * an unreadable source is written as `unknown`, never as a zero.
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

// ---------------------------------------------------------------------------
// Issue #4225 — PSI (pressure-stall information) and the liveness tick
// ---------------------------------------------------------------------------

/** Default PSI file for memory pressure (Linux 4.20+). */
export const PSI_MEMORY_PATH = "/proc/pressure/memory";

/** Default PSI file for CPU pressure (Linux 4.20+). */
export const PSI_CPU_PATH = "/proc/pressure/cpu";

/**
 * Largest PSI text the parser will look at. A real file is about 150
 * characters; anything far bigger is not PSI, and refusing it up front
 * bounds the work a hostile or corrupt file can cause.
 */
export const PSI_MAX_CHARS = 4096;

/** One PSI line: the averages are percentages, `totalUs` is microseconds. */
export interface PsiLine {
  avg10: number;
  avg60: number;
  avg300: number;
  totalUs: number;
}

/** A parsed PSI file: the `some` line, plus the `full` line when reported. */
export interface PsiReading {
  some: PsiLine;
  full?: PsiLine;
}

/** One `key=value` token of a PSI line. Only the four known keys match. */
const PSI_FIELD = /^(avg10|avg60|avg300|total)=(\d+(?:\.\d+)?)$/;

/**
 * Parse Linux PSI text, e.g.
 * `some avg10=0.00 avg60=0.00 avg300=0.00 total=0` with an optional `full`
 * line after it. Returns null for empty, oversized or malformed text: a
 * missing field, a repeated or unknown key, a line that is neither `some`
 * nor `full`, a repeated line, or a `full` line without a `some` line.
 *
 * Parsed by splitting lines and tokens rather than one backtracking regex,
 * so the cost is linear in the input length.
 */
export function parsePsi(text: string): PsiReading | null {
  if (typeof text !== "string") return null;
  if (text.length > PSI_MAX_CHARS) return null;
  let some: PsiLine | undefined;
  let full: PsiLine | undefined;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    const tokens = line.split(/\s+/);
    const kind = tokens.shift();
    if (kind === "some") {
      if (some) return null;
      const fields = parsePsiFields(tokens);
      if (fields === null) return null;
      some = fields;
    } else if (kind === "full") {
      if (full) return null;
      const fields = parsePsiFields(tokens);
      if (fields === null) return null;
      full = fields;
    } else {
      return null;
    }
  }
  if (!some) return null;
  return full ? { some, full } : { some };
}

/** The four `key=value` tokens of one PSI line, or null if any is off. */
function parsePsiFields(tokens: string[]): PsiLine | null {
  const values = new Map<string, number>();
  for (const token of tokens) {
    const match = PSI_FIELD.exec(token);
    const key = match?.[1];
    const digits = match?.[2];
    if (key === undefined || digits === undefined) return null;
    if (values.has(key)) return null;
    const value = Number(digits);
    const valid = key === "total"
      ? Number.isSafeInteger(value)
      : Number.isFinite(value);
    if (!valid) return null;
    values.set(key, value);
  }
  const avg10 = values.get("avg10");
  const avg60 = values.get("avg60");
  const avg300 = values.get("avg300");
  const totalUs = values.get("total");
  if (
    avg10 === undefined || avg60 === undefined || avg300 === undefined ||
    totalUs === undefined
  ) {
    return null;
  }
  return { avg10, avg60, avg300, totalUs };
}

/**
 * Read and parse one PSI file. Unknown (`undefined`) when the file is
 * missing, unreadable (no PSI in the kernel, or not Linux) or malformed —
 * never a made-up zero. Never throws. `readFile` is injectable for tests.
 */
export async function probePsi(
  path: string,
  readFile: (path: string) => Promise<string> = (p) => Deno.readTextFile(p),
): Promise<PsiReading | undefined> {
  try {
    return parsePsi(await readFile(path)) ?? undefined;
  } catch {
    return undefined;
  }
}

/** What the per-cycle liveness probe saw. Each source is independently optional. */
export interface LivenessResourceReading {
  mem: MemoryPressureReading;
  psiMem?: PsiReading;
  psiCpu?: PsiReading;
}

/**
 * Probe the three resource sources for the liveness tick (Issue #4225):
 * `/proc/meminfo` through {@link probeMemoryPressure}, then the memory and
 * CPU PSI files. The reads run concurrently; each probe catches its own read
 * failure, so the function never throws and an unreadable source is reported
 * as unknown rather than failing the tick.
 */
export async function probeLivenessResources(options: {
  readMemInfo?: () => Promise<string>;
  readPsi?: (path: string) => Promise<string>;
} = {}): Promise<LivenessResourceReading> {
  const [mem, psiMem, psiCpu] = await Promise.all([
    probeMemoryPressure({ readMemInfo: options.readMemInfo }),
    probePsi(PSI_MEMORY_PATH, options.readPsi),
    probePsi(PSI_CPU_PATH, options.readPsi),
  ]);
  return { mem, psiMem, psiCpu };
}

/**
 * `key=value` resource fields appended to the `[liveness] tick` line
 * (Issue #4225):
 * `mem_available_mib=400 mem_total_mib=8192 psi_mem_some_avg10=1.23
 * psi_mem_full_avg10=0.50 psi_cpu_some_avg10=45.00`.
 *
 * Convention: the key set is fixed, in this order, on every tick, so a
 * host-side reader never has to infer absence (the same convention as the
 * `hook_fail_*` fields). A value whose source was unreadable, missing or
 * malformed is written as `unknown`, never `0`. PSI averages print to two
 * decimal places, as the kernel does.
 */
export function livenessResourceLogFields(
  reading: LivenessResourceReading,
): string {
  const mib = (bytes: number | undefined): string =>
    bytes === undefined ? "unknown" : String(Math.round(bytes / 1024 ** 2));
  const avg10 = (line: PsiLine | undefined): string =>
    line === undefined ? "unknown" : line.avg10.toFixed(2);
  return [
    `mem_available_mib=${mib(reading.mem.availableBytes)}`,
    `mem_total_mib=${mib(reading.mem.totalBytes)}`,
    `psi_mem_some_avg10=${avg10(reading.psiMem?.some)}`,
    `psi_mem_full_avg10=${avg10(reading.psiMem?.full)}`,
    `psi_cpu_some_avg10=${avg10(reading.psiCpu?.some)}`,
  ].join(" ");
}
