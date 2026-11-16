/**
 * A needs-human fleet PR served from the cross-repo prefetch is held
 * (Issue #5047).
 *
 * `listActionablePrs` holds a PR by its `labels`. The prefetch wrote the
 * `prs_maint_${author}` entries without them, so a needs-human PR read back
 * from the cache was never held and every lane worked it.
 *
 * These drive the **real** prefetch (over `fakeGithubPrSearch`) and then the
 * real `listActionablePrs` with the same cache:
 *
 *   - the labelled PR is held and the unlabelled one returned, with no
 *     per-repo `gh pr list` (served from the prefetch);
 *   - the prefetched entry carries the labels the search reported;
 *   - a PR whose labels overflowed one page is not served from the prefetch,
 *     so the per-repo listing (which pages them) decides;
 *   - a label-less entry the old prefetch left in the cache is re-listed
 *     live for a caller that needs labels, and still served to one that
 *     does not.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertEquals } from "@std/assert";
import { prefetchFleetOpenPrs } from "../lib/fleet_pr_prefetch.ts";
import { IssueCache } from "../lib/issue_cache.ts";
import {
  listActionablePrs,
  listOpenPrs,
  type PrScanOptions,
} from "../lib/pr_maintenance.ts";
import type { Logger } from "../types.ts";
import {
  fakeGithubPrSearch,
  type FakeSearchPr,
} from "./support/github_graphql_fake.ts";

const REPO = "owner/repo-a";
const AUTHOR_A = "VibeCoderST";
const AUTHOR_B = "stservice";
const FLEET = [AUTHOR_A, AUTHOR_B];

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

async function withTempRoot(
  body: (root: string) => Promise<void>,
): Promise<void> {
  const root = Deno.makeTempDirSync({ prefix: "pr-needs-human-5047-" });
  try {
    await body(root);
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
}

function fleetPr(
  number: number,
  author: string,
  extra: Partial<FakeSearchPr> = {},
): FakeSearchPr {
  return {
    repo: REPO,
    number,
    author,
    title: `PR ${number}`,
    baseRefName: "main",
    headRefName: `issue-${number}-fix`,
    headRefOid: `oid-${number}`,
    isDraft: false,
    ...extra,
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
  assertEquals(served.ownersServed, ["owner"]);
  await seedBotDoor(cache);
}

/** Seed the bot-PR door's listing empty so it makes no `gh` call. */
async function seedBotDoor(cache: IssueCache): Promise<void> {
  await cache.write(REPO, "prs_open_all", []);
}

/**
 * A live `gh` whose per-repo `pr list --author <login>` answers
 * `listings[login]` (as the live listing would, labels included). The tests
 * give it PRs the cache does not hold, so the PRs returned show which source
 * (cache or live listing) served each author.
 */
function liveGh(
  listings: Record<string, unknown[]>,
): (args: string[]) => Promise<string> {
  return (args: string[]) => {
    if (args[0] === "pr" && args[1] === "list") {
      const author = args[args.indexOf("--author") + 1]!;
      return Promise.resolve(JSON.stringify(listings[author] ?? []));
    }
    return Promise.resolve("[]");
  };
}

/** A live listing entry for PR `number`, with its `labels`. */
function livePr(
  number: number,
  labels: string[] = [],
): Record<string, unknown> {
  return {
    ...oldShapeEntry(),
    number,
    title: `PR ${number}`,
    headRefName: `issue-${number}-fix`,
    headRefOid: `oid-${number}`,
    labels: labels.map((name) => ({ name })),
  };
}

function scanOptions(
  gh: (args: string[]) => Promise<string>,
  cache: IssueCache,
): PrScanOptions {
  return {
    githubUser: AUTHOR_A,
    prAuthors: FLEET,
    repos: [REPO],
    logger: makeSilentLogger(),
    isRepoAllowed: () => true,
    isAuthorisedCommenter: () => true,
    ghCommandFn: gh,
    cache,
  };
}

/** The label-less entry shape the prefetch wrote before Issue #5047. */
function oldShapeEntry(): Record<string, unknown> {
  return {
    number: 7,
    title: "PR 7",
    headRefName: "issue-7-fix",
    headRefOid: "oid-7",
    baseRefName: "main",
    author: { login: AUTHOR_A },
    isDraft: false,
  };
}

Deno.test("listActionablePrs - a needs-human fleet PR served from the prefetch is held (Issue #5047)", async () => {
  await withTempRoot(async (root) => {
    const cache = new IssueCache(`${root}/cache`, 600);
    await prefetchInto(cache, [
      fleetPr(7, AUTHOR_A, { labels: ["needs-human"] }),
      fleetPr(8, AUTHOR_A),
    ]);

    // The live listing holds a PR the prefetch does not: it must not appear,
    // because the prefetched listing is what serves this author.
    const prs = await listActionablePrs(
      REPO,
      FLEET,
      "number,headRefName",
      scanOptions(liveGh({ [AUTHOR_A]: [livePr(99)] }), cache),
    );

    assertEquals(prs.map((pr) => pr.number), [8]);
  });
});

