/**
 * The host-disk gate on heavy builds (Issue #3178).
 *
 * ## What went wrong
 *
 * GRQ-23, 2026-10-03: launch `vibe-coder-87008` started with the host
 * already below its disk floor (38.8 GB free, floor 46.0 GB). The claim gate
 * (Issue #226) did its job — no new issue was claimed — and logged
 * "maintenance continues". That maintenance included a milestone sync of a
 * large Rust repository whose verification and two agent repair rounds ran
 * `cargo check` and `cargo test --workspace`. On that trim-refused runtime the
 * output goes to the container's ephemeral root (Issue #2247), and it reached
 * 23 GB in 23 minutes. The host could not back the guest's writes, ext4
 * aborted its journal and `/` went read-only.
 *
 * So the disk gate stopped the cheap thing (a claim) and allowed the
 * expensive thing (a workspace-wide build and test). This module gates the
 * expensive thing.
 *
 * ## What this module does
 *
 * - **Below the floor, no maintenance build.** {@link judgeHostDiskForBuild}
 *   defers a build whenever the host-disk reading is `low`, and says which
 *   floor. Cheap maintenance — API calls, fetches, label work — never asks.
 * - **The ephemeral cargo root has a budget.** Where builds go to
 *   `/var/tmp/vibe-cargo-target`, a build starts only when the host has the
 *   floor **plus** {@link EPHEMERAL_CARGO_HEADROOM_BYTES} free — room for one
 *   build of the size that took GRQ-23 down. Short of that, idle checkouts'
 *   target directories are pruned (largest first). A build still not covered
 *   after pruning is not run, and the sync is not deferred. Merge-only mode
 *   ({@link heavyBuildAdmission}, Issue #4326) applies to a tree that holds a
 *   cargo project, because only a cargo build writes to the ephemeral cargo
 *   root; a repository with no cargo project keeps its own type check and the
 *   normal agent. {@link parkInFlightBuild} holds such a checkout to the host
 *   floor only, and prunes nothing for it (Issue #4413). In a cargo-only tree a conflict-free merge is pushed
 *   unverified with the `UNGATED:` note, and the milestone PR's own CI builds
 *   it. So is a merge whose conflicts the deterministic rules settle: its
 *   resolution gate reports a `skipped` verdict marked `landUnverified`, which
 *   is pushed with the same note. A Deno-only tree and a mixed tree keep their
 *   Deno checks and suites and are rolled back when those are red; a mixed
 *   tree whose Deno half passed records that cargo was left to CI. A conflict
 *   that needs the resolution agent is not landed in that cycle, because the
 *   agent is free to run the very cargo build the host cannot afford. The
 *   first such cycle is a refusal and is not charged. The next over-budget
 *   cycle charges the attempt, so the recovery ladder applies and the branch
 *   does not stay behind on disk budget alone.
 *
 *   No further reclaim step exists. On a runtime that refuses the trim,
 *   deleting artefacts inside the guest returns nothing to the host
 *   (`ephemeral_build_cache.ts`, `judgeGuestReclaim` in
 *   `work_volume_ratchet.ts`), so the ephemeral root's idle target directories
 *   are the only space the worker can hand back.
 * - **A pass cleans up after itself.** {@link releaseCheckoutTargetDirs}
 *   removes a checkout's target directories when the maintenance pass that
 *   built in it finishes, rather than leaving them to the relaunch.
 *
 * Pruning counts what it removes as room for the next build. That holds even
 * where the runtime refuses the trim: the blocks a guest deletes stay
 * allocated to the image, but the guest filesystem reuses them, so a build
 * writing into freed space does not grow the host image again.
 *
 * The host-disk reading comes from a probe the production wiring registers
 * ({@link registerHeavyBuildDiskProbe}) — the same `HostDiskMonitor` the claim
 * gate reads, so the two gates can never disagree about the floor. With no
 * probe registered (tests, ad hoc callers) nothing is gated, which is the
 * documented `unknown` default of Issue #226.
 *
 * Issue #4360: starting a generic agent checks only the host floor through
 * {@link parkRunningBuild}; manager startup does not itself start a build.
 * Explicit mutation, remediation and discrimination build steps use
 * {@link parkInFlightBuild} to check build admission. A checkout with no cargo
 * project is held to the floor only, and its idle sibling target directories
 * are not pruned for it, because only cargo writes to the ephemeral cargo root
 * (Issue #4413). {@link parkRunningBuild} also stops an active process at the
 * host floor, letting it consume the headroom admission required (Issue #4390).
 * {@link hostDiskLaunchStopReason} ends the
 * launch when the trim was refused and the host is below the floor — exiting the container
 * is what discards the ephemeral layer and lets the next launch recreate the
 * volume. The in-flight gate stays off until production enables it, so a test
 * that registers a probe does not park every other test in the process.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { formatGb, type HostDiskStatus } from "./host_disk.ts";
import {
  commandOutputWithTimeout,
  isCommandTimeoutError,
} from "./subprocess_timeout.ts";
import {
  cargoTargetDirForCheckout,
  EPHEMERAL_CARGO_TARGET_ROOT,
} from "./ephemeral_build_cache.ts";
import { findProjectManifests } from "./project_manifests.ts";

const GIB = 1_073_741_824;

/**
 * Free space a build into the ephemeral root needs above the host floor.
 *
 * Sized from the incident: one milestone sync of a large Rust workspace wrote
 * 23 GB there. A build is let start only when the host could absorb about
 * that much and still sit at its floor.
 */
