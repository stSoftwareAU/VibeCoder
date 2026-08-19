/**
 * Fleet author resolution for the open-PR duplicate guard (Issue #3138).
 *
 * The #3100 fleet-aware open-PR guard must see the open PRs of *every*
 * fleet account, otherwise a second host raises a duplicate PR for an
 * issue another host is already working (Issue #3095). The guard
 * enumerates fleet accounts and fetches their open PRs.
 *
 * Root cause of the #3138 miss: the guard enumerated fleet accounts from
 * `allowedAuthors` only, but the canonical list of *sibling fleet logins*
 * is `fleetPrAuthors` (`fleet_pr_authors` — "GitHub logins of sibling
 * fleet hosts"). A host with a sibling in `fleet_pr_authors` but not
 * `allowed_authors` never queried that sibling's open PRs, so the guard
 * was blind to it. This resolver unions both lists (plus the host's own
 * login) so the guard can never be blind to a configured sibling.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

/**
 * Resolve the complete set of fleet GitHub logins whose open PRs the
 * open-PR duplicate guard must consider.
 *
 * The set is the union of the host's own login, the trusted
 * `allowedAuthors`, and the sibling `fleetPrAuthors`. Blank/whitespace
 * entries are dropped and duplicates are removed case-insensitively
 * (GitHub logins are case-insensitive) while preserving first-seen
 * casing and order.
 *
 * @param githubUser - The current host's GitHub login.
 * @param allowedAuthors - Trusted authors (`allowed_authors`).
 * @param fleetPrAuthors - Sibling fleet logins (`fleet_pr_authors`).
 * @returns Deduplicated, non-empty fleet login list.
 */
export function resolveFleetAuthors(
  githubUser: string,
  allowedAuthors: string[],
  fleetPrAuthors: string[],
): string[] {
  const combined = [githubUser, ...allowedAuthors, ...fleetPrAuthors];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of combined) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

/**
 * The configuration inputs that define "the PRs the fleet owns in this
 * repo" (Issue #4024).
 *
 * Every consumer — the issue-side blocking guard
 * (`getBlockingPRForIssue` via `fetchOpenPRsForFleet`), the PR-maintenance
 * scans (`listOpenPrs`), and the CI-nudge scan — resolves its author set
 * from this one shape via {@link resolveFleetPrAuthorSet}. Two
 * independently-built author lists is exactly what let a fleet PR block
 * `work-on` issues while no scan ever maintained it (Lamarck PR #103,
 * Issue #4023).
 */
export interface FleetAuthorSetInput {
  /** The current host's GitHub login. */
  githubUser: string;
  /** Trusted authors (`allowed_authors`). */
  allowedAuthors?: readonly string[];
  /** Sibling fleet logins (`fleet_pr_authors`). */
  fleetPrAuthors?: readonly string[];
}

/**
 * Resolve the **fleet-owned (defer-to)** PR-author set from its
 * configuration inputs (Issues #4024, #4075).
 *
 * This set answers one question only: *is there an open PR the worker
 * must not duplicate, or must wait behind?* It is for **deferring to**
 * PRs — never for acting on them. Trusted humans (`allowedAuthors`) are
 * deliberately included: their open PR still blocks a duplicate.
 *
 * For "may I claim, push to, comment on, or auto-merge this PR?" use
 * {@link resolveFleetMaintenanceAuthorSet} instead — treating this set
 * as push-capable is the #4074 regression, where the maintenance scans
 * inherited `allowedAuthors` and adopted human-authored PRs.
 *
 * Invariant: the maintenance set is always a subset of this set. The
 * asymmetry is intended, not drift.
 *
 * @param input - The configured author inputs.
 * @returns Deduplicated fleet-owned login list.
 */
export function resolveFleetPrAuthorSet(input: FleetAuthorSetInput): string[] {
  return resolveFleetAuthors(
    input.githubUser,
    [...(input.allowedAuthors ?? [])],
    [...(input.fleetPrAuthors ?? [])],
  );
}

