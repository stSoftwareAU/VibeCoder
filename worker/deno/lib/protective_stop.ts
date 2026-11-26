/**
 * The worker's protective stops (Issues #4815, #5618, #5626): the guest-memory
 * floor and the host-disk park. Neither is a verdict on the work it stopped,
 * so a caller withdraws rather than charges it, and does not start more agent
 * work into the same low memory or full disk.
 *
 * @module
 */

import { GuestMemoryFloorError } from "./guest_memory_floor.ts";
import { HostDiskParkError } from "./heavy_build_gate.ts";

/** A typed protective stop. */
export type ProtectiveStop = GuestMemoryFloorError | HostDiskParkError;

/**
 * The protective stop an error is, or carries as its `cause`.
 *
 * @param error - A failed agent run's error, as returned by the runner or
 *   wrapped by a caller that keeps the stop as `cause`
 * @returns The protective stop, or undefined when the failure was not one
 */
export function protectiveStopOf(error: Error): ProtectiveStop | undefined {
  for (const candidate of [error, error.cause]) {
    if (
      candidate instanceof GuestMemoryFloorError ||
      candidate instanceof HostDiskParkError
    ) {
      return candidate;
    }
  }
  return undefined;
}
