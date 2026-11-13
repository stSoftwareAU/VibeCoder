/**
 * The ephemeral cargo root, measured and reported (Issue #5105).
 *
 * ## Why
 *
 * On a runtime that refuses the volume trim (Apple `container`), cargo builds
 * write to the container's own root filesystem under
 * `/var/tmp/vibe-cargo-target` rather than to the work volume. That growth is
 * real host disk, yet neither the `Work volume:` line (which covers only the
 * volume) nor the host-disk estimate (launch baseline minus volume growth)
 * counted it. This module measures the root and appends it to the work-volume
 * line; the same figure is handed to the host-disk monitor so its detail names
 * the term the estimate leaves out.
 *
 * The figure is never folded into the volume total, because it is not on the
 * volume. A root that cannot be measured is reported as unknown, never as zero.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { formatGb } from "./host_disk.ts";
import {
  type EphemeralRootDeps,
  type EphemeralTargetDir,
  strictlyMeasuredTargetDirs,
} from "./heavy_build_gate.ts";
import { EPHEMERAL_CARGO_TARGET_ROOT } from "./ephemeral_build_cache.ts";

/** How many target directories the line names before it says "…". */
const NAMED_DIR_LIMIT = 3;

/** What the ephemeral cargo root holds, or why that is not known. */
export interface EphemeralCargoRootUsage {
  bytes: number;
  /** Largest first. */
  dirs: EphemeralTargetDir[];
  /** Why the root could not be measured; null when the figure is real. */
  error: string | null;
}

/**
 * Measure every target directory under the ephemeral cargo root.
 *
 * A missing root means nothing has been built yet and is a true zero. Any
 * other failure is an unknown, never a clean zero: a `du` timeout, and, with
 * the default strict listing, an unreadable subtree or output with no size.
 * Files that vanished during the walk keep the measured figure; a released
 * target is omitted from the listing.
 */
export async function measureEphemeralCargoRoot(
  deps: Pick<EphemeralRootDeps, "listTargetDirs"> = {
    listTargetDirs: strictlyMeasuredTargetDirs,
  },
  root: string = EPHEMERAL_CARGO_TARGET_ROOT,
): Promise<EphemeralCargoRootUsage> {
  try {
    const listed = await deps.listTargetDirs(root);
    const dirs = [...listed].sort((a, b) => b.bytes - a.bytes);
    return {
      bytes: dirs.reduce((sum, d) => sum + d.bytes, 0),
      dirs,
      error: null,
    };
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return { bytes: 0, dirs: [], error: null };
    }
    return {
      bytes: 0,
      dirs: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function baseName(path: string): string {
  const parts = path.split("/").filter((p) => p !== "");
  return parts[parts.length - 1] ?? path;
}

/** One line segment naming the root's size, or that it is unknown. */
export function formatEphemeralCargoRootUsage(
  usage: EphemeralCargoRootUsage,
  root: string = EPHEMERAL_CARGO_TARGET_ROOT,
): string {
  if (usage.error !== null) {
    return `ephemeral cargo root unknown — ${root} could not be measured: ${usage.error} (Issue #5105)`;
  }
  const count = usage.dirs.length;
  const named = usage.dirs.slice(0, NAMED_DIR_LIMIT)
    .map((d) => `${baseName(d.path)} ${formatGb(d.bytes)}`)
    .join(", ");
  const detail = `${count} target dir${count === 1 ? "" : "s"}${
    count === 0 ? "" : `: ${named}${count > NAMED_DIR_LIMIT ? ", …" : ""}`
  }`;
  return `ephemeral cargo root ${
    formatGb(usage.bytes)
  } on the container's own layer, outside the volume (${detail}) (Issue #5105)`;
}

/** The inputs of {@link reportWorkVolumeWithEphemeralRoot}. */
export interface WorkVolumeReportOptions {
  label?: string;
  force?: boolean;
}

/**
 * The `Work volume:` line, with the ephemeral cargo root appended on a
 * trim-refused runtime and its bytes recorded for the host-disk monitor.
 * Elsewhere the line is returned unchanged.
 */
export async function reportWorkVolumeWithEphemeralRoot(
  options: WorkVolumeReportOptions | undefined,
  deps: {
    report: (options?: WorkVolumeReportOptions) => Promise<string>;
    trimRefused: () => boolean;
    measure: () => Promise<EphemeralCargoRootUsage>;
    record: (bytes: number | null) => void;
  },
): Promise<string> {
  const line = await deps.report(options);
  if (!deps.trimRefused()) return line;
  const usage = await deps.measure();
  deps.record(usage.error === null ? usage.bytes : null);
  return `${line} — ${formatEphemeralCargoRootUsage(usage)}`;
}

/**
 * The ephemeral cargo root's bytes for the host-disk monitor's own refresh
 * (Issue #5105): null on a runtime that honours the trim (the root is not
 * the term the estimate misses there). A root that cannot be measured
 * rejects with the cause, so the monitor reports it as unknown.
 */
export async function measureEphemeralCargoRootBytesIfTrimRefused(deps: {
  trimRefused: () => boolean;
  measure: () => Promise<EphemeralCargoRootUsage>;
}): Promise<number | null> {
  if (!deps.trimRefused()) return null;
  const usage = await deps.measure();
  if (usage.error !== null) throw new Error(usage.error);
  return usage.bytes;
}
