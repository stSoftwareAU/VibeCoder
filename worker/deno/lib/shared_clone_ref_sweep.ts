/**
 * Periodic sweep of shared clones for broken refs (Issue #2889).
 *
 * The broken refs Issue #2880/#2824 repair on-demand are loose ref files of
 * 41 NUL bytes, written while the host disk was low. Left alone they sit
 * until something happens to touch that exact ref — `git for-each-ref`
 * prints `warning: ignoring broken ref refs/heads/X` for them, and a ref
 * pointing at a missing object makes `for-each-ref` ABORT the listing with
 * `fatal: missing object <sha> for refs/…`, hiding every broken ref that
 * would otherwise be reported after it.
 *
 * This module sweeps every shared clone on an interval, finds every broken
 * ref (looping `for-each-ref` to work around the abort-on-first-fatal
 * behaviour, and walking the loose ref files directly to catch NUL-filled
 * refs `for-each-ref` silently skips), repairs each one, records
 * last-writer provenance for the self-heal log, and escalates loudly when
 * the same shared clone keeps reappearing with broken refs — the surest
 * sign the root cause (disk pressure while a ref write was in flight) is
 * still happening.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { brokenRefsIn, removeBrokenRef } from "./broken_ref_repair.ts";
import { assertSafeRefComponent } from "./git_ref_args.ts";
import {
  type GitCommandOptions,
  runGitCommand,
} from "./git_timeout.ts";
import {
  acquireMaintenanceRepoLease,
  type RepoLease,
} from "./maintenance_lane.ts";
import {
  emitSelfHealEvent,
  type SelfHealEvent,
} from "./self_heal_events.ts";

/** How often a shared clone is swept (Issue #2889). */
export const SHARED_CLONE_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** Repairs in the window above this count trigger escalation. */
export const REPAIR_ESCALATION_THRESHOLD = 2;

/** Rolling window the escalation threshold is measured over. */
export const REPAIR_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Self-heal events module name for this sweep. */
export const SHARED_CLONE_REF_SWEEP_MODULE = "shared-clone-ref-sweep";

/** Repair-history file name, relative to `workDir`. */
export const REPAIR_HISTORY_FILENAME = ".shared-clone-ref-repairs.json";

/** Upper bound on `for-each-ref` rounds before giving up on a repo. */
const MAX_FOR_EACH_REF_ROUNDS = 5;

/** Seams for {@link sweepSharedClone} and {@link sweepSharedClones}. */
export interface SharedCloneRefSweepDeps {
  log: (message: string) => void;
  logError: (message: string) => void;
  /** Injectable git runner. Defaults to {@link runGitCommand}. */
  runGit?: typeof runGitCommand;
  /** Injectable lease. Defaults to {@link acquireMaintenanceRepoLease}. */
  acquireLease?: (repo: string) => RepoLease | null;
  /** Injectable event sink. Defaults to {@link emitSelfHealEvent}. */
  emitEvent?: (event: SelfHealEvent) => Promise<void>;
  /** Injectable clock. Defaults to `new Date()`. */
  now?: () => Date;
  /** Directory scanned for `oom-*` files for OOM-correlation provenance. */
  logsDir?: string;
}

/** Last-writer provenance collected for a repaired ref. */
export interface RefProvenance {
  /** ISO mtime of the loose ref file when one existed. */
  refFileMtime?: string;
  /** Last line of the ref's reflog, truncated to 300 characters. */
  lastReflogEntry?: string;
  /** Worktree paths (from `git worktree list`) with this branch checked out. */
  checkedOutIn?: string[];
  /** `oom-*` log basenames whose mtime is close to the ref's mtime. */
  nearbyOomLogs?: string[];
}

/** Kind of brokenness found for a ref. */
export type RepairedRefKind = "nul-filled" | "missing-object";

/** How a broken ref was repaired. */
export type RepairedRefAction =
  | "restored-from-packed"
  | "refetched"
  | "deleted"
  | "deleted-gone-on-origin";

/** One ref this sweep repaired. */
export interface RepairedRef {
  ref: string;
  kind: RepairedRefKind;
  action: RepairedRefAction;
  provenance: RefProvenance;
}

