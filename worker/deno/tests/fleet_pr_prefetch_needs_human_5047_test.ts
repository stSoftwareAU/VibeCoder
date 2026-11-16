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
 * A recording `gh` whose per-repo `pr list --author <login>` answers
 * `listings[login]` (as the live listing would, labels included).
 */
function recordingGh(
  calls: string[][],
  listings: Record<string, unknown[]>,
): (args: string[]) => Promise<string> {
  return (args: string[]) => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "list") {
      const author = args[args.indexOf("--author") + 1]!;
      return Promise.resolve(JSON.stringify(listings[author] ?? []));
    }
    return Promise.resolve("[]");
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

function prListCalls(calls: string[][]): string[][] {
  return calls.filter((args) => args[0] === "pr" && args[1] === "list");
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

    const calls: string[][] = [];
    const prs = await listActionablePrs(
      REPO,
      FLEET,
      "number,headRefName",
      scanOptions(recordingGh(calls, {}), cache),
    );

    assertEquals(prs.map((pr) => pr.number), [8]);
    assertEquals(prListCalls(calls), [], "served from the prefetch");
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

    const calls: string[][] = [];
    const gh = recordingGh(calls, {
      [AUTHOR_A]: [{
        ...oldShapeEntry(),
        labels: [{ name: "needs-human" }],
      }],
    });
    const prs = await listActionablePrs(
      REPO,
      FLEET,
      "number,headRefName",
      scanOptions(gh, cache),
    );

    assertEquals(prs.map((pr) => pr.number), [8]);
    assertEquals(
      prListCalls(calls).map((args) => args[args.indexOf("--author") + 1]),
      [AUTHOR_A],
    );
  });
});

Deno.test("listActionablePrs - a label-less entry left by the old prefetch is re-listed live (Issue #5047)", async () => {
  await withTempRoot(async (root) => {
    const cache = new IssueCache(`${root}/cache`, 600);
    await cache.write(REPO, `prs_maint_${AUTHOR_A}`, [oldShapeEntry()]);
    await seedBotDoor(cache);

    const calls: string[][] = [];
    const gh = recordingGh(calls, {
      [AUTHOR_A]: [{ ...oldShapeEntry(), labels: [{ name: "needs-human" }] }],
    });
    const prs = await listActionablePrs(
      REPO,
      [AUTHOR_A],
      "number,headRefName",
      scanOptions(gh, cache),
    );

    assertEquals(prs.map((pr) => pr.number), []);
    assertEquals(prListCalls(calls).length, 1);
    const cached = await cache.read<{ labels?: unknown }[]>(
      REPO,
      `prs_maint_${AUTHOR_A}`,
    );
    assertEquals(cached?.map((pr) => pr.labels), [[{ name: "needs-human" }]]);
  });
});

Deno.test("listActionablePrs - control: an entry that carries labels is served from the cache (Issue #5047)", async () => {
  await withTempRoot(async (root) => {
    const cache = new IssueCache(`${root}/cache`, 600);
    await cache.write(REPO, `prs_maint_${AUTHOR_A}`, [
      { ...oldShapeEntry(), labels: [] },
    ]);
    await seedBotDoor(cache);

    const calls: string[][] = [];
    const prs = await listActionablePrs(
      REPO,
      [AUTHOR_A],
      "number,headRefName",
      scanOptions(recordingGh(calls, {}), cache),
    );

    assertEquals(prs.map((pr) => pr.number), [7]);
    assertEquals(prListCalls(calls), []);
  });
});

Deno.test("listOpenPrs - a caller that does not ask for labels is still served the label-less entry (Issue #5047)", async () => {
  await withTempRoot(async (root) => {
    const cache = new IssueCache(`${root}/cache`, 600);
    await cache.write(REPO, `prs_maint_${AUTHOR_A}`, [oldShapeEntry()]);

    const calls: string[][] = [];
    const prs = await listOpenPrs(
      REPO,
      AUTHOR_A,
      "number,headRefName",
      recordingGh(calls, {}),
      cache,
    );

    assertEquals(prs.map((pr) => pr.number), [7]);
    assertEquals(calls, []);
  });
});
