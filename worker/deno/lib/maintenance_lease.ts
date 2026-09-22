/**
 * Maintenance-lease decision — which host runs a repository's maintenance
 * sweeps (Issue #2448, Decision 2 of #2443).
 *
 * Four fixed-cost maintenance sweeps (`Close Issues for Merged PRs`,
 * `Recover Assigned with Closed PRs`, `Milestone Completions`,
 * `Failure-Detection Repair Resume`) cost ≈ 20 GraphQL calls each per cycle,
 * and every host repeats them. The lease stops that duplication: one host
 * holds a short lease per repository and runs the sweeps; the others skip.
 *
 * This module is the **pure decision** — identity, clock and dead-holder
 * rules — with no GitHub I/O. It decides, from a recorded holder marker and
 * the reader's own clock, whether this host should run. Reading and writing
 * the marker lives in a separate module.
 *
 * ## Identity
 *
 * The holder is identified by the per-install UUID from `machine_id.ts`
 * (`getOrCreateMachineUuid`), not the hostname. The container hostname
 * `vibe-coder-<random>` changes on every hourly launch (#2403), so comparing
 * on the hostname would make a holder never recognise its own lease after a
 * relaunch. The uuid survives relaunches, so two slots on one machine — and
 * the same machine after a relaunch — share one lease. {@link installFromMachineId}
 * (`stream_holder.ts`) extracts that uuid from a full machine id.
 *
 * ## Clock and dead holder
 *
 * The marker's own `at=` is compared with the reader's `nowSeconds`. A marker
 * stamped in the **future** is clock skew: it is clamped to `now` and treated
 * as fresh, never trusted as "extra time". A marker older than
 * {@link MAINTENANCE_LEASE_SECONDS} is a dead holder and may be taken over.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { installFromMachineId } from "./stream_holder.ts";

/** Marker name, and the `--jq test()` pattern the comment read filters on. */
export const MAINTENANCE_LEASE_MARKER_PREFIX = "vibe-maintenance-lease";

/** How long a lease lasts before the holder is treated as dead. */
export const MAINTENANCE_LEASE_SECONDS = 900;

/** A repository name — `owner/repo`, no surrounding whitespace or extra `/`. */
const REPO_RE = /^[^/\s]+\/[^/\s]+$/;

/**
 * The holder marker, in full.
 *
 * The `repo` field keeps its `/`, so its character class is wider than the
 * host's. Both are sanitised on the way out, so neither can carry whitespace
 * or the `-->` that would end the comment early — the pattern is therefore
 * anchored on character classes rather than a lazy `.*?`.
 */
const LEASE_MARKER_RE = new RegExp(
  `<!--\\s*${MAINTENANCE_LEASE_MARKER_PREFIX}\\s+repo=([A-Za-z0-9._/-]+)` +
    `\\s+host=([A-Za-z0-9._-]+)\\s+at=(\\d{1,15})\\s*-->`,
  "u",
);

/** The host that holds a repository's maintenance lease, as the marker records it. */
export interface MaintenanceLeaseHolder {
  /** Install uuid of the holder, as {@link MaintenanceLeaseMarker} recorded it. */
  host: string;
  /** Epoch seconds the lease was taken at. */
  atEpoch: number;
}

/** A parsed lease marker, with the repository it belongs to. */
export interface MaintenanceLeaseMarker extends MaintenanceLeaseHolder {
  /** `owner/repo` of the repository this marker holds a lease for. */
  repo: string;
}

/** Reduce a field to characters that cannot break the marker. */
function sanitiseField(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
}

/** Reduce a repository to characters that cannot break the marker (`/` kept). */
function sanitiseRepo(value: string): string {
  return value.replace(/[^A-Za-z0-9._/-]+/gu, "-")
    .replace(/^[/-]+|[/-]+$/gu, "");
}

/** Render the lease marker for `repo`. */
export function formatMaintenanceLeaseMarker(
  repo: string,
  host: string,
  atEpochSeconds: number,
): string {
  return `<!-- ${MAINTENANCE_LEASE_MARKER_PREFIX} repo=${sanitiseRepo(repo)} ` +
    `host=${sanitiseField(host)} at=${
      Math.max(0, Math.floor(atEpochSeconds))
    } -->`;
}

/**
 * The lease marker in `body`, or null when it carries none (or one that is
 * malformed: a non-numeric `at`, a missing `host`, or a repository that is not
 * `owner/repo`).
 */
export function parseMaintenanceLeaseMarker(
  body: string,
): MaintenanceLeaseMarker | null {
  const match = LEASE_MARKER_RE.exec(body);
  if (match === null) return null;
  const repo = match[1]!;
  if (!REPO_RE.test(repo)) return null;
  const host = match[2]!;
  const atEpoch = Number.parseInt(match[3]!, 10);
  if (!Number.isFinite(atEpoch)) return null;
  return { repo, host, atEpoch };
}

/** What the lease decision says this host should do. */
export interface MaintenanceLeaseDecision {
  /** Run the sweeps. */
  run: boolean;
  reason: "no-holder" | "own-lease" | "holder-expired" | "held-elsewhere";
  /** The holder host, as the marker recorded it. Present only for a foreign holder. */
  holderHost?: string;
  /** Whole seconds of lease left. Present only when held elsewhere. */
  secondsLeft?: number;
}

/**
 * Is `holderHost` this host's own install?
 *
 * The marker records the bare install uuid, while `thisHost` is usually the
 * full machine id (`{hostname}-{uuid}`). Compare on the install part when
 * present, and fall back to the raw value when one side carries no uuid.
 */
function isOwnLease(holderHost: string, thisHost: string): boolean {
  const thisInstall = installFromMachineId(thisHost);
  const holderInstall = installFromMachineId(holderHost);
  if (thisInstall !== null && holderInstall !== null) {
    return thisInstall === holderInstall;
  }
  if (thisInstall !== null) return thisInstall === holderHost;
  if (holderInstall !== null) return thisHost === holderInstall;
  return thisHost === holderHost;
}

/**
 * Decide whether this host runs the maintenance sweeps for `holder`'s repo.
 *
 * Pure — the holder, this host's identity and the clock are all inputs. The
 * holder is compared on the install uuid, so the same machine after a relaunch
 * (a new hostname, the same uuid) still recognises its own lease.
 */
export function decideMaintenanceLease(options: {
  holder: MaintenanceLeaseHolder | null;
  /** This host's machine id (`getMachineId`) or its install uuid. */
  thisHost: string;
  /** Current epoch seconds. */
  nowSeconds: number;
}): MaintenanceLeaseDecision {
  const { holder, thisHost, nowSeconds } = options;
  if (holder === null) return { run: true, reason: "no-holder" };

  if (isOwnLease(holder.host, thisHost)) {
    return { run: true, reason: "own-lease" };
  }

  // A marker stamped in the future is clock skew: clamp it to now so it is
  // treated as fresh, never trusted as "extra time".
  const clampedAt = Math.min(holder.atEpoch, nowSeconds);
  const age = nowSeconds - clampedAt;
  if (age >= MAINTENANCE_LEASE_SECONDS) {
    return { run: true, reason: "holder-expired", holderHost: holder.host };
  }
  return {
    run: false,
    reason: "held-elsewhere",
    holderHost: holder.host,
    secondsLeft: MAINTENANCE_LEASE_SECONDS - age,
  };
}
