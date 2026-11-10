/**
 * A draft fleet PR's by-design failing `gate` check is not handed to the
 * CI-fix scan when the listing is served from the cross-repo prefetch
 * (Issue #4951).
 *
 * The scan's draft filter reads `isDraft` from the listing it is given. The
 * prefetch writes the `prs_maint_${author}` entries that listing is served
 * from, and it used to leave `isDraft` out, so a draft read back from the
 * cache looked ready and the scan ran an agent on its `gate` check 24 times.
 *
 * These drive the **real** prefetch (over `fakeGithubPrSearch`, which models
 * the search API's own rules) and then the **real** `findFailedCiChecks`
 * with the same cache, so the listing comes from the prefetch rather than a
 * per-repo `gh pr list`:
 *
 *   - a draft fleet PR whose `gate` check failed is not returned (negative);
 *   - the same PR, not a draft, is returned (positive control: only
 *     `isDraft` differs);
 *   - the prefetched `prs_maint_${author}` entry carries `isDraft` true or
 *     false, as the search reported it.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals } from "@std/assert";
import { prefetchFleetOpenPrs } from "../lib/fleet_pr_prefetch.ts";
import { IssueCache } from "../lib/issue_cache.ts";
import {
  type CiCheckScanOptions,
  findFailedCiChecks,
} from "../lib/pr_maintenance.ts";
import type { Logger } from "../types.ts";
import {
  fakeGithubPrSearch,
  type FakeSearchPr,
} from "./support/github_graphql_fake.ts";

const OWNER = "owner";
const REPO = "owner/repo-a";
/** The scan's own login and the fleet's PR authors (`prAuthors`). */
const GITHUB_USER = "VibeCoderST";
const FLEET = ["VibeCoderST", "stservice"];

function makeSilentLogger(): Logger {
  const noop = () => {};
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    security: noop,
    skipReason: noop,
    timing: noop,
    scanSummary: noop,
    workerSummary: noop,
  };
}

