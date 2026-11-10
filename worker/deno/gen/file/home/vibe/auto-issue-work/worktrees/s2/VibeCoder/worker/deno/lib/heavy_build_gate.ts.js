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
 *   built in it finishes, rather than leaving them to the relaunch. The
 *   pre-PR verifier's disposable checkout is released the same way when the
 *   verifier finishes (Issue #4743).
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
 * Issue #4360: a build already running is held to the same floor. The claim
 * gate only stops new claims, so {@link parkInFlightBuild} checks admission
 * before an agent, mutation or discrimination build. A checkout with no cargo
 * project is held to the floor only, and its idle sibling target directories
 * are not pruned for it, because only cargo writes to the ephemeral cargo root
 * (Issue #4413). {@link parkRunningBuild}
 * stops an active process at the host floor, letting it consume the headroom
 * admission required (Issue #4390). {@link hostDiskLaunchStopReason} ends the
 * launch when the trim was refused and the host is below the floor — exiting the container
 * is what discards the ephemeral layer and lets the next launch recreate the
 * volume. The in-flight gate stays off until production enables it, so a test
 * that registers a probe does not park every other test in the process.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */ import { formatGb } from "./host_disk.ts";
import { commandOutputWithTimeout, isCommandTimeoutError } from "./subprocess_timeout.ts";
import { cargoTargetDirForCheckout, EPHEMERAL_CARGO_TARGET_ROOT } from "./ephemeral_build_cache.ts";
import { findProjectManifests } from "./project_manifests.ts";
const GIB = 1_073_741_824;
/**
 * Free space a build into the ephemeral root needs above the host floor.
 *
 * Sized from the incident: one milestone sync of a large Rust workspace wrote
 * 23 GB there. A build is let start only when the host could absorb about
 * that much and still sit at its floor.
 */ export const EPHEMERAL_CARGO_HEADROOM_BYTES = 25 * GIB;
/**
 * A target directory written to within this window is treated as in use by
 * another slot's build and is never pruned from under it.
 */ export const EPHEMERAL_TARGET_IN_USE_MS = 20 * 60_000;
/**
 * Should a heavy build wait because the host is below its floor?
 *
 * @returns The deferral reason, naming the floor, or null to proceed. An
 *   `unknown` reading never defers — a blind probe must not stop every build
 *   in the fleet, the same rule the claim gate follows.
 */ export function judgeHostDiskForBuild(reading) {
  if (reading.status.level !== "low") return null;
  return `host disk below its floor — ${reading.status.detail}; a ` + `repository build or test would grow host disk further, so it waits ` + `until the host recovers (Issue #3178)`;
}
/** The directory-name prefix every account's target dir for a checkout has. */ function checkoutKey(checkoutPath, root) {
  const dir = cargoTargetDirForCheckout(checkoutPath, {
    root
  });
  return dir.slice(dir.lastIndexOf("/") + 1);
}
/** Is this directory one of the checkout's own (any account)? */ function belongsTo(path, key) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name === key || name.startsWith(`${key}-`);
}
/**
 * Phrase a deferral carries when the merge may land and cargo must not run
 * (Issue #4326). Callers match it with {@link deferralSkipsCargoForMerge}.
 */ export const CARGO_BUILD_SKIPPED_FOR_MERGE = "cargo builds wait for CI";
/**
 * Whether `deferral` is the merge-only cargo skip (Issue #4326).
 *
 * A real build still waits. A milestone sync that is only a merge does not.
 */ export function deferralSkipsCargoForMerge(deferral) {
  return deferral !== null && deferral.includes(CARGO_BUILD_SKIPPED_FOR_MERGE);
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
 */ export async function enforceEphemeralCargoBudget(input, deps) {
  const root = input.root ?? EPHEMERAL_CARGO_TARGET_ROOT;
  const headroom = input.headroomBytes ?? EPHEMERAL_CARGO_HEADROOM_BYTES;
  const needed = input.floorBytes + headroom;
  let terms = `${formatGb(input.hostFreeBytes)} free, floor ` + `${formatGb(input.floorBytes)} + headroom ${formatGb(headroom)}`;
  let shortfall = needed - input.hostFreeBytes;
  if (shortfall <= 0) {
    return {
      proceed: true,
      prunedBytes: 0,
      skipCargoBuild: false,
      detail: `within budget (${terms})`
    };
  }
  let dirs;
  try {
    dirs = await deps.listTargetDirs(root);
  } catch (err) {
    return {
      proceed: false,
      prunedBytes: 0,
      skipCargoBuild: false,
      detail: `ephemeral cargo root over budget (${terms}) and ${root} could ` + `not be read to prune it: ${err instanceof Error ? err.message : String(err)} (Issue #3178)`
    };
  }
  const key = checkoutKey(input.checkoutPath, root);
  if (input.creditOwnCache) {
    // A build into an existing cache is incremental: what is already there was
    // part of the from-scratch build the headroom reserves (Issue #4423).
    const own = dirs.filter((d)=>belongsTo(d.path, key)).reduce((sum, d)=>sum + d.bytes, 0);
    const credit = Math.min(own, headroom);
    if (credit > 0) {
      shortfall -= credit;
      terms += `; ${formatGb(credit)} already in this checkout's cache`;
      if (shortfall <= 0) {
        return {
          proceed: true,
          prunedBytes: 0,
          skipCargoBuild: false,
          detail: `within budget (${terms}) (Issue #4423)`
        };
      }
    }
  }
  const now = deps.nowMs();
  const candidates = dirs.filter((d)=>!belongsTo(d.path, key)).filter((d)=>now - d.lastWriteMs >= EPHEMERAL_TARGET_IN_USE_MS).sort((a, b)=>b.bytes - a.bytes);
  let pruned = 0;
  const failures = [];
  for (const dir of candidates){
    if (shortfall <= 0) break;
    try {
      if (!input.dryRun) await deps.removeDir(dir.path);
      pruned += dir.bytes;
      shortfall -= dir.bytes;
    } catch (err) {
      failures.push(`${dir.path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const prunedNote = `pruned ${formatGb(pruned)} of idle target dirs` + (failures.length > 0 ? `; could not remove ${failures.join(", ")}` : "");
  if (shortfall <= 0) {
    return {
      proceed: true,
      prunedBytes: pruned,
      skipCargoBuild: false,
      detail: `ephemeral cargo root back within budget (${terms}) — ` + `${prunedNote} (Issue #3178)`
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
      detail: `ephemeral cargo root over budget (${terms}) — ${prunedNote} ` + `and ${formatGb(shortfall)} is still short, so ` + `${CARGO_BUILD_SKIPPED_FOR_MERGE} (Issue #3178 budget; Issue #4326 skip)`
    };
  }
  return {
    proceed: false,
    prunedBytes: pruned,
    skipCargoBuild: false,
    detail: `ephemeral cargo root over budget (${terms}) — ${prunedNote} and ` + `${formatGb(shortfall)} is still short, so the build is refused ` + `(Issue #3178)`
  };
}
/** The registered source of host-disk readings. */ let probe;
/**
 * Register (or, with undefined, clear) where heavy builds read the host disk
 * from. Production registers the run's own `HostDiskMonitor`.
 */ export function registerHeavyBuildDiskProbe(next) {
  probe = next;
}
/**
 * The one call a maintenance pass makes before it runs a repository build or
 * test in `checkoutPath`.
 *
 * @returns How the pass proceeds; see {@link HeavyBuildAdmission}
 */ export async function heavyBuildAdmission(checkoutPath, deps = productionEphemeralRootDeps, options = {}) {
  if (probe === undefined) return {
    mode: "build"
  };
  const reading = await probe();
  const low = judgeHostDiskForBuild(reading);
  if (low !== null) return {
    mode: "defer",
    reason: low
  };
  // The budget is about the ephemeral root, which builds use only where the
  // runtime refuses the trim (Issue #2247).
  if (!reading.trimRefused) return {
    mode: "build"
  };
  const free = reading.status.availableBytes;
  if (reading.status.level !== "ok" || free === undefined) {
    return {
      mode: "build"
    };
  }
  if (reading.floorBytes === undefined) return {
    mode: "build"
  };
  const verdict = await enforceEphemeralCargoBudget({
    checkoutPath,
    hostFreeBytes: free,
    floorBytes: reading.floorBytes,
    creditOwnCache: options.creditOwnCache
  }, deps);
  if (verdict.proceed) return {
    mode: "build"
  };
  return {
    mode: "merge-only",
    reason: `${verdict.detail}; cargo builds wait for CI; Deno projects keep their ` + `normal checks (Issue #4326)`
  };
}
/**
 * The sentence appended when a build is parked for the host disk (Issue #4360).
 *
 * Both host-fault classifiers match it, and it is not a worker-gate marker, so
 * the issue is not charged a failed-once or a gate verdict.
 */ export const HOST_DISK_PARK_NOTE = "Parked as infrastructure (Issue #4360).";
/** The deferral, plus {@link HOST_DISK_PARK_NOTE}, or null when the build may run. */ export function inFlightParkReason(deferral) {
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
 */ export function hostDiskLaunchStopReason(reading) {
  if (reading.status.level !== "low" || !reading.trimRefused) return null;
  const deferral = judgeHostDiskForBuild(reading);
  if (deferral === null) return null;
  if (reading.recreateDeclined === true) {
    const largest = reading.largestHostDirectories?.trim();
    const dirs = largest ? ` Largest host directories: ${largest}.` : "";
    return `${deferral} The launcher declined to recreate the work volume ` + `because the work volume does not hold the missing space; the missing ` + `space is elsewhere on the host (stale build caches or clones outside ` + `the worker volumes).${dirs} Nothing in the worker will free it until ` + `the host has room, so this launch ends and the ephemeral build layer ` + `is discarded (Issue #4498). ${HOST_DISK_PARK_NOTE}`;
  }
  if (reading.recreateUnrecovered === true) {
    const largest = reading.largestHostDirectories?.trim();
    const dirs = largest ? ` Largest host directories: ${largest}.` : "";
    return `${deferral} The launcher recreated the work volume this launch ` + `and it did not return the missing space; it will not recreate the ` + `volume again until the host's free-space reading moves (the missing ` + `space is elsewhere on the host).${dirs} This launch ends and the ephemeral build layer is discarded ` + `(Issue #4498). ${HOST_DISK_PARK_NOTE}`;
  }
  return `${deferral} The work volume trim was refused, so this launch ends ` + `and the ephemeral build layer is discarded; the next launch recreates ` + `the volume if the host is still below the floor (Issue #4360). ` + `${HOST_DISK_PARK_NOTE}`;
}
/**
 * Off until production turns it on. A process-global probe is how the
 * maintenance gate already reads the disk; enabling the in-flight callers
 * only in the worker process keeps a test's probe from parking another
 * test's agent (deno test runs files in parallel).
 */ let inFlightGateEnabled = false;
/** Enable or clear the in-flight host-disk gate for this process. */ export function enableInFlightHostDiskGate(enabled) {
  inFlightGateEnabled = enabled;
}
/** Whether production has armed {@link parkInFlightBuild}. */ export function inFlightHostDiskGateEnabled() {
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
 */ export async function parkInFlightBuild(checkoutPath, deps = productionEphemeralRootDeps) {
  if (!inFlightGateEnabled) return null;
  // No cargo project: only the host floor applies, and nothing is pruned (Issue #4413).
  if (!await holdsCargoProject(checkoutPath)) return await parkRunningBuild();
  const admission = await heavyBuildAdmission(checkoutPath, deps, {
    creditOwnCache: true
  });
  return inFlightParkReason(admission.mode === "build" ? null : admission.reason);
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
 */ export async function cargoClaimDeferral(checkoutPath, deps = productionEphemeralRootDeps) {
  if (!inFlightGateEnabled || probe === undefined) return null;
  const reading = await probe();
  if (!reading.trimRefused || reading.status.level !== "ok") return null;
  const free = reading.status.availableBytes;
  if (free === undefined || reading.floorBytes === undefined) return null;
  if (!await holdsCargoProject(checkoutPath)) return null;
  const verdict = await enforceEphemeralCargoBudget({
    checkoutPath,
    hostFreeBytes: free,
    floorBytes: reading.floorBytes,
    creditOwnCache: true,
    dryRun: true
  }, deps);
  return verdict.proceed ? null : verdict.detail;
}
/**
 * The repositories whose existing clone {@link cargoClaimDeferral} defers,
 * each with its reason (Issue #4540). A repository not cloned yet is left
 * claimable: its cargo-ness is unknown, and the in-flight park stays the
 * backstop.
 */ export async function cargoClaimDeferredRepos(repos, cloneDirFor, deps = productionEphemeralRootDeps) {
  const deferred = new Map();
  for (const repo of repos){
    const reason = await cargoClaimDeferral(cloneDirFor(repo), deps);
    if (reason !== null) deferred.set(repo, reason);
  }
  return deferred;
}
/** Whether a cargo project sits within the searched depth of `checkoutPath` (Issue #4413). */ async function holdsCargoProject(checkoutPath) {
  // Unreadable checkout: no manifest, and the agent could not run there either.
  return (await findProjectManifests(checkoutPath)).some((project)=>project.kind === "cargo");
}
/**
 * Stop an active process only at the host floor (Issue #4390).
 *
 * The full headroom is required before starting, then may be consumed:
 * re-applying it while running killed admitted builds after their first few
 * gigabytes. Poll the same live monitor without pruning other checkouts or
 * demanding another complete build's headroom. An unknown reading retains
 * the existing gate policy; a known low reading still stops the process.
 */ export async function parkRunningBuild() {
  if (!inFlightGateEnabled || probe === undefined) return null;
  return inFlightParkReason(judgeHostDiskForBuild(await probe()));
}
/**
 * Whether cargo must not run for `checkoutPath` (Issue #4326).
 *
 * True only when the host is above its floor, the runtime refuses the trim,
 * and pruning idle target directories freed nothing. No registered probe
 * (tests, ad hoc callers) never skips.
 */ export async function shouldSkipEphemeralCargoBuild(checkoutPath, deps = productionEphemeralRootDeps) {
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
    floorBytes: reading.floorBytes
  }, deps);
  return verdict.skipCargoBuild;
}
/**
 * Remove every account's ephemeral target directory for one checkout, once
 * the pass that built in it has finished.
 *
 * Best-effort: a directory the worker's account cannot remove (another
 * account's, under the sticky root) is reported, not fatal.
 */ export async function releaseCheckoutTargetDirs(checkoutPath, deps = productionEphemeralRootDeps, root = EPHEMERAL_CARGO_TARGET_ROOT) {
  const key = checkoutKey(checkoutPath, root);
  let dirs;
  try {
    dirs = await deps.listTargetDirs(root);
  } catch (err) {
    // No root yet means nothing was built there. Any other failure — a `du`
    // that timed out among them — left this checkout's dirs in place, and
    // saying so is what keeps a leak on the disk floor visible.
    if (err instanceof Deno.errors.NotFound) return {
      bytes: 0,
      errors: []
    };
    return {
      bytes: 0,
      errors: [
        `${root}: ${err instanceof Error ? err.message : String(err)}`
      ]
    };
  }
  let bytes = 0;
  const errors = [];
  for (const dir of dirs.filter((d)=>belongsTo(d.path, key))){
    try {
      await deps.removeDir(dir.path);
      bytes += dir.bytes;
    } catch (err) {
      errors.push(`${dir.path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return {
    bytes,
    errors
  };
}
/** `du` of one cargo target. Long enough for a large tree, still bounded. */ const DU_TIMEOUT_MS = 2 * 60 * 1000;
/** `du -sk` of one directory, in bytes; 0 when it cannot be measured. A timeout is a failure. */ export async function measureDirectoryBytes(path, timeoutMs = DU_TIMEOUT_MS) {
  try {
    const out = await commandOutputWithTimeout("du", {
      args: [
        "-sk",
        "--",
        path
      ],
      stdout: "piped",
      stderr: "null",
      timeoutMs
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
 */ async function lastWriteMs(path) {
  let latest = 0;
  for (const sub of [
    "",
    "/debug",
    "/debug/deps",
    "/release/deps"
  ]){
    try {
      const mtime = (await Deno.stat(`${path}${sub}`)).mtime?.getTime() ?? 0;
      latest = Math.max(latest, mtime);
    } catch  {
    // Absent: that profile was never built.
    }
  }
  return latest;
}
/** The real filesystem. */ export const productionEphemeralRootDeps = {
  listTargetDirs: async (root)=>{
    const dirs = [];
    for await (const entry of Deno.readDir(root)){
      if (!entry.isDirectory) continue;
      const path = `${root}/${entry.name}`;
      dirs.push({
        path,
        bytes: await measureDirectoryBytes(path),
        lastWriteMs: await lastWriteMs(path)
      });
    }
    return dirs;
  },
  removeDir: (path)=>Deno.remove(path, {
      recursive: true
    }),
  nowMs: ()=>Date.now()
};
/**
 * The real filesystem, without the measurement (Issue #4743).
 *
 * Target directories are listed by name only: no `du` and no stat, so every
 * entry reports 0 bytes and a last write of 0. That suits a release after one
 * verifier pass, where {@link productionEphemeralRootDeps} would `du` every
 * directory under the shared root. Because nothing is measured, the bytes a
 * release reports are 0. A missing root still rejects with
 * `Deno.errors.NotFound`.
 */ export const unmeasuredEphemeralRootDeps = {
  listTargetDirs: async (root)=>{
    const dirs = [];
    for await (const entry of Deno.readDir(root)){
      if (!entry.isDirectory) continue;
      dirs.push({
        path: `${root}/${entry.name}`,
        bytes: 0,
        lastWriteMs: 0
      });
    }
    return dirs;
  },
  removeDir: productionEphemeralRootDeps.removeDir,
  nowMs: productionEphemeralRootDeps.nowMs
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9oZWF2eV9idWlsZF9nYXRlLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogVGhlIGhvc3QtZGlzayBnYXRlIG9uIGhlYXZ5IGJ1aWxkcyAoSXNzdWUgIzMxNzgpLlxuICpcbiAqICMjIFdoYXQgd2VudCB3cm9uZ1xuICpcbiAqIEdSUS0yMywgMjAyNi0xMC0wMzogbGF1bmNoIGB2aWJlLWNvZGVyLTg3MDA4YCBzdGFydGVkIHdpdGggdGhlIGhvc3RcbiAqIGFscmVhZHkgYmVsb3cgaXRzIGRpc2sgZmxvb3IgKDM4LjggR0IgZnJlZSwgZmxvb3IgNDYuMCBHQikuIFRoZSBjbGFpbSBnYXRlXG4gKiAoSXNzdWUgIzIyNikgZGlkIGl0cyBqb2Ig4oCUIG5vIG5ldyBpc3N1ZSB3YXMgY2xhaW1lZCDigJQgYW5kIGxvZ2dlZFxuICogXCJtYWludGVuYW5jZSBjb250aW51ZXNcIi4gVGhhdCBtYWludGVuYW5jZSBpbmNsdWRlZCBhIG1pbGVzdG9uZSBzeW5jIG9mIGFcbiAqIGxhcmdlIFJ1c3QgcmVwb3NpdG9yeSB3aG9zZSB2ZXJpZmljYXRpb24gYW5kIHR3byBhZ2VudCByZXBhaXIgcm91bmRzIHJhblxuICogYGNhcmdvIGNoZWNrYCBhbmQgYGNhcmdvIHRlc3QgLS13b3Jrc3BhY2VgLiBPbiB0aGF0IHRyaW0tcmVmdXNlZCBydW50aW1lIHRoZVxuICogb3V0cHV0IGdvZXMgdG8gdGhlIGNvbnRhaW5lcidzIGVwaGVtZXJhbCByb290IChJc3N1ZSAjMjI0NyksIGFuZCBpdCByZWFjaGVkXG4gKiAyMyBHQiBpbiAyMyBtaW51dGVzLiBUaGUgaG9zdCBjb3VsZCBub3QgYmFjayB0aGUgZ3Vlc3QncyB3cml0ZXMsIGV4dDRcbiAqIGFib3J0ZWQgaXRzIGpvdXJuYWwgYW5kIGAvYCB3ZW50IHJlYWQtb25seS5cbiAqXG4gKiBTbyB0aGUgZGlzayBnYXRlIHN0b3BwZWQgdGhlIGNoZWFwIHRoaW5nIChhIGNsYWltKSBhbmQgYWxsb3dlZCB0aGVcbiAqIGV4cGVuc2l2ZSB0aGluZyAoYSB3b3Jrc3BhY2Utd2lkZSBidWlsZCBhbmQgdGVzdCkuIFRoaXMgbW9kdWxlIGdhdGVzIHRoZVxuICogZXhwZW5zaXZlIHRoaW5nLlxuICpcbiAqICMjIFdoYXQgdGhpcyBtb2R1bGUgZG9lc1xuICpcbiAqIC0gKipCZWxvdyB0aGUgZmxvb3IsIG5vIG1haW50ZW5hbmNlIGJ1aWxkLioqIHtAbGluayBqdWRnZUhvc3REaXNrRm9yQnVpbGR9XG4gKiAgIGRlZmVycyBhIGJ1aWxkIHdoZW5ldmVyIHRoZSBob3N0LWRpc2sgcmVhZGluZyBpcyBgbG93YCwgYW5kIHNheXMgd2hpY2hcbiAqICAgZmxvb3IuIENoZWFwIG1haW50ZW5hbmNlIOKAlCBBUEkgY2FsbHMsIGZldGNoZXMsIGxhYmVsIHdvcmsg4oCUIG5ldmVyIGFza3MuXG4gKiAtICoqVGhlIGVwaGVtZXJhbCBjYXJnbyByb290IGhhcyBhIGJ1ZGdldC4qKiBXaGVyZSBidWlsZHMgZ28gdG9cbiAqICAgYC92YXIvdG1wL3ZpYmUtY2FyZ28tdGFyZ2V0YCwgYSBidWlsZCBzdGFydHMgb25seSB3aGVuIHRoZSBob3N0IGhhcyB0aGVcbiAqICAgZmxvb3IgKipwbHVzKioge0BsaW5rIEVQSEVNRVJBTF9DQVJHT19IRUFEUk9PTV9CWVRFU30gZnJlZSDigJQgcm9vbSBmb3Igb25lXG4gKiAgIGJ1aWxkIG9mIHRoZSBzaXplIHRoYXQgdG9vayBHUlEtMjMgZG93bi4gU2hvcnQgb2YgdGhhdCwgaWRsZSBjaGVja291dHMnXG4gKiAgIHRhcmdldCBkaXJlY3RvcmllcyBhcmUgcHJ1bmVkIChsYXJnZXN0IGZpcnN0KS4gQSBidWlsZCBzdGlsbCBub3QgY292ZXJlZFxuICogICBhZnRlciBwcnVuaW5nIGlzIG5vdCBydW4sIGFuZCB0aGUgc3luYyBpcyBub3QgZGVmZXJyZWQuIE1lcmdlLW9ubHkgbW9kZVxuICogICAoe0BsaW5rIGhlYXZ5QnVpbGRBZG1pc3Npb259LCBJc3N1ZSAjNDMyNikgYXBwbGllcyB0byBhIHRyZWUgdGhhdCBob2xkcyBhXG4gKiAgIGNhcmdvIHByb2plY3QsIGJlY2F1c2Ugb25seSBhIGNhcmdvIGJ1aWxkIHdyaXRlcyB0byB0aGUgZXBoZW1lcmFsIGNhcmdvXG4gKiAgIHJvb3Q7IGEgcmVwb3NpdG9yeSB3aXRoIG5vIGNhcmdvIHByb2plY3Qga2VlcHMgaXRzIG93biB0eXBlIGNoZWNrIGFuZCB0aGVcbiAqICAgbm9ybWFsIGFnZW50LiB7QGxpbmsgcGFya0luRmxpZ2h0QnVpbGR9IGhvbGRzIHN1Y2ggYSBjaGVja291dCB0byB0aGUgaG9zdFxuICogICBmbG9vciBvbmx5LCBhbmQgcHJ1bmVzIG5vdGhpbmcgZm9yIGl0IChJc3N1ZSAjNDQxMykuIEluIGEgY2FyZ28tb25seSB0cmVlIGEgY29uZmxpY3QtZnJlZSBtZXJnZSBpcyBwdXNoZWRcbiAqICAgdW52ZXJpZmllZCB3aXRoIHRoZSBgVU5HQVRFRDpgIG5vdGUsIGFuZCB0aGUgbWlsZXN0b25lIFBSJ3Mgb3duIENJIGJ1aWxkc1xuICogICBpdC4gU28gaXMgYSBtZXJnZSB3aG9zZSBjb25mbGljdHMgdGhlIGRldGVybWluaXN0aWMgcnVsZXMgc2V0dGxlOiBpdHNcbiAqICAgcmVzb2x1dGlvbiBnYXRlIHJlcG9ydHMgYSBgc2tpcHBlZGAgdmVyZGljdCBtYXJrZWQgYGxhbmRVbnZlcmlmaWVkYCwgd2hpY2hcbiAqICAgaXMgcHVzaGVkIHdpdGggdGhlIHNhbWUgbm90ZS4gQSBEZW5vLW9ubHkgdHJlZSBhbmQgYSBtaXhlZCB0cmVlIGtlZXAgdGhlaXJcbiAqICAgRGVubyBjaGVja3MgYW5kIHN1aXRlcyBhbmQgYXJlIHJvbGxlZCBiYWNrIHdoZW4gdGhvc2UgYXJlIHJlZDsgYSBtaXhlZFxuICogICB0cmVlIHdob3NlIERlbm8gaGFsZiBwYXNzZWQgcmVjb3JkcyB0aGF0IGNhcmdvIHdhcyBsZWZ0IHRvIENJLiBBIGNvbmZsaWN0XG4gKiAgIHRoYXQgbmVlZHMgdGhlIHJlc29sdXRpb24gYWdlbnQgaXMgbm90IGxhbmRlZCBpbiB0aGF0IGN5Y2xlLCBiZWNhdXNlIHRoZVxuICogICBhZ2VudCBpcyBmcmVlIHRvIHJ1biB0aGUgdmVyeSBjYXJnbyBidWlsZCB0aGUgaG9zdCBjYW5ub3QgYWZmb3JkLiBUaGVcbiAqICAgZmlyc3Qgc3VjaCBjeWNsZSBpcyBhIHJlZnVzYWwgYW5kIGlzIG5vdCBjaGFyZ2VkLiBUaGUgbmV4dCBvdmVyLWJ1ZGdldFxuICogICBjeWNsZSBjaGFyZ2VzIHRoZSBhdHRlbXB0LCBzbyB0aGUgcmVjb3ZlcnkgbGFkZGVyIGFwcGxpZXMgYW5kIHRoZSBicmFuY2hcbiAqICAgZG9lcyBub3Qgc3RheSBiZWhpbmQgb24gZGlzayBidWRnZXQgYWxvbmUuXG4gKlxuICogICBObyBmdXJ0aGVyIHJlY2xhaW0gc3RlcCBleGlzdHMuIE9uIGEgcnVudGltZSB0aGF0IHJlZnVzZXMgdGhlIHRyaW0sXG4gKiAgIGRlbGV0aW5nIGFydGVmYWN0cyBpbnNpZGUgdGhlIGd1ZXN0IHJldHVybnMgbm90aGluZyB0byB0aGUgaG9zdFxuICogICAoYGVwaGVtZXJhbF9idWlsZF9jYWNoZS50c2AsIGBqdWRnZUd1ZXN0UmVjbGFpbWAgaW5cbiAqICAgYHdvcmtfdm9sdW1lX3JhdGNoZXQudHNgKSwgc28gdGhlIGVwaGVtZXJhbCByb290J3MgaWRsZSB0YXJnZXQgZGlyZWN0b3JpZXNcbiAqICAgYXJlIHRoZSBvbmx5IHNwYWNlIHRoZSB3b3JrZXIgY2FuIGhhbmQgYmFjay5cbiAqIC0gKipBIHBhc3MgY2xlYW5zIHVwIGFmdGVyIGl0c2VsZi4qKiB7QGxpbmsgcmVsZWFzZUNoZWNrb3V0VGFyZ2V0RGlyc31cbiAqICAgcmVtb3ZlcyBhIGNoZWNrb3V0J3MgdGFyZ2V0IGRpcmVjdG9yaWVzIHdoZW4gdGhlIG1haW50ZW5hbmNlIHBhc3MgdGhhdFxuICogICBidWlsdCBpbiBpdCBmaW5pc2hlcywgcmF0aGVyIHRoYW4gbGVhdmluZyB0aGVtIHRvIHRoZSByZWxhdW5jaC4gVGhlXG4gKiAgIHByZS1QUiB2ZXJpZmllcidzIGRpc3Bvc2FibGUgY2hlY2tvdXQgaXMgcmVsZWFzZWQgdGhlIHNhbWUgd2F5IHdoZW4gdGhlXG4gKiAgIHZlcmlmaWVyIGZpbmlzaGVzIChJc3N1ZSAjNDc0MykuXG4gKlxuICogUHJ1bmluZyBjb3VudHMgd2hhdCBpdCByZW1vdmVzIGFzIHJvb20gZm9yIHRoZSBuZXh0IGJ1aWxkLiBUaGF0IGhvbGRzIGV2ZW5cbiAqIHdoZXJlIHRoZSBydW50aW1lIHJlZnVzZXMgdGhlIHRyaW06IHRoZSBibG9ja3MgYSBndWVzdCBkZWxldGVzIHN0YXlcbiAqIGFsbG9jYXRlZCB0byB0aGUgaW1hZ2UsIGJ1dCB0aGUgZ3Vlc3QgZmlsZXN5c3RlbSByZXVzZXMgdGhlbSwgc28gYSBidWlsZFxuICogd3JpdGluZyBpbnRvIGZyZWVkIHNwYWNlIGRvZXMgbm90IGdyb3cgdGhlIGhvc3QgaW1hZ2UgYWdhaW4uXG4gKlxuICogVGhlIGhvc3QtZGlzayByZWFkaW5nIGNvbWVzIGZyb20gYSBwcm9iZSB0aGUgcHJvZHVjdGlvbiB3aXJpbmcgcmVnaXN0ZXJzXG4gKiAoe0BsaW5rIHJlZ2lzdGVySGVhdnlCdWlsZERpc2tQcm9iZX0pIOKAlCB0aGUgc2FtZSBgSG9zdERpc2tNb25pdG9yYCB0aGUgY2xhaW1cbiAqIGdhdGUgcmVhZHMsIHNvIHRoZSB0d28gZ2F0ZXMgY2FuIG5ldmVyIGRpc2FncmVlIGFib3V0IHRoZSBmbG9vci4gV2l0aCBub1xuICogcHJvYmUgcmVnaXN0ZXJlZCAodGVzdHMsIGFkIGhvYyBjYWxsZXJzKSBub3RoaW5nIGlzIGdhdGVkLCB3aGljaCBpcyB0aGVcbiAqIGRvY3VtZW50ZWQgYHVua25vd25gIGRlZmF1bHQgb2YgSXNzdWUgIzIyNi5cbiAqXG4gKiBJc3N1ZSAjNDM2MDogYSBidWlsZCBhbHJlYWR5IHJ1bm5pbmcgaXMgaGVsZCB0byB0aGUgc2FtZSBmbG9vci4gVGhlIGNsYWltXG4gKiBnYXRlIG9ubHkgc3RvcHMgbmV3IGNsYWltcywgc28ge0BsaW5rIHBhcmtJbkZsaWdodEJ1aWxkfSBjaGVja3MgYWRtaXNzaW9uXG4gKiBiZWZvcmUgYW4gYWdlbnQsIG11dGF0aW9uIG9yIGRpc2NyaW1pbmF0aW9uIGJ1aWxkLiBBIGNoZWNrb3V0IHdpdGggbm8gY2FyZ29cbiAqIHByb2plY3QgaXMgaGVsZCB0byB0aGUgZmxvb3Igb25seSwgYW5kIGl0cyBpZGxlIHNpYmxpbmcgdGFyZ2V0IGRpcmVjdG9yaWVzXG4gKiBhcmUgbm90IHBydW5lZCBmb3IgaXQsIGJlY2F1c2Ugb25seSBjYXJnbyB3cml0ZXMgdG8gdGhlIGVwaGVtZXJhbCBjYXJnbyByb290XG4gKiAoSXNzdWUgIzQ0MTMpLiB7QGxpbmsgcGFya1J1bm5pbmdCdWlsZH1cbiAqIHN0b3BzIGFuIGFjdGl2ZSBwcm9jZXNzIGF0IHRoZSBob3N0IGZsb29yLCBsZXR0aW5nIGl0IGNvbnN1bWUgdGhlIGhlYWRyb29tXG4gKiBhZG1pc3Npb24gcmVxdWlyZWQgKElzc3VlICM0MzkwKS4ge0BsaW5rIGhvc3REaXNrTGF1bmNoU3RvcFJlYXNvbn0gZW5kcyB0aGVcbiAqIGxhdW5jaCB3aGVuIHRoZSB0cmltIHdhcyByZWZ1c2VkIGFuZCB0aGUgaG9zdCBpcyBiZWxvdyB0aGUgZmxvb3Ig4oCUIGV4aXRpbmcgdGhlIGNvbnRhaW5lclxuICogaXMgd2hhdCBkaXNjYXJkcyB0aGUgZXBoZW1lcmFsIGxheWVyIGFuZCBsZXRzIHRoZSBuZXh0IGxhdW5jaCByZWNyZWF0ZSB0aGVcbiAqIHZvbHVtZS4gVGhlIGluLWZsaWdodCBnYXRlIHN0YXlzIG9mZiB1bnRpbCBwcm9kdWN0aW9uIGVuYWJsZXMgaXQsIHNvIGEgdGVzdFxuICogdGhhdCByZWdpc3RlcnMgYSBwcm9iZSBkb2VzIG5vdCBwYXJrIGV2ZXJ5IG90aGVyIHRlc3QgaW4gdGhlIHByb2Nlc3MuXG4gKlxuICogQXVzdHJhbGlhbiBFbmdsaXNoIHNwZWxsaW5nIHRocm91Z2hvdXQgKGJlaGF2aW91ciwgY29sb3VyLCBvcmdhbmlzYXRpb24pLlxuICovXG5cbmltcG9ydCB7IGZvcm1hdEdiLCB0eXBlIEhvc3REaXNrU3RhdHVzIH0gZnJvbSBcIi4vaG9zdF9kaXNrLnRzXCI7XG5pbXBvcnQge1xuICBjb21tYW5kT3V0cHV0V2l0aFRpbWVvdXQsXG4gIGlzQ29tbWFuZFRpbWVvdXRFcnJvcixcbn0gZnJvbSBcIi4vc3VicHJvY2Vzc190aW1lb3V0LnRzXCI7XG5pbXBvcnQge1xuICBjYXJnb1RhcmdldERpckZvckNoZWNrb3V0LFxuICBFUEhFTUVSQUxfQ0FSR09fVEFSR0VUX1JPT1QsXG59IGZyb20gXCIuL2VwaGVtZXJhbF9idWlsZF9jYWNoZS50c1wiO1xuaW1wb3J0IHsgZmluZFByb2plY3RNYW5pZmVzdHMgfSBmcm9tIFwiLi9wcm9qZWN0X21hbmlmZXN0cy50c1wiO1xuXG5jb25zdCBHSUIgPSAxXzA3M183NDFfODI0O1xuXG4vKipcbiAqIEZyZWUgc3BhY2UgYSBidWlsZCBpbnRvIHRoZSBlcGhlbWVyYWwgcm9vdCBuZWVkcyBhYm92ZSB0aGUgaG9zdCBmbG9vci5cbiAqXG4gKiBTaXplZCBmcm9tIHRoZSBpbmNpZGVudDogb25lIG1pbGVzdG9uZSBzeW5jIG9mIGEgbGFyZ2UgUnVzdCB3b3Jrc3BhY2Ugd3JvdGVcbiAqIDIzIEdCIHRoZXJlLiBBIGJ1aWxkIGlzIGxldCBzdGFydCBvbmx5IHdoZW4gdGhlIGhvc3QgY291bGQgYWJzb3JiIGFib3V0XG4gKiB0aGF0IG11Y2ggYW5kIHN0aWxsIHNpdCBhdCBpdHMgZmxvb3IuXG4gKi9cbmV4cG9ydCBjb25zdCBFUEhFTUVSQUxfQ0FSR09fSEVBRFJPT01fQllURVMgPSAyNSAqIEdJQjtcblxuLyoqXG4gKiBBIHRhcmdldCBkaXJlY3Rvcnkgd3JpdHRlbiB0byB3aXRoaW4gdGhpcyB3aW5kb3cgaXMgdHJlYXRlZCBhcyBpbiB1c2UgYnlcbiAqIGFub3RoZXIgc2xvdCdzIGJ1aWxkIGFuZCBpcyBuZXZlciBwcnVuZWQgZnJvbSB1bmRlciBpdC5cbiAqL1xuZXhwb3J0IGNvbnN0IEVQSEVNRVJBTF9UQVJHRVRfSU5fVVNFX01TID0gMjAgKiA2MF8wMDA7XG5cbi8qKiBXaGF0IHRoZSBnYXRlIG5lZWRzIHRvIGtub3cgYWJvdXQgdGhlIGhvc3QuICovXG5leHBvcnQgaW50ZXJmYWNlIEhlYXZ5QnVpbGREaXNrUmVhZGluZyB7XG4gIC8qKiBUaGUgaG9zdC1kaXNrIG1vbml0b3IncyBjdXJyZW50IHN0YXR1cy4gKi9cbiAgc3RhdHVzOiBIb3N0RGlza1N0YXR1cztcbiAgLyoqIFRoZSBmbG9vciBpbiBieXRlcyBmb3IgdGhpcyBob3N0LCB3aGVuIHRoZSB0b3RhbCBpcyBrbm93bi4gKi9cbiAgZmxvb3JCeXRlczogbnVtYmVyIHwgdW5kZWZpbmVkO1xuICAvKiogRGlkIHRoZSBsYXVuY2hlciByZXBvcnQgdGhlIHJ1bnRpbWUgcmVmdXNlcyB0aGUgd29yay12b2x1bWUgdHJpbT8gKi9cbiAgdHJpbVJlZnVzZWQ6IGJvb2xlYW47XG4gIC8qKlxuICAgKiBEaWQgdGhlIGxhdW5jaGVyIGRlY2xpbmUgdG8gcmVjcmVhdGUgdGhlIHdvcmsgdm9sdW1lIHRoaXMgbGF1bmNoLCBiZWNhdXNlXG4gICAqIHRoZSB3b3JrIHZvbHVtZSBkb2VzIG5vdCBob2xkIHRoZSBtaXNzaW5nIHNwYWNlIChJc3N1ZSAjNDQ5OCk/IEFic2VudCByZWFkc1xuICAgKiBhcyBmYWxzZS5cbiAgICovXG4gIHJlY3JlYXRlRGVjbGluZWQ/OiBib29sZWFuO1xuICAvKipcbiAgICogRGlkIHRoZSBsYXVuY2hlciByZWNyZWF0ZSB0aGUgd29yayB2b2x1bWUgdGhpcyBsYXVuY2ggYW5kIGZpbmQgdGhlIGhvc3RcbiAgICogc3RpbGwgYmVsb3cgaXRzIGZsb29yIChJc3N1ZSAjNDQ5OCk/IFRoZSBuZXh0IGxhdW5jaCB3aWxsIG5vdCByZWNyZWF0ZSBpdFxuICAgKiBhZ2FpbiB1bnRpbCB0aGUgZnJlZS1zcGFjZSByZWFkaW5nIG1vdmVzLiBBYnNlbnQgcmVhZHMgYXMgZmFsc2UuXG4gICAqL1xuICByZWNyZWF0ZVVucmVjb3ZlcmVkPzogYm9vbGVhbjtcbiAgLyoqXG4gICAqIFRoZSBsYXJnZXN0IGhvc3QgZGlyZWN0b3JpZXMgdGhlIGxhdW5jaGVyIHJlcG9ydGVkIChJc3N1ZSAjNDQ5OCkuIEFic2VudFxuICAgKiBvciBibGFuayBuYW1lcyBub25lLlxuICAgKi9cbiAgbGFyZ2VzdEhvc3REaXJlY3Rvcmllcz86IHN0cmluZztcbn1cblxuLyoqIE9uZSBkaXJlY3RvcnkgdW5kZXIgdGhlIGVwaGVtZXJhbCBjYXJnbyByb290LiAqL1xuZXhwb3J0IGludGVyZmFjZSBFcGhlbWVyYWxUYXJnZXREaXIge1xuICBwYXRoOiBzdHJpbmc7XG4gIC8qKiBCeXRlcyBpdCBob2xkcy4gKi9cbiAgYnl0ZXM6IG51bWJlcjtcbiAgLyoqIE1vc3QgcmVjZW50IHdyaXRlIHNlZW4gaW4gaXQsIGVwb2NoIG1zLiAqL1xuICBsYXN0V3JpdGVNczogbnVtYmVyO1xufVxuXG4vKiogVGhlIGZpbGVzeXN0ZW0gd29yayBiZWhpbmQgdGhlIGJ1ZGdldCwgaW5qZWN0YWJsZSBmb3IgdGVzdHMuICovXG5leHBvcnQgaW50ZXJmYWNlIEVwaGVtZXJhbFJvb3REZXBzIHtcbiAgbGlzdFRhcmdldERpcnM6IChyb290OiBzdHJpbmcpID0+IFByb21pc2U8RXBoZW1lcmFsVGFyZ2V0RGlyW10+O1xuICByZW1vdmVEaXI6IChwYXRoOiBzdHJpbmcpID0+IFByb21pc2U8dm9pZD47XG4gIG5vd01zOiAoKSA9PiBudW1iZXI7XG59XG5cbi8qKlxuICogU2hvdWxkIGEgaGVhdnkgYnVpbGQgd2FpdCBiZWNhdXNlIHRoZSBob3N0IGlzIGJlbG93IGl0cyBmbG9vcj9cbiAqXG4gKiBAcmV0dXJucyBUaGUgZGVmZXJyYWwgcmVhc29uLCBuYW1pbmcgdGhlIGZsb29yLCBvciBudWxsIHRvIHByb2NlZWQuIEFuXG4gKiAgIGB1bmtub3duYCByZWFkaW5nIG5ldmVyIGRlZmVycyDigJQgYSBibGluZCBwcm9iZSBtdXN0IG5vdCBzdG9wIGV2ZXJ5IGJ1aWxkXG4gKiAgIGluIHRoZSBmbGVldCwgdGhlIHNhbWUgcnVsZSB0aGUgY2xhaW0gZ2F0ZSBmb2xsb3dzLlxuICovXG5leHBvcnQgZnVuY3Rpb24ganVkZ2VIb3N0RGlza0ZvckJ1aWxkKFxuICByZWFkaW5nOiBIZWF2eUJ1aWxkRGlza1JlYWRpbmcsXG4pOiBzdHJpbmcgfCBudWxsIHtcbiAgaWYgKHJlYWRpbmcuc3RhdHVzLmxldmVsICE9PSBcImxvd1wiKSByZXR1cm4gbnVsbDtcbiAgcmV0dXJuIGBob3N0IGRpc2sgYmVsb3cgaXRzIGZsb29yIOKAlCAke3JlYWRpbmcuc3RhdHVzLmRldGFpbH07IGEgYCArXG4gICAgYHJlcG9zaXRvcnkgYnVpbGQgb3IgdGVzdCB3b3VsZCBncm93IGhvc3QgZGlzayBmdXJ0aGVyLCBzbyBpdCB3YWl0cyBgICtcbiAgICBgdW50aWwgdGhlIGhvc3QgcmVjb3ZlcnMgKElzc3VlICMzMTc4KWA7XG59XG5cbi8qKiBUaGUgZGlyZWN0b3J5LW5hbWUgcHJlZml4IGV2ZXJ5IGFjY291bnQncyB0YXJnZXQgZGlyIGZvciBhIGNoZWNrb3V0IGhhcy4gKi9cbmZ1bmN0aW9uIGNoZWNrb3V0S2V5KGNoZWNrb3V0UGF0aDogc3RyaW5nLCByb290OiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBkaXIgPSBjYXJnb1RhcmdldERpckZvckNoZWNrb3V0KGNoZWNrb3V0UGF0aCwgeyByb290IH0pO1xuICByZXR1cm4gZGlyLnNsaWNlKGRpci5sYXN0SW5kZXhPZihcIi9cIikgKyAxKTtcbn1cblxuLyoqIElzIHRoaXMgZGlyZWN0b3J5IG9uZSBvZiB0aGUgY2hlY2tvdXQncyBvd24gKGFueSBhY2NvdW50KT8gKi9cbmZ1bmN0aW9uIGJlbG9uZ3NUbyhwYXRoOiBzdHJpbmcsIGtleTogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGNvbnN0IG5hbWUgPSBwYXRoLnNsaWNlKHBhdGgubGFzdEluZGV4T2YoXCIvXCIpICsgMSk7XG4gIHJldHVybiBuYW1lID09PSBrZXkgfHwgbmFtZS5zdGFydHNXaXRoKGAke2tleX0tYCk7XG59XG5cbi8qKlxuICogUGhyYXNlIGEgZGVmZXJyYWwgY2FycmllcyB3aGVuIHRoZSBtZXJnZSBtYXkgbGFuZCBhbmQgY2FyZ28gbXVzdCBub3QgcnVuXG4gKiAoSXNzdWUgIzQzMjYpLiBDYWxsZXJzIG1hdGNoIGl0IHdpdGgge0BsaW5rIGRlZmVycmFsU2tpcHNDYXJnb0Zvck1lcmdlfS5cbiAqL1xuZXhwb3J0IGNvbnN0IENBUkdPX0JVSUxEX1NLSVBQRURfRk9SX01FUkdFID0gXCJjYXJnbyBidWlsZHMgd2FpdCBmb3IgQ0lcIjtcblxuLyoqIFRoZSBidWRnZXQncyB2ZXJkaWN0IGZvciBvbmUgYnVpbGQuICovXG5leHBvcnQgaW50ZXJmYWNlIENhcmdvQnVkZ2V0VmVyZGljdCB7XG4gIHByb2NlZWQ6IGJvb2xlYW47XG4gIC8qKiBCeXRlcyBwcnVuZWQgb24gdGhlIHdheSB0byB0aGUgdmVyZGljdC4gKi9cbiAgcHJ1bmVkQnl0ZXM6IG51bWJlcjtcbiAgLyoqIE9uZSBsaW5lIGZvciB0aGUgbG9nLiAqL1xuICBkZXRhaWw6IHN0cmluZztcbiAgLyoqXG4gICAqIEZyZWUgc3BhY2UgaXMgYXQgb3IgYWJvdmUgdGhlIGZsb29yIGFuZCBzaG9ydCBvZiBmbG9vciArIGhlYWRyb29tLCBhbmRcbiAgICogcHJ1bmluZyBmcmVlZCBub3RoaW5nLiBDYXJnbyBtdXN0IG5vdCBydW47IGEgbWVyZ2Utb25seSBzeW5jIG1heSBsYW5kXG4gICAqIGFuZCB0aGUgcmVwb3NpdG9yeSdzIENJIGJ1aWxkcyB0aGUgdHJlZSAoSXNzdWUgIzQzMjYpLlxuICAgKi9cbiAgc2tpcENhcmdvQnVpbGQ6IGJvb2xlYW47XG59XG5cbi8qKlxuICogV2hldGhlciBgZGVmZXJyYWxgIGlzIHRoZSBtZXJnZS1vbmx5IGNhcmdvIHNraXAgKElzc3VlICM0MzI2KS5cbiAqXG4gKiBBIHJlYWwgYnVpbGQgc3RpbGwgd2FpdHMuIEEgbWlsZXN0b25lIHN5bmMgdGhhdCBpcyBvbmx5IGEgbWVyZ2UgZG9lcyBub3QuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkZWZlcnJhbFNraXBzQ2FyZ29Gb3JNZXJnZShcbiAgZGVmZXJyYWw6IHN0cmluZyB8IG51bGwsXG4pOiBib29sZWFuIHtcbiAgcmV0dXJuIGRlZmVycmFsICE9PSBudWxsICYmXG4gICAgZGVmZXJyYWwuaW5jbHVkZXMoQ0FSR09fQlVJTERfU0tJUFBFRF9GT1JfTUVSR0UpO1xufVxuXG4vKipcbiAqIEVuZm9yY2UgdGhlIGVwaGVtZXJhbCBjYXJnbyByb290J3MgYnVkZ2V0IGJlZm9yZSBhIGJ1aWxkIGluIGBjaGVja291dFBhdGhgLlxuICpcbiAqIFRoZSBib3VuZCBpcyB0aWVkIHRvIGhvc3QgZnJlZSBzcGFjZTogYSBidWlsZCBtYXkgc3RhcnQgd2hlblxuICogYGZyZWUg4oiSIGhlYWRyb29tIOKJpSBmbG9vcmAuIFNob3J0IG9mIHRoYXQsIG90aGVyIGNoZWNrb3V0cycgaWRsZSB0YXJnZXRcbiAqIGRpcmVjdG9yaWVzIGFyZSByZW1vdmVkLCBsYXJnZXN0IGZpcnN0LCB1bnRpbCB0aGUgc2hvcnRmYWxsIGlzIGNvdmVyZWQ7XG4gKiBzdGlsbCBzaG9ydCwgYHByb2NlZWRgIGlzIGZhbHNlIGFuZCB7QGxpbmsgaGVhdnlCdWlsZEFkbWlzc2lvbn0gdHVybnMgdGhlXG4gKiBzeW5jIGludG8gYSBtZXJnZS1vbmx5IG9uZSAoSXNzdWUgIzQzMjYpLiBUaGUgY2hlY2tvdXQncyBvd24gZGlyZWN0b3JpZXNcbiAqIChpdHMgaW5jcmVtZW50YWwgY2FjaGUpIGFuZCBhbnkgd3JpdHRlbiB0byByZWNlbnRseSAoYW5vdGhlciBzbG90J3MgYnVpbGRcbiAqIGluIHByb2dyZXNzKSBhcmUgbmV2ZXIgcHJ1bmVkLiBXaXRoIGBjcmVkaXRPd25DYWNoZWAsIHRoZSBieXRlcyBhbHJlYWR5IGluXG4gKiB0aGUgY2hlY2tvdXQncyBvd24gZGlyZWN0b3JpZXMgY291bnQgdG93YXJkcyB0aGUgaGVhZHJvb20sIGNhcHBlZCBhdCBpdCwgc29cbiAqIHRoZSBmbG9vciBpdHNlbGYgaXMgbmV2ZXIgcmVsYXhlZCAoSXNzdWUgIzQ0MjMpLiBXaXRoIGBkcnlSdW5gLCBub3RoaW5nIGlzXG4gKiByZW1vdmVkOiB0aGUgdmVyZGljdCBpcyB0aGUgb25lIGEgcmVhbCBydW4gd291bGQgcmVhY2ggaWYgZXZlcnkgcmVtb3ZhbFxuICogc3VjY2VlZGVkIChJc3N1ZSAjNDU0MCwgdGhlIGNsYWltIHNjYW4ncyBxdWVzdGlvbikuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBlbmZvcmNlRXBoZW1lcmFsQ2FyZ29CdWRnZXQoXG4gIGlucHV0OiB7XG4gICAgY2hlY2tvdXRQYXRoOiBzdHJpbmc7XG4gICAgaG9zdEZyZWVCeXRlczogbnVtYmVyO1xuICAgIGZsb29yQnl0ZXM6IG51bWJlcjtcbiAgICBoZWFkcm9vbUJ5dGVzPzogbnVtYmVyO1xuICAgIHJvb3Q/OiBzdHJpbmc7XG4gICAgY3JlZGl0T3duQ2FjaGU/OiBib29sZWFuO1xuICAgIGRyeVJ1bj86IGJvb2xlYW47XG4gIH0sXG4gIGRlcHM6IEVwaGVtZXJhbFJvb3REZXBzLFxuKTogUHJvbWlzZTxDYXJnb0J1ZGdldFZlcmRpY3Q+IHtcbiAgY29uc3Qgcm9vdCA9IGlucHV0LnJvb3QgPz8gRVBIRU1FUkFMX0NBUkdPX1RBUkdFVF9ST09UO1xuICBjb25zdCBoZWFkcm9vbSA9IGlucHV0LmhlYWRyb29tQnl0ZXMgPz8gRVBIRU1FUkFMX0NBUkdPX0hFQURST09NX0JZVEVTO1xuICBjb25zdCBuZWVkZWQgPSBpbnB1dC5mbG9vckJ5dGVzICsgaGVhZHJvb207XG4gIGxldCB0ZXJtcyA9IGAke2Zvcm1hdEdiKGlucHV0Lmhvc3RGcmVlQnl0ZXMpfSBmcmVlLCBmbG9vciBgICtcbiAgICBgJHtmb3JtYXRHYihpbnB1dC5mbG9vckJ5dGVzKX0gKyBoZWFkcm9vbSAke2Zvcm1hdEdiKGhlYWRyb29tKX1gO1xuICBsZXQgc2hvcnRmYWxsID0gbmVlZGVkIC0gaW5wdXQuaG9zdEZyZWVCeXRlcztcbiAgaWYgKHNob3J0ZmFsbCA8PSAwKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHByb2NlZWQ6IHRydWUsXG4gICAgICBwcnVuZWRCeXRlczogMCxcbiAgICAgIHNraXBDYXJnb0J1aWxkOiBmYWxzZSxcbiAgICAgIGRldGFpbDogYHdpdGhpbiBidWRnZXQgKCR7dGVybXN9KWAsXG4gICAgfTtcbiAgfVxuXG4gIGxldCBkaXJzOiBFcGhlbWVyYWxUYXJnZXREaXJbXTtcbiAgdHJ5IHtcbiAgICBkaXJzID0gYXdhaXQgZGVwcy5saXN0VGFyZ2V0RGlycyhyb290KTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHByb2NlZWQ6IGZhbHNlLFxuICAgICAgcHJ1bmVkQnl0ZXM6IDAsXG4gICAgICBza2lwQ2FyZ29CdWlsZDogZmFsc2UsXG4gICAgICBkZXRhaWw6IGBlcGhlbWVyYWwgY2FyZ28gcm9vdCBvdmVyIGJ1ZGdldCAoJHt0ZXJtc30pIGFuZCAke3Jvb3R9IGNvdWxkIGAgK1xuICAgICAgICBgbm90IGJlIHJlYWQgdG8gcHJ1bmUgaXQ6ICR7XG4gICAgICAgICAgZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpXG4gICAgICAgIH0gKElzc3VlICMzMTc4KWAsXG4gICAgfTtcbiAgfVxuXG4gIGNvbnN0IGtleSA9IGNoZWNrb3V0S2V5KGlucHV0LmNoZWNrb3V0UGF0aCwgcm9vdCk7XG4gIGlmIChpbnB1dC5jcmVkaXRPd25DYWNoZSkge1xuICAgIC8vIEEgYnVpbGQgaW50byBhbiBleGlzdGluZyBjYWNoZSBpcyBpbmNyZW1lbnRhbDogd2hhdCBpcyBhbHJlYWR5IHRoZXJlIHdhc1xuICAgIC8vIHBhcnQgb2YgdGhlIGZyb20tc2NyYXRjaCBidWlsZCB0aGUgaGVhZHJvb20gcmVzZXJ2ZXMgKElzc3VlICM0NDIzKS5cbiAgICBjb25zdCBvd24gPSBkaXJzLmZpbHRlcigoZCkgPT4gYmVsb25nc1RvKGQucGF0aCwga2V5KSlcbiAgICAgIC5yZWR1Y2UoKHN1bSwgZCkgPT4gc3VtICsgZC5ieXRlcywgMCk7XG4gICAgY29uc3QgY3JlZGl0ID0gTWF0aC5taW4ob3duLCBoZWFkcm9vbSk7XG4gICAgaWYgKGNyZWRpdCA+IDApIHtcbiAgICAgIHNob3J0ZmFsbCAtPSBjcmVkaXQ7XG4gICAgICB0ZXJtcyArPSBgOyAke2Zvcm1hdEdiKGNyZWRpdCl9IGFscmVhZHkgaW4gdGhpcyBjaGVja291dCdzIGNhY2hlYDtcbiAgICAgIGlmIChzaG9ydGZhbGwgPD0gMCkge1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIHByb2NlZWQ6IHRydWUsXG4gICAgICAgICAgcHJ1bmVkQnl0ZXM6IDAsXG4gICAgICAgICAgc2tpcENhcmdvQnVpbGQ6IGZhbHNlLFxuICAgICAgICAgIGRldGFpbDogYHdpdGhpbiBidWRnZXQgKCR7dGVybXN9KSAoSXNzdWUgIzQ0MjMpYCxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICB9XG4gIH1cbiAgY29uc3Qgbm93ID0gZGVwcy5ub3dNcygpO1xuICBjb25zdCBjYW5kaWRhdGVzID0gZGlyc1xuICAgIC5maWx0ZXIoKGQpID0+ICFiZWxvbmdzVG8oZC5wYXRoLCBrZXkpKVxuICAgIC5maWx0ZXIoKGQpID0+IG5vdyAtIGQubGFzdFdyaXRlTXMgPj0gRVBIRU1FUkFMX1RBUkdFVF9JTl9VU0VfTVMpXG4gICAgLnNvcnQoKGEsIGIpID0+IGIuYnl0ZXMgLSBhLmJ5dGVzKTtcblxuICBsZXQgcHJ1bmVkID0gMDtcbiAgY29uc3QgZmFpbHVyZXM6IHN0cmluZ1tdID0gW107XG4gIGZvciAoY29uc3QgZGlyIG9mIGNhbmRpZGF0ZXMpIHtcbiAgICBpZiAoc2hvcnRmYWxsIDw9IDApIGJyZWFrO1xuICAgIHRyeSB7XG4gICAgICBpZiAoIWlucHV0LmRyeVJ1bikgYXdhaXQgZGVwcy5yZW1vdmVEaXIoZGlyLnBhdGgpO1xuICAgICAgcHJ1bmVkICs9IGRpci5ieXRlcztcbiAgICAgIHNob3J0ZmFsbCAtPSBkaXIuYnl0ZXM7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBmYWlsdXJlcy5wdXNoKFxuICAgICAgICBgJHtkaXIucGF0aH06ICR7ZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpfWAsXG4gICAgICApO1xuICAgIH1cbiAgfVxuICBjb25zdCBwcnVuZWROb3RlID0gYHBydW5lZCAke2Zvcm1hdEdiKHBydW5lZCl9IG9mIGlkbGUgdGFyZ2V0IGRpcnNgICtcbiAgICAoZmFpbHVyZXMubGVuZ3RoID4gMCA/IGA7IGNvdWxkIG5vdCByZW1vdmUgJHtmYWlsdXJlcy5qb2luKFwiLCBcIil9YCA6IFwiXCIpO1xuICBpZiAoc2hvcnRmYWxsIDw9IDApIHtcbiAgICByZXR1cm4ge1xuICAgICAgcHJvY2VlZDogdHJ1ZSxcbiAgICAgIHBydW5lZEJ5dGVzOiBwcnVuZWQsXG4gICAgICBza2lwQ2FyZ29CdWlsZDogZmFsc2UsXG4gICAgICBkZXRhaWw6IGBlcGhlbWVyYWwgY2FyZ28gcm9vdCBiYWNrIHdpdGhpbiBidWRnZXQgKCR7dGVybXN9KSDigJQgYCArXG4gICAgICAgIGAke3BydW5lZE5vdGV9IChJc3N1ZSAjMzE3OClgLFxuICAgIH07XG4gIH1cbiAgLy8gQWJvdmUgdGhlIGZsb29yLCB3aXRoIG5vdGhpbmcgcHJ1bmVkLCBhIG1lcmdlIG11c3Qgbm90IHdhaXQgb24gY2FyZ28uXG4gIC8vIFRoZSBob3N0IHN0YXlzIGF0IG9yIGFib3ZlIGl0cyBmbG9vciBiZWNhdXNlIGNhcmdvIGRvZXMgbm90IHJ1bjsgQ0lcbiAgLy8gYnVpbGRzIHRoZSBtZXJnZWQgdHJlZSAoSXNzdWUgIzQzMjYpLiBBIHBydW5lIHRoYXQgZnJlZWQgc29tZSBieXRlcyBhbmRcbiAgLy8gaXMgc3RpbGwgc2hvcnQga2VlcHMgcmVmdXNpbmcsIHNvIGEgcGFydGlhbCBmcmVlIGNhbm5vdCBzdGFydCBhIGJ1aWxkLlxuICBpZiAocHJ1bmVkID09PSAwICYmIGlucHV0Lmhvc3RGcmVlQnl0ZXMgPj0gaW5wdXQuZmxvb3JCeXRlcykge1xuICAgIHJldHVybiB7XG4gICAgICBwcm9jZWVkOiBmYWxzZSxcbiAgICAgIHBydW5lZEJ5dGVzOiAwLFxuICAgICAgc2tpcENhcmdvQnVpbGQ6IHRydWUsXG4gICAgICBkZXRhaWw6IGBlcGhlbWVyYWwgY2FyZ28gcm9vdCBvdmVyIGJ1ZGdldCAoJHt0ZXJtc30pIOKAlCAke3BydW5lZE5vdGV9IGAgK1xuICAgICAgICBgYW5kICR7Zm9ybWF0R2Ioc2hvcnRmYWxsKX0gaXMgc3RpbGwgc2hvcnQsIHNvIGAgK1xuICAgICAgICBgJHtDQVJHT19CVUlMRF9TS0lQUEVEX0ZPUl9NRVJHRX0gKElzc3VlICMzMTc4IGJ1ZGdldDsgSXNzdWUgIzQzMjYgc2tpcClgLFxuICAgIH07XG4gIH1cbiAgcmV0dXJuIHtcbiAgICBwcm9jZWVkOiBmYWxzZSxcbiAgICBwcnVuZWRCeXRlczogcHJ1bmVkLFxuICAgIHNraXBDYXJnb0J1aWxkOiBmYWxzZSxcbiAgICBkZXRhaWw6IGBlcGhlbWVyYWwgY2FyZ28gcm9vdCBvdmVyIGJ1ZGdldCAoJHt0ZXJtc30pIOKAlCAke3BydW5lZE5vdGV9IGFuZCBgICtcbiAgICAgIGAke2Zvcm1hdEdiKHNob3J0ZmFsbCl9IGlzIHN0aWxsIHNob3J0LCBzbyB0aGUgYnVpbGQgaXMgcmVmdXNlZCBgICtcbiAgICAgIGAoSXNzdWUgIzMxNzgpYCxcbiAgfTtcbn1cblxuLyoqIFRoZSByZWdpc3RlcmVkIHNvdXJjZSBvZiBob3N0LWRpc2sgcmVhZGluZ3MuICovXG5sZXQgcHJvYmU6ICgoKSA9PiBQcm9taXNlPEhlYXZ5QnVpbGREaXNrUmVhZGluZz4pIHwgdW5kZWZpbmVkO1xuXG4vKipcbiAqIFJlZ2lzdGVyIChvciwgd2l0aCB1bmRlZmluZWQsIGNsZWFyKSB3aGVyZSBoZWF2eSBidWlsZHMgcmVhZCB0aGUgaG9zdCBkaXNrXG4gKiBmcm9tLiBQcm9kdWN0aW9uIHJlZ2lzdGVycyB0aGUgcnVuJ3Mgb3duIGBIb3N0RGlza01vbml0b3JgLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVnaXN0ZXJIZWF2eUJ1aWxkRGlza1Byb2JlKFxuICBuZXh0OiAoKCkgPT4gUHJvbWlzZTxIZWF2eUJ1aWxkRGlza1JlYWRpbmc+KSB8IHVuZGVmaW5lZCxcbik6IHZvaWQge1xuICBwcm9iZSA9IG5leHQ7XG59XG5cbi8qKlxuICogV2hhdCBhIG1haW50ZW5hbmNlIHBhc3MgZG9lcyB3aXRoIGEgcmVwb3NpdG9yeSBidWlsZCBvciB0ZXN0IChJc3N1ZSAjNDMyNikuXG4gKlxuICogLSBgYnVpbGRgIOKAlCBydW4gaXQgYXMgdXN1YWwuXG4gKiAtIGBkZWZlcmAg4oCUIHRoZSBob3N0IGlzIGJlbG93IGl0cyBmbG9vcjogbm8gYnVpbGQgYW5kIG5vIG1lcmdlIHRoaXMgY3ljbGVcbiAqICAgKElzc3VlICMzMTc4KS5cbiAqIC0gYG1lcmdlLW9ubHlgIOKAlCB0aGUgZXBoZW1lcmFsIHJvb3QgaXMgc3RpbGwgc2hvcnQgb2YgYnVkZ2V0IGFmdGVyIHBydW5pbmc6XG4gKiAgIGNhcmdvIGJ1aWxkcyB3YWl0IGZvciB0aGUgbWlsZXN0b25lIFBSJ3MgQ0kuIERlbm8gcHJvamVjdHMgcmV0YWluIHRoZWlyXG4gKiAgIG5vcm1hbCB2ZXJpZmljYXRpb24uIFRoZSByZWFzb24gbmFtZXMgdGhlIGJ1ZGdldCB2ZXJkaWN0LlxuICovXG5leHBvcnQgdHlwZSBIZWF2eUJ1aWxkQWRtaXNzaW9uID1cbiAgfCB7IG1vZGU6IFwiYnVpbGRcIiB9XG4gIHwgeyBtb2RlOiBcImRlZmVyXCI7IHJlYXNvbjogc3RyaW5nIH1cbiAgfCB7IG1vZGU6IFwibWVyZ2Utb25seVwiOyByZWFzb246IHN0cmluZyB9O1xuXG4vKipcbiAqIFRoZSBvbmUgY2FsbCBhIG1haW50ZW5hbmNlIHBhc3MgbWFrZXMgYmVmb3JlIGl0IHJ1bnMgYSByZXBvc2l0b3J5IGJ1aWxkIG9yXG4gKiB0ZXN0IGluIGBjaGVja291dFBhdGhgLlxuICpcbiAqIEByZXR1cm5zIEhvdyB0aGUgcGFzcyBwcm9jZWVkczsgc2VlIHtAbGluayBIZWF2eUJ1aWxkQWRtaXNzaW9ufVxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gaGVhdnlCdWlsZEFkbWlzc2lvbihcbiAgY2hlY2tvdXRQYXRoOiBzdHJpbmcsXG4gIGRlcHM6IEVwaGVtZXJhbFJvb3REZXBzID0gcHJvZHVjdGlvbkVwaGVtZXJhbFJvb3REZXBzLFxuICBvcHRpb25zOiB7IGNyZWRpdE93bkNhY2hlPzogYm9vbGVhbiB9ID0ge30sXG4pOiBQcm9taXNlPEhlYXZ5QnVpbGRBZG1pc3Npb24+IHtcbiAgaWYgKHByb2JlID09PSB1bmRlZmluZWQpIHJldHVybiB7IG1vZGU6IFwiYnVpbGRcIiB9O1xuICBjb25zdCByZWFkaW5nID0gYXdhaXQgcHJvYmUoKTtcbiAgY29uc3QgbG93ID0ganVkZ2VIb3N0RGlza0ZvckJ1aWxkKHJlYWRpbmcpO1xuICBpZiAobG93ICE9PSBudWxsKSByZXR1cm4geyBtb2RlOiBcImRlZmVyXCIsIHJlYXNvbjogbG93IH07XG4gIC8vIFRoZSBidWRnZXQgaXMgYWJvdXQgdGhlIGVwaGVtZXJhbCByb290LCB3aGljaCBidWlsZHMgdXNlIG9ubHkgd2hlcmUgdGhlXG4gIC8vIHJ1bnRpbWUgcmVmdXNlcyB0aGUgdHJpbSAoSXNzdWUgIzIyNDcpLlxuICBpZiAoIXJlYWRpbmcudHJpbVJlZnVzZWQpIHJldHVybiB7IG1vZGU6IFwiYnVpbGRcIiB9O1xuICBjb25zdCBmcmVlID0gcmVhZGluZy5zdGF0dXMuYXZhaWxhYmxlQnl0ZXM7XG4gIGlmIChyZWFkaW5nLnN0YXR1cy5sZXZlbCAhPT0gXCJva1wiIHx8IGZyZWUgPT09IHVuZGVmaW5lZCkge1xuICAgIHJldHVybiB7IG1vZGU6IFwiYnVpbGRcIiB9O1xuICB9XG4gIGlmIChyZWFkaW5nLmZsb29yQnl0ZXMgPT09IHVuZGVmaW5lZCkgcmV0dXJuIHsgbW9kZTogXCJidWlsZFwiIH07XG4gIGNvbnN0IHZlcmRpY3QgPSBhd2FpdCBlbmZvcmNlRXBoZW1lcmFsQ2FyZ29CdWRnZXQoe1xuICAgIGNoZWNrb3V0UGF0aCxcbiAgICBob3N0RnJlZUJ5dGVzOiBmcmVlLFxuICAgIGZsb29yQnl0ZXM6IHJlYWRpbmcuZmxvb3JCeXRlcyxcbiAgICBjcmVkaXRPd25DYWNoZTogb3B0aW9ucy5jcmVkaXRPd25DYWNoZSxcbiAgfSwgZGVwcyk7XG4gIGlmICh2ZXJkaWN0LnByb2NlZWQpIHJldHVybiB7IG1vZGU6IFwiYnVpbGRcIiB9O1xuICByZXR1cm4ge1xuICAgIG1vZGU6IFwibWVyZ2Utb25seVwiLFxuICAgIHJlYXNvbjpcbiAgICAgIGAke3ZlcmRpY3QuZGV0YWlsfTsgY2FyZ28gYnVpbGRzIHdhaXQgZm9yIENJOyBEZW5vIHByb2plY3RzIGtlZXAgdGhlaXIgYCArXG4gICAgICBgbm9ybWFsIGNoZWNrcyAoSXNzdWUgIzQzMjYpYCxcbiAgfTtcbn1cblxuLyoqXG4gKiBUaGUgc2VudGVuY2UgYXBwZW5kZWQgd2hlbiBhIGJ1aWxkIGlzIHBhcmtlZCBmb3IgdGhlIGhvc3QgZGlzayAoSXNzdWUgIzQzNjApLlxuICpcbiAqIEJvdGggaG9zdC1mYXVsdCBjbGFzc2lmaWVycyBtYXRjaCBpdCwgYW5kIGl0IGlzIG5vdCBhIHdvcmtlci1nYXRlIG1hcmtlciwgc29cbiAqIHRoZSBpc3N1ZSBpcyBub3QgY2hhcmdlZCBhIGZhaWxlZC1vbmNlIG9yIGEgZ2F0ZSB2ZXJkaWN0LlxuICovXG5leHBvcnQgY29uc3QgSE9TVF9ESVNLX1BBUktfTk9URSA9IFwiUGFya2VkIGFzIGluZnJhc3RydWN0dXJlIChJc3N1ZSAjNDM2MCkuXCI7XG5cbi8qKiBUaGUgZGVmZXJyYWwsIHBsdXMge0BsaW5rIEhPU1RfRElTS19QQVJLX05PVEV9LCBvciBudWxsIHdoZW4gdGhlIGJ1aWxkIG1heSBydW4uICovXG5leHBvcnQgZnVuY3Rpb24gaW5GbGlnaHRQYXJrUmVhc29uKGRlZmVycmFsOiBzdHJpbmcgfCBudWxsKTogc3RyaW5nIHwgbnVsbCB7XG4gIGlmIChkZWZlcnJhbCA9PT0gbnVsbCkgcmV0dXJuIG51bGw7XG4gIHJldHVybiBgJHtkZWZlcnJhbH0gJHtIT1NUX0RJU0tfUEFSS19OT1RFfWA7XG59XG5cbi8qKlxuICogV2hldGhlciB0aGlzIGxhdW5jaCBtdXN0IGVuZCBzbyB0aGUgaG9zdCBnZXRzIGl0cyBzcGFjZSBiYWNrIChJc3N1ZSAjNDM2MCkuXG4gKlxuICogRGVsZXRpbmcgZmlsZXMgaW5zaWRlIGEgdm9sdW1lIHdob3NlIHRyaW0gd2FzIHJlZnVzZWQgZG9lcyBub3QgcmV0dXJuIGhvc3RcbiAqIGJsb2Nrcy4gRW5kaW5nIHRoZSBsYXVuY2ggZGlzY2FyZHMgdGhlIGNvbnRhaW5lcidzIGVwaGVtZXJhbCBsYXllciwgYW5kIHRoZVxuICogbGF1bmNoZXIgdGhlbiBlaXRoZXIgcmVjcmVhdGVzIHRoZSB2b2x1bWUsIGlmIHRoZSBob3N0IGlzIHN0aWxsIGJlbG93IHRoZVxuICogZmxvb3IsIG9yLCB3aGVuIGl0IGRlY2xpbmVkIHRvIHJlY3JlYXRlIG9yIGEgcmVjcmVhdGUgaXQgcmFuIGxlZnQgdGhlIGhvc3RcbiAqIHNob3J0IChJc3N1ZSAjNDQ5OCksIHNheXMgdGhlIG1pc3Npbmcgc3BhY2UgaXMgZWxzZXdoZXJlIG9uIHRoZSBob3N0IChhZnRlciBhXG4gKiBkZWNsaW5lZCByZWNyZWF0ZSBpdCBhZGRzIHRoYXQgbm90aGluZyBpbiB0aGUgd29ya2VyIHdpbGwgZnJlZSBpdCkuIEFib3ZlIHRoZSBmbG9vciwgb3Igd2hlcmUgdGhlIHRyaW0gaXMgaG9ub3VyZWQsIHRoZSBidWlsZCBpcyBwYXJrZWQgYW5kIHRoZSBsYXVuY2hcbiAqIGNvbnRpbnVlczogZnN0cmltIGNhbiByZXR1cm4gdGhlIGJsb2NrcywgYW5kIGEgcmVjcmVhdGUgd291bGQgbm90LlxuICpcbiAqIEByZXR1cm5zIFRoZSByZWFzb24gdG8gZW5kIHRoZSBsYXVuY2gsIG5hbWluZyB0aGUgZmxvb3IsIG9yIG51bGwgdG8gY29udGludWUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBob3N0RGlza0xhdW5jaFN0b3BSZWFzb24oXG4gIHJlYWRpbmc6IEhlYXZ5QnVpbGREaXNrUmVhZGluZyxcbik6IHN0cmluZyB8IG51bGwge1xuICBpZiAocmVhZGluZy5zdGF0dXMubGV2ZWwgIT09IFwibG93XCIgfHwgIXJlYWRpbmcudHJpbVJlZnVzZWQpIHJldHVybiBudWxsO1xuICBjb25zdCBkZWZlcnJhbCA9IGp1ZGdlSG9zdERpc2tGb3JCdWlsZChyZWFkaW5nKTtcbiAgaWYgKGRlZmVycmFsID09PSBudWxsKSByZXR1cm4gbnVsbDtcbiAgaWYgKHJlYWRpbmcucmVjcmVhdGVEZWNsaW5lZCA9PT0gdHJ1ZSkge1xuICAgIGNvbnN0IGxhcmdlc3QgPSByZWFkaW5nLmxhcmdlc3RIb3N0RGlyZWN0b3JpZXM/LnRyaW0oKTtcbiAgICBjb25zdCBkaXJzID0gbGFyZ2VzdCA/IGAgTGFyZ2VzdCBob3N0IGRpcmVjdG9yaWVzOiAke2xhcmdlc3R9LmAgOiBcIlwiO1xuICAgIHJldHVybiBgJHtkZWZlcnJhbH0gVGhlIGxhdW5jaGVyIGRlY2xpbmVkIHRvIHJlY3JlYXRlIHRoZSB3b3JrIHZvbHVtZSBgICtcbiAgICAgIGBiZWNhdXNlIHRoZSB3b3JrIHZvbHVtZSBkb2VzIG5vdCBob2xkIHRoZSBtaXNzaW5nIHNwYWNlOyB0aGUgbWlzc2luZyBgICtcbiAgICAgIGBzcGFjZSBpcyBlbHNld2hlcmUgb24gdGhlIGhvc3QgKHN0YWxlIGJ1aWxkIGNhY2hlcyBvciBjbG9uZXMgb3V0c2lkZSBgICtcbiAgICAgIGB0aGUgd29ya2VyIHZvbHVtZXMpLiR7ZGlyc30gTm90aGluZyBpbiB0aGUgd29ya2VyIHdpbGwgZnJlZSBpdCB1bnRpbCBgICtcbiAgICAgIGB0aGUgaG9zdCBoYXMgcm9vbSwgc28gdGhpcyBsYXVuY2ggZW5kcyBhbmQgdGhlIGVwaGVtZXJhbCBidWlsZCBsYXllciBgICtcbiAgICAgIGBpcyBkaXNjYXJkZWQgKElzc3VlICM0NDk4KS4gJHtIT1NUX0RJU0tfUEFSS19OT1RFfWA7XG4gIH1cbiAgaWYgKHJlYWRpbmcucmVjcmVhdGVVbnJlY292ZXJlZCA9PT0gdHJ1ZSkge1xuICAgIGNvbnN0IGxhcmdlc3QgPSByZWFkaW5nLmxhcmdlc3RIb3N0RGlyZWN0b3JpZXM/LnRyaW0oKTtcbiAgICBjb25zdCBkaXJzID0gbGFyZ2VzdCA/IGAgTGFyZ2VzdCBob3N0IGRpcmVjdG9yaWVzOiAke2xhcmdlc3R9LmAgOiBcIlwiO1xuICAgIHJldHVybiBgJHtkZWZlcnJhbH0gVGhlIGxhdW5jaGVyIHJlY3JlYXRlZCB0aGUgd29yayB2b2x1bWUgdGhpcyBsYXVuY2ggYCArXG4gICAgICBgYW5kIGl0IGRpZCBub3QgcmV0dXJuIHRoZSBtaXNzaW5nIHNwYWNlOyBpdCB3aWxsIG5vdCByZWNyZWF0ZSB0aGUgYCArXG4gICAgICBgdm9sdW1lIGFnYWluIHVudGlsIHRoZSBob3N0J3MgZnJlZS1zcGFjZSByZWFkaW5nIG1vdmVzICh0aGUgbWlzc2luZyBgICtcbiAgICAgIGBzcGFjZSBpcyBlbHNld2hlcmUgb24gdGhlIGhvc3QpLiR7ZGlyc30gVGhpcyBsYXVuY2ggZW5kcyBhbmQgdGhlIGVwaGVtZXJhbCBidWlsZCBsYXllciBpcyBkaXNjYXJkZWQgYCArXG4gICAgICBgKElzc3VlICM0NDk4KS4gJHtIT1NUX0RJU0tfUEFSS19OT1RFfWA7XG4gIH1cbiAgcmV0dXJuIGAke2RlZmVycmFsfSBUaGUgd29yayB2b2x1bWUgdHJpbSB3YXMgcmVmdXNlZCwgc28gdGhpcyBsYXVuY2ggZW5kcyBgICtcbiAgICBgYW5kIHRoZSBlcGhlbWVyYWwgYnVpbGQgbGF5ZXIgaXMgZGlzY2FyZGVkOyB0aGUgbmV4dCBsYXVuY2ggcmVjcmVhdGVzIGAgK1xuICAgIGB0aGUgdm9sdW1lIGlmIHRoZSBob3N0IGlzIHN0aWxsIGJlbG93IHRoZSBmbG9vciAoSXNzdWUgIzQzNjApLiBgICtcbiAgICBgJHtIT1NUX0RJU0tfUEFSS19OT1RFfWA7XG59XG5cbi8qKlxuICogT2ZmIHVudGlsIHByb2R1Y3Rpb24gdHVybnMgaXQgb24uIEEgcHJvY2Vzcy1nbG9iYWwgcHJvYmUgaXMgaG93IHRoZVxuICogbWFpbnRlbmFuY2UgZ2F0ZSBhbHJlYWR5IHJlYWRzIHRoZSBkaXNrOyBlbmFibGluZyB0aGUgaW4tZmxpZ2h0IGNhbGxlcnNcbiAqIG9ubHkgaW4gdGhlIHdvcmtlciBwcm9jZXNzIGtlZXBzIGEgdGVzdCdzIHByb2JlIGZyb20gcGFya2luZyBhbm90aGVyXG4gKiB0ZXN0J3MgYWdlbnQgKGRlbm8gdGVzdCBydW5zIGZpbGVzIGluIHBhcmFsbGVsKS5cbiAqL1xubGV0IGluRmxpZ2h0R2F0ZUVuYWJsZWQgPSBmYWxzZTtcblxuLyoqIEVuYWJsZSBvciBjbGVhciB0aGUgaW4tZmxpZ2h0IGhvc3QtZGlzayBnYXRlIGZvciB0aGlzIHByb2Nlc3MuICovXG5leHBvcnQgZnVuY3Rpb24gZW5hYmxlSW5GbGlnaHRIb3N0RGlza0dhdGUoZW5hYmxlZDogYm9vbGVhbik6IHZvaWQge1xuICBpbkZsaWdodEdhdGVFbmFibGVkID0gZW5hYmxlZDtcbn1cblxuLyoqIFdoZXRoZXIgcHJvZHVjdGlvbiBoYXMgYXJtZWQge0BsaW5rIHBhcmtJbkZsaWdodEJ1aWxkfS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpbkZsaWdodEhvc3REaXNrR2F0ZUVuYWJsZWQoKTogYm9vbGVhbiB7XG4gIHJldHVybiBpbkZsaWdodEdhdGVFbmFibGVkO1xufVxuXG4vKipcbiAqIFdoeSBhIG5ldyBidWlsZCBzdGVwIG11c3Qgbm90IHN0YXJ0IGluIGBjaGVja291dFBhdGhgIChJc3N1ZSAjNDM2MCkuXG4gKlxuICogQSBjaGVja291dCB3aXRoIGEgY2FyZ28gcHJvamVjdCBnZXRzIHRoZSBzYW1lIGZsb29yIGFuZCBlcGhlbWVyYWwgaGVhZHJvb21cbiAqIGFzIHtAbGluayBoZWF2eUJ1aWxkQWRtaXNzaW9ufTogYSBgZGVmZXJgIGFkbWlzc2lvbiAoaG9zdCBiZWxvdyBpdHMgZmxvb3IpXG4gKiBvciBhIGBtZXJnZS1vbmx5YCBhZG1pc3Npb24gKHNob3J0IG9mIHRoZSBoZWFkcm9vbSkgcGFya3MgaXQsIGFuZCB0aGUgYnVkZ2V0XG4gKiBtYXkgcHJ1bmUgaWRsZSBzaWJsaW5nIHRhcmdldCBkaXJlY3RvcmllcyBmb3IgaXQuIEEgY2hlY2tvdXQgd2l0aCBubyBjYXJnb1xuICogcHJvamVjdCBpcyBoZWxkIHRvIHRoZSBob3N0IGZsb29yIG9ubHkgKElzc3VlICM0NDEzKTogb25seSBjYXJnbyB3cml0ZXMgdG9cbiAqIHRoZSBlcGhlbWVyYWwgY2FyZ28gcm9vdCwgc28gdGhlIGJ1ZGdldCBpcyBub3QgY29uc3VsdGVkLCBub3RoaW5nIGlzIHBydW5lZCxcbiAqIGFuZCBpdHMgaWRsZSBzaWJsaW5nIHRhcmdldCBkaXJlY3RvcmllcyBhcmUgbGVmdCBhbG9uZS4gQSBjYXJnbyBjaGVja291dCdzXG4gKiBvd24gY2FjaGUgY291bnRzIHRvd2FyZHMgdGhlIGhlYWRyb29tIChJc3N1ZSAjNDQyMyk6IGEgcnVuIHRoYXQgd2FzIGFkbWl0dGVkXG4gKiBhbmQgYnVpbHQgaXMgbm90IHJlZnVzZWQgYSBsYXRlciBzdGVwIGZvciB0aGUgc3BhY2UgaXRzIG93biBidWlsZCB1c2VkLlxuICogTnVsbCB3aGVuIHRoZSBnYXRlXG4gKiBpcyBub3QgYXJtZWQsIG5vIHByb2JlIGlzIHJlZ2lzdGVyZWQsIG9yIHRoZSBob3N0IGhhcyByb29tLlxuICogQWN0aXZlLXByb2Nlc3Mgd2F0Y2hlcnMgdXNlIHtAbGluayBwYXJrUnVubmluZ0J1aWxkfSBpbnN0ZWFkLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcGFya0luRmxpZ2h0QnVpbGQoXG4gIGNoZWNrb3V0UGF0aDogc3RyaW5nLFxuICBkZXBzOiBFcGhlbWVyYWxSb290RGVwcyA9IHByb2R1Y3Rpb25FcGhlbWVyYWxSb290RGVwcyxcbik6IFByb21pc2U8c3RyaW5nIHwgbnVsbD4ge1xuICBpZiAoIWluRmxpZ2h0R2F0ZUVuYWJsZWQpIHJldHVybiBudWxsO1xuICAvLyBObyBjYXJnbyBwcm9qZWN0OiBvbmx5IHRoZSBob3N0IGZsb29yIGFwcGxpZXMsIGFuZCBub3RoaW5nIGlzIHBydW5lZCAoSXNzdWUgIzQ0MTMpLlxuICBpZiAoIShhd2FpdCBob2xkc0NhcmdvUHJvamVjdChjaGVja291dFBhdGgpKSkgcmV0dXJuIGF3YWl0IHBhcmtSdW5uaW5nQnVpbGQoKTtcbiAgY29uc3QgYWRtaXNzaW9uID0gYXdhaXQgaGVhdnlCdWlsZEFkbWlzc2lvbihjaGVja291dFBhdGgsIGRlcHMsIHtcbiAgICBjcmVkaXRPd25DYWNoZTogdHJ1ZSxcbiAgfSk7XG4gIHJldHVybiBpbkZsaWdodFBhcmtSZWFzb24oXG4gICAgYWRtaXNzaW9uLm1vZGUgPT09IFwiYnVpbGRcIiA/IG51bGwgOiBhZG1pc3Npb24ucmVhc29uLFxuICApO1xufVxuXG4vKipcbiAqIFdoeSBhIG5ldyBjbGFpbSBpbiBgY2hlY2tvdXRQYXRoYCB3b3VsZCBiZSBwYXJrZWQgYXQgb25jZSwgb3IgbnVsbCB0byBjbGFpbVxuICogKElzc3VlICM0NTQwKS5cbiAqXG4gKiBUaGUgY2xhaW0gZ2F0ZSBvcGVucyBhdCB0aGUgaG9zdCBmbG9vciwgYnV0IHtAbGluayBwYXJrSW5GbGlnaHRCdWlsZH1cbiAqIHJlZnVzZXMgYSBjYXJnbyBjaGVja291dCdzIGFnZW50IHVudGlsIHRoZSBmbG9vciBwbHVzIHRoZSBjYXJnbyBoZWFkcm9vbSBpc1xuICogZnJlZS4gSW4gYmV0d2VlbiwgZXZlcnkgY2xhaW0gb24gYSBjYXJnbyByZXBvc2l0b3J5IHdhcyB0YWtlbiwgcGFya2VkIGFuZFxuICogcmVsZWFzZWQsIGFuZCB0YWtlbiBhZ2FpbiBuZXh0IGN5Y2xlLCB3aGlsZSB3b3JrIHRoYXQgY291bGQgcnVuIHdhaXRlZC5cbiAqIFRoaXMgYXNrcyB0aGUgaW4tZmxpZ2h0IHBhcmsncyBvd24gcXVlc3Rpb24gYXMgYSBkcnkgcnVuIOKAlCB0aGUgY2hlY2tvdXQnc1xuICogb3duIGNhY2hlIGlzIGNyZWRpdGVkIGFuZCBpZGxlIHNpYmxpbmdzIGNvdW50IGFzIHBydW5hYmxlLCBidXQgbm90aGluZyBpc1xuICogcmVtb3ZlZCBhdCBzY2FuIHRpbWUuIEEgaG9zdCBiZWxvdyBpdHMgZmxvb3IgaXMgbGVmdCB0byB0aGUgaG9zdC1kaXNrIGNsYWltXG4gKiBnYXRlLCB3aGljaCBhbHJlYWR5IHN0b3BzIGV2ZXJ5IGNsYWltLiBBIGNoZWNrb3V0IHdpdGggbm8gY2FyZ28gcHJvamVjdCxcbiAqIGEgZGlzYXJtZWQgZ2F0ZSBvciBhbiB1bmtub3duIHJlYWRpbmcgbmV2ZXIgZGVmZXJzLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gY2FyZ29DbGFpbURlZmVycmFsKFxuICBjaGVja291dFBhdGg6IHN0cmluZyxcbiAgZGVwczogRXBoZW1lcmFsUm9vdERlcHMgPSBwcm9kdWN0aW9uRXBoZW1lcmFsUm9vdERlcHMsXG4pOiBQcm9taXNlPHN0cmluZyB8IG51bGw+IHtcbiAgaWYgKCFpbkZsaWdodEdhdGVFbmFibGVkIHx8IHByb2JlID09PSB1bmRlZmluZWQpIHJldHVybiBudWxsO1xuICBjb25zdCByZWFkaW5nID0gYXdhaXQgcHJvYmUoKTtcbiAgaWYgKCFyZWFkaW5nLnRyaW1SZWZ1c2VkIHx8IHJlYWRpbmcuc3RhdHVzLmxldmVsICE9PSBcIm9rXCIpIHJldHVybiBudWxsO1xuICBjb25zdCBmcmVlID0gcmVhZGluZy5zdGF0dXMuYXZhaWxhYmxlQnl0ZXM7XG4gIGlmIChmcmVlID09PSB1bmRlZmluZWQgfHwgcmVhZGluZy5mbG9vckJ5dGVzID09PSB1bmRlZmluZWQpIHJldHVybiBudWxsO1xuICBpZiAoIShhd2FpdCBob2xkc0NhcmdvUHJvamVjdChjaGVja291dFBhdGgpKSkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IHZlcmRpY3QgPSBhd2FpdCBlbmZvcmNlRXBoZW1lcmFsQ2FyZ29CdWRnZXQoe1xuICAgIGNoZWNrb3V0UGF0aCxcbiAgICBob3N0RnJlZUJ5dGVzOiBmcmVlLFxuICAgIGZsb29yQnl0ZXM6IHJlYWRpbmcuZmxvb3JCeXRlcyxcbiAgICBjcmVkaXRPd25DYWNoZTogdHJ1ZSxcbiAgICBkcnlSdW46IHRydWUsXG4gIH0sIGRlcHMpO1xuICByZXR1cm4gdmVyZGljdC5wcm9jZWVkID8gbnVsbCA6IHZlcmRpY3QuZGV0YWlsO1xufVxuXG4vKipcbiAqIFRoZSByZXBvc2l0b3JpZXMgd2hvc2UgZXhpc3RpbmcgY2xvbmUge0BsaW5rIGNhcmdvQ2xhaW1EZWZlcnJhbH0gZGVmZXJzLFxuICogZWFjaCB3aXRoIGl0cyByZWFzb24gKElzc3VlICM0NTQwKS4gQSByZXBvc2l0b3J5IG5vdCBjbG9uZWQgeWV0IGlzIGxlZnRcbiAqIGNsYWltYWJsZTogaXRzIGNhcmdvLW5lc3MgaXMgdW5rbm93biwgYW5kIHRoZSBpbi1mbGlnaHQgcGFyayBzdGF5cyB0aGVcbiAqIGJhY2tzdG9wLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gY2FyZ29DbGFpbURlZmVycmVkUmVwb3MoXG4gIHJlcG9zOiByZWFkb25seSBzdHJpbmdbXSxcbiAgY2xvbmVEaXJGb3I6IChyZXBvOiBzdHJpbmcpID0+IHN0cmluZyxcbiAgZGVwczogRXBoZW1lcmFsUm9vdERlcHMgPSBwcm9kdWN0aW9uRXBoZW1lcmFsUm9vdERlcHMsXG4pOiBQcm9taXNlPE1hcDxzdHJpbmcsIHN0cmluZz4+IHtcbiAgY29uc3QgZGVmZXJyZWQgPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nPigpO1xuICBmb3IgKGNvbnN0IHJlcG8gb2YgcmVwb3MpIHtcbiAgICBjb25zdCByZWFzb24gPSBhd2FpdCBjYXJnb0NsYWltRGVmZXJyYWwoY2xvbmVEaXJGb3IocmVwbyksIGRlcHMpO1xuICAgIGlmIChyZWFzb24gIT09IG51bGwpIGRlZmVycmVkLnNldChyZXBvLCByZWFzb24pO1xuICB9XG4gIHJldHVybiBkZWZlcnJlZDtcbn1cblxuLyoqIFdoZXRoZXIgYSBjYXJnbyBwcm9qZWN0IHNpdHMgd2l0aGluIHRoZSBzZWFyY2hlZCBkZXB0aCBvZiBgY2hlY2tvdXRQYXRoYCAoSXNzdWUgIzQ0MTMpLiAqL1xuYXN5bmMgZnVuY3Rpb24gaG9sZHNDYXJnb1Byb2plY3QoY2hlY2tvdXRQYXRoOiBzdHJpbmcpOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgLy8gVW5yZWFkYWJsZSBjaGVja291dDogbm8gbWFuaWZlc3QsIGFuZCB0aGUgYWdlbnQgY291bGQgbm90IHJ1biB0aGVyZSBlaXRoZXIuXG4gIHJldHVybiAoYXdhaXQgZmluZFByb2plY3RNYW5pZmVzdHMoY2hlY2tvdXRQYXRoKSkuc29tZSgocHJvamVjdCkgPT5cbiAgICBwcm9qZWN0LmtpbmQgPT09IFwiY2FyZ29cIlxuICApO1xufVxuXG4vKipcbiAqIFN0b3AgYW4gYWN0aXZlIHByb2Nlc3Mgb25seSBhdCB0aGUgaG9zdCBmbG9vciAoSXNzdWUgIzQzOTApLlxuICpcbiAqIFRoZSBmdWxsIGhlYWRyb29tIGlzIHJlcXVpcmVkIGJlZm9yZSBzdGFydGluZywgdGhlbiBtYXkgYmUgY29uc3VtZWQ6XG4gKiByZS1hcHBseWluZyBpdCB3aGlsZSBydW5uaW5nIGtpbGxlZCBhZG1pdHRlZCBidWlsZHMgYWZ0ZXIgdGhlaXIgZmlyc3QgZmV3XG4gKiBnaWdhYnl0ZXMuIFBvbGwgdGhlIHNhbWUgbGl2ZSBtb25pdG9yIHdpdGhvdXQgcHJ1bmluZyBvdGhlciBjaGVja291dHMgb3JcbiAqIGRlbWFuZGluZyBhbm90aGVyIGNvbXBsZXRlIGJ1aWxkJ3MgaGVhZHJvb20uIEFuIHVua25vd24gcmVhZGluZyByZXRhaW5zXG4gKiB0aGUgZXhpc3RpbmcgZ2F0ZSBwb2xpY3k7IGEga25vd24gbG93IHJlYWRpbmcgc3RpbGwgc3RvcHMgdGhlIHByb2Nlc3MuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBwYXJrUnVubmluZ0J1aWxkKCk6IFByb21pc2U8c3RyaW5nIHwgbnVsbD4ge1xuICBpZiAoIWluRmxpZ2h0R2F0ZUVuYWJsZWQgfHwgcHJvYmUgPT09IHVuZGVmaW5lZCkgcmV0dXJuIG51bGw7XG4gIHJldHVybiBpbkZsaWdodFBhcmtSZWFzb24oanVkZ2VIb3N0RGlza0ZvckJ1aWxkKGF3YWl0IHByb2JlKCkpKTtcbn1cblxuLyoqXG4gKiBXaGV0aGVyIGNhcmdvIG11c3Qgbm90IHJ1biBmb3IgYGNoZWNrb3V0UGF0aGAgKElzc3VlICM0MzI2KS5cbiAqXG4gKiBUcnVlIG9ubHkgd2hlbiB0aGUgaG9zdCBpcyBhYm92ZSBpdHMgZmxvb3IsIHRoZSBydW50aW1lIHJlZnVzZXMgdGhlIHRyaW0sXG4gKiBhbmQgcHJ1bmluZyBpZGxlIHRhcmdldCBkaXJlY3RvcmllcyBmcmVlZCBub3RoaW5nLiBObyByZWdpc3RlcmVkIHByb2JlXG4gKiAodGVzdHMsIGFkIGhvYyBjYWxsZXJzKSBuZXZlciBza2lwcy5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHNob3VsZFNraXBFcGhlbWVyYWxDYXJnb0J1aWxkKFxuICBjaGVja291dFBhdGg6IHN0cmluZyxcbiAgZGVwczogRXBoZW1lcmFsUm9vdERlcHMgPSBwcm9kdWN0aW9uRXBoZW1lcmFsUm9vdERlcHMsXG4pOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgaWYgKHByb2JlID09PSB1bmRlZmluZWQpIHJldHVybiBmYWxzZTtcbiAgY29uc3QgcmVhZGluZyA9IGF3YWl0IHByb2JlKCk7XG4gIGlmIChqdWRnZUhvc3REaXNrRm9yQnVpbGQocmVhZGluZykgIT09IG51bGwpIHJldHVybiBmYWxzZTtcbiAgaWYgKCFyZWFkaW5nLnRyaW1SZWZ1c2VkKSByZXR1cm4gZmFsc2U7XG4gIGNvbnN0IGZyZWUgPSByZWFkaW5nLnN0YXR1cy5hdmFpbGFibGVCeXRlcztcbiAgaWYgKHJlYWRpbmcuc3RhdHVzLmxldmVsICE9PSBcIm9rXCIgfHwgZnJlZSA9PT0gdW5kZWZpbmVkKSByZXR1cm4gZmFsc2U7XG4gIGlmIChyZWFkaW5nLmZsb29yQnl0ZXMgPT09IHVuZGVmaW5lZCkgcmV0dXJuIGZhbHNlO1xuICBjb25zdCB2ZXJkaWN0ID0gYXdhaXQgZW5mb3JjZUVwaGVtZXJhbENhcmdvQnVkZ2V0KHtcbiAgICBjaGVja291dFBhdGgsXG4gICAgaG9zdEZyZWVCeXRlczogZnJlZSxcbiAgICBmbG9vckJ5dGVzOiByZWFkaW5nLmZsb29yQnl0ZXMsXG4gIH0sIGRlcHMpO1xuICByZXR1cm4gdmVyZGljdC5za2lwQ2FyZ29CdWlsZDtcbn1cblxuLyoqIFdoYXQge0BsaW5rIHJlbGVhc2VDaGVja291dFRhcmdldERpcnN9IHJlbW92ZWQuICovXG5leHBvcnQgaW50ZXJmYWNlIFJlbGVhc2VkVGFyZ2V0RGlycyB7XG4gIGJ5dGVzOiBudW1iZXI7XG4gIGVycm9yczogc3RyaW5nW107XG59XG5cbi8qKlxuICogUmVtb3ZlIGV2ZXJ5IGFjY291bnQncyBlcGhlbWVyYWwgdGFyZ2V0IGRpcmVjdG9yeSBmb3Igb25lIGNoZWNrb3V0LCBvbmNlXG4gKiB0aGUgcGFzcyB0aGF0IGJ1aWx0IGluIGl0IGhhcyBmaW5pc2hlZC5cbiAqXG4gKiBCZXN0LWVmZm9ydDogYSBkaXJlY3RvcnkgdGhlIHdvcmtlcidzIGFjY291bnQgY2Fubm90IHJlbW92ZSAoYW5vdGhlclxuICogYWNjb3VudCdzLCB1bmRlciB0aGUgc3RpY2t5IHJvb3QpIGlzIHJlcG9ydGVkLCBub3QgZmF0YWwuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZWxlYXNlQ2hlY2tvdXRUYXJnZXREaXJzKFxuICBjaGVja291dFBhdGg6IHN0cmluZyxcbiAgZGVwczogRXBoZW1lcmFsUm9vdERlcHMgPSBwcm9kdWN0aW9uRXBoZW1lcmFsUm9vdERlcHMsXG4gIHJvb3Q6IHN0cmluZyA9IEVQSEVNRVJBTF9DQVJHT19UQVJHRVRfUk9PVCxcbik6IFByb21pc2U8UmVsZWFzZWRUYXJnZXREaXJzPiB7XG4gIGNvbnN0IGtleSA9IGNoZWNrb3V0S2V5KGNoZWNrb3V0UGF0aCwgcm9vdCk7XG4gIGxldCBkaXJzOiBFcGhlbWVyYWxUYXJnZXREaXJbXTtcbiAgdHJ5IHtcbiAgICBkaXJzID0gYXdhaXQgZGVwcy5saXN0VGFyZ2V0RGlycyhyb290KTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgLy8gTm8gcm9vdCB5ZXQgbWVhbnMgbm90aGluZyB3YXMgYnVpbHQgdGhlcmUuIEFueSBvdGhlciBmYWlsdXJlIOKAlCBhIGBkdWBcbiAgICAvLyB0aGF0IHRpbWVkIG91dCBhbW9uZyB0aGVtIOKAlCBsZWZ0IHRoaXMgY2hlY2tvdXQncyBkaXJzIGluIHBsYWNlLCBhbmRcbiAgICAvLyBzYXlpbmcgc28gaXMgd2hhdCBrZWVwcyBhIGxlYWsgb24gdGhlIGRpc2sgZmxvb3IgdmlzaWJsZS5cbiAgICBpZiAoZXJyIGluc3RhbmNlb2YgRGVuby5lcnJvcnMuTm90Rm91bmQpIHJldHVybiB7IGJ5dGVzOiAwLCBlcnJvcnM6IFtdIH07XG4gICAgcmV0dXJuIHtcbiAgICAgIGJ5dGVzOiAwLFxuICAgICAgZXJyb3JzOiBbYCR7cm9vdH06ICR7ZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpfWBdLFxuICAgIH07XG4gIH1cbiAgbGV0IGJ5dGVzID0gMDtcbiAgY29uc3QgZXJyb3JzOiBzdHJpbmdbXSA9IFtdO1xuICBmb3IgKGNvbnN0IGRpciBvZiBkaXJzLmZpbHRlcigoZCkgPT4gYmVsb25nc1RvKGQucGF0aCwga2V5KSkpIHtcbiAgICB0cnkge1xuICAgICAgYXdhaXQgZGVwcy5yZW1vdmVEaXIoZGlyLnBhdGgpO1xuICAgICAgYnl0ZXMgKz0gZGlyLmJ5dGVzO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgZXJyb3JzLnB1c2goXG4gICAgICAgIGAke2Rpci5wYXRofTogJHtlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycil9YCxcbiAgICAgICk7XG4gICAgfVxuICB9XG4gIHJldHVybiB7IGJ5dGVzLCBlcnJvcnMgfTtcbn1cblxuLyoqIGBkdWAgb2Ygb25lIGNhcmdvIHRhcmdldC4gTG9uZyBlbm91Z2ggZm9yIGEgbGFyZ2UgdHJlZSwgc3RpbGwgYm91bmRlZC4gKi9cbmNvbnN0IERVX1RJTUVPVVRfTVMgPSAyICogNjAgKiAxMDAwO1xuXG4vKiogYGR1IC1za2Agb2Ygb25lIGRpcmVjdG9yeSwgaW4gYnl0ZXM7IDAgd2hlbiBpdCBjYW5ub3QgYmUgbWVhc3VyZWQuIEEgdGltZW91dCBpcyBhIGZhaWx1cmUuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbWVhc3VyZURpcmVjdG9yeUJ5dGVzKFxuICBwYXRoOiBzdHJpbmcsXG4gIHRpbWVvdXRNczogbnVtYmVyID0gRFVfVElNRU9VVF9NUyxcbik6IFByb21pc2U8bnVtYmVyPiB7XG4gIHRyeSB7XG4gICAgY29uc3Qgb3V0ID0gYXdhaXQgY29tbWFuZE91dHB1dFdpdGhUaW1lb3V0KFwiZHVcIiwge1xuICAgICAgYXJnczogW1wiLXNrXCIsIFwiLS1cIiwgcGF0aF0sXG4gICAgICBzdGRvdXQ6IFwicGlwZWRcIixcbiAgICAgIHN0ZGVycjogXCJudWxsXCIsXG4gICAgICB0aW1lb3V0TXMsXG4gICAgfSk7XG4gICAgY29uc3Qga2IgPSBOdW1iZXIucGFyc2VJbnQobmV3IFRleHREZWNvZGVyKCkuZGVjb2RlKG91dC5zdGRvdXQpLCAxMCk7XG4gICAgcmV0dXJuIE51bWJlci5pc0Zpbml0ZShrYikgPyBrYiAqIDEwMjQgOiAwO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGlmIChpc0NvbW1hbmRUaW1lb3V0RXJyb3IoZXJyb3IpKSB0aHJvdyBlcnJvcjtcbiAgICByZXR1cm4gMDtcbiAgfVxufVxuXG4vKipcbiAqIFRoZSBsYXRlc3Qgd3JpdGUgc2VlbiBpbiBhIHRhcmdldCBkaXI6IHRoZSBkaXIgaXRzZWxmIGFuZCB0aGUgYGRlcHNgXG4gKiBkaXJlY3RvcmllcyBjYXJnbyBhZGRzIGFuIGFydGVmYWN0IHRvIG9uIGV2ZXJ5IGNvbXBpbGVkIGNyYXRlLlxuICovXG5hc3luYyBmdW5jdGlvbiBsYXN0V3JpdGVNcyhwYXRoOiBzdHJpbmcpOiBQcm9taXNlPG51bWJlcj4ge1xuICBsZXQgbGF0ZXN0ID0gMDtcbiAgZm9yIChjb25zdCBzdWIgb2YgW1wiXCIsIFwiL2RlYnVnXCIsIFwiL2RlYnVnL2RlcHNcIiwgXCIvcmVsZWFzZS9kZXBzXCJdKSB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IG10aW1lID0gKGF3YWl0IERlbm8uc3RhdChgJHtwYXRofSR7c3VifWApKS5tdGltZT8uZ2V0VGltZSgpID8/IDA7XG4gICAgICBsYXRlc3QgPSBNYXRoLm1heChsYXRlc3QsIG10aW1lKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIEFic2VudDogdGhhdCBwcm9maWxlIHdhcyBuZXZlciBidWlsdC5cbiAgICB9XG4gIH1cbiAgcmV0dXJuIGxhdGVzdDtcbn1cblxuLyoqIFRoZSByZWFsIGZpbGVzeXN0ZW0uICovXG5leHBvcnQgY29uc3QgcHJvZHVjdGlvbkVwaGVtZXJhbFJvb3REZXBzOiBFcGhlbWVyYWxSb290RGVwcyA9IHtcbiAgbGlzdFRhcmdldERpcnM6IGFzeW5jIChyb290OiBzdHJpbmcpID0+IHtcbiAgICBjb25zdCBkaXJzOiBFcGhlbWVyYWxUYXJnZXREaXJbXSA9IFtdO1xuICAgIGZvciBhd2FpdCAoY29uc3QgZW50cnkgb2YgRGVuby5yZWFkRGlyKHJvb3QpKSB7XG4gICAgICBpZiAoIWVudHJ5LmlzRGlyZWN0b3J5KSBjb250aW51ZTtcbiAgICAgIGNvbnN0IHBhdGggPSBgJHtyb290fS8ke2VudHJ5Lm5hbWV9YDtcbiAgICAgIGRpcnMucHVzaCh7XG4gICAgICAgIHBhdGgsXG4gICAgICAgIGJ5dGVzOiBhd2FpdCBtZWFzdXJlRGlyZWN0b3J5Qnl0ZXMocGF0aCksXG4gICAgICAgIGxhc3RXcml0ZU1zOiBhd2FpdCBsYXN0V3JpdGVNcyhwYXRoKSxcbiAgICAgIH0pO1xuICAgIH1cbiAgICByZXR1cm4gZGlycztcbiAgfSxcbiAgcmVtb3ZlRGlyOiAocGF0aDogc3RyaW5nKSA9PiBEZW5vLnJlbW92ZShwYXRoLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KSxcbiAgbm93TXM6ICgpID0+IERhdGUubm93KCksXG59O1xuXG4vKipcbiAqIFRoZSByZWFsIGZpbGVzeXN0ZW0sIHdpdGhvdXQgdGhlIG1lYXN1cmVtZW50IChJc3N1ZSAjNDc0MykuXG4gKlxuICogVGFyZ2V0IGRpcmVjdG9yaWVzIGFyZSBsaXN0ZWQgYnkgbmFtZSBvbmx5OiBubyBgZHVgIGFuZCBubyBzdGF0LCBzbyBldmVyeVxuICogZW50cnkgcmVwb3J0cyAwIGJ5dGVzIGFuZCBhIGxhc3Qgd3JpdGUgb2YgMC4gVGhhdCBzdWl0cyBhIHJlbGVhc2UgYWZ0ZXIgb25lXG4gKiB2ZXJpZmllciBwYXNzLCB3aGVyZSB7QGxpbmsgcHJvZHVjdGlvbkVwaGVtZXJhbFJvb3REZXBzfSB3b3VsZCBgZHVgIGV2ZXJ5XG4gKiBkaXJlY3RvcnkgdW5kZXIgdGhlIHNoYXJlZCByb290LiBCZWNhdXNlIG5vdGhpbmcgaXMgbWVhc3VyZWQsIHRoZSBieXRlcyBhXG4gKiByZWxlYXNlIHJlcG9ydHMgYXJlIDAuIEEgbWlzc2luZyByb290IHN0aWxsIHJlamVjdHMgd2l0aFxuICogYERlbm8uZXJyb3JzLk5vdEZvdW5kYC5cbiAqL1xuZXhwb3J0IGNvbnN0IHVubWVhc3VyZWRFcGhlbWVyYWxSb290RGVwczogRXBoZW1lcmFsUm9vdERlcHMgPSB7XG4gIGxpc3RUYXJnZXREaXJzOiBhc3luYyAocm9vdDogc3RyaW5nKSA9PiB7XG4gICAgY29uc3QgZGlyczogRXBoZW1lcmFsVGFyZ2V0RGlyW10gPSBbXTtcbiAgICBmb3IgYXdhaXQgKGNvbnN0IGVudHJ5IG9mIERlbm8ucmVhZERpcihyb290KSkge1xuICAgICAgaWYgKCFlbnRyeS5pc0RpcmVjdG9yeSkgY29udGludWU7XG4gICAgICBkaXJzLnB1c2goeyBwYXRoOiBgJHtyb290fS8ke2VudHJ5Lm5hbWV9YCwgYnl0ZXM6IDAsIGxhc3RXcml0ZU1zOiAwIH0pO1xuICAgIH1cbiAgICByZXR1cm4gZGlycztcbiAgfSxcbiAgcmVtb3ZlRGlyOiBwcm9kdWN0aW9uRXBoZW1lcmFsUm9vdERlcHMucmVtb3ZlRGlyLFxuICBub3dNczogcHJvZHVjdGlvbkVwaGVtZXJhbFJvb3REZXBzLm5vd01zLFxufTtcbiJdLCJuYW1lcyI6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
// denoCacheMetadata=13786209099552580303,18349580885355142268