/** What one sweep of one shared clone did. */
export interface SharedCloneSweepOutcome {
  repo: string;
  skipped: "no-clone" | "leased" | null;
  repaired: RepairedRef[];
  failures: string[];
  escalated: boolean;
}

/** Repair-history file shape (Issue #2889). */
interface RepairHistory {
  repairs: Record<string, number[]>;
}

/** Whether a sweep is due, given the last sweep time. */
export function isSweepDue(
  lastSweepAtMs: number | undefined,
  nowMs: number,
  intervalMs: number = SHARED_CLONE_SWEEP_INTERVAL_MS,
): boolean {
  if (lastSweepAtMs === undefined) return true;
  return nowMs - lastSweepAtMs >= intervalMs;
}

/** Resolve the shared clone path for `repo` under `workDir`. */
function clonePath(repo: string, workDir: string): string {
  const name = repo.split("/")[1] ?? repo;
  return `${workDir}/${name}`;
}

/** True once the clone directory looks like a real git checkout. */
async function hasGitDir(clone: string): Promise<boolean> {
  try {
    const stat = await Deno.stat(`${clone}/.git`);
    return stat.isDirectory || stat.isFile; // `.git` is a file in worktrees.
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

/** Resolve the ref store directory (shared by lane worktrees). */
async function commonDirOf(
  clone: string,
  runGit: typeof runGitCommand,
): Promise<string | null> {
  const result = await runGit(["rev-parse", "--git-common-dir"], {
    cwd: clone,
  });
  if (!result.ok || result.value.code !== 0) return null;
  const raw = result.value.stdout.trim();
  return raw.startsWith("/") ? raw : `${clone}/${raw}`;
}

/**
 * Sweep one shared clone for broken refs, repair each, and track escalation.
 */
export async function sweepSharedClone(
  repo: string,
  workDir: string,
  deps: SharedCloneRefSweepDeps,
): Promise<SharedCloneSweepOutcome> {
  const runGit = deps.runGit ?? runGitCommand;
  const acquire = deps.acquireLease ?? ((r: string) =>
    acquireMaintenanceRepoLease(r));
  const emit = deps.emitEvent ?? ((event: SelfHealEvent) =>
    emitSelfHealEvent(event, { workDir, now: deps.now }).then(() => {}));
  const now = deps.now ?? (() => new Date());

  const outcome: SharedCloneSweepOutcome = {
    repo,
    skipped: null,
    repaired: [],
    failures: [],
    escalated: false,
  };

  const clone = clonePath(repo, workDir);
  if (!(await hasGitDir(clone))) {
    return { ...outcome, skipped: "no-clone" };
  }

  const lease = acquire(repo);
  if (lease === null) {
    deps.log(`Shared-clone sweep deferred: repo lease held by a lane: ${repo}`);
    await emit({
      timestamp: now().toISOString(),
      module: SHARED_CLONE_REF_SWEEP_MODULE,
      action: "sweep",
      result: "skipped",
      reason: `repo lease held by a lane: ${repo}`,
    });
    return { ...outcome, skipped: "leased" };
  }

  try {
    const commonDir = await commonDirOf(clone, runGit);
    if (commonDir === null) {
      outcome.failures.push(
        `could not resolve the git common directory for ${repo}`,
      );
      deps.logError(
        `Shared-clone sweep: could not resolve the git common directory for ${repo}`,
      );
      return outcome;
    }

    const handled = new Set<string>();

    await sweepNulFilledLooseRefs(
      repo,
      clone,
      commonDir,
      runGit,
      deps,
      now,
      emit,
      handled,
      outcome,
    );

    await sweepForEachRefLoop(
      repo,
      clone,
      commonDir,
      runGit,
      deps,
      now,
      emit,
      handled,
      outcome,
    );
  } finally {
    lease.release();
  }

  if (outcome.repaired.length > 0) {
    await recordRepairAndMaybeEscalate(repo, workDir, now, deps, emit, outcome);
  }

  return outcome;
}

/** Sequentially sweep every repo; a thrown error for one does not stop others. */
export async function sweepSharedClones(
  repos: readonly string[],
  workDir: string,
  deps: SharedCloneRefSweepDeps,
): Promise<SharedCloneSweepOutcome[]> {
  const outcomes: SharedCloneSweepOutcome[] = [];
  for (const repo of repos) {
    try {
      outcomes.push(await sweepSharedClone(repo, workDir, deps));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.logError(`Shared-clone sweep threw for ${repo}: ${message}`);
      outcomes.push({
        repo,
        skipped: null,
        repaired: [],
        failures: [`sweep threw: ${message}`],
        escalated: false,
      });
    }
  }
  return outcomes;
}

// ---------------------------------------------------------------------------
// NUL-filled loose ref discovery
// ---------------------------------------------------------------------------

/** Walk `<common-dir>/refs/heads` and `refs/remotes`, finding NUL-filled files. */
async function sweepNulFilledLooseRefs(
  repo: string,
  clone: string,
  commonDir: string,
  runGit: typeof runGitCommand,
  deps: SharedCloneRefSweepDeps,
  now: () => Date,
  emit: (event: SelfHealEvent) => Promise<void>,
  handled: Set<string>,
  outcome: SharedCloneSweepOutcome,
): Promise<void> {
  for (const namespace of ["refs/heads", "refs/remotes"]) {
    const found = await findNulFilledRefs(`${commonDir}/${namespace}`, "");
    for (const relative of found) {
      const ref = `${namespace}/${relative}`;
      if (handled.has(ref)) continue;
      handled.add(ref);
      await repairNulFilledRef(
        repo,
        ref,
        clone,
        commonDir,
        runGit,
        deps,
        now,
        emit,
        outcome,
      );
    }
  }
}

/** Recursively find loose ref files under `dir` that are empty or NUL-filled. */
async function findNulFilledRefs(
  dir: string,
  prefix: string,
): Promise<string[]> {
  let entries: Deno.DirEntry[];
  try {
    entries = [];
    for await (const entry of Deno.readDir(dir)) entries.push(entry);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }

  const found: string[] = [];
  for (const entry of entries) {
    const path = `${dir}/${entry.name}`;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    let stat: Deno.FileInfo;
    try {
      stat = await Deno.lstat(path);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) continue;
      throw error;
    }
    if (stat.isSymlink) continue;
    if (stat.isDirectory) {
      found.push(...(await findNulFilledRefs(path, relative)));
      continue;
    }
    if (!stat.isFile) continue;
    let bytes: Uint8Array;
    try {
      bytes = await Deno.readFile(path);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) continue;
      throw error;
    }
    if (bytes.length === 0 || bytes.includes(0)) {
      found.push(relative);
    }
  }
  return found;
}

