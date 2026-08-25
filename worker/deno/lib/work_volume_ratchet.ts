/**
 * The work volume image only grows (Issue #384).
 *
 * ## What went wrong
 *
 * Host GRQ-23 sat below the host-disk floor for days, claiming nothing,
 * while its own reclaim reported success at freeing nothing:
 *
 * ```text
 * [HOST_DISK_LOW] reclaimed 0 bytes of disposable work-volume space …
 * host 6.5 GB free (1.4%) of 460.4 GB, floor 46.0 GB — below the floor
 * ```
 *
 * The named volume is a thin-provisioned disk image on the host
 * (`volumes/vibe-work/volume.img`). Blocks are allocated to it when the
 * guest writes and are **never returned** when the guest deletes: the guest
 * filesystem marks them free, the image keeps them. So 36.5 GB was allocated
 * on the host for ~13 GB of real content, and every guest-side sweep —
 * `reclaimWorkVolumeTiers`, the 90 %-disk `nukeWorkDir` — returned exactly
 * zero bytes to the host. The reclaim was measuring the guest and the floor
 * was measured on the host; the two numbers are not comparable and the code
 * treated them as if they were.
 *
 * ## What this module does
 *
 * One pure classification and the two sentences the operator needs:
 *
 * - {@link classifyWorkVolumeRatchet} — the gap between the guest's
 *   high-water mark (what the host has already lost to the image) and what
 *   the guest still uses. That gap is dead space the guest cannot give back.
 * - {@link describeWorkVolumeRatchet} — the short clause the host-disk
 *   status appends, so the alarm itself says the volume image is the problem.
 * - {@link describeGuestReclaimToHost} — the full line the disk-low reclaim
 *   logs: guest bytes freed, host bytes returned (zero), and the remedy.
 *
 * The remedy is not an operator incantation any more: `container/volume-init.sh`
 * runs `fstrim` on the volume at every launch, which punches the freed blocks
 * out of the image and hands them back to the host. Where the runtime cannot
 * discard, recreating the volume is the fallback, and the message says so.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { formatGb } from "./work_volume_prune.ts";

/**
 * The named volume the launcher mounts at the work directory. Kept in step
 * with `WORK_VOLUME_NAME` (container_launch.ts) by
 * `work_volume_ratchet_test.ts`: the remedy an operator is told to run must
 * name the volume that actually exists. Duplicated deliberately rather than
 * imported — this module is loaded by the in-container disk path, which has
 * no business pulling the host-side launch planner into its graph.
 */
export const WORK_VOLUME_RATCHET_NAME = "vibe-work";

/**
 * Below this much dead space the gap is filesystem noise (journal, metadata
 * churn), not the ratchet worth naming in an alarm.
 */
export const DEFAULT_RATCHET_FLOOR_BYTES = 1_073_741_824;

/** What the volume image holds against what the guest still uses. */
export interface WorkVolumeRatchet {
  /** True when the image holds materially more than the guest still uses. */
  ratcheted: boolean;
  /** Bytes the image holds that the guest filesystem has already freed. */
  deadBytes: number;
  /** High-water mark of guest usage — what the host has lost to the image. */
  peakBytes: number;
  /** What the guest filesystem uses now. */
  usedBytes: number;
}

/**
 * Classify the gap between the volume's high-water mark and its current use.
 *
 * Either reading unknown yields a non-claim: an unmeasured volume is not
 * evidence of a ratchet, and an alarm that guesses is worse than one that
 * says nothing.
 *
 * @param usedBytes - Guest filesystem bytes in use now, or null.
 * @param peakBytes - Highest guest usage observed, or null.
 * @param floorBytes - Dead space below which the gap is not named.
 */
export function classifyWorkVolumeRatchet(
  usedBytes: number | null,
  peakBytes: number | null,
  floorBytes: number = DEFAULT_RATCHET_FLOOR_BYTES,
): WorkVolumeRatchet {
  if (usedBytes === null || peakBytes === null) {
    return { ratcheted: false, deadBytes: 0, peakBytes: 0, usedBytes: 0 };
  }
  const deadBytes = Math.max(0, peakBytes - usedBytes);
  return {
    ratcheted: deadBytes >= floorBytes,
    deadBytes,
    peakBytes,
    usedBytes,
  };
}

/**
 * The short clause the host-disk status appends when the volume has
 * ratcheted, or `""` when it has not.
 *
 * An operator meeting the `[HOST_DISK_LOW]` alarm learns from this line that
 * the volume image — not the work directory's contents — is where the host's
 * space went.
 */
export function describeWorkVolumeRatchet(
  ratchet: WorkVolumeRatchet,
  volumeName: string = WORK_VOLUME_RATCHET_NAME,
): string {
  if (!ratchet.ratcheted) return "";
  return `${
    formatGb(ratchet.deadBytes)
  } of the host's loss is space the guest has freed but the ${volumeName} ` +
    `volume image still holds (guest ${formatGb(ratchet.usedBytes)}, image ` +
    `high-water ${
      formatGb(ratchet.peakBytes)
    }) — the launch-time volume trim returns it (Issue #384)`;
}

/**
 * The line the disk-low reclaim logs: what the guest sweep freed, what the
 * host got back for it (nothing), and what does return the bytes.
 *
 * Always non-empty. Guest reclaim never moves the host figure, ratchet or
 * not, and saying so is the whole point — the old line read as a failed
 * cleanup when it was a category error.
 *
 * @param guestBytesFreed - Bytes the guest-side sweep deleted.
 * @param ratchet - Classification from {@link classifyWorkVolumeRatchet}.
 * @param volumeName - Named volume to name in the remedy.
 */
export function describeGuestReclaimToHost(
  guestBytesFreed: number,
  ratchet: WorkVolumeRatchet,
  volumeName: string = WORK_VOLUME_RATCHET_NAME,
): string {
  const freed = guestBytesFreed > 0
    ? `${formatGb(guestBytesFreed)} freed inside the guest, `
    : "";
  const dead = ratchet.ratcheted
    ? ` — ${formatGb(ratchet.deadBytes)} of the image is now space the ` +
      `guest has already freed`
    : "";
  return `${freed}0 bytes returned to the host: the ${volumeName} volume ` +
    `image only grows${dead}. The launch-time volume trim (fstrim in ` +
    `volume-init) hands those blocks back on the next launch; where the ` +
    `runtime cannot discard, stop the container and \`volume delete ` +
    `${volumeName}\` — the clones re-clone and the approval snapshots ` +
    `re-baseline (Issue #384)`;
}