export const EPHEMERAL_CARGO_HEADROOM_BYTES = 25 * GIB;

/**
 * A target directory written to within this window is treated as in use by
 * another slot's build and is never pruned from under it.
 */
export const EPHEMERAL_TARGET_IN_USE_MS = 20 * 60_000;

/** What the gate needs to know about the host. */
export interface HeavyBuildDiskReading {
  /** The host-disk monitor's current status. */
  status: HostDiskStatus;
  /** The floor in bytes for this host, when the total is known. */
  floorBytes: number | undefined;
  /** Did the launcher report the runtime refuses the work-volume trim? */
  trimRefused: boolean;
  /**
   * Did the launcher decline to recreate the work volume this launch, because
   * the work volume does not hold the missing space (Issue #4498)? Absent reads
   * as false.
   */
  recreateDeclined?: boolean;
  /**
   * Did the launcher recreate the work volume this launch and find the host
   * still below its floor (Issue #4498)? The next launch will not recreate it
   * again until the free-space reading moves. Absent reads as false.
   */
  recreateUnrecovered?: boolean;
  /**
   * The largest host directories the launcher reported (Issue #4498). Absent
   * or blank names none.
   */
  largestHostDirectories?: string;
}

/** One directory under the ephemeral cargo root. */
export interface EphemeralTargetDir {
  path: string;
  /** Bytes it holds. */
  bytes: number;
  /** Most recent write seen in it, epoch ms. */
  lastWriteMs: number;
}

/** The filesystem work behind the budget, injectable for tests. */
export interface EphemeralRootDeps {
  listTargetDirs: (root: string) => Promise<EphemeralTargetDir[]>;
  removeDir: (path: string) => Promise<void>;
  nowMs: () => number;
}

/**
 * Should a heavy build wait because the host is below its floor?
 *
 * @returns The deferral reason, naming the floor, or null to proceed. An
 *   `unknown` reading never defers — a blind probe must not stop every build
 *   in the fleet, the same rule the claim gate follows.
 */
export function judgeHostDiskForBuild(
  reading: HeavyBuildDiskReading,
): string | null {
  if (reading.status.level !== "low") return null;
  return `host disk below its floor — ${reading.status.detail}; a ` +
    `repository build or test would grow host disk further, so it waits ` +
    `until the host recovers (Issue #3178)`;
}

/** The directory-name prefix every account's target dir for a checkout has. */
function checkoutKey(checkoutPath: string, root: string): string {
  const dir = cargoTargetDirForCheckout(checkoutPath, { root });
  return dir.slice(dir.lastIndexOf("/") + 1);
}

/** Is this directory one of the checkout's own (any account)? */
function belongsTo(path: string, key: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name === key || name.startsWith(`${key}-`);
}

/**
 * Phrase a deferral carries when the merge may land and cargo must not run
 * (Issue #4326). Callers match it with {@link deferralSkipsCargoForMerge}.
 */
