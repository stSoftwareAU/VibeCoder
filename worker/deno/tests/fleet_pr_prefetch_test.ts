/**
 * Tests for the cross-repo open-PR prefetch (Issue #1486).
 *
 * These drive the **real** consumers against the prefetched cache, so what is
 * proven is the outcome the issue asks for — the fleet PR listings issue O(1)
 * cross-repo queries per cycle instead of O(repos x authors) — rather than the
 * shape of the code that produces it:
 *
 *   - `fetchOpenPRsForFleet`, `listOpenPrs` and `listInvitedHumanPrs` run
 *     across every repo and author with **zero** `gh pr list` calls;
 *   - each one still sees the fields it saw from `gh pr list`;
 *   - a repo with no open PR is answered from the prefetch, not by a call;
 *   - a failed search leaves the per-repo path untouched;
 *   - `forceRefresh` still bypasses the prefetch for read-after-write.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals } from "@std/assert";
import { prefetchFleetOpenPrs } from "../lib/fleet_pr_prefetch.ts";
import type { FleetPrSearchResult } from "../lib/fleet_pr_search.ts";
import { IssueCache } from "../lib/issue_cache.ts";
import { fetchOpenPRsForFleet } from "../lib/issue_query.ts";
import {
  listOpenPrs,
  PR_MAINTENANCE_LIST_FIELDS,
} from "../lib/pr_maintenance.ts";
import { listInvitedHumanPrs } from "../lib/pr_invitation_lookup.ts";

const REPOS = ["owner/repo-a", "owner/repo-b", "owner/repo-c"];
const FLEET = ["VibeCoderST", "stservice"];
const HUMANS = ["alice"];

function testCache(): IssueCache {
  return new IssueCache(
    Deno.makeTempDirSync({ prefix: "fleet-pr-prefetch-" }),
    600,
  );
}

/** One PR as the cross-repo search returns it. */
function searchPr(
  repo: string,
  number: number,
  author: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    repo,
    number,
    title: `Fix it (Issue #${number})`,
    baseRefName: "main",
    headRefName: `issue-${number}-fix`,
    headRefOid: `oid-${number}`,
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-02T00:00:00Z",
    isDraft: false,
    mergeable: "MERGEABLE",
    author,
    labels: ["enhancement"],
    autoMergeRequest: {
      enabledAt: "2026-09-02T01:00:00Z",
      mergeMethod: "SQUASH",
    },
    comments: [],
    reviews: [],
    ...overrides,
  };
}

/** A search stub returning the given PRs for every owner. */
function stubSearch(
  prs: ReturnType<typeof searchPr>[],
  counter?: { calls: number },
): (options: { owner: string }) => Promise<FleetPrSearchResult> {
  return (_options) => {
    if (counter) counter.calls++;
    return Promise.resolve({ ok: true, prs, calls: 1 });
  };
}

/** A gh runner that fails the test if any listing call is made. */
function forbiddenGh(seen: string[][]): (args: string[]) => Promise<string> {
  return (args) => {
    seen.push(args);
    return Promise.resolve("[]");
  };
}

Deno.test("prefetch - one search per owner serves every repo and author", async () => {
  const cache = testCache();
  const counter = { calls: 0 };
  const prs = [
    searchPr("owner/repo-a", 1, "VibeCoderST"),
    searchPr("owner/repo-b", 2, "stservice"),
  ];

  const result = await prefetchFleetOpenPrs({
    repos: REPOS,
    guardAuthors: FLEET,
    maintenanceAuthors: FLEET,
    invitationAuthors: HUMANS,
    cache,
    ghCommandFn: () => Promise.reject(new Error("no gh call expected")),
    searchFn: stubSearch(prs, counter),
  });

  assertEquals(counter.calls, 1, "one search covers the whole owner");
  assertEquals(result.ownersServed, ["owner"]);
  assertEquals(result.ownersSkipped, []);
  // 3 repos x (2 fleet x 2 listings + 1 human x 1 listing) = 15 entries.
  assertEquals(result.entriesWritten, 15);
  assertEquals(result.listingsAvoided, 15);

  // The duplicate guard now runs across every repo without one gh call.
  const calls: string[][] = [];
  for (const repo of REPOS) {
    const open = await fetchOpenPRsForFleet(
      repo,
      FLEET,
      cache,
      forbiddenGh(calls),
    );
    if (repo === "owner/repo-a") {
      assertEquals(open.map((pr) => pr.number), [1]);
      assertEquals(open[0]!.headRefName, "issue-1-fix");
      assertEquals(open[0]!.baseRefName, "main");
      assertEquals(open[0]!.author, "VibeCoderST");
    } else if (repo === "owner/repo-b") {
      assertEquals(open.map((pr) => pr.number), [2]);
    } else {
      assertEquals(open, [], "a repo with no PR is answered from the cache");
    }
  }
  assertEquals(calls, [], "no per-repo listing was issued");
});

