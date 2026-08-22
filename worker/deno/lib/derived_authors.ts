/**
 * Per-cycle derived author allowlists (Issue #254, parent #234).
 *
 * Combines the collaborator fetch (#250) and the exclusion sources (#251)
 * into a single all-or-nothing resolver. Per repo: write/maintain/admin
 * collaborators minus the union of static exclusions, `[bot]` logins, and
 * optional team members. Both `allowedAuthors` and `authorisedCommenters`
 * come from that same set.
 *
 * A fetch error from any repo or from the configured team fails the whole
 * resolve — there is no partially-successful variant, so a caller cannot
 * hold "repo A resolved, repo B did not" and quietly widen trust.
 *
 * The result is cached for the duration of one cycle (`deps.cycleId`).
 * Team membership is fetched once per resolve, not once per repo.
 *
 * Australian English throughout (authorised, behaviour, normalise).
 */

import { fetchRepoCollaborators } from "./collaborator_permissions.ts";
import {
  fetchTeamMembers,
  isBotLogin,
  resolveStaticExclusions,
} from "./trust_exclusions.ts";

/** The two trusted-author arrays derived from one collaborator-minus-exclusion set. */
export interface TrustedAuthors {
  allowedAuthors: string[];
  authorisedCommenters: string[];
}

/**
 * Outcome of {@link resolveDerivedAuthors}.
 *
 * Success carries a complete per-repo map. Failure names the source that
 * broke the resolve and deliberately omits `byRepo`.
 */
export type DerivedAuthorsResult =
  | { ok: true; byRepo: Map<string, TrustedAuthors> }
  | { ok: false; reason: string; failedSource: string };

/** Inputs that identify the monitored repos and the exclusion sources. */
export interface ResolveDerivedAuthorsInput {
  repos: readonly string[];
  serviceAccounts: readonly string[];
  githubUser: string;
  exclusionTeamSlug?: string;
}

/** Per-cycle cache key plus the optional summary-log sink. */
export interface DerivedAuthorsDeps {
  /**
   * Identifies the worker cycle. Repeated calls with the same id return
   * the cached result object without further `gh` calls.
   */
  cycleId: unknown;
  /** Sink for the single per-resolve cost-accounting line. */
  log?: (message: string) => void;
}

interface CycleCache {
  cycleId: unknown;
  result: DerivedAuthorsResult;
}

let cycleCache: CycleCache | null = null;

/** Drop the per-cycle cache. Test-only, and for a caller starting a new run. */
export function _resetDerivedAuthorsCache(): void {
  cycleCache = null;
}

function fail(reason: string, failedSource: string): DerivedAuthorsResult {
  return { ok: false, reason, failedSource };
}

function trustedFrom(logins: string[]): TrustedAuthors {
  return {
    allowedAuthors: [...logins],
    authorisedCommenters: [...logins],
  };
}

function isExcluded(
  login: string,
  staticExclusions: ReadonlySet<string>,
  teamMembers: ReadonlySet<string>,
): boolean {
  return staticExclusions.has(login) || teamMembers.has(login) ||
    isBotLogin(login);
}

/**
 * Fetch team members once, then each repo's collaborators, and subtract
 * the exclusion union. Cached per `deps.cycleId`.
 */
export async function resolveDerivedAuthors(
  input: ResolveDerivedAuthorsInput,
  deps: DerivedAuthorsDeps,
): Promise<DerivedAuthorsResult> {
  if (cycleCache !== null && Object.is(cycleCache.cycleId, deps.cycleId)) {
    return cycleCache.result;
  }

  const result = await resolveFresh(input, deps);
  cycleCache = { cycleId: deps.cycleId, result };
  return result;
}