export const CARGO_BUILD_SKIPPED_FOR_MERGE = "cargo builds wait for CI";

/** The budget's verdict for one build. */
export interface CargoBudgetVerdict {
  proceed: boolean;
  /** Bytes pruned on the way to the verdict. */
  prunedBytes: number;
  /** One line for the log. */
  detail: string;
  /**
   * Free space is at or above the floor and short of floor + headroom, and
   * pruning freed nothing. Cargo must not run; a merge-only sync may land
   * and the repository's CI builds the tree (Issue #4326).
   */
  skipCargoBuild: boolean;
}

/**
 * Whether `deferral` is the merge-only cargo skip (Issue #4326).
 *
 * A real build still waits. A milestone sync that is only a merge does not.
 */
export function deferralSkipsCargoForMerge(
  deferral: string | null,
): boolean {
  return deferral !== null &&
    deferral.includes(CARGO_BUILD_SKIPPED_FOR_MERGE);
}

/**
 * Enforce the ephemeral cargo root's budget before a build in `checkoutPath`.
 *
 * The bound is tied to host free space: a build may start when
 * `free − headroom ≥ floor`. Short of that, other checkouts' idle target
 * directories are removed, largest first, until the shortfall is covered;
 * still short, `proceed` is false and {@link heavyBuildAdmission} turns the
 * sync into a merge-only one (Issue #4326). The checkout's own directories
 * (its incremental cache) and any written to recently (another slot's build
 * in progress) are never pruned. With `creditOwnCache`, the bytes already in
 * the checkout's own directories count towards the headroom, capped at it, so
 * the floor itself is never relaxed (Issue #4423). With `dryRun`, nothing is
 * removed: the verdict is the one a real run would reach if every removal
 * succeeded (Issue #4540, the claim scan's question).
 */