Deno.test("prefetch - the maintenance listing keeps its field set", async () => {
  const cache = testCache();
  await prefetchFleetOpenPrs({
    repos: REPOS,
    guardAuthors: FLEET,
    maintenanceAuthors: FLEET,
    cache,
    ghCommandFn: () => Promise.reject(new Error("no gh call expected")),
    searchFn: stubSearch([searchPr("owner/repo-a", 1, "VibeCoderST")]),
  });

  const calls: string[][] = [];
  const entries = await listOpenPrs(
    "owner/repo-a",
    FLEET,
    PR_MAINTENANCE_LIST_FIELDS,
    forbiddenGh(calls),
    cache,
  );

  assertEquals(calls, []);
  assertEquals(entries.length, 1);
  const pr = entries[0]!;
  assertEquals(pr.number, 1);
  assertEquals(pr.headRefName, "issue-1-fix");
  assertEquals(pr.headRefOid, "oid-1");
  assertEquals(pr.baseRefName, "main");
  assertEquals(pr.author?.login, "VibeCoderST");
  assertEquals(pr.autoMergeRequest?.mergeMethod, "SQUASH");
});

Deno.test("prefetch - an invited human PR is admitted from the prefetch", async () => {
  const cache = testCache();
  const invited = searchPr("owner/repo-a", 9, "alice", {
    comments: [{ author: { login: "alice" }, body: "@VibeCoderST take this" }],
  });
  const uninvited = searchPr("owner/repo-b", 10, "alice");

  await prefetchFleetOpenPrs({
    repos: REPOS,
    guardAuthors: FLEET,
    maintenanceAuthors: FLEET,
    invitationAuthors: HUMANS,
    cache,
    ghCommandFn: () => Promise.reject(new Error("no gh call expected")),
    searchFn: stubSearch([invited, uninvited]),
  });

  const calls: string[][] = [];
  const admitted = await listInvitedHumanPrs<{ number: number }>({
    repo: "owner/repo-a",
    githubUser: "VibeCoderST",
    allowedAuthors: ["alice", "VibeCoderST"],
    fleetPrAuthors: FLEET,
    fields: "number,headRefName",
    ghCommandFn: forbiddenGh(calls),
    cache,
  });
  const none = await listInvitedHumanPrs<{ number: number }>({
    repo: "owner/repo-b",
    githubUser: "VibeCoderST",
    allowedAuthors: ["alice", "VibeCoderST"],
    fleetPrAuthors: FLEET,
    fields: "number,headRefName",
    ghCommandFn: forbiddenGh(calls),
    cache,
  });

  assertEquals(calls, [], "no invitation listing was issued");
  assertEquals(admitted.map((pr) => pr.number), [9]);
  assertEquals(none, [], "an uninvited human PR is still not admitted");
});

Deno.test("prefetch - a failed search leaves the per-repo path in place", async () => {
  const cache = testCache();
  const log: string[] = [];
  const result = await prefetchFleetOpenPrs({
    repos: ["owner/repo-a"],
    guardAuthors: ["VibeCoderST"],
    cache,
    ghCommandFn: () => Promise.resolve("[]"),
    log: (message) => log.push(message),
    searchFn: () =>
      Promise.resolve({ ok: false, reason: "truncated", calls: 3 }),
  });

  assertEquals(result.ownersServed, []);
  assertEquals(result.ownersSkipped, [{ owner: "owner", reason: "truncated" }]);
  assertEquals(result.entriesWritten, 0);
  assertEquals(result.searchCalls, 3);
  assert(log.some((line) => line.includes("falling back to per-repo")));

  // Nothing was cached, so the guard still asks GitHub directly.
  const calls: string[][] = [];
  const open = await fetchOpenPRsForFleet(
    "owner/repo-a",
    ["VibeCoderST"],
    cache,
    (args) => {
      calls.push(args);
      return Promise.resolve(
        JSON.stringify([
          {
            number: 5,
            title: "live",
            baseRefName: "main",
            headRefName: "issue-5",
          },
        ]),
      );
    },
  );
  assertEquals(open.map((pr) => pr.number), [5]);
  assertEquals(calls.length, 1);
  assertEquals(calls[0]![0], "pr");
});

