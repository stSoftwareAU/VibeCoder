/**
 * Per-branch milestone-sync failure streaks (Issue #4260, proposal 2).
 *
 * A milestone branch that fails to sync cycle after cycle (FLEET
 * `milestone/4064` sat 5 commits behind Develop for days) needs to become
 * visible where its owner looks — the milestone's tracking issue — not just
 * scroll past in the worker log. This persists a per-branch consecutive
 * failure count across cycles so an escalation fires once at a threshold,
 * not every cycle.
 *
 * Same shape as the merged-sweep watermark and the scan cursor (#2427): a
 * small JSON file in `WORK_DIR`, atomic tempfile-then-rename write, and a
 * missing or corrupt file reads as empty (the streak just restarts).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { atomicWrite } from "./file_utils.ts";

/** Consecutive failures before a needs-human escalation is posted. */
export const MILESTONE_SYNC_ESCALATION_THRESHOLD = 3;

/** One branch's streak state. */
export interface SyncStreakEntry {
  /** Consecutive failed sync cycles for this branch. */
  count: number;
  /** True once the needs-human comment has been posted for this streak. */
  escalated: boolean;
  /**
   * True once the merge-gate escalation has been posted for this streak
   * (Issue #974). Tracked apart from {@link escalated} so a branch that has
   * already escalated for an ordinary sync failure still reports a merge the
   * type check refused — the silence this gate exists to end.
   */
  gateEscalated?: boolean;
}

/** Streak state keyed by "owner/repo|milestone-branch". */
export type SyncStreaks = Record<string, SyncStreakEntry>;

/** Resolve the streak file path for a work directory. */
export function milestoneSyncStreakPath(workDir: string): string {
  return `${workDir}/milestone_sync_failures.json`;
}

/** Load streaks; a missing or corrupt file reads as empty. */
export async function loadSyncStreaks(path: string): Promise<SyncStreaks> {
  try {
    const parsed = JSON.parse(await Deno.readTextFile(path));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const streaks: SyncStreaks = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (
          value && typeof value === "object" &&
          typeof (value as SyncStreakEntry).count === "number" &&
          Number.isFinite((value as SyncStreakEntry).count)
        ) {
          streaks[key] = {
            count: Math.max(0, Math.floor((value as SyncStreakEntry).count)),
            escalated: (value as SyncStreakEntry).escalated === true,
            gateEscalated: (value as SyncStreakEntry).gateEscalated === true,
          };
        }
      }
      return streaks;
    }
  } catch {
    // Missing or corrupt — start fresh.
  }
  return {};
}

/** Persist streaks atomically. Failures are the caller's to ignore. */
export async function saveSyncStreaks(
  path: string,
  streaks: SyncStreaks,
): Promise<void> {
  await atomicWrite({
    targetFile: path,
    content: JSON.stringify(streaks, null, 2) + "\n",
  });
}

/**
 * Extract the tracking-issue number a milestone title leads with
 * (e.g. `#3648 Learn stage fails…` → 3648). Milestone titles in this fleet
 * are named for the issue that tracks them; returns null when none leads.
 */
export function trackingIssueFromMilestoneTitle(title: string): number | null {
  const match = title.trim().match(/^#(\d+)\b/);
  if (!match) return null;
  const n = parseInt(match[1]!, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}
