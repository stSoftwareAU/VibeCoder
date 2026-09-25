/**
 * The cross-repo PR prefetch keeps serving under a failed or rate-limited
 * search (Issue #2662, criterion 5).
 *
 * GRQ-23 on 2026-09-25 spent 3,281 GraphQL calls on the per-repo
 * `gh pr list --author … --state open` listing that the cross-repo prefetch
 * (Issue #1486) exists to replace. When the owner-wide search failed - most
 * often because the shared account's quota was gone - every consumer fell
 * back to listing each repo per author, multiplying calls at exactly the
 * moment the budget was spent, for every host sharing the account.
 *
 * These tests drive the **real** prefetch and the **real** consumers
 * (`fetchOpenPRsForFleet`, `listOpenPrs`) over a 20-repo fixture fleet with a
 * counting `gh` stub, and an injected clock for both the cache and the
 * prefetch - no network, no sleeps. They count one cycle's `gh pr list`
 * calls before and after:
 *
 *   - a search that fails inside the reuse window is served from the last
 *     good result: zero per-repo listings (was 120 a cycle);
 *   - a rate-limited search is never answered with per-repo listings; with no
 *     usable result the prefetch reports it so the cycle waits for the quota;
 *   - beyond the window the per-repo path still runs, once per repo per cache
 *     window - the saving is forfeited, never the correctness;
 *   - a reused result fills only missing entries, never a live one;
 *   - the post-scan auto-merge pass lists live only the repos the cycle
 *     claimed from (was every repo);
 *   - what the scan would claim is identical on every path.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals } from "@std/assert";
import {
  PREFETCH_REUSE_WINDOW_SECONDS,
  prefetchFleetOpenPrs,
} from "../lib/fleet_pr_prefetch.ts";
import { IssueCache } from "../lib/issue_cache.ts";
import {
  fetchOpenPRsByUser,
  fetchOpenPRsForFleet,
  type OpenPR,
} from "../lib/issue_query.ts";
import {
  listOpenPrs,
  PR_MAINTENANCE_LIST_FIELDS,
} from "../lib/pr_maintenance.ts";
import { refreshesRepoLive } from "../lib/run_core.ts";
import {
  fakeGithubPrSearch,
  type FakeSearchPr,
} from "./support/github_graphql_fake.ts";

// ---------------------------------------------------------------------------
// Fixture: a 20-repo fleet under one owner
// ---------------------------------------------------------------------------

const OWNER = "fleet";
const REPOS = Array.from(
  { length: 20 },
  (_, i) => `${OWNER}/repo-${String(i + 1).padStart(2, "0")}`,
);
/** Two fleet accounts and two trusted humans - the duplicate guard's set. */
const FLEET = ["VibeCoderST", "stservice"];
const HUMANS = ["alice", "bob"];
const GUARD = [...FLEET, ...HUMANS];

/** Open PRs on the fake GitHub: fleet PRs block repos 01, 02 and 05. */
function fixturePrs(): FakeSearchPr[] {
  const pr = (
    repo: number,
    number: number,
    author: string,
    extra: Partial<FakeSearchPr> = {},
  ): FakeSearchPr => ({
    repo: REPOS[repo - 1]!,
    number,
    author,
    title: `PR ${number}`,
    baseRefName: "main",
    headRefName: `issue-${number}`,
    ...extra,
  });
  return [
    pr(1, 101, "VibeCoderST"),
    pr(2, 201, "stservice"),
    pr(5, 501, "VibeCoderST", { isDraft: true }),
    pr(7, 701, "alice"),
  ];
}

const T0_MS = Date.UTC(2026, 8, 25, 10, 0, 0);
const MINUTE_MS = 60_000;

/** An injectable clock shared by the cache and the prefetch. */
interface Clock {
  ms: number;
}

function testCache(clock: Clock): IssueCache {
  return new IssueCache(
    Deno.makeTempDirSync({ prefix: "prefetch-budget-2662-" }),
    600,
    () => clock.ms,
  );
}

type SearchMode = "ok" | "rate-limited" | "error";

/**
 * A counting `gh` stub. The search is answered by the fake GitHub (or refused
 * per `mode`); a per-repo `gh pr list` is counted and answered from the same
 * server state, so the per-repo path and the prefetch see one truth.
 */
