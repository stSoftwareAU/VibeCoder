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