/** Remove a NUL-filled loose ref and try the packed-refs fallback first. */
async function repairNulFilledRef(
  repo: string,
  ref: string,
  clone: string,
  commonDir: string,
  runGit: typeof runGitCommand,
  deps: SharedCloneRefSweepDeps,
  now: () => Date,
  emit: (event: SelfHealEvent) => Promise<void>,
  outcome: SharedCloneSweepOutcome,
): Promise<void> {
  const looseRefPath = `${commonDir}/${ref}`;
  // Path confinement: the path is built purely from the earlier directory
  // walk, never from text git printed, so no ref-name escape is possible.
  if (!looseRefPath.startsWith(`${commonDir}/`)) {
    outcome.failures.push(ref);
    deps.logError(
      `Shared-clone sweep: refusing to touch ${looseRefPath} for ${ref} in ${repo}: outside the git common directory`,
    );
    return;
  }

  const provenance = await collectProvenance(ref, clone, commonDir, deps, now);

  try {
    await Deno.remove(looseRefPath);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      const message = error instanceof Error ? error.message : String(error);
      outcome.failures.push(ref);
      deps.logError(
        `Shared-clone sweep: could not remove NUL-filled ref ${ref} in ${repo}: ${message}`,
      );
      return;
    }
  }

  // The loose file is gone — see if packed-refs already carries a healthy copy.
  const verify = await runGit(
    ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
    { cwd: clone },
  );
  if (verify.ok && verify.value.code === 0) {
    const repaired: RepairedRef = {
      ref,
      kind: "nul-filled",
      action: "restored-from-packed",
      provenance,
    };
    outcome.repaired.push(repaired);
    await reportRepair(repo, repaired, deps, now, emit);
    return;
  }

  // No usable packed-refs copy — fall through to the same restore policy the
  // for-each-ref loop uses for a missing-object ref.
  await restoreBrokenRef(
    repo,
    ref,
    "nul-filled",
    clone,
    provenance,
    runGit,
    deps,
    now,
    emit,
    outcome,
  );
}

