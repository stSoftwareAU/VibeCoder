/**
 * Build artefacts on the ephemeral container layer (Issue #2247).
 *
 * ## What went wrong
 *
 * GRQ-23 runs Apple `container`, whose runtime refuses FITRIM on the work
 * volume (Issue #478). The volume is a thin-provisioned sparse image: every
 * block a `cargo build` touches is allocated to the image on the host and is
 * **never returned** when the guest deletes it, because the discard the guest
 * issues is refused. So a `target/` inside a checkout ratchets the image by
 * everything every build ever wrote — 22 GB of host image for 6.4 GB of live
 * guest data on 2026-09-16, growing 15–20 GB an hour through a Rust-heavy
 * cycle, and 16 GB of that was one `target/` in the shared clone the
 * merge-conflict pass builds in. The worker then correctly stopped claiming
 * below the host floor, the launcher recreated the volume, every repository
 * re-cloned, and the next cycle did it again: 20–30 idle minutes an hour and
 * a cold cache every launch.
 *
 * `judgeGuestReclaim` (`work_volume_ratchet.ts`) already knows deleting the
 * artefacts inside the guest returns nothing. Nothing stopped them being
 * *written* to the persistent image in the first place.
 *
 * ## What this module does
 *
 * The container's own writable layer is **ephemeral** — its host allocation
 * (`containers/<id>`, 11–12 GB mid-cycle) is released at every relaunch — so
 * churn placed there costs nothing across cycles. When the launcher reports
 * `workVolumeTrimRefused` (host-disk.json, Issue #2077), the worker points
 * `CARGO_TARGET_DIR` at {@link EPHEMERAL_CARGO_TARGET_ROOT} on that layer for
 * every subprocess it runs against a checkout: the agent, the repository's
 * own quality gate, the milestone merge gate and the milestone resolution
 * gate. The persistent volume then keeps only clones, worktrees and state,
 * and the `Work volume:` telemetry's "build artefacts" figure reads 0.
 *
 * Two properties matter and are pinned by tests:
 *
 * - **One directory per checkout.** Cargo takes a file lock on the target
 *   directory for the whole build, so a single shared directory would
 *   serialise two slots' Rust builds. The key is derived from the checkout
 *   path, which covers a lane worktree (`worktrees/<slot>/<repo>`) and the
 *   shared clone (`<work root>/<repo>`) the maintenance passes use alike.
 * - **Nothing changes where the trim is honoured.** On a runtime that returns
 *   the blocks, the env is untouched and builds stay incremental across
 *   cycles exactly as before.
 *
 * Incremental builds are lost at relaunch. They were lost at every volume
 * recreate anyway — and a recreate now happens only when live data outgrows
 * the floor, not every cycle.
 *
 * The cargo *registry* cache (`CARGO_HOME`) and the Deno cache (`DENO_DIR`)
 * are deliberately left where the entrypoint puts them: they are bounded,
 * they were measured off the volume on the affected host, and moving them
 * would buy a cold download every launch for space that is not the ratchet.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { HOST_DISK_REFRESH_FILE, parseHostDiskRefresh } from "./host_disk.ts";

/**
 * Where build artefacts go on a trim-refused runtime.
 *
 * `/var/tmp` is on the container's own root filesystem — a separate sparse
 * image, ephemeral per container — not on the `vibe-work` volume. That
 * dialect (Apple `container`) takes no tmpfs and runs with a writable root,
 * which is exactly why the space comes back for free at every relaunch.
 */
export const EPHEMERAL_CARGO_TARGET_ROOT = "/var/tmp/vibe-cargo-target";

/** How much of the checkout's own name is kept in the directory key. */
const NAME_KEY_MAX = 40;

/**
 * A stable 32-bit FNV-1a digest of a string, as 8 hex characters.
 *
 * Not a security primitive — it only has to separate two checkouts. A
 * collision would give two checkouts one target directory, which cargo's own
 * lock makes slow rather than wrong.
 */
function shortDigest(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    // FNV prime, 32-bit, via Math.imul so the multiply stays exact.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Strip trailing and duplicated separators so one checkout has one key. */
function normaliseCheckoutPath(checkoutPath: string): string {
  return checkoutPath.trim().replace(/\/+/g, "/").replace(/\/+$/, "");
}

/** How a target directory is keyed. */
export interface CargoTargetDirOptions {
  /** Where the per-checkout directories live. */
  root?: string;
  /**
   * The account the build will run as, when it is not the worker's own.
   *
   * The container runs repository-supplied commands as a second unprivileged
   * account (`agent`, Issue #571), and a directory one account creates is not
   * writable by the other — cargo would fail outright the first time the two
   * met in one directory. Each account therefore gets its own; the ephemeral
   * layer is a 504 GB image released at every relaunch, so the duplication
   * costs nothing that survives the cycle.
   */
  account?: string;
}

/**
 * The ephemeral cargo target directory for one checkout.
 *
 * @param checkoutPath - The working tree cargo will be run in: a lane
 *   worktree, or the shared clone a maintenance pass uses.
 * @param options - Root and, where the build drops to it, the account.
 * @returns An absolute path under the root, unique to this checkout.
 * @throws When the checkout path is empty — an unnamed checkout would key
 *   every build to the same directory, which is the serialisation this
 *   exists to avoid.
 */
export function cargoTargetDirForCheckout(
  checkoutPath: string,
  options: CargoTargetDirOptions = {},
): string {
  const root = options.root ?? EPHEMERAL_CARGO_TARGET_ROOT;
  const normalised = normaliseCheckoutPath(checkoutPath);
  if (normalised.length === 0) {
    throw new Error(
      "cargoTargetDirForCheckout: an empty checkout path names no working " +
        "tree — refusing to key every build to one target directory",
    );
  }
  // The digest carries the identity; the name is only there so an operator
  // reading `du -sh /var/tmp/vibe-cargo-target/*` can tell which is which.
  // Sanitised to one safe segment: the checkout path is worker-derived, but
  // a repository name reaches it, and a key that could contain `/` or `..`
  // would put the build somewhere other than the root.
  const base = normalised.slice(normalised.lastIndexOf("/") + 1);
  const safeName = base.replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/^[.-]+/, "")
    .slice(0, NAME_KEY_MAX);
  const account = (options.account ?? "").replace(/[^A-Za-z0-9._-]/g, "-");
  const key = [
    ...(safeName.length > 0 ? [safeName] : []),
    shortDigest(normalised),
    ...(account.length > 0 ? [account] : []),
  ].join("-");
  return `${root}/${key}`;
}