function countingGh(server: FakeSearchPr[]) {
  const state = { mode: "ok" as SearchMode, prList: 0, searches: 0 };
  const gh = (args: string[]): Promise<string> => {
    if (args[0] === "api" && args[1] === "graphql") {
      state.searches++;
      if (state.mode === "rate-limited") {
        return Promise.reject(
          new Error(
            "gh: API rate limit exceeded for user ID 1. If you reach out " +
              "to GitHub Support for help, please include the request ID",
          ),
        );
      }
      if (state.mode === "error") {
        return Promise.reject(new Error("HTTP 502: Bad Gateway"));
      }
      return fakeGithubPrSearch(server).gh(args);
    }
    if (args[0] === "pr" && args[1] === "list") {
      state.prList++;
      const repo = args[args.indexOf("--repo") + 1]!;
      const author = args[args.indexOf("--author") + 1]!.toLowerCase();
      const rows = server
        .filter((pr) =>
          pr.repo === repo && pr.author.toLowerCase() === author &&
          (pr.state ?? "open") === "open"
        )
        .map((pr) => ({
          number: pr.number,
          title: pr.title ?? `PR ${pr.number}`,
          baseRefName: pr.baseRefName ?? "main",
          headRefName: pr.headRefName ?? `branch-${pr.number}`,
          headRefOid: pr.headRefOid ?? `oid-${pr.number}`,
          isDraft: pr.isDraft ?? false,
          author: { login: pr.author },
        }));
      return Promise.resolve(JSON.stringify(rows));
    }
    return Promise.reject(new Error(`unexpected gh call: ${args.join(" ")}`));
  };
  return { gh, state };
}

function prefetch(
  cache: IssueCache,
  gh: (args: string[]) => Promise<string>,
  clock: Clock,
  log: string[] = [],
) {
  return prefetchFleetOpenPrs({
    repos: REPOS,
    guardAuthors: GUARD,
    maintenanceAuthors: FLEET,
    invitationAuthors: HUMANS,
    cache,
    ghCommandFn: gh,
    now: () => clock.ms,
    log: (message) => log.push(message),
  });
}

/**
 * What one cycle's consumers read: the scan's duplicate guard across every
 * repo, and the PR-maintenance listing across every repo. Returns each
 * repo's guard view, for the claim comparison.
 */
async function consumeCycle(
  cache: IssueCache,
  gh: (args: string[]) => Promise<string>,
): Promise<Map<string, OpenPR[]>> {
  const views = new Map<string, OpenPR[]>();
  for (const repo of REPOS) {
    views.set(repo, await fetchOpenPRsForFleet(repo, GUARD, cache, gh));
    await listOpenPrs(repo, FLEET, PR_MAINTENANCE_LIST_FIELDS, gh, cache);
  }
  return views;
}

/**
 * The repo the scan would claim from: the first whose fleet guard view holds
 * no fleet-authored PR. A stand-in for the claim decision that depends only
 * on the data the guard reads - which is exactly what these tests vary.
 */
function claimedRepo(views: Map<string, OpenPR[]>): string | null {
  for (const repo of REPOS) {
    const prs = views.get(repo) ?? [];
    if (!prs.some((pr) => FLEET.includes(pr.author ?? ""))) return repo;
  }
  return null;
}