// ---------------------------------------------------------------------------
// for-each-ref loop (missing-object refs)
// ---------------------------------------------------------------------------

/** Loop `for-each-ref`, repairing each newly named broken ref, up to a bound. */
async function sweepForEachRefLoop(
  repo: string,
  clone: string,
  commonDir: string,
  runGit: typeof runGitCommand,
  deps: SharedCloneRefSweepDeps,
  now: () => Date,
  emit: (event: SelfHealEvent) => Promise<void>,
  handled: Set<string>,
  outcome: SharedCloneSweepOutcome,
): Promise<void> {
  for (let round = 0; round < MAX_FOR_EACH_REF_ROUNDS; round++) {
    const result = await runGit(
      ["for-each-ref", "refs/heads", "refs/remotes"],
      { cwd: clone },
    );
    if (!result.ok) {
      outcome.failures.push("for-each-ref");
      deps.logError(
        `Shared-clone sweep: for-each-ref failed in ${repo}: ${result.error.message}`,
      );
      return;
    }
    if (result.value.code === 0) return; // Healthy — nothing left to repair.

    const broken = brokenRefsIn(result.value.stderr);
    const newRefs = broken.filter((ref) => !handled.has(ref));
    if (newRefs.length === 0) {
      outcome.failures.push("for-each-ref");
      deps.logError(
        `Shared-clone sweep: for-each-ref exited ${result.value.code} in ${repo} without naming a broken ref: ${result.value.stderr.trim()}`,
      );
      return;
    }

    for (const ref of newRefs) {
      handled.add(ref);
      const provenance = await collectProvenance(
        ref,
        clone,
        commonDir,
        deps,
        now,
      );
      const removal = await removeBrokenRef(ref, { cwd: clone }, runGit);
      if (!removal.ok) {
        outcome.failures.push(ref);
        deps.logError(
          `Shared-clone sweep: could not remove broken ref ${ref} in ${repo}: ${removal.error.message}`,
        );
        continue;
      }
      await restoreBrokenRef(
        repo,
        ref,
        "missing-object",
        clone,
        provenance,
        runGit,
        deps,
        now,
        emit,
        outcome,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Restore policy
// ---------------------------------------------------------------------------

/** Pattern allowed for a branch component landing in a refspec/argv. */
const SAFE_BRANCH_NAME = /^[!-~]+$/; // Printable, no whitespace/control chars.

/** Restore a ref whose broken copy is already gone, per the Issue #2889 policy. */
async function restoreBrokenRef(
  repo: string,
  ref: string,
  kind: RepairedRefKind,
  clone: string,
  provenance: RefProvenance,
  runGit: typeof runGitCommand,
  deps: SharedCloneRefSweepDeps,
  now: () => Date,
  emit: (event: SelfHealEvent) => Promise<void>,
  outcome: SharedCloneSweepOutcome,
): Promise<void> {
  const remoteMatch = ref.match(/^refs\/remotes\/([^/]+)\/(.+)$/);
  if (remoteMatch) {
    const [, remote, branch] = remoteMatch;
    if (branch === "HEAD") {
      // Never resurrected: origin/HEAD is a symbolic pointer, not a branch.
      const repaired: RepairedRef = {
        ref,
        kind,
        action: "deleted",
        provenance,
      };
      outcome.repaired.push(repaired);
      await reportRepair(repo, repaired, deps, now, emit);
      return;
    }
    if (!isSafeBranchName(branch)) {
      const repaired: RepairedRef = {
        ref,
        kind,
        action: "deleted",
        provenance,
      };
      outcome.repaired.push(repaired);
      await reportRepair(repo, repaired, deps, now, emit);
      return;
    }
    const fetch = await runGit(
      ["fetch", "--end-of-options", remote, `+refs/heads/${branch}:${ref}`],
      { cwd: clone },
    );
    if (fetch.ok && fetch.value.code === 0) {
      const repaired: RepairedRef = { ref, kind, action: "refetched", provenance };
      outcome.repaired.push(repaired);
      await reportRepair(repo, repaired, deps, now, emit);
      return;
    }
    const stderr = fetch.ok ? fetch.value.stderr : fetch.error.message;
    if (stderr.includes("couldn't find remote ref")) {
      const repaired: RepairedRef = {
        ref,
        kind,
        action: "deleted-gone-on-origin",
        provenance,
      };
      outcome.repaired.push(repaired);
      await reportRepair(repo, repaired, deps, now, emit);
      return;
    }
    outcome.failures.push(ref);
    deps.logError(
      `Shared-clone sweep: could not re-fetch ${ref} in ${repo}: ${stderr.trim()}`,
    );
    return;
  }

  const localMatch = ref.match(/^refs\/heads\/(.+)$/);
  if (!localMatch) {
    outcome.failures.push(ref);
    deps.logError(
      `Shared-clone sweep: ${ref} in ${repo} is outside the repaired namespaces`,
    );
    return;
  }
  const branch = localMatch[1];

  if (branch.startsWith("issue-") || branch.startsWith("milestone/")) {
    await deleteLocalBranchLeftovers(repo, ref, kind, clone, provenance, runGit, deps, now, emit, outcome);
    return;
  }

  if (!isSafeBranchName(branch)) {
    await deleteLocalBranchLeftovers(repo, ref, kind, clone, provenance, runGit, deps, now, emit, outcome);
    return;
  }

  const lsRemote = await runGit(
    ["ls-remote", "--exit-code", "--heads", "origin", branch],
    { cwd: clone },
  );
  if (lsRemote.ok && lsRemote.value.code === 0) {
    const trackingRef = `refs/remotes/origin/${branch}`;
    const fetch = await runGit(
      ["fetch", "--end-of-options", "origin", `+refs/heads/${branch}:${trackingRef}`],
      { cwd: clone },
    );
    if (fetch.ok && fetch.value.code === 0) {
      const update = await runGit(
        ["update-ref", ref, trackingRef],
        { cwd: clone },
      );
      if (update.ok && update.value.code === 0) {
        const repaired: RepairedRef = { ref, kind, action: "refetched", provenance };
        outcome.repaired.push(repaired);
        await reportRepair(repo, repaired, deps, now, emit);
        return;
      }
      outcome.failures.push(ref);
      deps.logError(
        `Shared-clone sweep: could not point ${ref} at ${trackingRef} in ${repo}: ${
          update.ok ? update.value.stderr.trim() : update.error.message
        }`,
      );
      return;
    }
    outcome.failures.push(ref);
    deps.logError(
      `Shared-clone sweep: could not re-fetch ${branch} for ${ref} in ${repo}: ${
        fetch.ok ? fetch.value.stderr.trim() : fetch.error.message
      }`,
    );
    return;
  }
  if (lsRemote.ok && lsRemote.value.code === 2) {
    // Not on origin any more — delete only.
    await deleteLocalBranchLeftovers(repo, ref, kind, clone, provenance, runGit, deps, now, emit, outcome);
    return;
  }
  outcome.failures.push(ref);
  deps.logError(
    `Shared-clone sweep: could not check origin for ${branch} (ref ${ref}) in ${repo}: ${
      lsRemote.ok
        ? `exit ${lsRemote.value.code}: ${lsRemote.value.stderr.trim()}`
        : lsRemote.error.message
    }`,
  );
}

/** Delete a local branch ref, mopping up any surviving packed-refs copy. */
async function deleteLocalBranchLeftovers(
  repo: string,
  ref: string,
  kind: RepairedRefKind,
  clone: string,
  provenance: RefProvenance,
  runGit: typeof runGitCommand,
  deps: SharedCloneRefSweepDeps,
  now: () => Date,
  emit: (event: SelfHealEvent) => Promise<void>,
  outcome: SharedCloneSweepOutcome,
): Promise<void> {
  const verify = await runGit(
    ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
    { cwd: clone },
  );
  if (verify.ok && verify.value.code === 0) {
    // A packed copy still resolves to a real commit — leave it alone, the
    // loose file removal already made the ref healthy again.
    const repaired: RepairedRef = { ref, kind, action: "deleted", provenance };
    outcome.repaired.push(repaired);
    await reportRepair(repo, repaired, deps, now, emit);
    return;
  }
  // Still broken (or missing an object) — delete the packed entry too.
  await runGit(["update-ref", "-d", "--end-of-options", ref], { cwd: clone });
  const repaired: RepairedRef = { ref, kind, action: "deleted", provenance };
  outcome.repaired.push(repaired);
  await reportRepair(repo, repaired, deps, now, emit);
}

/** Reject a branch name unsafe to interpolate into a refspec or argv. */
function isSafeBranchName(branch: string): boolean {
  if (branch.includes("..")) return false;
  try {
    assertSafeRefComponent(branch, "shared-clone ref sweep branch name");
  } catch {
    return false;
  }
  return SAFE_BRANCH_NAME.test(branch);
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/** Best-effort provenance collection; every I/O error is narrowed and logged. */
async function collectProvenance(
  ref: string,
  clone: string,
  commonDir: string,
  deps: SharedCloneRefSweepDeps,
  now: () => Date,
): Promise<RefProvenance> {
  const provenance: RefProvenance = {};

  let refFileMtimeMs: number | undefined;
  try {
    const stat = await Deno.lstat(`${commonDir}/${ref}`);
    if (stat.mtime) {
      provenance.refFileMtime = stat.mtime.toISOString();
      refFileMtimeMs = stat.mtime.getTime();
    }
  } catch (error) {
    // Already removed, or never existed as a loose file (packed-only) —
    // provenance simply has no mtime to report.
    if (!(error instanceof Deno.errors.NotFound)) {
      deps.log(
        `Shared-clone sweep: could not stat ${ref} for provenance: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  try {
    const reflog = await Deno.readTextFile(`${commonDir}/logs/${ref}`);
    const lastLine = reflog.split("\n").map((l) => l.trim()).filter(Boolean)
      .at(-1);
    if (lastLine) provenance.lastReflogEntry = lastLine.slice(0, 300);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      deps.log(
        `Shared-clone sweep: could not read reflog for ${ref}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  if (ref.startsWith("refs/heads/")) {
    const branch = ref.slice("refs/heads/".length);
    const checkedOutIn = await checkedOutWorktrees(clone, branch, deps);
    if (checkedOutIn.length > 0) provenance.checkedOutIn = checkedOutIn;
  }

  if (deps.logsDir) {
    const nearby = await nearbyOomLogs(
      deps.logsDir,
      refFileMtimeMs ?? now().getTime(),
      deps,
    );
    if (nearby.length > 0) provenance.nearbyOomLogs = nearby;
  }

  return provenance;
}

/** Worktree paths with `branch` checked out, from `git worktree list --porcelain`. */
async function checkedOutWorktrees(
  clone: string,
  branch: string,
  deps: SharedCloneRefSweepDeps,
): Promise<string[]> {
  const runGit = deps.runGit ?? runGitCommand;
  const result = await runGit(["worktree", "list", "--porcelain"], {
    cwd: clone,
  } satisfies GitCommandOptions);
  if (!result.ok || result.value.code !== 0) return [];

  const paths: string[] = [];
  let currentPath: string | null = null;
  for (const line of result.value.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length).trim();
    } else if (line.startsWith("branch ")) {
      const branchRef = line.slice("branch ".length).trim();
      if (currentPath && branchRef === `refs/heads/${branch}`) {
        paths.push(currentPath);
      }
    } else if (line === "") {
      currentPath = null;
    }
  }
  return paths;
}

/** `logsDir/oom-*` basenames whose mtime is within 15 minutes of `targetMs`. */
async function nearbyOomLogs(
  logsDir: string,
  targetMs: number,
  deps: SharedCloneRefSweepDeps,
): Promise<string[]> {
  const windowMs = 15 * 60 * 1000;
  const matches: string[] = [];
  let entries: Deno.DirEntry[];
  try {
    entries = [];
    for await (const entry of Deno.readDir(logsDir)) entries.push(entry);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      deps.log(
        `Shared-clone sweep: could not read logsDir for OOM correlation: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return matches;
  }
  for (const entry of entries) {
    if (!entry.isFile || !entry.name.startsWith("oom-")) continue;
    try {
      const stat = await Deno.stat(`${logsDir}/${entry.name}`);
      if (stat.mtime && Math.abs(stat.mtime.getTime() - targetMs) <= windowMs) {
        matches.push(entry.name);
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        deps.log(
          `Shared-clone sweep: could not stat ${entry.name} for OOM correlation: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
  return matches;
}

// ---------------------------------------------------------------------------
// Event/log reporting and escalation
// ---------------------------------------------------------------------------

/** Emit and log one repair. */
async function reportRepair(
  repo: string,
  repaired: RepairedRef,
  deps: SharedCloneRefSweepDeps,
  now: () => Date,
  emit: (event: SelfHealEvent) => Promise<void>,
): Promise<void> {
  const summaryParts: string[] = [];
  if (repaired.provenance.checkedOutIn?.length) {
    summaryParts.push(`checked out in ${repaired.provenance.checkedOutIn.join(", ")}`);
  }
  if (repaired.provenance.lastReflogEntry) {
    summaryParts.push(`last reflog: ${repaired.provenance.lastReflogEntry}`);
  }
  if (repaired.provenance.nearbyOomLogs?.length) {
    summaryParts.push(`nearby OOM logs: ${repaired.provenance.nearbyOomLogs.join(", ")}`);
  }
  const summary = summaryParts.length > 0 ? ` (${summaryParts.join("; ")})` : "";
  deps.log(
    `Shared-clone sweep: repaired ${repaired.kind} ref ${repaired.ref} in ${repo} → ${repaired.action}${summary}`,
  );
  await emit({
    timestamp: now().toISOString(),
    module: SHARED_CLONE_REF_SWEEP_MODULE,
    action: "repair-broken-ref",
    result: "ok",
    reason: `${repaired.kind} ${repaired.ref} in ${repo} → ${repaired.action}`,
    details: {
      repo,
      ref: repaired.ref,
      kind: repaired.kind,
      action: repaired.action,
      ...repaired.provenance,
    },
  });
}

/** Append this sweep's repair to the history file and escalate if it churns. */
async function recordRepairAndMaybeEscalate(
  repo: string,
  workDir: string,
  now: () => Date,
  deps: SharedCloneRefSweepDeps,
  emit: (event: SelfHealEvent) => Promise<void>,
  outcome: SharedCloneSweepOutcome,
): Promise<void> {
  const historyPath = `${workDir}/${REPAIR_HISTORY_FILENAME}`;
  const nowMs = now().getTime();

  let history: RepairHistory = { repairs: {} };
  try {
    const text = await Deno.readTextFile(historyPath);
    const parsed = JSON.parse(text);
    if (
      parsed && typeof parsed === "object" &&
      parsed.repairs && typeof parsed.repairs === "object"
    ) {
      history = parsed as RepairHistory;
    } else {
      throw new Error("unexpected shape");
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      deps.logError(
        `Shared-clone sweep: repair history file is corrupt, starting fresh: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    history = { repairs: {} };
  }

  const windowStart = nowMs - REPAIR_WINDOW_MS;
  const existing = (history.repairs[repo] ?? []).filter((t) => t >= windowStart);
  existing.push(nowMs);
  history.repairs[repo] = existing;

  const tempPath = `${historyPath}.tmp-${crypto.randomUUID()}`;
  try {
    await Deno.writeTextFile(tempPath, JSON.stringify(history));
    await Deno.rename(tempPath, historyPath);
  } catch (error) {
    deps.logError(
      `Shared-clone sweep: could not write repair history for ${repo}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    try {
      await Deno.remove(tempPath);
    } catch {
      /* best-effort cleanup of the temp file; nothing further to do */
    }
  }

  const repairsInWindow = existing.length;
  if (repairsInWindow > REPAIR_ESCALATION_THRESHOLD) {
    outcome.escalated = true;
    const message =
      `[SHARED_CLONE_REF_CHURN] ${repo}: shared clone repaired ${repairsInWindow} ` +
      "times in the last 24h — broken refs keep reappearing; last-writer " +
      "provenance is in self-heal.jsonl (Issue #2889)";
    deps.logError(message);
    await emit({
      timestamp: now().toISOString(),
      module: SHARED_CLONE_REF_SWEEP_MODULE,
      action: "escalate",
      result: "failed",
      reason: message,
      details: { repo, repairsInWindow },
    });
  }
}
