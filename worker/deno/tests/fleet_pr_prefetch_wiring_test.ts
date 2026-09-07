/**
 * The production factory wires the cross-repo open-PR prefetch (Issue #1486).
 *
 * The prefetch can be perfect and still change nothing about a running
 * worker, because the only thing that switches it on is
 * `run_core_production_deps.ts`. So this drives the real
 * `createProductionRunCoreDeps`, calls the real `prefetchFleetOpenPrs` dep it
 * builds with a stubbed `gh`, and then asks the **real** consumers what they
 * see — with a `gh` runner that fails the test if any per-repo listing is
 * issued. Delete the wiring and the first test fails.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { createProductionRunCoreDeps } from "../lib/run_core_production_deps.ts";
import { createLogger } from "../lib/logger.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { IssueCache } from "../lib/issue_cache.ts";
import { fetchOpenPRsForFleet } from "../lib/issue_query.ts";
import {
  listOpenPrs,
  PR_MAINTENANCE_LIST_FIELDS,
} from "../lib/pr_maintenance.ts";
import { listInvitedHumanPrs } from "../lib/pr_invitation_lookup.ts";
import type { TrustedAuthors } from "../lib/derived_authors.ts";
import type { WorkerConfig } from "../types.ts";

const REPO_A = "org/repo-a";
const REPO_B = "org/repo-b";
const WORKER_USER = "worker-bot";
/** A sibling Vibe Coder - `fleet_pr_authors`. */
const SIBLING = "sibling-bot";
/** A trusted human - `allowed_authors` only. */
const HUMAN = "human-dev";

/** One GraphQL search node, as GitHub returns it. */
function searchNode(
  repo: string,
  number: number,
  author: string,
  comments: unknown[] = [],
): Record<string, unknown> {
  return {
    number,
    title: `Work (Issue #${number})`,
    baseRefName: "main",
    headRefName: `issue-${number}-work`,
    headRefOid: `oid-${number}`,
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-02T00:00:00Z",
    isDraft: false,
    mergeable: "MERGEABLE",
    author: { login: author },
    repository: { nameWithOwner: repo },
    labels: { nodes: [] },
    autoMergeRequest: null,
    comments: { nodes: comments },
    reviews: { nodes: [] },
  };
}

/** A `gh` stub answering the one cross-repo search this cycle makes. */
function searchGh(seen: string[][]): (args: string[]) => Promise<string> {
  return (args) => {
    seen.push(args);
    return Promise.resolve(JSON.stringify({
      data: {
        search: {
          issueCount: 3,
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            searchNode(REPO_A, 11, WORKER_USER),
            searchNode(REPO_A, 12, SIBLING),
            searchNode(REPO_A, 13, HUMAN, [
              { author: { login: HUMAN }, body: `@${WORKER_USER} take this` },
            ]),
          ],
        },
      },
    }));
  };
}

/** The collaborator set the stubbed resolver returns for every repo. */
function trusted(): TrustedAuthors {
  return {
    allowedAuthors: [HUMAN, WORKER_USER],
    authorisedCommenters: [HUMAN, WORKER_USER],
  };
}

function fixtureConfig(workDir: string): WorkerConfig {
  return {
    ...buildDefaultWorkerConfig(),
    workDir,
    repos: [REPO_A, REPO_B],
    allowedAuthors: [HUMAN, WORKER_USER],
    fleetPrAuthors: [SIBLING],
  };
}