export async function enforceEphemeralCargoBudget(
  input: {
    checkoutPath: string;
    hostFreeBytes: number;
    floorBytes: number;
    headroomBytes?: number;
    root?: string;
    creditOwnCache?: boolean;
    dryRun?: boolean;
  },
  deps: EphemeralRootDeps,
): Promise<CargoBudgetVerdict> {
  const root = input.root ?? EPHEMERAL_CARGO_TARGET_ROOT;
  const headroom = input.headroomBytes ?? EPHEMERAL_CARGO_HEADROOM_BYTES;
  const needed = input.floorBytes + headroom;
  let terms = `${formatGb(input.hostFreeBytes)} free, floor ` +
    `${formatGb(input.floorBytes)} + headroom ${formatGb(headroom)}`;
  let shortfall = needed - input.hostFreeBytes;
  if (shortfall <= 0) {
    return {
      proceed: true,
      prunedBytes: 0,
      skipCargoBuild: false,
      detail: `within budget (${terms})`,
    };
  }

  let dirs: EphemeralTargetDir[];
  try {
    dirs = await deps.listTargetDirs(root);
  } catch (err) {
    return {
      proceed: false,
      prunedBytes: 0,
      skipCargoBuild: false,
      detail: `ephemeral cargo root over budget (${terms}) and ${root} could ` +
        `not be read to prune it: ${
          err instanceof Error ? err.message : String(err)
        } (Issue #3178)`,
    };
  }

  const key = checkoutKey(input.checkoutPath, root);
  if (input.creditOwnCache) {
    // A build into an existing cache is incremental: what is already there was
    // part of the from-scratch build the headroom reserves (Issue #4423).
    const own = dirs.filter((d) => belongsTo(d.path, key))
      .reduce((sum, d) => sum + d.bytes, 0);
    const credit = Math.min(own, headroom);
    if (credit > 0) {
      shortfall -= credit;
      terms += `; ${formatGb(credit)} already in this checkout's cache`;
      if (shortfall <= 0) {
        return {
          proceed: true,
          prunedBytes: 0,
          skipCargoBuild: false,
          detail: `within budget (${terms}) (Issue #4423)`,
        };
      }
    }
  }
  const now = deps.nowMs();
  const candidates = dirs
    .filter((d) => !belongsTo(d.path, key))
    .filter((d) => now - d.lastWriteMs >= EPHEMERAL_TARGET_IN_USE_MS)
    .sort((a, b) => b.bytes - a.bytes);

  let pruned = 0;
  const failures: string[] = [];
  for (const dir of candidates) {
    if (shortfall <= 0) break;
    try {
      if (!input.dryRun) await deps.removeDir(dir.path);
      pruned += dir.bytes;
      shortfall -= dir.bytes;
    } catch (err) {
      failures.push(
        `${dir.path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  const prunedNote = `pruned ${formatGb(pruned)} of idle target dirs` +
    (failures.length > 0 ? `; could not remove ${failures.join(", ")}` : "");
  if (shortfall <= 0) {
    return {
      proceed: true,
      prunedBytes: pruned,
      skipCargoBuild: false,
      detail: `ephemeral cargo root back within budget (${terms}) — ` +
        `${prunedNote} (Issue #3178)`,
    };
  }
  // Above the floor, with nothing pruned, a merge must not wait on cargo.
  // The host stays at or above its floor because cargo does not run; CI
  // builds the merged tree (Issue #4326). A prune that freed some bytes and
  // is still short keeps refusing, so a partial free cannot start a build.
  if (pruned === 0 && input.hostFreeBytes >= input.floorBytes) {
    return {
      proceed: false,
      prunedBytes: 0,
      skipCargoBuild: true,
      detail: `ephemeral cargo root over budget (${terms}) — ${prunedNote} ` +
        `and ${formatGb(shortfall)} is still short, so ` +
        `${CARGO_BUILD_SKIPPED_FOR_MERGE} (Issue #3178 budget; Issue #4326 skip)`,
    };
  }
  return {
    proceed: false,
    prunedBytes: pruned,
    skipCargoBuild: false,
    detail: `ephemeral cargo root over budget (${terms}) — ${prunedNote} and ` +
      `${formatGb(shortfall)} is still short, so the build is refused ` +
      `(Issue #3178)`,
  };
}

/** The registered source of host-disk readings. */
let probe: (() => Promise<HeavyBuildDiskReading>) | undefined;

/**
 * Register (or, with undefined, clear) where heavy builds read the host disk
 * from. Production registers the run's own `HostDiskMonitor`.
 */
export function registerHeavyBuildDiskProbe(
  next: (() => Promise<HeavyBuildDiskReading>) | undefined,
): void {
  probe = next;
}

/**
 * What a maintenance pass does with a repository build or test (Issue #4326).
 *
 * - `build` — run it as usual.
 * - `defer` — the host is below its floor: no build and no merge this cycle
 *   (Issue #3178).
 * - `merge-only` — the ephemeral root is still short of budget after pruning:
 *   cargo builds wait for the milestone PR's CI. Deno projects retain their
 *   normal verification. The reason names the budget verdict.
 */
export type HeavyBuildAdmission =
  | { mode: "build" }
  | { mode: "defer"; reason: string }
  | { mode: "merge-only"; reason: string };

/**
 * The one call a maintenance pass makes before it runs a repository build or
 * test in `checkoutPath`.
 *
 * @returns How the pass proceeds; see {@link HeavyBuildAdmission}
 */
export async function heavyBuildAdmission(
  checkoutPath: string,
  deps: EphemeralRootDeps = productionEphemeralRootDeps,
  options: { creditOwnCache?: boolean } = {},
): Promise<HeavyBuildAdmission> {
  if (probe === undefined) return { mode: "build" };
  const reading = await probe();
  const low = judgeHostDiskForBuild(reading);
  if (low !== null) return { mode: "defer", reason: low };
  // The budget is about the ephemeral root, which builds use only where the
  // runtime refuses the trim (Issue #2247).
  if (!reading.trimRefused) return { mode: "build" };
  const free = reading.status.availableBytes;
  if (reading.status.level !== "ok" || free === undefined) {
    return { mode: "build" };
  }
  if (reading.floorBytes === undefined) return { mode: "build" };
  const verdict = await enforceEphemeralCargoBudget({
    checkoutPath,
    hostFreeBytes: free,
    floorBytes: reading.floorBytes,
    creditOwnCache: options.creditOwnCache,
  }, deps);
  if (verdict.proceed) return { mode: "build" };
  return {
    mode: "merge-only",
    reason:
      `${verdict.detail}; cargo builds wait for CI; Deno projects keep their ` +
      `normal checks (Issue #4326)`,
  };
}

/**
 * The sentence appended when a build is parked for the host disk (Issue #4360).
 *
 * Both host-fault classifiers match it, and it is not a worker-gate marker, so
 * the issue is not charged a failed-once or a gate verdict.
 */
export const HOST_DISK_PARK_NOTE = "Parked as infrastructure (Issue #4360).";

/** The deferral, plus {@link HOST_DISK_PARK_NOTE}, or null when the build may run. */
export function inFlightParkReason(deferral: string | null): string | null {
  if (deferral === null) return null;
  return `${deferral} ${HOST_DISK_PARK_NOTE}`;
}

/**
 * Whether this launch must end so the host gets its space back (Issue #4360).
 *
 * Deleting files inside a volume whose trim was refused does not return host
 * blocks. Ending the launch discards the container's ephemeral layer, and the
 * launcher then either recreates the volume, if the host is still below the
 * floor, or, when it declined to recreate or a recreate it ran left the host
 * short (Issue #4498), says the missing space is elsewhere on the host (after a
 * declined recreate it adds that nothing in the worker will free it). Above the floor, or where the trim is honoured, the build is parked and the launch
 * continues: fstrim can return the blocks, and a recreate would not.
 *
 * @returns The reason to end the launch, naming the floor, or null to continue.
 */
export function hostDiskLaunchStopReason(
  reading: HeavyBuildDiskReading,
): string | null {
  if (reading.status.level !== "low" || !reading.trimRefused) return null;
  const deferral = judgeHostDiskForBuild(reading);
  if (deferral === null) return null;
  if (reading.recreateDeclined === true) {
    const largest = reading.largestHostDirectories?.trim();
    const dirs = largest ? ` Largest host directories: ${largest}.` : "";
    return `${deferral} The launcher declined to recreate the work volume ` +
      `because the work volume does not hold the missing space; the missing ` +
      `space is elsewhere on the host (stale build caches or clones outside ` +
      `the worker volumes).${dirs} Nothing in the worker will free it until ` +
      `the host has room, so this launch ends and the ephemeral build layer ` +
      `is discarded (Issue #4498). ${HOST_DISK_PARK_NOTE}`;
  }
  if (reading.recreateUnrecovered === true) {
    const largest = reading.largestHostDirectories?.trim();
    const dirs = largest ? ` Largest host directories: ${largest}.` : "";
    return `${deferral} The launcher recreated the work volume this launch ` +
      `and it did not return the missing space; it will not recreate the ` +
      `volume again until the host's free-space reading moves (the missing ` +
      `space is elsewhere on the host).${dirs} This launch ends and the ephemeral build layer is discarded ` +
      `(Issue #4498). ${HOST_DISK_PARK_NOTE}`;
  }
  return `${deferral} The work volume trim was refused, so this launch ends ` +
    `and the ephemeral build layer is discarded; the next launch recreates ` +
    `the volume if the host is still below the floor (Issue #4360). ` +
    `${HOST_DISK_PARK_NOTE}`;
}

/**
 * Off until production turns it on. A process-global probe is how the
 * maintenance gate already reads the disk; enabling the in-flight callers
 * only in the worker process keeps a test's probe from parking another
 * test's agent (deno test runs files in parallel).
 */
let inFlightGateEnabled = false;

/** Enable or clear the in-flight host-disk gate for this process. */
export function enableInFlightHostDiskGate(enabled: boolean): void {
  inFlightGateEnabled = enabled;
}

/** Whether production has armed {@link parkInFlightBuild}. */
export function inFlightHostDiskGateEnabled(): boolean {
  return inFlightGateEnabled;
}

/**
 * Why a new build step must not start in `checkoutPath` (Issue #4360).
 *
 * A checkout with a cargo project gets the same floor and ephemeral headroom
 * as {@link heavyBuildAdmission}: a `defer` admission (host below its floor)
 * or a `merge-only` admission (short of the headroom) parks it, and the budget
 * may prune idle sibling target directories for it. A checkout with no cargo
 * project is held to the host floor only (Issue #4413): only cargo writes to
 * the ephemeral cargo root, so the budget is not consulted, nothing is pruned,
 * and its idle sibling target directories are left alone. A cargo checkout's
 * own cache counts towards the headroom (Issue #4423): a run that was admitted
 * and built is not refused a later step for the space its own build used.
 * Null when the gate
 * is not armed, no probe is registered, or the host has room.
 * Active-process watchers use {@link parkRunningBuild} instead.
 */
export async function parkInFlightBuild(
  checkoutPath: string,
  deps: EphemeralRootDeps = productionEphemeralRootDeps,
): Promise<string | null> {
  if (!inFlightGateEnabled) return null;
  // No cargo project: only the host floor applies, and nothing is pruned (Issue #4413).
  if (!(await holdsCargoProject(checkoutPath))) return await parkRunningBuild();
  const admission = await heavyBuildAdmission(checkoutPath, deps, {
    creditOwnCache: true,
  });
  return inFlightParkReason(
    admission.mode === "build" ? null : admission.reason,
  );
}

/**
 * Why a new claim in `checkoutPath` would be parked at once, or null to claim
 * (Issue #4540).
 *
 * The claim gate opens at the host floor, but {@link parkInFlightBuild}
 * refuses a cargo checkout's agent until the floor plus the cargo headroom is
 * free. In between, every claim on a cargo repository was taken, parked and
 * released, and taken again next cycle, while work that could run waited.
 * This asks the in-flight park's own question as a dry run — the checkout's
 * own cache is credited and idle siblings count as prunable, but nothing is
 * removed at scan time. A host below its floor is left to the host-disk claim
 * gate, which already stops every claim. A checkout with no cargo project,
 * a disarmed gate or an unknown reading never defers.
 */
export async function cargoClaimDeferral(
  checkoutPath: string,
  deps: EphemeralRootDeps = productionEphemeralRootDeps,
): Promise<string | null> {
  if (!inFlightGateEnabled || probe === undefined) return null;
  const reading = await probe();
  if (!reading.trimRefused || reading.status.level !== "ok") return null;
  const free = reading.status.availableBytes;
  if (free === undefined || reading.floorBytes === undefined) return null;
  if (!(await holdsCargoProject(checkoutPath))) return null;
  const verdict = await enforceEphemeralCargoBudget({
    checkoutPath,
    hostFreeBytes: free,
    floorBytes: reading.floorBytes,
    creditOwnCache: true,
    dryRun: true,
  }, deps);
  return verdict.proceed ? null : verdict.detail;
}

/**
 * The repositories whose existing clone {@link cargoClaimDeferral} defers,
 * each with its reason (Issue #4540). A repository not cloned yet is left
 * claimable: its cargo-ness is unknown, and the in-flight park stays the
 * backstop.
 */
export async function cargoClaimDeferredRepos(
  repos: readonly string[],
  cloneDirFor: (repo: string) => string,
  deps: EphemeralRootDeps = productionEphemeralRootDeps,
): Promise<Map<string, string>> {
  const deferred = new Map<string, string>();
  for (const repo of repos) {
    const reason = await cargoClaimDeferral(cloneDirFor(repo), deps);
    if (reason !== null) deferred.set(repo, reason);
  }
  return deferred;
}

/** Whether a cargo project sits within the searched depth of `checkoutPath` (Issue #4413). */
async function holdsCargoProject(checkoutPath: string): Promise<boolean> {
  // Unreadable checkout: no manifest, and the agent could not run there either.
  return (await findProjectManifests(checkoutPath)).some((project) =>
    project.kind === "cargo"
  );
}

/**
 * Stop an active process only at the host floor (Issue #4390).
 *
 * The full headroom is required before starting, then may be consumed:
 * re-applying it while running killed admitted builds after their first few
 * gigabytes. Poll the same live monitor without pruning other checkouts or
 * demanding another complete build's headroom. An unknown reading retains
 * the existing gate policy; a known low reading still stops the process.
 */
export async function parkRunningBuild(): Promise<string | null> {
  if (!inFlightGateEnabled || probe === undefined) return null;
  return inFlightParkReason(judgeHostDiskForBuild(await probe()));
}

/**
 * Whether cargo must not run for `checkoutPath` (Issue #4326).
 *
 * True only when the host is above its floor, the runtime refuses the trim,
 * and pruning idle target directories freed nothing. No registered probe
 * (tests, ad hoc callers) never skips.
 */
export async function shouldSkipEphemeralCargoBuild(
  checkoutPath: string,
  deps: EphemeralRootDeps = productionEphemeralRootDeps,
): Promise<boolean> {
  if (probe === undefined) return false;
  const reading = await probe();
  if (judgeHostDiskForBuild(reading) !== null) return false;
  if (!reading.trimRefused) return false;
  const free = reading.status.availableBytes;
  if (reading.status.level !== "ok" || free === undefined) return false;
  if (reading.floorBytes === undefined) return false;
  const verdict = await enforceEphemeralCargoBudget({
    checkoutPath,
    hostFreeBytes: free,
    floorBytes: reading.floorBytes,
  }, deps);
  return verdict.skipCargoBuild;
}

/** What {@link releaseCheckoutTargetDirs} removed. */
export interface ReleasedTargetDirs {
  bytes: number;
  errors: string[];
}

/**
 * Remove every account's ephemeral target directory for one checkout, once
 * the pass that built in it has finished.
 *
 * Best-effort: a directory the worker's account cannot remove (another
 * account's, under the sticky root) is reported, not fatal.
 */
export async function releaseCheckoutTargetDirs(
  checkoutPath: string,
  deps: EphemeralRootDeps = productionEphemeralRootDeps,
  root: string = EPHEMERAL_CARGO_TARGET_ROOT,
): Promise<ReleasedTargetDirs> {
  const key = checkoutKey(checkoutPath, root);
  let dirs: EphemeralTargetDir[];
  try {
    dirs = await deps.listTargetDirs(root);
  } catch (err) {
    // No root yet means nothing was built there. Any other failure — a `du`
    // that timed out among them — left this checkout's dirs in place, and
    // saying so is what keeps a leak on the disk floor visible.
    if (err instanceof Deno.errors.NotFound) return { bytes: 0, errors: [] };
    return {
      bytes: 0,
      errors: [`${root}: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
  let bytes = 0;
  const errors: string[] = [];
  for (const dir of dirs.filter((d) => belongsTo(d.path, key))) {
    try {
      await deps.removeDir(dir.path);
      bytes += dir.bytes;
    } catch (err) {
      errors.push(
        `${dir.path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return { bytes, errors };
}

/** `du` of one cargo target. Long enough for a large tree, still bounded. */
const DU_TIMEOUT_MS = 2 * 60 * 1000;

/** `du -sk` of one directory, in bytes; 0 when it cannot be measured. A timeout is a failure. */
export async function measureDirectoryBytes(
  path: string,
  timeoutMs: number = DU_TIMEOUT_MS,
): Promise<number> {
  try {
    const out = await commandOutputWithTimeout("du", {
      args: ["-sk", "--", path],
      stdout: "piped",
      stderr: "null",
      timeoutMs,
    });
    const kb = Number.parseInt(new TextDecoder().decode(out.stdout), 10);
    return Number.isFinite(kb) ? kb * 1024 : 0;
  } catch (error) {
    if (isCommandTimeoutError(error)) throw error;
    return 0;
  }
}

/**
 * The latest write seen in a target dir: the dir itself and the `deps`
 * directories cargo adds an artefact to on every compiled crate.
 */
async function lastWriteMs(path: string): Promise<number> {
  let latest = 0;
  for (const sub of ["", "/debug", "/debug/deps", "/release/deps"]) {
    try {
      const mtime = (await Deno.stat(`${path}${sub}`)).mtime?.getTime() ?? 0;
      latest = Math.max(latest, mtime);
    } catch {
      // Absent: that profile was never built.
    }
  }
  return latest;
}

/** The real filesystem. */
export const productionEphemeralRootDeps: EphemeralRootDeps = {
  listTargetDirs: async (root: string) => {
    const dirs: EphemeralTargetDir[] = [];
    for await (const entry of Deno.readDir(root)) {
      if (!entry.isDirectory) continue;
      const path = `${root}/${entry.name}`;
      dirs.push({
        path,
        bytes: await measureDirectoryBytes(path),
        lastWriteMs: await lastWriteMs(path),
      });
    }
    return dirs;
  },
  removeDir: (path: string) => Deno.remove(path, { recursive: true }),
  nowMs: () => Date.now(),
};
