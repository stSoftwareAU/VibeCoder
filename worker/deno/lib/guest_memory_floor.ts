/**
 * Guest memory floor for a running agent (Issue #4815).
 *
 * Watchdog kills showed the container guest VM going silent mid-run; the last
 * reading before one freeze was MemAvailable 2344 MiB, and the guest has no
 * swap, so exhausting memory without an OOM kill freezes it. This stops the
 * agent while the guest still answers.
 *
 * Fail-safe: a reading without numbers never stops a run.
 */
import {
  formatMemoryBytes,
  type MemoryPressureReading,
} from "./memory_pressure.ts";

/** The smallest floor, whatever the guest size. */
export const GUEST_MEMORY_FLOOR_MIN_BYTES = 512 * 1024 * 1024;
/** Share of total memory the floor is held at on larger guests. */
export const GUEST_MEMORY_FLOOR_FRACTION = 0.05;
/** Consecutive low readings before the run is stopped. */
export const GUEST_MEMORY_FLOOR_READINGS = 2;
/** Cadence of the in-run check. */
export const GUEST_MEMORY_POLL_MS = 5_000;
/** Marker that opens the stop reason. */
export const GUEST_MEMORY_FLOOR_MARKER = "[GUEST_MEMORY_FLOOR]";
/** Opens the log line when killing the agent at the floor failed. */
export const GUEST_MEMORY_KILL_FAILED = "Guest-memory kill failed for PID";
/** Opens the log line when the floor SIGKILLs the agent's handle (Issue #5638). */
export const GUEST_MEMORY_HANDLE_KILL =
  "Guest-memory floor sent SIGKILL through the agent's process handle, PID";

/** The available-memory floor for a guest with `totalBytes` of memory. */
export function guestMemoryFloorBytes(totalBytes: number): number {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) {
    return GUEST_MEMORY_FLOOR_MIN_BYTES;
  }
  return Math.max(
    GUEST_MEMORY_FLOOR_MIN_BYTES,
    Math.round(GUEST_MEMORY_FLOOR_FRACTION * totalBytes),
  );
}

/** The reason recorded when the floor is crossed. */
export function guestMemoryFloorReason(
  availableBytes: number,
  floorBytes: number,
  readings: number,
): string {
  return `${GUEST_MEMORY_FLOOR_MARKER} guest memory stayed below its floor ` +
    `(${formatMemoryBytes(availableBytes)} available, floor ${
      formatMemoryBytes(floorBytes)
    }) for ${readings} readings in a row: the agent run was stopped so the ` +
    `guest keeps answering (Issue #4815)`;
}

/** Counts consecutive low readings; trips once. */
export class GuestMemoryFloorWatch {
  #streak = 0;
  #latched = false;

  constructor(private readonly readings = GUEST_MEMORY_FLOOR_READINGS) {}

  /** The stop reason when this reading completes the streak, else null. */
  observe(reading: MemoryPressureReading): string | null {
    const { totalBytes, availableBytes } = reading;
    if (
      totalBytes === undefined || availableBytes === undefined ||
      !Number.isFinite(totalBytes) || !Number.isFinite(availableBytes)
    ) {
      this.#streak = 0;
      return null;
    }
    const floor = guestMemoryFloorBytes(totalBytes);
    if (availableBytes >= floor) {
      this.#streak = 0;
      return null;
    }
    this.#streak++;
    if (this.#latched || this.#streak < this.readings) return null;
    this.#latched = true;
    return guestMemoryFloorReason(availableBytes, floor, this.readings);
  }
}

/** Thrown (as a result error) when the agent was stopped at the floor. */
export class GuestMemoryFloorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuestMemoryFloorError";
  }
}

let armed = false;

/** Off until production arms it, so unit tests never inherit the host's memory. */
export function armGuestMemoryFloor(enabled: boolean): void {
  armed = enabled;
}

/** Whether production has armed the guest memory floor. */
export function guestMemoryFloorArmed(): boolean {
  return armed;
}
