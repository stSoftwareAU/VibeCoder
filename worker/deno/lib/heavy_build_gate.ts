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
 *   target directories are pruned (largest first); a build that is still not
 *   covered is refused ({@link enforceEphemeralCargoBudget}).
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
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { formatGb, type HostDiskStatus } from "./host_disk.ts";
import {
  cargoTargetDirForCheckout,
  EPHEMERAL_CARGO_TARGET_ROOT,
} from "./ephemeral_build_cache.ts";

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

/** The budget's verdict for one build. */
export interface CargoBudgetVerdict {
  proceed: boolean;
  /** Bytes pruned on the way to the verdict. */
  prunedBytes: number;
  /** One line for the log. */
  detail: string;
}

/**
 * Enforce the ephemeral cargo root's budget before a build in `checkoutPath`.
 *
 * The bound is tied to host free space: a build may start when
 * `free − headroom ≥ floor`. Short of that, other checkouts' idle target
 * directories are removed, largest first, until the shortfall is covered;
 * still short, the build is refused. The checkout's own directories (its
 * incremental cache) and any written to recently (another slot's build in
 * progress) are never pruned.
 */
export async function enforceEphemeralCargoBudget(
  input: {
    checkoutPath: string;
    hostFreeBytes: number;
    floorBytes: number;
    headroomBytes?: number;
    root?: string;
  },
  deps: EphemeralRootDeps,
): Promise<CargoBudgetVerdict> {
  const root = input.root ?? EPHEMERAL_CARGO_TARGET_ROOT;
  const headroom = input.headroomBytes ?? EPHEMERAL_CARGO_HEADROOM_BYTES;
  const needed = input.floorBytes + headroom;
  const terms = `${formatGb(input.hostFreeBytes)} free, floor ` +
    `${formatGb(input.floorBytes)} + headroom ${formatGb(headroom)}`;
  let shortfall = needed - input.hostFreeBytes;
  if (shortfall <= 0) {
    return {
      proceed: true,
      prunedBytes: 0,
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
      detail: `ephemeral cargo root over budget (${terms}) and ${root} could ` +
        `not be read to prune it: ${
          err instanceof Error ? err.message : String(err)
        } (Issue #3178)`,
    };
  }

  const key = checkoutKey(input.checkoutPath, root);
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
      await deps.removeDir(dir.path);
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
      detail: `ephemeral cargo root back within budget (${terms}) — ` +
        `${prunedNote} (Issue #3178)`,
    };
  }
  return {
    proceed: false,
    prunedBytes: pruned,
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
 * The one call a maintenance pass makes before it runs a repository build or
 * test in `checkoutPath`.
 *
 * @returns Why the build must wait, or null to proceed.
 */
export async function heavyBuildDeferral(
  checkoutPath: string,
  deps: EphemeralRootDeps = productionEphemeralRootDeps,
): Promise<string | null> {
  if (probe === undefined) return null;
  const reading = await probe();
  const low = judgeHostDiskForBuild(reading);
  if (low !== null) return low;
  // The budget is about the ephemeral root, which builds use only where the
  // runtime refuses the trim (Issue #2247).
  if (!reading.trimRefused) return null;
  const free = reading.status.availableBytes;
  if (reading.status.level !== "ok" || free === undefined) return null;
  if (reading.floorBytes === undefined) return null;
  const verdict = await enforceEphemeralCargoBudget({
    checkoutPath,
    hostFreeBytes: free,
    floorBytes: reading.floorBytes,
  }, deps);
  return verdict.proceed ? null : verdict.detail;
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
  } catch {
    // No root yet means nothing was built there.
    return { bytes: 0, errors: [] };
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

/** `du -sk` of one directory, in bytes; 0 when it cannot be measured. */
async function duBytes(path: string): Promise<number> {
  try {
    const out = await new Deno.Command("du", {
      args: ["-sk", "--", path],
      stdout: "piped",
      stderr: "null",
    }).output();
    const kb = Number.parseInt(new TextDecoder().decode(out.stdout), 10);
    return Number.isFinite(kb) ? kb * 1024 : 0;
  } catch {
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
        bytes: await duBytes(path),
        lastWriteMs: await lastWriteMs(path),
      });
    }
    return dirs;
  },
  removeDir: (path: string) => Deno.remove(path, { recursive: true }),
  nowMs: () => Date.now(),
};