/**
 * Resolve the **push-capable (act-on)** fleet maintenance author set
 * (Issue #4075).
 *
 * This set answers: *may the worker claim this PR, push commits to it,
 * comment on it, or auto-merge it?* Membership is the host's own login
 * plus the sibling fleet logins (`fleetPrAuthors`) — accounts the fleet
 * actually operates.
 *
 * `allowedAuthors` is deliberately excluded: a trusted human is trusted
 * to *instruct* the worker, not to have their PRs taken over. A login
 * that appears in both lists stays in this set via `fleetPrAuthors`, so
 * a genuine fleet account is never dropped for also being trusted.
 *
 * Invariant: this set is always a subset of
 * {@link resolveFleetPrAuthorSet}'s fleet-owned set — everything the
 * fleet may act on is something it also defers to, never the reverse.
 * The asymmetry is intended, not drift.
 *
 * Normalisation matches {@link resolveFleetAuthors}: blank/whitespace
 * entries dropped, case-insensitive dedup preserving first-seen casing.
 *
 * @param input - The configured author inputs.
 * @returns Deduplicated push-capable login list.
 */
export function resolveFleetMaintenanceAuthorSet(
  input: FleetAuthorSetInput,
): string[] {
  return resolveFleetAuthors(
    input.githubUser,
    [],
    [...(input.fleetPrAuthors ?? [])],
  );
}

/**
 * The result of comparing the blocking-guard author set against the
 * PR-maintenance scan set (Issues #4024, #4079).
 *
 * The invariant this describes is no longer "the two sets are equal".
 * Since #4076 it is: *the maintenance set is the fleet-owned set minus
 * the trusted humans (`allowed_authors`), and nothing else*. A trusted
 * human present in the blocking set and absent from the maintenance set
 * is the intended shape, not drift, so it never appears here.
 */
export interface FleetAuthorSetDivergence {
  /**
   * True when the sets differ by anything other than the expected
   * trusted-human exclusions — i.e. the invariant above is violated.
   */
  diverged: boolean;
  /**
   * Fleet-owned authors the blocking guard defers to but no maintenance
   * scan covers, **excluding** the expected trusted-human delta — the
   * #4023 failure shape: a fleet PR that blocks work but is never fixed,
   * answered, or merged.
   */
  missingFromMaintenance: string[];
  /**
   * Authors maintained but invisible to the blocking guard — a login the
   * worker will push to that cannot block a duplicate PR (#3138).
   */
  missingFromBlocking: string[];
}

/** Options for {@link compareFleetAuthorSets} (Issue #4079). */
export interface FleetAuthorSetComparisonOptions {
  /**
   * Logins the maintenance set is *expected* to omit — the trusted
   * humans (`allowed_authors`) that {@link resolveFleetMaintenanceAuthorSet}
   * deliberately drops. Matched case-insensitively; blank entries are
   * ignored. An excluded login that is nonetheless present in the
   * maintenance set (listed in both `allowed_authors` and
   * `fleet_pr_authors`) is simply not missing, so it never diverges
   * either.
   */
  expectedMaintenanceExclusions?: readonly string[];
}

/**
 * Compare the blocking-guard and PR-maintenance author sets
 * (Issues #4024, #4079).
 *
 * The fleet invariant is: *every open PR `getBlockingPRForIssue()` can
 * return must be present in the PR-maintenance scan set, except the
 * trusted humans the maintenance set excludes by design*. This pure
 * comparison makes that invariant self-checking — callers emit a single
 * structured warning when it is violated and carry on (the check is
 * observability, never a gate).
 *
 * The check is intent-aware: pass `expectedMaintenanceExclusions` (the
 * configured `allowed_authors`) and that delta is silent, so the warning
 * still means what it says. Both genuine hazards remain alarms — a
 * fleet-owned sibling absent from maintenance (#4023), and a maintained
 * login the blocking guard cannot see (#3138).
 *
 * Comparison is case-insensitive (GitHub logins are), and the reported
 * logins keep the casing of the set they are missing from the *other*
 * side of.
 *
 * @param blockingAuthors - Set feeding the open-PR blocking guard.
 * @param maintenanceAuthors - Set feeding the PR-maintenance scans.
 * @param options - Expected-delta inputs; omitted means "expect equality".
 * @returns The divergence description (`diverged: false` when the sets
 *   differ only by the expected exclusions).
 */
