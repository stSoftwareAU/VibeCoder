/**
 * Per-repo merged-PR sweep watermarks (Issue #4255).
 *
 * `cleanupMergedPrBranches` re-assessed the same last-30 merged PRs per
 * repo on every cycle — up to 28 × 30 × 2 GraphQL `pr list` calls to
 * delete, typically, zero branches. The watermark persists the highest
 * merged-PR number already swept per repo so the next cycle only looks at
 * PRs above it; on a quiet repo the sweep then costs one list call.
 *
 * Same shape as the per-host scan cursor (#2427): a small JSON file in
 * `WORK_DIR`, written tempfile-then-rename so a crash mid-write cannot
 * truncate the live file. A missing or corrupt file reads as empty — the
 * sweep just pays the full cost once and re-persists.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { atomicWrite } from "./file_utils.ts";

/** Highest merged-PR number already swept, keyed by "owner/repo". */
export type SweepWatermarks = Record<string, number>;

/** Resolve the watermark file path for a work directory. */
export function mergedSweepWatermarkPath(workDir: string): string {
  return `${workDir}/merged_sweep_watermarks.json`;
}

/**
 * Watermark file for the Close-Issues-for-Merged-PRs reconciler
 * (Issue #4256). A separate file from the branch-cleanup sweep: the two
 * passes advance independently — a branch can be swept while its issue
 * reconciliation is still held back, and vice versa.
 */
export function mergedReconcileWatermarkPath(workDir: string): string {
  return `${workDir}/merged_reconcile_watermarks.json`;
}

/** Load watermarks; a missing or corrupt file reads as empty. */
export async function loadSweepWatermarks(
  path: string,
): Promise<SweepWatermarks> {
  try {
    const parsed = JSON.parse(await Deno.readTextFile(path));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const marks: SweepWatermarks = {};
      for (const [repo, value] of Object.entries(parsed)) {
        if (typeof value === "number" && Number.isFinite(value) && value > 0) {
          marks[repo] = value;
        }
      }
      return marks;
    }
  } catch {
    // Missing or corrupt — start fresh; the sweep re-persists.
  }
  return {};
}

/** Persist watermarks atomically. Failures are the caller's to ignore. */
export async function saveSweepWatermarks(
  path: string,
  marks: SweepWatermarks,
): Promise<void> {
  await atomicWrite({
    targetFile: path,
    content: JSON.stringify(marks, null, 2) + "\n",
  });
}