async function resolveFresh(
  input: ResolveDerivedAuthorsInput,
  deps: DerivedAuthorsDeps,
): Promise<DerivedAuthorsResult> {
  const staticExclusions = resolveStaticExclusions({
    serviceAccounts: input.serviceAccounts,
    githubUser: input.githubUser,
  });

  const team = await fetchTeamMembers(input.exclusionTeamSlug);
  if (!team.ok) {
    return fail(
      team.error.message,
      input.exclusionTeamSlug?.trim() || "exclusion-team",
    );
  }
  const teamMembers = team.value.kind === "members"
    ? team.value.members
    : new Set<string>();

  const byRepo = new Map<string, TrustedAuthors>();
  let collaboratorCount = 0;
  let excludedCount = 0;
  let trustedCount = 0;

  for (const repo of input.repos) {
    const fetched = await fetchRepoCollaborators(repo);
    if (!fetched.ok) {
      return fail(fetched.detail, repo);
    }

    const trusted: string[] = [];
    for (const collaborator of fetched.value.collaborators) {
      collaboratorCount++;
      if (isExcluded(collaborator.login, staticExclusions, teamMembers)) {
        excludedCount++;
        continue;
      }
      trusted.push(collaborator.login);
      trustedCount++;
    }
    byRepo.set(repo, trustedFrom(trusted));
  }

  const repos = input.repos.join(",");
  const line =
    `[derived-authors] repos=${repos} collaborators=${collaboratorCount} ` +
    `excluded=${excludedCount} trusted=${trustedCount}`;
  (deps.log ?? console.error)(line);

  return { ok: true, byRepo };
}

/**
 * Fold the per-repo map into the one fleet-wide set the snapshot holds
 * (Issue #256).
 *
 * **This is an intersection, deliberately.** A login is fleet-wide trusted
 * only when it holds write/maintain/admin on *every* monitored repo. The
 * parent issue's rule is that a resolve must never widen trust, and a union
 * would do exactly that: write access on one monitored repo would confer
 * trust on all fifteen, so a contractor added to a single low-stakes repo
 * would become an authorised author on the rest. Nothing about "this person
 * can push to repo A" implies "the worker should act on their issue in
 * repo B".
 *
 * The cost is understood and accepted: the fleet-wide set is the *smallest*
 * of the per-repo sets, so a human with write on fourteen of fifteen repos
 * is not fleet-wide trusted. That is the fail-closed direction, and the
 * remedy — grant the access, or narrow `repos` — is visible and deliberate.
 * The per-repo map stays on {@link DerivedAuthorsResult} so a repo-scoped
 * call site can use that repo's exact set rather than this floor.
 *
 * An empty repo list yields empty sets: no repo has vouched for anyone, so
 * nobody is trusted. Combined with the skip-cycle gate, a misconfiguration
 * that empties the set stops the worker rather than opening it up.
 *
 * @param byRepo - Per-repo trusted sets from a successful resolve.
 * @returns The intersection, as the two arrays the snapshot holder takes.
 */
export function intersectDerivedAuthors(
  byRepo: ReadonlyMap<string, TrustedAuthors>,
): TrustedAuthors {
  const perRepo = [...byRepo.values()];
  if (perRepo.length === 0) {
    return { allowedAuthors: [], authorisedCommenters: [] };
  }

  const intersect = (pick: (t: TrustedAuthors) => string[]): string[] => {
    let survivors: string[] = [...pick(perRepo[0]!)];
    for (const repo of perRepo.slice(1)) {
      const here = new Set(pick(repo));
      survivors = survivors.filter((login) => here.has(login));
      if (survivors.length === 0) break;
    }
    // Deduplicate while keeping first-seen order, so the logged set is
    // stable between cycles and diffable by an operator.
    return [...new Set(survivors)];
  };

  return {
    allowedAuthors: intersect((t) => t.allowedAuthors),
    authorisedCommenters: intersect((t) => t.authorisedCommenters),
  };
}

/**
 * One line naming what the fold discarded (Issue #256).
 *
 * The intersection is invisible in its own result — a login dropped because
 * it was missing from one repo looks identical to one that was never a
 * collaborator. Naming the per-repo sizes next to the fleet-wide size is
 * what lets an operator see that trust narrowed and why.
 */
export function formatDerivedAuthorsFoldSummary(
  byRepo: ReadonlyMap<string, TrustedAuthors>,
  folded: TrustedAuthors,
): string {
  const perRepo = [...byRepo.entries()]
    .map(([repo, t]) => `${repo}=${t.allowedAuthors.length}`)
    .join(" ");
  return `[derived-authors] fleet-wide=${folded.allowedAuthors.length} ` +
    `(intersection of ${byRepo.size} repo(s)) ${perRepo}`;
}
