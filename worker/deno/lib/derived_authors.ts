/**
 * Per-cycle derived author allowlists (Issue #254, parent #234; two-axis
 * rewrite Issue #1066).
 *
 * Combines the collaborator fetch (#250) and the exclusion sources (#251)
 * into a single all-or-nothing resolver, and answers **two** questions from
 * one fetch:
 *
 * | Actor                                       | may direct work | may supply input |
 * | ------------------------------------------- | --------------- | ---------------- |
 * | Human with write access, not a Vibe Coder   | yes             | yes              |
 * | Vibe Coder (`service_accounts` / `fleet_pr_authors`) | no      | yes              |
 * | Known bot (`authorized_commenters`)         | no              | yes              |
 * | Anyone else — no write access, unknown bots | no              | no               |
 *
 * **`allowedAuthors` — who may direct work** (raise, label, schedule):
 * `hasWriteAccess(repo, login) && !isVibeCoder(login) && !isBot(login)`.
 * Derived from repository permissions every cycle; no hand-maintained
 * allowlist contributes to it.
 *
 * **`authorisedCommenters` — whose input we act on** (test results, code
 * reviews, PR comments): the set above, plus a *known* list — the Vibe Coder
 * logins and the operator's `authorized_commenters` bots. "Known" is exactly
 * the property that cannot be derived from repository permissions: a GitHub
 * App is not a collaborator at all, so a naive derived rule would silently
 * stop processing Copilot reviews and Actions results.
 *
 * The asymmetry is the point: a Vibe Coder's or a bot's review is accepted as
 * input, and neither may schedule or change work.
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
  FLEET_LOGIN_CONFIG_KEYS,
  isBotLogin,
  resolveVibeCoderLogins,
} from "./trust_exclusions.ts";
import { normaliseLogin } from "./identity_guard.ts";

/** The two trusted-author arrays derived from one collaborator fetch. */
export interface TrustedAuthors {
  /** Axis 1 — logins that may raise, label and schedule work. */
  allowedAuthors: string[];
  /** Axis 2 — logins whose test results, reviews and comments we act on. */
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

/** Inputs that identify the monitored repos and both trust axes. */
export interface ResolveDerivedAuthorsInput {
  /** Monitored repositories, `owner/repo`. */
  repos: readonly string[];
  /** `service_accounts` — half of the Vibe Coder login set. */
  serviceAccounts: readonly string[];
  /** `fleet_pr_authors` — the other half of the Vibe Coder login set. */
  fleetPrAuthors: readonly string[];
  /** This host's own resolved `gh` login. */
  githubUser: string;
  /** Optional *additional* exclusion for org-team-based setups. */
  exclusionTeamSlug?: string;
  /**
   * `authorized_commenters` — the known logins whose input we accept without
   * their holding repository write access (Copilot, Actions, and any other
   * bot the operator names). Never grants the right to direct work.
   */
  knownInputLogins: readonly string[];
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

/**
 * Build both axes for one repo: the directing set as given, and the input set
 * as that plus the known logins (Vibe Coders and named bots).
 */
function trustedFrom(
  logins: string[],
  knownInput: readonly string[],
): TrustedAuthors {
  const commenters = [...logins];
  const seen = new Set(logins.map((l) => l.toLowerCase()));
  for (const login of knownInput) {
    const key = login.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    commenters.push(login);
  }
  return { allowedAuthors: [...logins], authorisedCommenters: commenters };
}

/**
 * Whether `login` is barred from the directing set: a Vibe Coder, a member of
 * the optional `exclusion_team`, or any bot. The bot term stands on its own —
 * write access alone must never confer the right to direct work on a bot.
 */
function isExcluded(
  login: string,
  vibeCoderLogins: ReadonlySet<string>,
  teamMembers: ReadonlySet<string>,
): boolean {
  return vibeCoderLogins.has(login) || teamMembers.has(login) ||
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
  const vibeCoderLogins = resolveVibeCoderLogins({
    serviceAccounts: input.serviceAccounts,
    fleetPrAuthors: input.fleetPrAuthors,
    githubUser: input.githubUser,
  });
  // Defence in depth behind the config-load check: with nothing to subtract,
  // the fleet's own accounts hold write access and would be trusted to direct
  // their own work. Refuse rather than resolve an open set.
  if (vibeCoderLogins.size === 0) {
    return fail(
      `the Vibe Coder login set is empty, so the fleet's own accounts would ` +
        `be trusted to direct work — set ${
          FLEET_LOGIN_CONFIG_KEYS.join(" or ")
        }` +
        ` in .config.json`,
      "vibe-coder-logins",
    );
  }

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

  // Axis 2's known half: the Vibe Coder logins (their reviews and test
  // results are input we want) plus whatever `authorized_commenters` names.
  const knownInput: string[] = [];
  const knownSeen = new Set<string>();
  for (const login of [...vibeCoderLogins, ...input.knownInputLogins]) {
    const key = normaliseLogin(login);
    if (!key || knownSeen.has(key)) continue;
    knownSeen.add(key);
    knownInput.push(login);
  }

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
      if (isExcluded(collaborator.login, vibeCoderLogins, teamMembers)) {
        excludedCount++;
        continue;
      }
      trusted.push(collaborator.login);
      trustedCount++;
    }
    byRepo.set(repo, trustedFrom(trusted, knownInput));
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
