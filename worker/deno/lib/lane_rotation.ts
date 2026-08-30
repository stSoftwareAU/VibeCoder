/**
 * Rotating the maintenance lane's pass order (Issue #608).
 *
 * The four agent-backed passes share one lane slot and ran in a fixed order —
 * PR Feedback, Spelling Fix, CI Fix, then Resolve PR Merge Conflicts. Whoever
 * is last gets whatever the others leave, and on a busy host that is nothing:
 *
 *     04:16:44Z [m1] Priority 1.55: CI Fix
 *     04:26:44Z [m1] [watchdog] Priority 1.55 (CI Fix) exceeded hard timeout 600s
 *     04:26:44Z [m1] stop reason=deadline — Resolve PR Merge Conflicts … defer
 *
 * That starves the pass that clears conflicts, and a conflicting PR is one CI
 * will not even start on — held behind the open-PR gate that also holds new
 * issue claims. So the pass most worth running was the one least likely to.
 *
 * Rotating the order by one each cycle fixes it without touching the resource
 * bound the single slot exists to enforce: still one agent-backed pass at a
 * time, just not always the same one first.
 *
 * The offset is PERSISTED because run-local rotation would not be enough —
 * measured on the fleet, runs get 1, 6, 1 and 2 lane cycles, so a
 * single-cycle run would always lead with the same pass and the last one would
 * never move. Persisting is best-effort: an unreadable or unwritable counter
 * degrades to "no rotation this cycle", never to a failed pass. That is the
 * Issue #580 lesson — a state file that cannot be written must not take the
 * work down with it.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

/** State file, relative to the work directory. */
export const LANE_ROTATION_FILE = ".lane_rotation";

/**
 * Rotate `items` left by `offset`.
 *
 * Pure and total: a negative, fractional or out-of-range offset is normalised
 * rather than throwing, because a corrupt counter must not fail a pass.
 */
export function rotate<T>(items: readonly T[], offset: number): T[] {
  if (items.length === 0) return [];
  const normalised = Number.isFinite(offset)
    ? ((Math.trunc(offset) % items.length) + items.length) % items.length
    : 0;
  return [...items.slice(normalised), ...items.slice(0, normalised)];
}

/** Filesystem seams, injected so tests never touch a real work directory. */
export interface LaneRotationIo {
  readTextFile: (path: string) => Promise<string>;
  writeTextFile: (path: string, data: string) => Promise<void>;
}

const productionIo: LaneRotationIo = {
  readTextFile: (path) => Deno.readTextFile(path),
  writeTextFile: (path, data) => Deno.writeTextFile(path, data),
};

/**
 * Read the rotation offset for this cycle.
 *
 * @param workDir - The work directory; absent means no persistence and the
 *   declared order stands.
 * @returns The offset, or 0 when it cannot be read — a first run, a wiped
 *   volume and a corrupt file are all "start from the top", not a failure.
 */
export async function readLaneRotation(
  workDir: string | undefined,
  io: LaneRotationIo = productionIo,
): Promise<number> {
  if (!workDir) return 0;
  try {
    const raw = await io.readTextFile(`${workDir}/${LANE_ROTATION_FILE}`);
    const parsed = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

/**
 * Record the offset the next cycle should start from.
 *
 * Best-effort by design: a lane that cannot persist its counter still runs,
 * it simply does not rotate. Reported through `warn` so a host that has been
 * silently unrotated is diagnosable.
 */
export async function advanceLaneRotation(
  workDir: string | undefined,
  current: number,
  io: LaneRotationIo = productionIo,
  warn?: (message: string) => void,
): Promise<void> {
  if (!workDir) return;
  try {
    await io.writeTextFile(
      `${workDir}/${LANE_ROTATION_FILE}`,
      String(current + 1),
    );
  } catch (error) {
    warn?.(
      `[maintenance-lane] could not persist the pass rotation in ${workDir}: ` +
        `${error instanceof Error ? error.message : String(error)} — the ` +
        `lane keeps running, but the same pass leads every cycle (Issue #608)`,
    );
  }
}
