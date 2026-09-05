/**
 * Repairing a corrupt shared object store (Issue #1093).
 *
 * The lane-scoped worktrees of Issue #923 deliberately **share one object
 * store** per repository, so the work volume does not carry a full checkout
 * per slot. That is the right trade, but it makes a single damaged object a
 * **repository-wide** fault: every slot and every milestone branch in that
 * repository inherits it, and it persists across runs because nothing repairs
 * it.
 *
 * Observed on GRQ-23 on 2026-09-05, on a host with a history of disk
 * exhaustion — a plausible source of a truncated object write:
 *
 * ```text
 * Failed to create feature branch 'issue-984-…' from 'milestone/933-…':
 *   git checkout -B … exited 128:
 *   error: inflate: data stream error (unknown compression method)
 * ```
 *
 * `setup` read that as an ordinary branch-creation failure and failed the
 * issue, so the next issue in that repository hit the same object and failed
 * the same way. Every object is recoverable from the remote, so this is
 * repairable without human help: drop the clone (and the lane worktrees
 * hanging off it) and clone again.
 *
 * The repair is claimed **once per repository per run** — one bad object is
 * one fault, not one fault per issue — and a repair that does not resolve the
 * corruption escalates with the repository named.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { CommandResult, Result } from "../types.ts";
import { runGitCommand } from "./git_timeout.ts";
import { setupRepo as setupRepoCommand } from "../commands/git_operations.ts";
import { repoCheckoutPath } from "./repo_checkout_path.ts";
import { LANE_WORKTREE_ROOT } from "./lane_worktree.ts";

/**
 * Signatures of object-store corruption, as git itself words it.
 *
 * A distinct class from a bad ref or a missing branch: those name a ref the
 * repository does not have, while these name an object the repository has
 * but cannot read. Deliberately narrow — an ambiguous git failure stays an
 * ordinary failure, because re-cloning a healthy repository on a guess costs
 * a slot's worth of network for nothing.
 */
const CORRUPTION_SIGNATURES: readonly RegExp[] = [
  /\binflate:/i,
  /loose object .* is corrupt/i,
  /unable to read sha1 file/i,
  /object file .* is empty/i,
  /\bobject corrupt or missing\b/i,
];

/** True when `message` names object-store corruption rather than a bad ref. */
export function isObjectStoreCorruption(message: string): boolean {
  return CORRUPTION_SIGNATURES.some((re) => re.test(message));
}

/**
 * Repositories whose object store this run has already re-cloned, so the
 * repair is attempted once per repository per run rather than once per issue.
 *
 * Process-lifetime only, deliberately, for the same reason
 * `milestone_branch_rejection.ts` keeps its registry that way: a fresh run
 * should be free to repair again, and persisting the claim would leave a
 * genuinely corrupt store unrepaired for as long as the file survived.
 */
const repaired = new Set<string>();

/**
 * Claim the one repair this run may make for `repo`.
 *
 * @returns `true` on the first sighting — the caller should repair. `false`
 *   when this run already re-cloned that repository, which means the
 *   corruption survived the repair and a human is needed.
 */
export function claimObjectStoreRepair(repo: string): boolean {
  if (repaired.has(repo)) return false;
  repaired.add(repo);
  return true;
}

/** Whether this run has already re-cloned `repo`'s object store. */
export function hasClaimedObjectStoreRepair(repo: string): boolean {
  return repaired.has(repo);
}

/** Reset the registry. Tests only — production state is per process. */
export function resetObjectStoreRepairsForTest(): void {
  repaired.clear();
}

/** Longest `git fsck` excerpt carried into the log and the escalation. */
export const MAX_FSCK_EVIDENCE_CHARS = 2000;

/** What {@link repairSharedObjectStore} was asked to repair. */
export interface ObjectStoreRepairRequest {
  /** Repository in `owner/name` form. */
  repo: string;
  /** Directory the worker clones repositories into (`WORK_DIR`). */
  workDir: string;
}

/** What the repair did, for the log and for any escalation that follows. */
export interface ObjectStoreRepairOutcome {
  /** `git fsck` output, bounded — evidence, not a gate. */
  fsck: string;
  /** Directories removed before the re-clone, in the order removed. */
  removed: string[];
  /** Path of the freshly cloned shared store. */
  repoPath: string;
}