Deno.test("prefetch - the prs_maint entry carries the labels the search reported (Issue #5047)", async () => {
  await withTempRoot(async (root) => {
    const cache = new IssueCache(`${root}/cache`, 600);
    await prefetchInto(cache, [
      fleetPr(7, AUTHOR_A, { labels: ["needs-human"] }),
      fleetPr(8, AUTHOR_A),
    ]);

    const entries = await cache.read<
      { number: number; labels?: unknown }[]
    >(REPO, `prs_maint_${AUTHOR_A}`);
    assertEquals(entries?.map((pr) => [pr.number, pr.labels]), [
      [7, [{ name: "needs-human" }]],
      [8, []],
    ]);
  });
});

Deno.test("prefetch - a PR whose labels overflowed one page is left to the per-repo listing (Issue #5047)", async () => {
  await withTempRoot(async (root) => {
    const cache = new IssueCache(`${root}/cache`, 600);
    await prefetchInto(cache, [
      fleetPr(7, AUTHOR_A, { labels: ["bug"], extraLabels: 1 }),
      fleetPr(8, AUTHOR_B),
    ]);

    assertEquals(await cache.read(REPO, `prs_maint_${AUTHOR_A}`), null);
    assertEquals(
      (await cache.read<{ number: number }[]>(REPO, `prs_maint_${AUTHOR_B}`))
        ?.map((pr) => pr.number),
      [8],
    );

    // Author A's live listing holds the needs-human PR 7 (held) and PR 9
    // (not held), which the prefetch never saw: returning 9 shows A's listing
    // was read live rather than dropped. Author B is served from the cache.
    const gh = liveGh({
      [AUTHOR_A]: [livePr(7, ["needs-human"]), livePr(9)],
    });
    const prs = await listActionablePrs(
      REPO,
      FLEET,
      "number,headRefName",
      scanOptions(gh, cache),
    );

    assertEquals(prs.map((pr) => pr.number).sort(), [8, 9]);
  });
});

Deno.test("listActionablePrs - a label-less entry left by the old prefetch is re-listed live (Issue #5047)", async () => {
  await withTempRoot(async (root) => {
    const cache = new IssueCache(`${root}/cache`, 600);
    await cache.write(REPO, `prs_maint_${AUTHOR_A}`, [oldShapeEntry()]);
    await seedBotDoor(cache);

    // The live listing now holds PR 7 with needs-human, plus PR 9. Serving the
    // old entry would return 7; the live re-list holds 7 and returns 9.
    const gh = liveGh({
      [AUTHOR_A]: [livePr(7, ["needs-human"]), livePr(9)],
    });
    const prs = await listActionablePrs(
      REPO,
      [AUTHOR_A],
      "number,headRefName",
      scanOptions(gh, cache),
    );

    assertEquals(prs.map((pr) => pr.number), [9]);
    const cached = await cache.read<{ number: number; labels?: unknown }[]>(
      REPO,
      `prs_maint_${AUTHOR_A}`,
    );
    assertEquals(cached?.map((pr) => [pr.number, pr.labels]), [
      [7, [{ name: "needs-human" }]],
      [9, []],
    ]);
  });
});

Deno.test("listActionablePrs - control: an entry that carries labels is served from the cache (Issue #5047)", async () => {
  await withTempRoot(async (root) => {
    const cache = new IssueCache(`${root}/cache`, 600);
    await cache.write(REPO, `prs_maint_${AUTHOR_A}`, [
      { ...oldShapeEntry(), labels: [] },
    ]);
    await seedBotDoor(cache);

    const prs = await listActionablePrs(
      REPO,
      [AUTHOR_A],
      "number,headRefName",
      scanOptions(liveGh({ [AUTHOR_A]: [livePr(99)] }), cache),
    );

    assertEquals(prs.map((pr) => pr.number), [7]);
  });
});

Deno.test("listOpenPrs - a caller that does not ask for labels is still served the label-less entry (Issue #5047)", async () => {
  await withTempRoot(async (root) => {
    const cache = new IssueCache(`${root}/cache`, 600);
    await cache.write(REPO, `prs_maint_${AUTHOR_A}`, [oldShapeEntry()]);

    const prs = await listOpenPrs(
      REPO,
      AUTHOR_A,
      "number,headRefName",
      liveGh({ [AUTHOR_A]: [livePr(99)] }),
      cache,
    );

    assertEquals(prs.map((pr) => pr.number), [7]);
  });
});
