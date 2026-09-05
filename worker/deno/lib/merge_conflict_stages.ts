/**
 * Which side of a conflicted file still exists, and what that means for a
 * resolution that takes the incoming branch (Issue #1048).
 *
 * The milestone sync resolves conflicts by taking the default branch's side.
 * For a *content* conflict `git checkout --theirs <file>` does that. For a
 * **modify/delete** conflict — the branch edited a file the default branch
 * deleted — there is no incoming side to check out: the command fails, the
 * working-tree copy (the branch's own edit) is staged instead, and the file
 * the default branch deliberately removed comes back. That is how 1984 lines
 * of a deleted subsystem returned to `milestone/863`.
 *
 * Taking the incoming side of a modify/delete therefore means **deleting the
 * file**, and this module is the one place the milestone sync makes that
 * decision. (The rebase resolver in `git_conflict_resolution.ts` picks a side
 * too, but stages nothing when `checkout --<side>` fails, so it stalls the
 * rebase rather than reviving a file — a different, already-loud outcome.)
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

/** Which merge stages `git ls-files -u` reports for a conflicted path. */
export interface UnmergedStages {
  /** Stage 1 — the merge base. */
  base: boolean;
  /** Stage 2 — "ours", the branch being merged into. */
  ours: boolean;
  /** Stage 3 — "theirs", the incoming branch. */
  theirs: boolean;
}

/** How to resolve one conflicted path in favour of the incoming branch. */
export type IncomingResolution =
  /** The incoming branch deleted it — delete it here too. */
  | "delete"
  /** The incoming branch has a version — check that version out. */
  | "take-incoming";

/**
 * Parse `git ls-files -u -- <path>` output into the stages it reports.
 *
 * Each line is `<mode> <sha> <stage>\t<path>`, one per stage present.
 */
export function parseUnmergedStages(output: string): UnmergedStages {
  const stages: UnmergedStages = { base: false, ours: false, theirs: false };
  for (const line of output.split("\n")) {
    const fields = line.split("\t")[0]?.trim().split(/\s+/) ?? [];
    switch (fields[2]) {
      case "1":
        stages.base = true;
        break;
      case "2":
        stages.ours = true;
        break;
      case "3":
        stages.theirs = true;
        break;
    }
  }
  return stages;
}

/** Whether any stage at all was reported — none means the read failed. */
export function hasAnyStage(stages: UnmergedStages): boolean {
  return stages.base || stages.ours || stages.theirs;
}

/**
 * Decide how to resolve a conflicted path in favour of the incoming branch.
 *
 * No incoming stage means the incoming branch deleted the file, so the
 * resolution is a delete. Keeping it would revive a file the incoming branch
 * decided to remove — the wrong default, and a silent one.
 */
export function resolveTowardsIncoming(
  stages: UnmergedStages,
): IncomingResolution {
  return stages.theirs ? "take-incoming" : "delete";
}