/** Injectable seams so the repair is testable without a real clone. */
export interface ObjectStoreRepairDeps {
  /** Runs git. Defaults to {@link runGitCommand}. */
  runGit?: typeof runGitCommand;
  /** Removes a directory tree. Defaults to a recursive `Deno.remove`. */
  removeTree?: (path: string) => Promise<void>;
  /** Lists the lane ids under `${workDir}/worktrees`. */
  listLaneIds?: (workDir: string) => Promise<string[]>;
  /** Clones the repository afresh. Defaults to `setupRepo`. */
  recloneFn?: (repo: string, workDir: string) => Promise<CommandResult>;
  /** Informational sink. Defaults to a no-op. */
  log?: (message: string) => void;
}

/** Default tree removal — an absent path is already removed. */
async function removeTreeDefault(path: string): Promise<void> {
  try {
    await Deno.remove(path, { recursive: true });
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
}

/** Default lane listing — an absent worktree root means no lanes. */
async function listLaneIdsDefault(workDir: string): Promise<string[]> {
  const lanes: string[] = [];
  try {
    for await (
      const entry of Deno.readDir(`${workDir}/${LANE_WORKTREE_ROOT}`)
    ) {
      if (entry.isDirectory) lanes.push(entry.name);
    }
  } catch {
    // No lane worktrees on this host yet — nothing to remove.
  }
  return lanes;
}

/**
 * Re-clone `repo`'s shared object store, taking every lane worktree hanging
 * off it with it.
 *
 * The stale worktree directories must go too: they are linked to the clone's
 * `.git`, so once it is gone `git worktree add` refuses their paths as
 * non-empty and every lane inherits the fault it was meant to escape.
 * `ensureLaneWorktree` recreates each lane's worktree on its next use.
 *
 * `git fsck` is run first and its output carried out as **evidence**, not as
 * a gate: the clones are shallow, so fsck is noisy in both directions, and
 * the checkout error that brought us here is already the confirmation. A
 * repair refused because fsck happened to say nothing would leave the store
 * corrupt for every issue that follows.
 *
 * @param request - Repository and work root
 * @param deps - Injected git, filesystem and clone seams
 * @returns The repair evidence, or the reason the store could not be replaced
 */
export async function repairSharedObjectStore(
  request: ObjectStoreRepairRequest,
  deps: ObjectStoreRepairDeps = {},
): Promise<Result<ObjectStoreRepairOutcome>> {
  const { repo, workDir } = request;
  const runGit = deps.runGit ?? runGitCommand;
  const removeTree = deps.removeTree ?? removeTreeDefault;
  const listLaneIds = deps.listLaneIds ?? listLaneIdsDefault;
  const reclone = deps.recloneFn ?? setupRepoCommand;
  const log = deps.log ?? (() => {});

  const repoPath = repoCheckoutPath(workDir, repo);
  const repoName = repo.split("/").pop() ?? repo;

  let fsck = "";
  try {
    const result = await runGit(["fsck", "--no-progress"], { cwd: repoPath });
    fsck = result.ok
      ? `${result.value.stdout}${result.value.stderr}`.trim()
      : result.error.message;
  } catch (error) {
    fsck = error instanceof Error ? error.message : String(error);
  }
  if (fsck.length > MAX_FSCK_EVIDENCE_CHARS) {
    fsck = `${fsck.slice(0, MAX_FSCK_EVIDENCE_CHARS)}… [truncated]`;
  }
  log(`[object-store-repair] git fsck on ${repo}: ${fsck || "(no output)"}`);

  const removed: string[] = [];
  const targets = [repoPath];
  for (const laneId of await listLaneIds(workDir)) {
    targets.push(`${workDir}/${LANE_WORKTREE_ROOT}/${laneId}/${repoName}`);
  }
  for (const target of targets) {
    try {
      await removeTree(target);
      removed.push(target);
    } catch (error) {
      return {
        ok: false,
        error: new Error(
          `Could not remove ${target} while repairing the corrupt object ` +
            `store of ${repo}: ${
              error instanceof Error ? error.message : String(error)
            }`,
        ),
      };
    }
  }
  log(
    `[object-store-repair] removed ${removed.length} path(s) for ${repo}; ` +
      "re-cloning",
  );

  const cloned = await reclone(repo, workDir);
  if (!cloned.success) {
    return {
      ok: false,
      error: new Error(
        `Re-clone of ${repo} after object-store corruption failed: ${cloned.message}`,
      ),
    };
  }

  return { ok: true, value: { fsck, removed, repoPath } };
}