/** What {@link ephemeralBuildCacheEnv} needs to decide. */
export interface EphemeralBuildCacheOptions {
  /** The working tree the subprocess runs in. */
  checkoutPath?: string;
  /** The launcher's word that the runtime refused to trim the volume. */
  trimRefused: boolean;
  /** Where the per-checkout directories live. */
  root?: string;
  /** The account the build will run as, when it is not the worker's own. */
  account?: string;
  /** The environment the child would otherwise inherit. */
  source?: Record<string, string>;
}

/**
 * The environment entries that move this checkout's build artefacts off the
 * persistent work volume.
 *
 * @returns The entries to overlay onto the child's environment — empty on a
 *   runtime that honours the trim, when no checkout is named, or when the
 *   caller's environment already sets `CARGO_TARGET_DIR` itself.
 */
export function ephemeralBuildCacheEnv(
  options: EphemeralBuildCacheOptions,
): Record<string, string> {
  if (!options.trimRefused) return {};
  const checkoutPath = options.checkoutPath ?? "";
  if (normaliseCheckoutPath(checkoutPath).length === 0) return {};
  // An explicit setting is somebody's deliberate choice; never overridden.
  if ((options.source?.["CARGO_TARGET_DIR"] ?? "").trim().length > 0) return {};
  return {
    CARGO_TARGET_DIR: cargoTargetDirForCheckout(checkoutPath, {
      ...(options.root === undefined ? {} : { root: options.root }),
      ...(options.account === undefined ? {} : { account: options.account }),
    }),
  };
}

/**
 * Where the launcher's reading sits for the worker inside the container:
 * `${HOME}/logs/host-disk.json` (the host's log directory, mounted rw).
 *
 * @returns The path, or null when `HOME` names nowhere to read it from.
 */
export function hostDiskRefreshPath(
  env: (name: string) => string | undefined,
): string | null {
  const home = env("HOME")?.trim();
  if (!home) return null;
  return `${home}/logs/${HOST_DISK_REFRESH_FILE}`;
}

/** Injectable reader for {@link readWorkVolumeTrimRefused}. */
export interface TrimRefusedReadDeps {
  /** The launcher's reading file, or null when there is none to read. */
  path: string | null;
  readTextFile: (path: string) => string;
}

/**
 * Did the launcher report that this runtime refused to trim the work volume?
 *
 * A missing, unreadable or malformed reading, and a reading from a launcher
 * old enough not to write the flag, all read as **not refused** — the same
 * documented default as `HostDiskMonitor` (`host_disk.ts`), and the safe one:
 * it leaves behaviour exactly as it was rather than relocating builds on a
 * guess.
 */
export function readWorkVolumeTrimRefused(
  deps: TrimRefusedReadDeps,
): boolean {
  if (deps.path === null) return false;
  let body: string;
  try {
    body = deps.readTextFile(deps.path);
  } catch {
    return false;
  }
  return parseHostDiskRefresh(body)?.workVolumeTrimRefused === true;
}

/** Memoised answer for this process — see {@link workVolumeTrimRefusedForLaunch}. */
let launchTrimRefused: boolean | undefined;

/**
 * The launcher's trim verdict for this launch, read once per process.
 *
 * The flag is a property of the launch, not of one sample — `host_disk.ts`
 * says so where it adopts the reading — so re-reading the file at every spawn
 * would buy nothing.
 */
export function workVolumeTrimRefusedForLaunch(): boolean {
  if (launchTrimRefused === undefined) {
    launchTrimRefused = readWorkVolumeTrimRefused({
      path: hostDiskRefreshPath((name) => {
        try {
          return Deno.env.get(name);
        } catch {
          return undefined;
        }
      }),
      readTextFile: (path) => Deno.readTextFileSync(path),
    });
  }
  return launchTrimRefused;
}

/** Forget the memoised verdict — for tests that vary it. */
export function resetWorkVolumeTrimRefusedForLaunch(): void {
  launchTrimRefused = undefined;
}

/**
 * The environment entries for a subprocess about to run in `checkoutPath`,
 * using this launch's trim verdict.
 *
 * The one-line call every spawn site makes.
 *
 * @param checkoutPath - The working tree the subprocess runs in.
 * @param options.source - The environment the child would otherwise inherit,
 *   so an explicit `CARGO_TARGET_DIR` is never overridden.
 * @param options.account - The account the command drops to, where it does.
 */
export function buildCacheEnvForCheckout(
  checkoutPath: string | undefined,
  options: { source?: Record<string, string>; account?: string } = {},
): Record<string, string> {
  return ephemeralBuildCacheEnv({
    ...(checkoutPath === undefined ? {} : { checkoutPath }),
    trimRefused: workVolumeTrimRefusedForLaunch(),
    ...(options.source === undefined ? {} : { source: options.source }),
    ...(options.account === undefined ? {} : { account: options.account }),
  });
}