/** Numbers per repo, so views compare regardless of object identity. */
function numbers(views: Map<string, OpenPR[]>): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const [repo, prs] of views) {
    out[repo] = prs.map((pr) => pr.number).sort((a, b) => a - b);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reuse inside the window
// ---------------------------------------------------------------------------

Deno.test("#2662 - a rate-limited search reuses the last good prefetch: zero per-repo listings", async () => {
  const clock = { ms: T0_MS };
  const cache = testCache(clock);
  const { gh, state } = countingGh(fixturePrs());

  await prefetch(cache, gh, clock);
  const healthy = await consumeCycle(cache, gh);
  assertEquals(state.prList, 0, "a healthy cycle lists nothing per repo");

  // Eleven minutes on: the listing cache (600 s) and the prefetch marker have
  // both expired, and the shared account's quota is gone.
  clock.ms += 11 * MINUTE_MS;
  state.mode = "rate-limited";
  state.prList = 0;
  const log: string[] = [];
  const result = await prefetch(cache, gh, clock, log);
  const limited = await consumeCycle(cache, gh);

  assertEquals(
    state.prList,
    0,
    `a rate-limited cycle must not fall back to per-repo listings ` +
      `(was ${REPOS.length * (GUARD.length + FLEET.length)} a cycle)`,
  );
  assertEquals(result.ownersReused.map((r) => r.owner), [OWNER]);
  assertEquals(result.ownersSkipped, []);
  assert(log.some((line) => line.includes("reusing the last good")));
  assert(!log.some((line) => line.includes("falling back to per-repo")));
  assertEquals(numbers(limited), numbers(healthy), "consumers see the same");
  assertEquals(claimedRepo(limited), claimedRepo(healthy));
  assertEquals(claimedRepo(limited), `${OWNER}/repo-03`);
});

Deno.test("#2662 - a failed search inside the window reuses the last good prefetch", async () => {
  const clock = { ms: T0_MS };
  const cache = testCache(clock);
  const { gh, state } = countingGh(fixturePrs());

  await prefetch(cache, gh, clock);
  clock.ms += 30 * MINUTE_MS;
  state.mode = "error";
  const result = await prefetch(cache, gh, clock);
  await consumeCycle(cache, gh);

  assertEquals(state.prList, 0, "served from the last good result");
  assertEquals(result.ownersReused.length, 1);
  assertEquals(result.ownersReused[0]!.ageSeconds, 30 * 60);
});

Deno.test("#2662 - beyond the window the per-repo path runs, once per repo per cache window", async () => {
  const clock = { ms: T0_MS };
  const cache = testCache(clock);
  const { gh, state } = countingGh(fixturePrs());

  await prefetch(cache, gh, clock);
  clock.ms += (PREFETCH_REUSE_WINDOW_SECONDS + 60) * 1000;
  state.mode = "error";
  const log: string[] = [];
  const result = await prefetch(cache, gh, clock, log);
  const fallback = await consumeCycle(cache, gh);

  assertEquals(result.ownersReused, [], "too old to reuse");
  assertEquals(result.ownersSkipped.map((s) => s.owner), [OWNER]);
  assert(log.some((line) => line.includes("falling back to per-repo")));
  assertEquals(state.prList, REPOS.length * (GUARD.length + FLEET.length));

  // The next cycle, two minutes later, still cannot search - and does not
  // list any repo again inside the cache window.
  clock.ms += 2 * MINUTE_MS;
  state.prList = 0;
  await prefetch(cache, gh, clock);
  const again = await consumeCycle(cache, gh);
  assertEquals(state.prList, 0, "at most once per repo per window");
  assertEquals(claimedRepo(again), claimedRepo(fallback));
});

Deno.test("#2662 - rate-limited with no usable result: no per-repo fallback, reported as rate-limited", async () => {
  const clock = { ms: T0_MS };
  const cache = testCache(clock);
  const { gh, state } = countingGh(fixturePrs());
  state.mode = "rate-limited";

  const log: string[] = [];
  const result = await prefetch(cache, gh, clock, log);

  assertEquals(result.ownersRateLimited.map((r) => r.owner), [OWNER]);
  assert(result.ownersRateLimited[0]!.reason.includes("API rate limit"));
  assertEquals(result.ownersSkipped, [], "not left on the per-repo path");
  assertEquals(result.entriesWritten, 0);
  assert(!log.some((line) => line.includes("falling back to per-repo")));
  assert(log.some((line) => line.includes("waits for the quota")));
});

Deno.test("#2662 - a healthy search is still preferred over the last good result", async () => {
  const clock = { ms: T0_MS };
  const cache = testCache(clock);
  const server = fixturePrs();
  const { gh } = countingGh(server);

  await prefetch(cache, gh, clock);
  // PR 101 merges; a new cycle past the TTL searches and sees it gone.
  server.splice(0, 1);
  clock.ms += 11 * MINUTE_MS;
  const result = await prefetch(cache, gh, clock);
  const views = await consumeCycle(cache, gh);

  assertEquals(result.ownersServed, [OWNER]);
  assertEquals(result.ownersReused, []);
  assertEquals(numbers(views)[REPOS[0]!], []);
  assertEquals(claimedRepo(views), REPOS[0]);
});

Deno.test("#2662 - a reused result fills only missing entries, never a live one", async () => {
  const clock = { ms: T0_MS };
  const cache = testCache(clock);
  const server = fixturePrs();
  const { gh, state } = countingGh(server);

  await prefetch(cache, gh, clock);

  // Nine minutes on, a sibling opens PR 199 in repo-01 and the claim-time
  // re-check lists that repo live (forceRefresh), refreshing its entry.
  clock.ms += 9 * MINUTE_MS;
  server.push({
    repo: REPOS[0]!,
    number: 199,
    author: "VibeCoderST",
    title: "PR 199",
    baseRefName: "main",
    headRefName: "issue-199",
  });
  await fetchOpenPRsByUser(REPOS[0]!, "VibeCoderST", cache, gh, true);

  // Two minutes later the search is rate-limited and the stale result is
  // reused - but the live entry, still inside its TTL, must win.
  clock.ms += 2 * MINUTE_MS;
  state.mode = "rate-limited";
  await prefetch(cache, gh, clock);
  const live = await cache.read<OpenPR[]>(REPOS[0]!, "prs_VibeCoderST");
  assertEquals(live?.map((pr) => pr.number).sort(), [101, 199]);
});

Deno.test("#2662 - invitation listings are never served from a reused result", async () => {
  const clock = { ms: T0_MS };
  const cache = testCache(clock);
  const { gh, state } = countingGh(fixturePrs());

  await prefetch(cache, gh, clock);
  clock.ms += 11 * MINUTE_MS;
  state.mode = "error";
  await prefetch(cache, gh, clock);

  // A human PR is admitted only on a current reading of its conversation, so
  // the invitation listing fails closed to its own per-repo path.
  assertEquals(await cache.read(REPOS[6]!, "prs_invited_alice"), null);
  assert(
    (await cache.read(REPOS[6]!, "prs_alice")) !== null,
    "the duplicate guard's entry is reused",
  );
});

Deno.test("#2662 - the prefetched open-PR entry carries isDraft", async () => {
  const clock = { ms: T0_MS };
  const cache = testCache(clock);
  const { gh, state } = countingGh(fixturePrs());

  await prefetch(cache, gh, clock);
  const draft = await fetchOpenPRsByUser(REPOS[4]!, "VibeCoderST", cache, gh);

  assertEquals(state.prList, 0);
  // Issue #1800: the auto-merge sweep skips a draft; served from the
  // prefetch it must still know the PR is one.
  assertEquals(draft.map((pr) => pr.isDraft), [true]);
});

// ---------------------------------------------------------------------------
// Post-scan auto-merge pass
// ---------------------------------------------------------------------------

Deno.test("#2662 - the post-scan sweep lists live only the repos the cycle claimed from", async () => {
  const clock = { ms: T0_MS };
  const cache = testCache(clock);
  const { gh, state } = countingGh(fixturePrs());

  await prefetch(cache, gh, clock);
  const claimed = `${OWNER}/repo-03`;
  const opts = { refreshOpenPrs: true, refreshRepos: [claimed] };
  for (const repo of REPOS) {
    await fetchOpenPRsForFleet(
      repo,
      FLEET,
      cache,
      gh,
      undefined,
      refreshesRepoLive(opts, repo),
    );
  }

  assertEquals(
    state.prList,
    FLEET.length,
    `one live listing per fleet author in the claimed repo ` +
      `(was ${REPOS.length * FLEET.length})`,
  );
  // Both directions: without the repo list every repo is listed live, as the
  // pass always did; without refreshOpenPrs nothing is.
  assertEquals(refreshesRepoLive({ refreshOpenPrs: true }, REPOS[0]!), true);
  assertEquals(refreshesRepoLive(opts, REPOS[0]!), false);
  assertEquals(refreshesRepoLive(opts, claimed), true);
  assertEquals(refreshesRepoLive(undefined, claimed), false);
  assertEquals(
    refreshesRepoLive({ refreshRepos: [claimed] }, claimed),
    false,
  );
});

// ---------------------------------------------------------------------------
// The whole picture, one number per cycle
// ---------------------------------------------------------------------------

Deno.test("#2662 - per-cycle pr list calls on a 20-repo fleet, and the same claim on every path", async () => {
  // The per-repo path with no prefetch at all: what the fallback costs, and
  // the claim it produces - the reference every other path must match.
  const refClock = { ms: T0_MS };
  const refCache = testCache(refClock);
  const reference = countingGh(fixturePrs());
  const refViews = await consumeCycle(refCache, reference.gh);
  const perRepoCost = reference.state.prList;
  assertEquals(perRepoCost, REPOS.length * (GUARD.length + FLEET.length));

  const clock = { ms: T0_MS };
  const cache = testCache(clock);
  const { gh, state } = countingGh(fixturePrs());
  const perCycle: Record<string, number> = {};

  await prefetch(cache, gh, clock);
  perCycle.healthy = state.prList;
  const healthy = await consumeCycle(cache, gh);
  perCycle.healthy = state.prList - perCycle.healthy;

  for (
    const [label, mode] of [["failed", "error"], [
      "rate-limited",
      "rate-limited",
    ]] as const
  ) {
    clock.ms += 11 * MINUTE_MS;
    state.mode = mode;
    const before = state.prList;
    await prefetch(cache, gh, clock);
    const views = await consumeCycle(cache, gh);
    perCycle[label] = state.prList - before;
    assertEquals(claimedRepo(views), claimedRepo(refViews), label);
    assertEquals(numbers(views), numbers(refViews), label);
  }

  assertEquals(perCycle, { healthy: 0, failed: 0, "rate-limited": 0 });
  assertEquals(claimedRepo(healthy), claimedRepo(refViews));
});
