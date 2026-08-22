/**
 * Per-cycle trusted-author snapshot (Issue #253).
 *
 * Trusted-author sets used to be captured once at dependency-construction
 * time and baked into fleet-author inputs, heartbeat marker options, and
 * stuck-issue recovery. A later source flip (Issue #256) refreshes those
 * sets each cycle from GitHub; this module is the holder that makes that
 * refresh a single assignment rather than a scavenger hunt through
 * closures.
 *
 * This sub-issue is behaviour-neutral: the production hook still copies
 * the static config arrays. The holder exists so a snapshot change
 * recomputes every derived set — a stale `fleetPrAuthorInput` would
 * silently reintroduce the #4023/#4079 divergence.
 *
 * Uses Australian English throughout (behaviour, authorised, normalise).
 */

import {
  type FleetAuthorSetInput,
  resolveFleetAuthors,
  resolveFleetMaintenanceAuthorSet,
} from "./fleet_authors.ts";

/** Outcome of one per-cycle trusted-author refresh. */
export type RefreshOutcome =
  | { ok: true }
  | { ok: false; reason: string };

/** The two raw trusted-author arrays the rest of the worker reads. */
export interface TrustedAuthorSets {
  allowedAuthors: string[];
  authorisedCommenters: string[];
}

/** Sets derived from {@link TrustedAuthorSets} plus the host/fleet logins. */
export interface DerivedTrustSets {
  fleetAuthors: string[];
  fleetPrAuthorInput: FleetAuthorSetInput;
  maintenanceAuthors: string[];
}

/** The full snapshot: raw arrays plus every set derived from them. */
export interface TrustSnapshot extends TrustedAuthorSets, DerivedTrustSets {}

/** Host-stable inputs that are not themselves the refreshable snapshot. */
export interface TrustSnapshotContext {
  githubUser: string;
  fleetPrAuthors: readonly string[];
}

/**
 * Recompute the fleet-author sets from a snapshot.
 *
 * Matches today's production wiring: `resolveFleetAuthors` is called
 * without a separate `serviceAccounts` argument — `loadConfig` already
 * folds those logins into `fleetPrAuthors`. Keeping that call shape is
 * what makes this refactor behaviour-neutral.
 */
export function recomputeDerivedTrust(
  sets: TrustedAuthorSets,
  ctx: TrustSnapshotContext,
): DerivedTrustSets {
  const fleetPrAuthorInput: FleetAuthorSetInput = {
    githubUser: ctx.githubUser,
    allowedAuthors: [...sets.allowedAuthors],
    fleetPrAuthors: [...ctx.fleetPrAuthors],
  };
  const fleetAuthors = resolveFleetAuthors(
    ctx.githubUser,
    [...sets.allowedAuthors],
    [...ctx.fleetPrAuthors],
  );
  const maintenanceAuthors = resolveFleetMaintenanceAuthorSet(
    fleetPrAuthorInput,
  );
  return { fleetAuthors, fleetPrAuthorInput, maintenanceAuthors };
}

/** Readable/replaceable holder used by the production deps closures. */
export interface TrustSnapshotHolder {
  read(): TrustSnapshot;
  apply(sets: TrustedAuthorSets): TrustSnapshot;
}

/** Create a holder seeded with `initial` and recomputed derived sets. */
export function createTrustSnapshotHolder(
  ctx: TrustSnapshotContext,
  initial: TrustedAuthorSets,
): TrustSnapshotHolder {
  let current: TrustSnapshot = {
    allowedAuthors: [...initial.allowedAuthors],
    authorisedCommenters: [...initial.authorisedCommenters],
    ...recomputeDerivedTrust(initial, ctx),
  };
  return {
    read: () => current,
    apply(sets) {
      current = {
        allowedAuthors: [...sets.allowedAuthors],
        authorisedCommenters: [...sets.authorisedCommenters],
        ...recomputeDerivedTrust(sets, ctx),
      };
      return current;
    },
  };
}
