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
 * A fetch error from the configured team, or a transient error from any
 * repo, fails the whole resolve — there is no partially-successful variant,
 * so a caller cannot hold "repo A resolved, repo B did not" and quietly widen
 * trust. One exception, deliberate (Issue #1453): a repo whose collaborators
 * **this login cannot list** — 404, or 403 "Must have push access" — is not
 * a GitHub outage but a property of the deployment, and the worker could
 * never write to that repo either. Such a repo is skipped, named once, and
 * left out of the fold; only when *every* repo is skipped is there nothing
 * to trust and the resolve fails closed. A read-only service account no
 * longer stands the fleet down every cycle.
 *
 * The result is cached for the duration of one cycle (`deps.cycleId`), and —
 * when the caller asks for it — reused across cycles as a **snapshot** for
 * `snapshotTtlSeconds` (Issue #1453). Listing every monitored repo's
 * collaborators once per cycle was ~33 calls every 40 seconds for a set that
 * changes a few times a year, on a budget four hosts share. Within the TTL
 * no call is made; after it a fresh resolve replaces the snapshot; and when
 * that fresh resolve fails *transiently* the snapshot is served instead, with
 * its age in the log, until `snapshotMaxAgeSeconds` — the timestamped result
 * of a real fetch is not the stale `.config.json` array the fail-closed rule
 * forbids. The snapshot lives in process memory only, never on disk: the
 * work volume is writable by the agent subprocess, and a trust set the agent
 * could edit would be a widening the whole design exists to prevent.
 * Team membership is fetched once per resolve, not once per repo.
 *
 * Australian English throughout (authorised, behaviour, normalise).
 */

import {
  fetchRepoCollaborators,
  isCollaboratorAccessDenied,
} from "./collaborator_permissions.ts";
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

/** A monitored repo left out of the fold because this login cannot list it. */
export interface SkippedRepo {
  /** `owner/repo` slug. */
  repo: string;
  /** GitHub's own words — the 403 or 404 text. */
  detail: string;
}

/**
 * Outcome of {@link resolveDerivedAuthors}.
 *
 * Success carries a complete per-repo map of every repo that resolved, the
 * repos skipped as unwritable by this login, and — when the answer did not
 * come from a fresh fetch — where it came from. Failure names the source
 * that broke the resolve, says whether a retry could help, and deliberately
 * omits `byRepo`.
 */
export type DerivedAuthorsResult =
  | {
    ok: true;
    byRepo: Map<string, TrustedAuthors>;
    /**
     * Monitored repos this login cannot list collaborators on (Issue #1453).
     * Absent from a stub; the resolver always sets it.
     */
    skippedRepos?: SkippedRepo[];
    /**
     * Set when no `gh` call was made for this answer: the snapshot was inside
     * its TTL (`within-ttl`), or a fresh resolve failed transiently and the
     * snapshot was served in its place (`after-transient-failure`).
     */
    servedFrom?: {
      snapshot: "within-ttl" | "after-transient-failure";
      ageSeconds: number;
      /** The transient failure the snapshot papered over, when it did. */
      reason?: string;
    };
  }
  | {
    ok: false;
    reason: string;
    failedSource: string;
    /**
     * True when a later attempt could succeed — a network fault, a 5xx, a
     * rate limit. False, or absent (a stub), for a property of the
     * deployment: an empty Vibe Coder login set, a team that does not exist,
     * no listable repo at all. Absent is read as not transient — the
     * fail-closed direction.
     */
    transient?: boolean;
  };

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

/** Per-cycle cache key, the snapshot policy, and the log sinks. */
export interface DerivedAuthorsDeps {
  /**
   * Identifies the worker cycle. Repeated calls with the same id return
   * the cached result object without further `gh` calls.
   */
  cycleId: unknown;
  /** Sink for the single per-resolve cost-accounting line. */
  log?: (message: string) => void;
  /**
   * Sink for what an operator must hear: repos skipped as unwritable, and a
   * snapshot served after a transient failure. Defaults to `log`.
   */
  warn?: (message: string) => void;
  /**
   * How long a successful resolve is reused across cycles before a fresh one
   * is attempted (Issue #1453). `0` — the default, and the pre-#1453
   * behaviour — resolves on every cycle.
   */
  snapshotTtlSeconds?: number;
  /**
   * Hard ceiling on serving the snapshot after a fresh resolve failed
   * transiently. Past it the failure stands and the cycle fails closed.
   * Defaults to {@link DEFAULT_SNAPSHOT_MAX_AGE_SECONDS}.
   */
  snapshotMaxAgeSeconds?: number;
  /** Clock in milliseconds, injectable for tests. */
  now?: () => number;
}

/**
 * How long a snapshot may cover for GitHub before the worker stands down:
 * six hours. Long enough to ride out an outage or a busy afternoon of rate
 * limits, short enough that a revoked collaborator is not trusted overnight.
 */
export const DEFAULT_SNAPSHOT_MAX_AGE_SECONDS = 6 * 60 * 60;

interface CycleCache {
  cycleId: unknown;
  result: DerivedAuthorsResult;
}

/** The last successful fresh resolve, and what it was resolved for. */
interface Snapshot {
  /** Everything the answer depends on; a changed input is a different set. */
  key: string;
  /** When the fetch completed, in milliseconds. */
  at: number;
  result: Extract<DerivedAuthorsResult, { ok: true }>;
}

let cycleCache: CycleCache | null = null;
let snapshot: Snapshot | null = null;
/** The skipped-repo set last reported, so a stable condition is said once. */
let lastSkippedKey = "";

/**
 * Drop the per-cycle cache, the snapshot and the skip memory. Test-only, and
 * for a caller starting a new run.
 */
export function _resetDerivedAuthorsCache(): void {
  cycleCache = null;
  snapshot = null;
  lastSkippedKey = "";
}

function fail(
  reason: string,
  failedSource: string,
  transient: boolean,
): DerivedAuthorsResult {
  return { ok: false, reason, failedSource, transient };
}

/** What the answer depends on, so a changed input never reuses a snapshot. */
function snapshotKey(input: ResolveDerivedAuthorsInput): string {
  const sorted = (values: readonly string[]) =>
    [...values].map((v) => v.trim().toLowerCase()).sort().join(",");
  return [
    sorted(input.repos),
    sorted(input.serviceAccounts),
    sorted(input.fleetPrAuthors),
    input.githubUser.trim().toLowerCase(),
    (input.exclusionTeamSlug ?? "").trim().toLowerCase(),
    sorted(input.knownInputLogins),
  ].join("|");
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
 * the exclusion union. Cached per `deps.cycleId`, and reused as a snapshot
 * across cycles for `deps.snapshotTtlSeconds` (Issue #1453).
 */
export async function resolveDerivedAuthors(
  input: ResolveDerivedAuthorsInput,
  deps: DerivedAuthorsDeps,
): Promise<DerivedAuthorsResult> {
  if (cycleCache !== null && Object.is(cycleCache.cycleId, deps.cycleId)) {
    return cycleCache.result;
  }

  const now = deps.now ?? Date.now;
  const ttlMs = Math.max(0, deps.snapshotTtlSeconds ?? 0) * 1000;
  const maxAgeMs = Math.max(
    0,
    deps.snapshotMaxAgeSeconds ?? DEFAULT_SNAPSHOT_MAX_AGE_SECONDS,
  ) *
    1000;
  const key = snapshotKey(input);
  const warn = deps.warn ?? deps.log ?? console.error;

  const reusable = snapshot !== null && snapshot.key === key ? snapshot : null;
  if (reusable !== null && ttlMs > 0 && now() - reusable.at < ttlMs) {
    const result: DerivedAuthorsResult = {
      ...reusable.result,
      servedFrom: {
        snapshot: "within-ttl",
        ageSeconds: Math.floor((now() - reusable.at) / 1000),
      },
    };
    cycleCache = { cycleId: deps.cycleId, result };
    return result;
  }

  let result = await resolveFresh(input, deps);
  if (result.ok) {
    snapshot = { key, at: now(), result };
  } else if (
    result.transient === true && reusable !== null &&
    now() - reusable.at < maxAgeMs
  ) {
    const ageSeconds = Math.floor((now() - reusable.at) / 1000);
    warn(
      `[derived-authors] refresh failed transiently on ${result.failedSource} ` +
        `(${result.reason}); serving the trusted-author snapshot fetched ` +
        `${ageSeconds}s ago, for at most ${
          Math.floor(maxAgeMs / 1000)
        }s (Issue #1453)`,
    );
    result = {
      ...reusable.result,
      servedFrom: {
        snapshot: "after-transient-failure",
        ageSeconds,
        reason: result.reason,
      },
    };
  }
  cycleCache = { cycleId: deps.cycleId, result };
  return result;
}

/** One line naming the repos left out of the fold, said once per change. */
function reportSkipped(
  skipped: readonly SkippedRepo[],
  githubUser: string,
  warn: (message: string) => void,
): void {
  const key = skipped.map((s) => s.repo).sort().join(",");
  if (key === lastSkippedKey) return;
  lastSkippedKey = key;
  if (skipped.length === 0) return;
  const named = skipped
    .map((s) => `${s.repo} (${s.detail.split("\n")[0]?.trim() ?? ""})`)
    .join(", ");
  warn(
    `[derived-authors] ${skipped.length} monitored repo(s) skipped — ` +
      `${githubUser} cannot list their collaborators, so they are not a ` +
      `trust source and not a write target: ${named}. Grant push, or ` +
      `remove them from repos (Issue #1453)`,
  );
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
      false,
    );
  }

  const team = await fetchTeamMembers(input.exclusionTeamSlug);
  if (!team.ok) {
    // A team that does not exist, or that this login may not read, is a
    // property of the deployment; anything else may clear on its own.
    const permanent = /\(HTTP 40[34]\)|\bHTTP 40[34]\b|Not Found/i.test(
      team.error.message,
    ) && !/rate limit/i.test(team.error.message);
    return fail(
      team.error.message,
      input.exclusionTeamSlug?.trim() || "exclusion-team",
      !permanent,
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
  const skippedRepos: SkippedRepo[] = [];
  let collaboratorCount = 0;
  let excludedCount = 0;
  let trustedCount = 0;

  for (const repo of input.repos) {
    const fetched = await fetchRepoCollaborators(repo);
    if (!fetched.ok) {
      if (isCollaboratorAccessDenied(fetched)) {
        // Not an outage: this login cannot list — and could not push to —
        // this repo. Leave it out of the fold rather than stand the whole
        // fleet down (Issue #1453).
        skippedRepos.push({ repo, detail: fetched.detail });
        continue;
      }
      // Anything a later attempt might fix is transient; a repo with no
      // write collaborator at all, or a malformed slug, is not.
      const transient = fetched.reason === "gh-failed" ||
        fetched.reason === "malformed-json" ||
        fetched.reason === "http-403";
      return fail(fetched.detail, repo, transient);
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

  reportSkipped(
    skippedRepos,
    input.githubUser,
    deps.warn ?? deps.log ?? console.error,
  );

  if (input.repos.length > 0 && byRepo.size === 0) {
    return fail(
      `no monitored repository is a trust source: ${input.githubUser} cannot ` +
        `list collaborators on any of ${
          skippedRepos.map((s) => s.repo).join(", ")
        } — grant push on the repos the worker should work, or remove them ` +
        `from repos`,
      "collaborators",
      false,
    );
  }

  const repos = [...byRepo.keys()].join(",");
  const line =
    `[derived-authors] repos=${repos} collaborators=${collaboratorCount} ` +
    `excluded=${excludedCount} trusted=${trustedCount}` +
    (skippedRepos.length > 0 ? ` skipped=${skippedRepos.length}` : "");
  (deps.log ?? console.error)(line);

  return { ok: true, byRepo, skippedRepos };
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