/** Run `body` with a fresh temp root holding the cache and the state dir. */
async function withTempRoot(
  body: (root: string) => Promise<void>,
): Promise<void> {
  const root = Deno.makeTempDirSync({ prefix: "pr-draft-ci-4951-" });
  try {
    await body(root);
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
}

/** One open fleet PR on {@link REPO}, with its head and draft state. */
function fleetPr(
  number: number,
  author: string,
  isDraft: boolean,
): FakeSearchPr {
  return {
    repo: REPO,
    number,
    author,
    title: `PR ${number}`,
    baseRefName: "main",
    headRefName: `issue-${number}-fix`,
    headRefOid: `oid-${number}`,
    isDraft,
  };
}

/** Run the real prefetch over `prs` into `cache`, as a cycle does. */
async function prefetchInto(
  cache: IssueCache,
  prs: FakeSearchPr[],
): Promise<void> {
  const served = await prefetchFleetOpenPrs({
    repos: [REPO],
    guardAuthors: FLEET,
    maintenanceAuthors: FLEET,
    cache,
    ghCommandFn: fakeGithubPrSearch(prs).gh,
  });
  // Sanity: the prefetch really served the owner, so the scan below reads
  // the cache and not a fallback listing.
  assertEquals(served.ownersServed, [OWNER]);
  // The bot-PR door reads the repo's un-filtered listing from the cache too
  // (`prs_open_all`). Seed it empty so the whole scan is cache-served and no
  // `gh pr list` of any kind is left to assert about.
  await cache.write(REPO, "prs_open_all", []);
}

/**
 * A `gh` stub for the CI-fix scan. It records every call, answers a per-repo
 * `gh pr list` faithfully (so a fallback would still see `isDraft`), and
 * serves one failing `gate` check for every check-run read.
 */
function ciGh(
  calls: string[][],
  prs: FakeSearchPr[],
): (args: string[]) => Promise<string> {
  return (args: string[]) => {
    calls.push(args);
    const key = args.join(" ");
    if (key.includes("pr list")) {
      return Promise.resolve(JSON.stringify(prs.map((pr) => ({
        number: pr.number,
        headRefName: pr.headRefName,
        headRefOid: pr.headRefOid,
        baseRefName: pr.baseRefName,
        author: { login: pr.author },
        isDraft: pr.isDraft ?? false,
      }))));
    }
    if (key.includes("annotations")) return Promise.resolve("[]");
    if (key.includes("check-runs")) {
      return Promise.resolve(JSON.stringify([{
        id: 4951,
        name: "gate",
        status: "completed",
        conclusion: "failure",
      }]));
    }
    return Promise.resolve("[]");
  };
}

/** The scan's options: the prefetch cache and a temp state directory. */
function scanOptions(
  ghCommandFn: (args: string[]) => Promise<string>,
  cache: IssueCache,
  stateDir: string,
): CiCheckScanOptions {
  return {
    githubUser: GITHUB_USER,
    prAuthors: FLEET,
    repos: [REPO],
    logger: makeSilentLogger(),
    isRepoAllowed: () => true,
    isAuthorisedCommenter: () => true,
    ghCommandFn,
    cache,
    stateDir,
  };
}

/** The `gh pr list` calls the scan issued, if any. */
function prListCalls(calls: string[][]): string[][] {
  return calls.filter((args) => args[0] === "pr" && args[1] === "list");
}

Deno.test("findFailedCiChecks - a draft fleet PR's failing gate is not returned when the listing is served from the prefetch (Issue #4951)", async () => {
  await withTempRoot(async (root) => {
    const cache = new IssueCache(`${root}/cache`, 600);
    const prs = [fleetPr(7, "VibeCoderST", true)];
    await prefetchInto(cache, prs);

    const calls: string[][] = [];
    const result = await findFailedCiChecks(
      scanOptions(ciGh(calls, prs), cache, `${root}/ci-state`),
    );

    assertEquals(result.ok, true);
    if (result.ok) assertEquals(result.value, null);
    assertEquals(
      prListCalls(calls),
      [],
      "the listing was served from the prefetch, not a per-repo gh pr list",
    );
  });
});

Deno.test("findFailedCiChecks - the same PR, not a draft, is returned with its failing gate (Issue #4951 positive control)", async () => {
  await withTempRoot(async (root) => {
    const cache = new IssueCache(`${root}/cache`, 600);
    const prs = [fleetPr(7, "VibeCoderST", false)];
    await prefetchInto(cache, prs);

    const calls: string[][] = [];
    const result = await findFailedCiChecks(
      scanOptions(ciGh(calls, prs), cache, `${root}/ci-state`),
    );

    assertEquals(result.ok, true);
    if (result.ok) {
      assert(result.value !== null, "expected the failing gate to be returned");
      assertEquals(result.value.checkName, "gate");
      assertEquals(result.value.prNumber, 7);
    }
    assertEquals(
      prListCalls(calls),
      [],
      "the listing was served from the prefetch, not a per-repo gh pr list",
    );
  });
});

Deno.test("prefetch - the prs_maint entry carries isDraft true for a draft and false for a ready PR (Issue #4951)", async () => {
  await withTempRoot(async (root) => {
    const cache = new IssueCache(`${root}/cache`, 600);
    await prefetchInto(cache, [
      fleetPr(7, "VibeCoderST", true),
      fleetPr(8, "stservice", false),
    ]);

    const byVibe = await cache.read<{ number: number; isDraft?: unknown }[]>(
      REPO,
      "prs_maint_VibeCoderST",
    );
    const byService = await cache.read<{ number: number; isDraft?: unknown }[]>(
      REPO,
      "prs_maint_stservice",
    );

    assertEquals(byVibe?.map((pr) => [pr.number, pr.isDraft]), [[7, true]]);
    assertEquals(byService?.map((pr) => [pr.number, pr.isDraft]), [[8, false]]);
  });
});
