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
 * Three properties matter and are pinned by tests:
 *
 * - **One directory per checkout.** Cargo takes a file lock on the target
 *   directory for the whole build, so a single shared directory would
 *   serialise two slots' Rust builds. The key is derived from the checkout
 *   path, which covers a lane worktree (`worktrees/<slot>/<repo>`) and the
 *   shared clone (`<work root>/<repo>`) the maintenance passes use alike.
 * - **One directory per account.** The repository's own commands run as
 *   `agent` and the worker's as `vibe` (Issue #571); neither can write a
 *   directory the other created, so the account is part of the key and the
 *   shared root is created `1777` like `/tmp`.
 * - **Nothing changes where the trim is honoured.** On a runtime that returns
 *   the blocks, the env is untouched and builds stay incremental across
 *   cycles exactly as before.
 *
 * Incremental builds are lost at relaunch. They were lost at every volume
 * recreate anyway — and a recreate now happens only when live data outgrows
 * the floor, not every cycle.
 *
 * The cargo *registry* cache (`CARGO_HOME`) and the Deno cache (`DENO_DIR`)
 * are deliberately left where `container/entrypoint.sh` puts them — on the
 * volume, at `${VIBE_STATE_DIR}/cargo` and `~/auto-issue-work/.deno-cache`.
 * They are not the ratchet: a download cache grows by what it fetched and is
 * read back on the next launch, where a `target/` is rewritten every build,
 * which is what allocates fresh image blocks on a runtime that returns none.
 * Moving them would buy a cold registry and dependency download at every
 * launch to reclaim space the measurements do not attribute the growth to.
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
    // No catch around the environment read: a process without `--allow-env`
    // must fail loudly rather than quietly report a trimming runtime and
    // leave the ratchet in place. Every worker entry point grants it.
    launchTrimRefused = readWorkVolumeTrimRefused({
      path: hostDiskRefreshPath((name) => Deno.env.get(name)),
      readTextFile: (path) => Deno.readTextFileSync(path),
    });
  }
  return launchTrimRefused;
}

/** Roots this process has already provisioned, and whether they are usable. */
const provisionedRoots = new Map<string, boolean>();

/**
 * Make the shared root usable by **both** accounts (Issue #571).
 *
 * The worker runs as `vibe` and the repository's own commands as `agent`;
 * whichever builds first would otherwise create the root with a `022` umask
 * and lock the other out of creating its own directory beside it. The mode is
 * `1777` — the same shape as `/tmp`, and the same reasoning as the work
 * root's sticky bit (Issue #1442): either account may create its own
 * directory, neither may remove the other's.
 *
 * A root that already carries the mode is left alone, so the second account
 * does not try to chmod a directory it does not own. A root that cannot be
 * provisioned is **reported** and the placement is abandoned: the build then
 * runs exactly as it does today, on the volume, rather than a disk problem
 * being turned into a hard build failure.
 *
 * Memoised per root, so the answer is one `stat` per process.
 *
 * @param root - The shared root to provision.
 * @param warn - Where the failure is reported.
 * @returns Whether the root is usable.
 */
export function ensureEphemeralCargoRoot(
  root: string,
  warn: (message: string) => void = (message) => console.error(message),
): boolean {
  const remembered = provisionedRoots.get(root);
  if (remembered !== undefined) return remembered;
  const usable = provisionRoot(root, warn);
  provisionedRoots.set(root, usable);
  return usable;
}

/** The one-off work behind {@link ensureEphemeralCargoRoot}. */
function provisionRoot(
  root: string,
  warn: (message: string) => void,
): boolean {
  try {
    if ((Deno.statSync(root).mode ?? 0) % 0o10000 === 0o1777) return true;
  } catch {
    // Absent, or unreadable — the mkdir below is the honest next step.
  }
  try {
    Deno.mkdirSync(root, { recursive: true });
    Deno.chmodSync(root, 0o1777);
    return true;
  } catch (err) {
    warn(
      `[WARN] could not provision ${root} for both accounts ` +
        `(${
          err instanceof Error ? err.message : err
        }) — build artefacts stay ` +
        `on the work volume this launch, so the image keeps ratchetting ` +
        `(Issue #2247)`,
    );
    return false;
  }
}

/**
 * The environment entries for a subprocess about to run in `checkoutPath`,
 * using this launch's trim verdict.
 *
 * The one-line call every spawn site makes. Provisions the shared root the
 * first time this process places a build there.
 *
 * @param checkoutPath - The working tree the subprocess runs in.
 * @param options.source - The environment an explicit `CARGO_TARGET_DIR`
 *   would come from; defaults to the worker's own, so an operator's setting
 *   is honoured at every spawn site rather than only where one is passed,
 *   so an explicit `CARGO_TARGET_DIR` is never overridden.
 * @param options.account - The account the command drops to, where it does.
 * @param options.trimRefused - The launch verdict. Taken as a parameter so a
 *   caller — and every test — can state it rather than inherit it from the
 *   host; production leaves it out and gets this launch's own.
 */
export function buildCacheEnvForCheckout(
  checkoutPath: string | undefined,
  options: {
    source?: Record<string, string>;
    account?: string;
    trimRefused?: boolean;
    /** Where the per-checkout directories live; production takes the default. */
    root?: string;
  } = {},
): Record<string, string> {
  const env = ephemeralBuildCacheEnv({
    ...(checkoutPath === undefined ? {} : { checkoutPath }),
    trimRefused: options.trimRefused ?? workVolumeTrimRefusedForLaunch(),
    source: options.source ?? Deno.env.toObject(),
    ...(options.account === undefined ? {} : { account: options.account }),
    ...(options.root === undefined ? {} : { root: options.root }),
  });
  const target = env["CARGO_TARGET_DIR"];
  if (target === undefined) return env;
  // A root that cannot be made usable by both accounts means today's
  // behaviour, loudly, rather than a build that cannot write anywhere.
  return ensureEphemeralCargoRoot(target.slice(0, target.lastIndexOf("/")))
    ? env
    : {};
}
