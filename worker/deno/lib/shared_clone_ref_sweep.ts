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
import { runGitCommand } from "./git_timeout.ts";
import {
  acquireMaintenanceRepoLease,
  type RepoLease,
} from "./maintenance_lane.ts";
import { emitSelfHealEvent, type SelfHealEvent } from "./self_heal_events.ts";
import {
  collectProvenance,
  type RefProvenance,
} from "./shared_clone_ref_provenance.ts";
import { recordRepairAndMaybeEscalate } from "./shared_clone_repair_history.ts";

export type { RefProvenance } from "./shared_clone_ref_provenance.ts";

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

/** Shared state threaded through the internal sweep helpers for one repo. */
interface SweepContext {
  repo: string;
  clone: string;
  commonDir: string;
  runGit: typeof runGitCommand;
  deps: SharedCloneRefSweepDeps;
  now: () => Date;
  emit: (event: SelfHealEvent) => Promise<void>;
  outcome: SharedCloneSweepOutcome;
  handled: Set<string>;
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

/** Sweep one shared clone for broken refs, repair each, and track escalation. */
export async function sweepSharedClone(
  repo: string,
  workDir: string,
  deps: SharedCloneRefSweepDeps,
): Promise<SharedCloneSweepOutcome> {
  const runGit = deps.runGit ?? runGitCommand;
  const acquire = deps.acquireLease ??
    ((r: string) => acquireMaintenanceRepoLease(r));
  const emit = deps.emitEvent ??
    ((event: SelfHealEvent) =>
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

    const ctx: SweepContext = {
      repo,
      clone,
      commonDir,
      runGit,
      deps,
      now,
      emit,
      outcome,
      handled: new Set<string>(),
    };

    await sweepNulFilledLooseRefs(ctx);
    await sweepForEachRefLoop(ctx);
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

/** Record one repair on the outcome and report it (log + self-heal event). */
async function recordRepair(
  ctx: SweepContext,
  ref: string,
  kind: RepairedRefKind,
  action: RepairedRefAction,
  provenance: RefProvenance,
): Promise<void> {
  const repaired: RepairedRef = { ref, kind, action, provenance };
  ctx.outcome.repaired.push(repaired);
  await reportRepair(ctx, repaired);
}

/** Walk `<common-dir>/refs/heads` and `refs/remotes`, finding NUL-filled files. */
async function sweepNulFilledLooseRefs(ctx: SweepContext): Promise<void> {
  for (const namespace of ["refs/heads", "refs/remotes"]) {
    const found = await findNulFilledRefs(`${ctx.commonDir}/${namespace}`, "");
    for (const relative of found) {
      const ref = `${namespace}/${relative}`;
      if (ctx.handled.has(ref)) continue;
      ctx.handled.add(ref);
      await repairNulFilledRef(ctx, ref);
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
  ctx: SweepContext,
  ref: string,
): Promise<void> {
  const looseRefPath = `${ctx.commonDir}/${ref}`;
  // Built purely from the earlier directory walk, so no ref-name escape is possible.
  if (!looseRefPath.startsWith(`${ctx.commonDir}/`)) {
    ctx.outcome.failures.push(ref);
    ctx.deps.logError(
      `Shared-clone sweep: refusing to touch ${looseRefPath} for ${ref} in ${ctx.repo}: outside the git common directory`,
    );
    return;
  }

  const provenance = await collectProvenance(
    ref,
    ctx.clone,
    ctx.commonDir,
    ctx.deps,
    ctx.now,
  );

  try {
    await Deno.remove(looseRefPath);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.outcome.failures.push(ref);
      ctx.deps.logError(
        `Shared-clone sweep: could not remove NUL-filled ref ${ref} in ${ctx.repo}: ${message}`,
      );
      return;
    }
  }

  // The loose file is gone — see if packed-refs already carries a healthy copy.
  const verify = await ctx.runGit(
    ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
    { cwd: ctx.clone },
  );
  if (verify.ok && verify.value.code === 0) {
    await recordRepair(
      ctx,
      ref,
      "nul-filled",
      "restored-from-packed",
      provenance,
    );
    return;
  }

  // No usable packed-refs copy — fall through to the missing-object restore policy.
  await restoreBrokenRef(ctx, ref, "nul-filled", provenance);
}

/** Loop `for-each-ref`, repairing each newly named broken ref, up to a bound. */
async function sweepForEachRefLoop(ctx: SweepContext): Promise<void> {
  for (let round = 0; round < MAX_FOR_EACH_REF_ROUNDS; round++) {
    const result = await ctx.runGit(
      ["for-each-ref", "refs/heads", "refs/remotes"],
      { cwd: ctx.clone },
    );
    if (!result.ok) {
      ctx.outcome.failures.push("for-each-ref");
      ctx.deps.logError(
        `Shared-clone sweep: for-each-ref failed in ${ctx.repo}: ${result.error.message}`,
      );
      return;
    }
    // Parsed on every round, whatever the exit code: git prints
    // "warning: ignoring broken ref <ref>" for a truncated loose ref and
    // still exits 0, so exit 0 alone does not mean healthy (#2889 review).
    const broken = brokenRefsIn(result.value.stderr);
    const newRefs = broken.filter((ref) => !ctx.handled.has(ref));
    if (newRefs.length === 0) {
      if (result.value.code === 0) return; // Healthy — nothing left to repair.
      ctx.outcome.failures.push("for-each-ref");
      ctx.deps.logError(
        `Shared-clone sweep: for-each-ref exited ${result.value.code} in ${ctx.repo} without naming a broken ref: ${result.value.stderr.trim()}`,
      );
      return;
    }

    for (const ref of newRefs) {
      ctx.handled.add(ref);
      const provenance = await collectProvenance(
        ref,
        ctx.clone,
        ctx.commonDir,
        ctx.deps,
        ctx.now,
      );
      const removal = await removeBrokenRef(
        ref,
        { cwd: ctx.clone },
        ctx.runGit,
      );
      if (!removal.ok) {
        ctx.outcome.failures.push(ref);
        ctx.deps.logError(
          `Shared-clone sweep: could not remove broken ref ${ref} in ${ctx.repo}: ${removal.error.message}`,
        );
        continue;
      }
      await restoreBrokenRef(ctx, ref, "missing-object", provenance);
    }
  }
}

/** Pattern allowed for a branch component landing in a refspec/argv (printable, no whitespace/control chars). */
const SAFE_BRANCH_NAME = /^[!-~]+$/;

/** Restore a ref whose broken copy is already gone, per the Issue #2889 policy. */
async function restoreBrokenRef(
  ctx: SweepContext,
  ref: string,
  kind: RepairedRefKind,
  provenance: RefProvenance,
): Promise<void> {
  const { repo, clone, runGit, deps, outcome } = ctx;
  const remoteMatch = ref.match(/^refs\/remotes\/([^/]+)\/(.+)$/);
  if (
    remoteMatch && remoteMatch[1] !== undefined && remoteMatch[2] !== undefined
  ) {
    const remote = remoteMatch[1];
    const branch = remoteMatch[2];
    // origin/HEAD is a symbolic pointer, not a branch, and an unsafe branch
    // name cannot be refetched safely — both are resurrected by deletion only.
    if (branch === "HEAD" || !isSafeBranchName(branch)) {
      await recordRepair(ctx, ref, kind, "deleted", provenance);
      return;
    }
    const fetch = await runGit(
      ["fetch", "--end-of-options", remote, `+refs/heads/${branch}:${ref}`],
      { cwd: clone },
    );
    if (fetch.ok && fetch.value.code === 0) {
      await recordRepair(ctx, ref, kind, "refetched", provenance);
      return;
    }
    const stderr = fetch.ok ? fetch.value.stderr : fetch.error.message;
    if (stderr.includes("couldn't find remote ref")) {
      await recordRepair(ctx, ref, kind, "deleted-gone-on-origin", provenance);
      return;
    }
    outcome.failures.push(ref);
    deps.logError(
      `Shared-clone sweep: could not re-fetch ${ref} in ${repo}: ${stderr.trim()}`,
    );
    return;
  }

  const localMatch = ref.match(/^refs\/heads\/(.+)$/);
  if (!localMatch || localMatch[1] === undefined) {
    outcome.failures.push(ref);
    deps.logError(
      `Shared-clone sweep: ${ref} in ${repo} is outside the repaired namespaces`,
    );
    return;
  }
  const branch = localMatch[1];

  // Issue/milestone branches are ephemeral work branches, and an unsafe name
  // cannot be refetched safely — both are resurrected by deletion only.
  if (
    branch.startsWith("issue-") || branch.startsWith("milestone/") ||
    !isSafeBranchName(branch)
  ) {
    await deleteLocalBranchLeftovers(ctx, ref, kind, provenance);
    return;
  }

  const lsRemote = await runGit(
    ["ls-remote", "--exit-code", "--heads", "origin", branch],
    { cwd: clone },
  );
  if (lsRemote.ok && lsRemote.value.code === 0) {
    const trackingRef = `refs/remotes/origin/${branch}`;
    const fetch = await runGit(
      [
        "fetch",
        "--end-of-options",
        "origin",
        `+refs/heads/${branch}:${trackingRef}`,
      ],
      { cwd: clone },
    );
    if (fetch.ok && fetch.value.code === 0) {
      const update = await runGit(
        ["update-ref", ref, trackingRef],
        { cwd: clone },
      );
      if (update.ok && update.value.code === 0) {
        await recordRepair(ctx, ref, kind, "refetched", provenance);
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
    await deleteLocalBranchLeftovers(ctx, ref, kind, provenance);
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
  ctx: SweepContext,
  ref: string,
  kind: RepairedRefKind,
  provenance: RefProvenance,
): Promise<void> {
  const { repo, clone, runGit, deps, outcome } = ctx;
  const verify = await runGit(
    ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
    { cwd: clone },
  );
  if (verify.ok && verify.value.code === 0) {
    // A packed copy still resolves to a real commit — the loose file removal
    // already made the ref healthy again, so leave the packed copy alone.
    await recordRepair(ctx, ref, kind, "restored-from-packed", provenance);
    return;
  }
  const del = await runGit(
    ["update-ref", "-d", "--end-of-options", ref],
    { cwd: clone },
  );
  if (!del.ok || del.value.code !== 0) {
    outcome.failures.push(ref);
    deps.logError(
      `Shared-clone sweep: could not delete ${ref} in ${repo}: ${
        del.ok ? del.value.stderr.trim() : del.error.message
      }`,
    );
    return;
  }
  await recordRepair(ctx, ref, kind, "deleted", provenance);
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

/** Emit and log one repair. */
async function reportRepair(
  ctx: SweepContext,
  repaired: RepairedRef,
): Promise<void> {
  const { repo, deps, now, emit } = ctx;
  const summaryParts: string[] = [];
  if (repaired.provenance.checkedOutIn?.length) {
    summaryParts.push(
      `checked out in ${repaired.provenance.checkedOutIn.join(", ")}`,
    );
  }
  if (repaired.provenance.lastReflogEntry) {
    summaryParts.push(`last reflog: ${repaired.provenance.lastReflogEntry}`);
  }
  if (repaired.provenance.nearbyOomLogs?.length) {
    summaryParts.push(
      `nearby OOM logs: ${repaired.provenance.nearbyOomLogs.join(", ")}`,
    );
  }
  const summary = summaryParts.length > 0
    ? ` (${summaryParts.join("; ")})`
    : "";
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
