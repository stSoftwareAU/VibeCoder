/**
 * Fixed words and digits derived from the guest evidence of a hard kill
 * (Issue #5062).
 *
 * The auto-filed hard-kill issue is public, and the killed run may have been
 * working a private repository. A later recurrence still has to tell a frozen
 * guest VM from an agent hung in a live VM, so the issue carries four figures
 * read from the evidence record: how long the log had been silent before the
 * capture, whether the guest answered the exec probe, its memory and its
 * pressure stall figures. Each figure is either a fixed word or a number that
 * a strict pattern captured. No ps, meminfo or log text is ever returned.
 *
 * Every evidence string is cut to its first {@link SCAN_CHARS} characters
 * before it is matched, and every pattern is linear: no overlapping
 * quantifiers.
 *
 * Uses Australian English spelling throughout (behaviour, colour, etc.).
 */

import {
  GUEST_EXEC_NO_ANSWER_CAUSE,
  type HardKillEvidence,
  NOT_COLLECTED_CAUSE,
  UNAVAILABLE_PREFIX,
} from "./hard_kill_evidence.ts";

/** Cap on each evidence string scanned (cost and ReDoS guard). */
const SCAN_CHARS = 4000;

/** The state of the guest's exec probe, as the issue words it. */
export type GuestProbeState =
  | "answered"
  | "did not answer"
  | "not collected"
  | "unavailable";

/** The note the capture adds when the last log line carries no timestamp. */
const MTIME_NOTE_RE = / \(log file modified time; [^()]{0,200}\)$/;
/** A UTC timestamp once the date and time are joined by `T`. */
const UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
/** `MemTotal` in kB, on its own line; the digit run is bounded. */
const MEM_TOTAL_RE = /^MemTotal:[ \t]+(\d{1,12}) kB/m;
/** `MemAvailable` in kB, on its own line; the digit run is bounded. */
const MEM_AVAILABLE_RE = /^MemAvailable:[ \t]+(\d{1,12}) kB/m;
/** A pressure average: at most three integer digits, two decimals. */
const PRESSURE_NUMBER_RE = /^\d{1,3}(?:\.\d{1,2})?$/;
/** The pressure averages the issue keeps, in the order it prints them. */
const PRESSURE_KEYS = ["avg10", "avg60", "avg300"] as const;

/** Evidence text, cut to the scan cap. */
function scanned(text: string): string {
  return text.slice(0, SCAN_CHARS);
}

/**
 * Words an elapsed time of whole seconds as `1h 2m 3s`, dropping leading
 * zero units only: `48m 51s`, `1h 0m 3s`, `45s`, `0s`.
 */
function formatElapsed(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (hours > 0 || minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(" ");
}

/**
 * How long the worker log had been silent before the capture.
 *
 * Elapsed time runs from the last log line's timestamp to the capture time,
 * floored to whole seconds. A timestamp taken from the log file's modified
 * time is marked as such.
 *
 * @param evidence - The evidence record
 * @returns A duration such as `48m 51s`, or `unknown` when it cannot be
 *   worked out from a UTC timestamp no later than the capture
 */
export function hardKillSilentFor(evidence: HardKillEvidence): string {
  const raw = scanned(evidence.lastLogTimestamp);
  const note = MTIME_NOTE_RE.exec(raw);
  const stamp = (note ? raw.slice(0, note.index) : raw).replace(" ", "T");
  if (!UTC_RE.test(stamp)) return "unknown";
  const last = Date.parse(stamp);
  const captured = Date.parse(scanned(evidence.capturedAt));
  if (Number.isNaN(last) || Number.isNaN(captured) || last > captured) {
    return "unknown";
  }
  const elapsed = formatElapsed(Math.floor((captured - last) / 1000));
  return note ? `${elapsed} (from the log file's modified time)` : elapsed;
}

/**
 * The state of the guest's exec probe, read from the `ps` field the capture
 * wrote. The cause prefixes come from `hard_kill_evidence.ts`, the same
 * constants the capture writes.
 *
 * @param evidence - The evidence record
 * @returns `did not answer` when the runtime's exec failed, `not collected`
 *   when the capture cap ended first, `unavailable` for any other failed
 *   step, and `answered` when the guest's process list was read
 */
export function hardKillGuestProbe(
  evidence: HardKillEvidence,
): GuestProbeState {
  const ps = scanned(evidence.evidence.guest.ps);
  if (ps.startsWith(`${UNAVAILABLE_PREFIX}${GUEST_EXEC_NO_ANSWER_CAUSE}`)) {
    return "did not answer";
  }
  if (ps.startsWith(`${UNAVAILABLE_PREFIX}${NOT_COLLECTED_CAUSE}`)) {
    return "not collected";
  }
  if (ps.startsWith(UNAVAILABLE_PREFIX)) return "unavailable";
  return "answered";
}

/**
 * The guest's memory total and available memory, in MB (kB divided by 1024,
 * rounded down), read from `/proc/meminfo`.
 *
 * @param evidence - The evidence record
 * @returns For example `MemTotal 4096 MB, MemAvailable 120 MB`, each figure
 *   present in that order, or `not available` when neither parses
 */
export function hardKillGuestMemory(evidence: HardKillEvidence): string {
  const text = scanned(evidence.evidence.guest.meminfo);
  const parts: string[] = [];
  const total = MEM_TOTAL_RE.exec(text);
  if (total) parts.push(`MemTotal ${mebibytes(total[1]!)} MB`);
  const available = MEM_AVAILABLE_RE.exec(text);
  if (available) parts.push(`MemAvailable ${mebibytes(available[1]!)} MB`);
  return parts.length > 0 ? parts.join(", ") : "not available";
}

/** A kilobyte count, as whole megabytes rounded down. */
function mebibytes(kilobytes: string): number {
  return Math.floor(Number(kilobytes) / 1024);
}

/**
 * The `some` and `full` pressure lines of one resource, as `<label> <kind>
 * avgN=...` segments. Only averages that are present and well formed are kept;
 * `total=` is skipped.
 */
function pressureSegments(label: string, field: string): string[] {
  const segments: string[] = [];
  for (const line of scanned(field).split("\n")) {
    const tokens = line.trim().split(/\s+/);
    const kind = tokens[0];
    if (kind !== "some" && kind !== "full") continue;
    const figures: string[] = [];
    for (const key of PRESSURE_KEYS) {
      const token = tokens.find((entry) => entry.startsWith(`${key}=`));
      const value = token?.slice(key.length + 1) ?? "";
      if (PRESSURE_NUMBER_RE.test(value)) {
        figures.push(`${key}=${value}`);
      }
    }
    if (figures.length > 0) {
      segments.push(`${label} ${kind} ${figures.join(" ")}`);
    }
  }
  return segments;
}

/**
 * The guest's CPU, memory and I/O pressure averages, read from
 * `/proc/pressure/*`.
 *
 * @param evidence - The evidence record
 * @returns For example `cpu some avg10=0.00 avg60=0.00 avg300=0.00; memory
 *   some avg10=99.00`, or `not available` when no line parses
 */
export function hardKillGuestPressure(evidence: HardKillEvidence): string {
  const guest = evidence.evidence.guest;
  const segments = [
    ...pressureSegments("cpu", guest.pressureCpu),
    ...pressureSegments("memory", guest.pressureMemory),
    ...pressureSegments("io", guest.pressureIo),
  ];
  return segments.length > 0 ? segments.join("; ") : "not available";
}