Deno.test("prefetch - forceRefresh still bypasses the prefetched entry", async () => {
  const cache = testCache();
  await prefetchFleetOpenPrs({
    repos: ["owner/repo-a"],
    guardAuthors: ["VibeCoderST"],
    cache,
    ghCommandFn: () => Promise.reject(new Error("no gh call expected")),
    searchFn: stubSearch([searchPr("owner/repo-a", 1, "VibeCoderST")]),
  });

  const calls: string[][] = [];
  const live = await fetchOpenPRsForFleet(
    "owner/repo-a",
    ["VibeCoderST"],
    cache,
    (args) => {
      calls.push(args);
      return Promise.resolve(
        JSON.stringify([
          {
            number: 42,
            title: "just opened",
            baseRefName: "main",
            headRefName: "issue-42",
          },
        ]),
      );
    },
    undefined,
    true,
  );

  assertEquals(calls.length, 1, "read-after-write still asks GitHub");
  assertEquals(live.map((pr) => pr.number), [42]);
});

Deno.test("prefetch - authors match case-insensitively", async () => {
  const cache = testCache();
  await prefetchFleetOpenPrs({
    repos: ["owner/repo-a"],
    guardAuthors: ["VibeCoderST"],
    cache,
    ghCommandFn: () => Promise.reject(new Error("no gh call expected")),
    searchFn: stubSearch([searchPr("owner/repo-a", 1, "vibecoderst")]),
  });

  const calls: string[][] = [];
  const open = await fetchOpenPRsForFleet(
    "owner/repo-a",
    ["VibeCoderST"],
    cache,
    forbiddenGh(calls),
  );
  assertEquals(open.map((pr) => pr.number), [1]);
  assertEquals(calls, []);
});

Deno.test("prefetch - each owner gets its own search", async () => {
  const cache = testCache();
  const owners: string[] = [];
  const result = await prefetchFleetOpenPrs({
    repos: ["owner-a/one", "owner-a/two", "owner-b/three"],
    guardAuthors: ["VibeCoderST"],
    cache,
    ghCommandFn: () => Promise.reject(new Error("no gh call expected")),
    searchFn: (options) => {
      owners.push(options.owner);
      return Promise.resolve({ ok: true, prs: [], calls: 1 });
    },
  });

  assertEquals(owners, ["owner-a", "owner-b"]);
  assertEquals(result.searchCalls, 2);
  assertEquals(result.ownersServed, ["owner-a", "owner-b"]);
});

Deno.test("prefetch - no authors means no search and no writes", async () => {
  const cache = testCache();
  let searched = 0;
  const result = await prefetchFleetOpenPrs({
    repos: REPOS,
    guardAuthors: [],
    maintenanceAuthors: [],
    invitationAuthors: [],
    cache,
    ghCommandFn: () => Promise.reject(new Error("no gh call expected")),
    searchFn: () => {
      searched++;
      return Promise.resolve({ ok: true, prs: [], calls: 1 });
    },
  });

  assertEquals(searched, 0);
  assertEquals(result.entriesWritten, 0);
});

Deno.test("prefetch - one login in several sets is searched once", async () => {
  const cache = testCache();
  let searchAuthors: readonly string[] = [];
  const result = await prefetchFleetOpenPrs({
    repos: ["owner/repo-a"],
    // The fleet login is required in allowed_authors for PR dedup, so it
    // routinely appears in more than one of these sets.
    guardAuthors: ["VibeCoderST", "alice"],
    maintenanceAuthors: ["vibecoderst"],
    invitationAuthors: ["Alice"],
    cache,
    ghCommandFn: () => Promise.reject(new Error("no gh call expected")),
    searchFn: (options) => {
      searchAuthors = options.authors;
      return Promise.resolve({ ok: true, prs: [], calls: 1 });
    },
  });

  assertEquals(searchAuthors, ["VibeCoderST", "alice"]);
  // 1 repo x (2 guard + 1 maintenance + 1 invitation) = 4 entries.
  assertEquals(result.entriesWritten, 4);
});