/** Build the production deps against a scratch work directory. */
async function withDeps(
  gh: (args: string[]) => Promise<string>,
  body: (
    prefetch: () => Promise<void>,
    cache: IssueCache,
  ) => Promise<void>,
): Promise<void> {
  const workDir = await Deno.makeTempDir({ prefix: "fleet-prefetch-wiring-" });
  try {
    const { deps } = await createProductionRunCoreDeps({
      repoDir: workDir,
      workDir,
      githubUser: WORKER_USER,
      logger: createLogger({ write: () => {} }),
      config: fixtureConfig(workDir),
      fleetPrefetchGhCommandFn: gh,
      // The cycle refreshes trust before the prefetch runs, and it is the
      // refreshed `allowed_authors` that decides which humans the invitation
      // listing covers - so resolve it here the way the cycle does.
      resolveTrustedAuthors: () =>
        Promise.resolve({
          ok: true as const,
          byRepo: new Map<string, TrustedAuthors>([
            [REPO_A, trusted()],
            [REPO_B, trusted()],
          ]),
        }),
    });
    assertEquals((await deps.refreshTrustedAuthors!()).ok, true);
    assert(
      deps.prefetchFleetOpenPrs !== undefined,
      "the factory must wire prefetchFleetOpenPrs",
    );
    // The same cache the factory built, at the same location.
    const cache = new IssueCache(`${workDir}/.gh-scan-cache`);
    await body(deps.prefetchFleetOpenPrs, cache);
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
}

/** A `gh` runner recording any per-repo listing the consumers still issue. */
function recordingGh(seen: string[][]): (args: string[]) => Promise<string> {
  return (args) => {
    seen.push(args);
    return Promise.resolve("[]");
  };
}

Deno.test("production deps - one search serves every repo's open-PR guard (Issue #1486)", async () => {
  await withDeps(searchGh([]), async (prefetch, cache) => {
    await prefetch();

    const listings: string[][] = [];
    const inA = await fetchOpenPRsForFleet(
      REPO_A,
      [WORKER_USER, SIBLING, HUMAN],
      cache,
      recordingGh(listings),
    );
    const inB = await fetchOpenPRsForFleet(
      REPO_B,
      [WORKER_USER, SIBLING, HUMAN],
      cache,
      recordingGh(listings),
    );

    assertEquals(inA.map((pr) => pr.number).sort(), [11, 12, 13]);
    assertEquals(inB, [], "a repo with no PR is answered without a call");
    assertEquals(listings, [], "no per-repo listing was issued");
  });
});

Deno.test("production deps - the prefetch issues one search for the whole owner (Issue #1486)", async () => {
  const calls: string[][] = [];
  await withDeps(searchGh(calls), async (prefetch) => {
    await prefetch();
    assertEquals(calls.length, 1, "two repos, one owner, one search");
    assertEquals(calls[0]![0], "api");
    assertEquals(calls[0]![1], "graphql");
    const q = calls[0]!.find((a) => a.startsWith("q="));
    assert(q !== undefined);
    // The factory must hand over every login the listings ask about.
    for (const login of [WORKER_USER, SIBLING, HUMAN]) {
      assert(q.includes(`author:${login}`), `search must cover ${login}`);
    }
  });
});

Deno.test("production deps - the maintenance scan reads the prefetched listing (Issue #1486)", async () => {
  await withDeps(searchGh([]), async (prefetch, cache) => {
    await prefetch();

    const listings: string[][] = [];
    const entries = await listOpenPrs(
      REPO_A,
      [WORKER_USER, SIBLING],
      PR_MAINTENANCE_LIST_FIELDS,
      recordingGh(listings),
      cache,
    );

    assertEquals(listings, [], "no per-repo maintenance listing was issued");
    assertEquals(entries.map((pr) => pr.number).sort(), [11, 12]);
    assertEquals(entries[0]!.headRefOid, "oid-11");
  });
});

Deno.test("production deps - the invitation lookup reads the prefetched listing (Issue #1486)", async () => {
  await withDeps(searchGh([]), async (prefetch, cache) => {
    await prefetch();

    const listings: string[][] = [];
    const admitted = await listInvitedHumanPrs<{ number: number }>({
      repo: REPO_A,
      githubUser: WORKER_USER,
      allowedAuthors: [HUMAN, WORKER_USER],
      fleetPrAuthors: [SIBLING],
      fields: "number,headRefName",
      ghCommandFn: recordingGh(listings),
      cache,
    });

    assertEquals(listings, [], "no per-repo invitation listing was issued");
    assertEquals(admitted.map((pr) => pr.number), [13]);
  });
});

Deno.test("production deps - a failed search leaves the per-repo path in place (Issue #1486)", async () => {
  await withDeps(
    () => Promise.reject(new Error("search unavailable")),
    async (prefetch, cache) => {
      // The prefetch must not throw: the cycle continues without it.
      await prefetch();

      const listings: string[][] = [];
      await fetchOpenPRsForFleet(
        REPO_A,
        [WORKER_USER],
        cache,
        recordingGh(listings),
      );
      assertEquals(listings.length, 1, "the per-repo listing still runs");
      assertEquals(listings[0]![0], "pr");
    },
  );
});
