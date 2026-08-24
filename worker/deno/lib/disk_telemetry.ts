/**
 * How much of its own disk this host can still see (Issue #345).
 *
 * Two independent signals answer that question:
 *
 * - **host-disk** (Issue #226) — free space on the host filesystem, from the
 *   launcher's baseline or `df`.
 * - **work-volume** (Issue #244) — the standing totals of what the work
 *   volume holds, from the depth-1 `du` walk.
 *
 * On GRQ-23 both went blind at once and only one said so: `df` reported
 * "unreadable" while `du` reported a confident `0.0 GB` for every bucket,
 * and the feature report advertised both as `available` right up to the
 * moment the host crashed out of disk on 2026-08-21.
 *
 * This module is the pure verdict over the pair: a signal that cannot
 * produce a value is named, and losing **both** is a host health condition —
 * a host with no disk telemetry cannot warn anybody before it fills up.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

/** What each disk signal currently believes. */
export interface DiskSignalState {
  /** False when the host-disk reading is `unknown` (Issue #226). */
  hostDiskKnown: boolean;
  /** The reading, or why there is none. */
  hostDiskDetail: string;
  /** False when the work-volume totals are not a measurement (Issue #244). */
  workVolumeKnown: boolean;
  /** The totals, or why they are unknown. */
  workVolumeDetail: string;
}

/** The verdict over both signals. */
export interface DiskTelemetryVerdict {
  /** True only when **both** signals are blind. */
  blind: boolean;
  /** One line naming what cannot be seen. */
  detail: string;
  /** Notes for the fleet-health payload — empty when both signals read. */
  notes: string[];
}

/**
 * Assess the pair of disk signals.
 *
 * One blind signal is named on the fleet payload but is not a health
 * condition — the other still warns. Both blind is: nothing left to warn
 * with.
 */
export function assessDiskTelemetry(
  state: DiskSignalState,
): DiskTelemetryVerdict {
  const hostBlind = !state.hostDiskKnown;
  const volumeBlind = !state.workVolumeKnown;

  if (hostBlind && volumeBlind) {
    const detail =
      `both disk signals blind — host-disk: ${state.hostDiskDetail}; ` +
      `work volume: ${state.workVolumeDetail}`;
    return {
      blind: true,
      detail,
      notes: [
        `${detail} — this host cannot see its own disk filling (Issue #345)`,
      ],
    };
  }
  if (hostBlind) {
    return {
      blind: false,
      detail: `host-disk blind: ${state.hostDiskDetail}`,
      notes: [
        `host-disk telemetry blind: ${state.hostDiskDetail} — the work-volume ` +
        `totals are the only remaining disk signal (Issue #345)`,
      ],
    };
  }
  if (volumeBlind) {
    return {
      blind: false,
      detail: `work-volume telemetry blind: ${state.workVolumeDetail}`,
      notes: [
        `work-volume telemetry blind: ${state.workVolumeDetail} — the ` +
        `host-disk reading is the only remaining disk signal (Issue #345)`,
      ],
    };
  }
  return { blind: false, detail: "both disk signals readable", notes: [] };
}
