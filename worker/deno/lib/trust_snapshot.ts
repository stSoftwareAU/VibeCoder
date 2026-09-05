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
 * `resolveFleetAuthors` is called without a separate `serviceAccounts`
 * argument — `loadConfig` already folds those logins into `fleetPrAuthors`.
 *
 * Issue #1066: `fleetAuthors` is a **fleet-identity** set, not a permission
 * set. It gates heartbeat-marker adoption (#3751) and stale-assignment
 * recovery (#3164) — both of which ask "is this one of us?", never "may this
 * person instruct us". Under the old local-array model `allowed_authors`
 * happened to name the fleet accounts, so folding it in was harmless; under
 * the derived model it names *every write-access collaborator*, and folding
 * it in would make a colleague's assignment read as fleet occupancy. That is
 * the #1064 shape, and DESIGN-PRINCIPLES states the rule: the set of logins
 * that can occupy or block is the fleet-identity set, never a permission set.
 *
 * `fleetPrAuthorInput` still carries `allowedAuthors`, because the
 * **defer-to** set (`resolveFleetPrAuthorSet`) deliberately includes trusted
 * humans: their open PR still blocks a duplicate. Only the act-on sets drop
 * them.
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
    [],
    [...ctx.fleetPrAuthors],
  );
  const maintenanceAuthors = resolveFleetMaintenanceAuthorSet(
    fleetPrAuthorInput,
  );
  return { fleetAuthors, fleetPrAuthorInput, maintenanceAuthors };
}

/**
 * The trusted sets the *current* process has resolved, published so a call
 * site that re-reads `.config.json` from disk cannot fall back to the local
 * arrays (Issue #1066).
 *
 * `null` until a refresh has landed, which is the fail-closed state: nobody
 * may direct work and no input is accepted until GitHub has been asked.
 */
let liveTrustedAuthors: TrustedAuthorSets | null = null;

/** Publish the sets a successful refresh resolved. */
export function setLiveTrustedAuthors(sets: TrustedAuthorSets): void {
  liveTrustedAuthors = {
    allowedAuthors: [...sets.allowedAuthors],
    authorisedCommenters: [...sets.authorisedCommenters],
  };
}

/** The sets the current process has resolved, or `null` before the first refresh. */
export function readLiveTrustedAuthors(): TrustedAuthorSets | null {
  return liveTrustedAuthors === null ? null : {
    allowedAuthors: [...liveTrustedAuthors.allowedAuthors],
    authorisedCommenters: [...liveTrustedAuthors.authorisedCommenters],
  };
}

/** Forget the published sets. Test-only. */
export function _resetLiveTrustedAuthors(): void {
  liveTrustedAuthors = null;
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