export function compareFleetAuthorSets(
  blockingAuthors: readonly string[],
  maintenanceAuthors: readonly string[],
  options: FleetAuthorSetComparisonOptions = {},
): FleetAuthorSetDivergence {
  // Blank/whitespace entries are not authors — `resolveFleetPrAuthorSet`
  // drops them, so an unresolved list must not report them as missing.
  const blocking = blockingAuthors.filter((a) =>
    typeof a === "string" && a.trim().length > 0
  );
  const maintenance = maintenanceAuthors.filter((a) =>
    typeof a === "string" && a.trim().length > 0
  );
  const expectedExclusions = [
    ...(options.expectedMaintenanceExclusions ?? []),
  ].filter((a) => typeof a === "string" && a.trim().length > 0);
  const missingFromMaintenance = blocking.filter(
    (a) =>
      !isFleetAuthor(a, maintenance) && !isFleetAuthor(a, expectedExclusions),
  );
  const missingFromBlocking = maintenance.filter(
    (a) => !isFleetAuthor(a, blocking),
  );
  return {
    diverged: missingFromMaintenance.length > 0 ||
      missingFromBlocking.length > 0,
    missingFromMaintenance,
    missingFromBlocking,
  };
}

/**
 * Whether a PR author is a **human** — a login outside the fleet's
 * push-capable accounts (Issue #4133).
 *
 * `pushCapableAuthors` is the set from
 * {@link resolveFleetMaintenanceAuthorSet} (host login + `fleet_pr_authors`)
 * — the accounts the fleet actually operates. Everything else is somebody
 * else's PR: the developer manages it, so it never blocks the worker's
 * issue pickup.
 *
 * Two inputs are deliberately *not* classified as human, because
 * authorship could not be established and a wrong "human" verdict would
 * let the worker run a second PR into a work stream the fleet already owns
 * (merge hell):
 *
 * - a blank/missing author (a pre-#4024 cache entry that was never
 *   stamped), and
 * - an empty push-capable set (an unresolved or misconfigured fleet).
 *
 * Both fall back to "treat as fleet-owned", which keeps the existing
 * one-open-PR-at-a-time rule.
 *
 * @param author - The PR author login (may be missing).
 * @param pushCapableAuthors - The push-capable fleet set.
 * @returns True only when the author is positively outside the fleet.
 */
export function isHumanAuthoredPr(
  author: string | null | undefined,
  pushCapableAuthors: readonly string[],
): boolean {
  const fleet = pushCapableAuthors.filter(
    (a) => typeof a === "string" && a.trim().length > 0,
  );
  if (fleet.length === 0) return false;
  if (typeof author !== "string" || author.trim().length === 0) return false;
  return !isFleetAuthor(author, [...fleet]);
}

/**
 * Whether a GitHub comment/timeline actor login belongs to the fleet
 * (Issue #3164).
 *
 * GitHub logins are case-insensitive, so the comparison lower-cases both
 * sides. A blank, missing, or non-string login is never a fleet member —
 * callers use this to *fail toward recovery / toward allowing a claim* when
 * a claim or heartbeat marker cannot be attributed to a fleet account,
 * mirroring the author check `verifyOperationalLabels` performs on labels.
 *
 * @param login - The comment/timeline author login (may be null/undefined).
 * @param fleetAuthors - The resolved fleet login set (`resolveFleetAuthors`).
 * @returns True only when `login` matches a fleet author case-insensitively.
 */
export function isFleetAuthor(
  login: string | null | undefined,
  fleetAuthors: string[],
): boolean {
  if (typeof login !== "string") return false;
  const key = login.trim().toLowerCase();
  if (key.length === 0) return false;
  return fleetAuthors.some(
    (a) => typeof a === "string" && a.trim().toLowerCase() === key,
  );
}
