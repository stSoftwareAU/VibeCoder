/**
 * Tests for the cross-repo open-PR prefetch (Issue #1486).
 *
 * These drive the **real** search against `fakeGithubPrSearch` (which models
 * the search API's own rules) and then ask the **real** consumers what they
 * see, so what is proven is the outcome the issue asks for — the fleet PR
 * listings issue O(1) cross-repo queries per cycle instead of
 * O(repos x authors) — rather than the shape of the code that produces it:
 *
 *   - `fetchOpenPRsForFleet`, `listOpenPrs` and `listInvitedHumanPrs` run
 *     across every repo and author with **zero** `gh pr list` calls;
 *   - each one still sees the fields it saw from `gh pr list`;
 *   - a repo with no open PR is answered from the prefetch, not by a call;
 *   - a failed search leaves the per-repo path untouched;
 *   - a PR whose conversation did not fit one page is left to the per-repo
 *     listing rather than served short;
 *   - `forceRefresh` still bypasses the prefetch for read-after-write.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals } from "@std/assert";
import { prefetchFleetOpenPrs } from "../lib/fleet_pr_prefetch.ts";
import { IssueCache } from "../lib/issue_cache.ts";
import { fetchOpenPRsForFleet } from "../lib/issue_query.ts";
import {
  listOpenPrs,
  PR_MAINTENANCE_LIST_FIELDS,
} from "../lib/pr_maintenance.ts";
import { listInvitedHumanPrs } from "../lib/pr_invitation_lookup.ts";
import {
  fakeGithubPrSearch,
  type FakeSearchPr,
} from "./support/github_graphql_fake.ts";

const REPOS = ["owner/repo-a", "owner/repo-b", "owner/repo-c"];
const FLEET = ["VibeCoderST", "stservice"];
const HUMANS = ["alice"];

function testCache(): IssueCache {
  return new IssueCache(
    Deno.makeTempDirSync({ prefix: "fleet-pr-prefetch-" }),
    600,
  );
}

/** A `gh` runner recording any per-repo listing a consumer still issues. */
function recordingGh(seen: string[][]): (args: string[]) => Promise<string> {
  return (args) => {
    seen.push(args);
    return Promise.resolve("[]");
  };
}

Deno.test("prefetch - one search per owner serves every repo and author", async () => {
  const cache = testCache();
  const fake = fakeGithubPrSearch([
    { repo: "owner/repo-a", number: 1, author: "VibeCoderST" },
    { repo: "owner/repo-b", number: 2, author: "stservice" },
  ]);

  const result = await prefetchFleetOpenPrs({
    repos: REPOS,
    guardAuthors: FLEET,
    maintenanceAuthors: FLEET,
    invitationAuthors: HUMANS,
    cache,
    ghCommandFn: fake.gh,
  });

  assertEquals(result.searchCalls, 1, "one search covers the whole owner");
  assertEquals(result.ownersServed, ["owner"]);
  assertEquals(result.ownersSkipped, []);
  // 3 repos x (2 guard + 2 maintenance + 1 invitation) = 15 entries.
  assertEquals(result.entriesWritten, 15);
  assertEquals(result.listingsAvoided, 15);

  // The duplicate guard now runs across every repo without one gh call.
  const calls: string[][] = [];
  for (const repo of REPOS) {
    const open = await fetchOpenPRsForFleet(
      repo,
      FLEET,
      cache,
      recordingGh(calls),
    );
    if (repo === "owner/repo-a") {
      assertEquals(open.map((pr) => pr.number), [1]);
      assertEquals(open[0]!.headRefName, "branch-1");
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
    ghCommandFn: fakeGithubPrSearch([{
      repo: "owner/repo-a",
      number: 1,
      author: "VibeCoderST",
      autoMergeRequest: {
        enabledAt: "2026-09-02T01:00:00Z",
        mergeMethod: "SQUASH",
      },
    }]).gh,
  });

  const calls: string[][] = [];
  const entries = await listOpenPrs(
    "owner/repo-a",
    FLEET,
    PR_MAINTENANCE_LIST_FIELDS,
    recordingGh(calls),
    cache,
  );

  assertEquals(calls, []);
  assertEquals(entries.length, 1);
  const pr = entries[0]!;
  assertEquals(pr.number, 1);
  assertEquals(pr.headRefName, "branch-1");
  assertEquals(pr.headRefOid, "oid-1");
  assertEquals(pr.baseRefName, "main");
  assertEquals(pr.author?.login, "VibeCoderST");
  assertEquals(pr.autoMergeRequest?.mergeMethod, "SQUASH");
});

Deno.test("prefetch - an invited human PR is admitted from the prefetch", async () => {
  const cache = testCache();
  const prs: FakeSearchPr[] = [
    {
      repo: "owner/repo-a",
      number: 9,
      author: "alice",
      comments: [{ author: "alice", body: "@VibeCoderST take this" }],
    },
    { repo: "owner/repo-b", number: 10, author: "alice" },
  ];

  await prefetchFleetOpenPrs({
    repos: REPOS,
    guardAuthors: FLEET,
    maintenanceAuthors: FLEET,
    invitationAuthors: HUMANS,
    cache,
    ghCommandFn: fakeGithubPrSearch(prs).gh,
  });

  const calls: string[][] = [];
  const admitted = await listInvitedHumanPrs<{ number: number }>({
    repo: "owner/repo-a",
    githubUser: "VibeCoderST",
    allowedAuthors: ["alice", "VibeCoderST"],
    fleetPrAuthors: FLEET,
    fields: "number,headRefName",
    ghCommandFn: recordingGh(calls),
    cache,
  });
  const none = await listInvitedHumanPrs<{ number: number }>({
    repo: "owner/repo-b",
    githubUser: "VibeCoderST",
    allowedAuthors: ["alice", "VibeCoderST"],
    fleetPrAuthors: FLEET,
    fields: "number,headRefName",
    ghCommandFn: recordingGh(calls),
    cache,
  });

  assertEquals(calls, [], "no invitation listing was issued");
  assertEquals(admitted.map((pr) => pr.number), [9]);
  assertEquals(none, [], "an uninvited human PR is still not admitted");
});

Deno.test("prefetch - a PR whose conversation did not fit one page is left to the per-repo listing", async () => {
  const cache = testCache();
  const log: string[] = [];
  const result = await prefetchFleetOpenPrs({
    repos: ["owner/repo-a"],
    guardAuthors: ["VibeCoderST"],
    invitationAuthors: ["alice"],
    cache,
    // One comment per page, with more waiting: the invitation predicate
    // reads every comment, so this listing must not be served from here.
    conversationSize: 1,
    ghCommandFn: fakeGithubPrSearch([{
      repo: "owner/repo-a",
      number: 9,
      author: "alice",
      comments: [{ author: "alice", body: "first" }],
      extraComments: 3,
    }]).gh,
    log: (message) => log.push(message),
  });

  // The guard entry is still written; only the invitation one is withheld.
  assertEquals(result.entriesWritten, 1);
  assert(log.some((line) => line.includes("exceeded one page")));

  const calls: string[][] = [];
  await listInvitedHumanPrs<{ number: number }>({
    repo: "owner/repo-a",
    githubUser: "VibeCoderST",
    allowedAuthors: ["alice", "VibeCoderST"],
    fleetPrAuthors: ["VibeCoderST"],
    fields: "number",
    ghCommandFn: recordingGh(calls),
    cache,
  });
  assertEquals(calls.length, 1, "the per-repo invitation listing still runs");
  assertEquals(calls[0]![0], "pr");
});

Deno.test("prefetch - a failed search leaves the per-repo path in place", async () => {
  const cache = testCache();
  const log: string[] = [];
  const result = await prefetchFleetOpenPrs({
    repos: ["owner/repo-a"],
    guardAuthors: ["VibeCoderST"],
    cache,
    ghCommandFn: () => Promise.reject(new Error("search unavailable")),
    log: (message) => log.push(message),
  });

  assertEquals(result.ownersServed, []);
  assertEquals(result.entriesWritten, 0);
  assertEquals(result.ownersSkipped.length, 1);
  assertEquals(result.ownersSkipped[0]!.owner, "owner");
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

Deno.test("prefetch - a second pass inside the TTL costs no search", async () => {
  const cache = testCache();
  const fake = fakeGithubPrSearch([
    { repo: "owner/repo-a", number: 1, author: "VibeCoderST" },
  ]);
  const options = {
    repos: ["owner/repo-a"],
    guardAuthors: ["VibeCoderST"],
    cache,
    ghCommandFn: fake.gh,
  };

  const first = await prefetchFleetOpenPrs(options);
  const second = await prefetchFleetOpenPrs(options);

  assertEquals(first.searchCalls, 1);
  assertEquals(second.searchCalls, 0, "the entries are still fresh");
  assertEquals(second.ownersFresh, ["owner"]);
  assertEquals(second.entriesWritten, 0);
  assertEquals(fake.queries.length, 1);
});

Deno.test("prefetch - forceRefresh still bypasses the prefetched entry", async () => {
  const cache = testCache();
  await prefetchFleetOpenPrs({
    repos: ["owner/repo-a"],
    guardAuthors: ["VibeCoderST"],
    cache,
    ghCommandFn: fakeGithubPrSearch([
      { repo: "owner/repo-a", number: 1, author: "VibeCoderST" },
    ]).gh,
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
    ghCommandFn: fakeGithubPrSearch([
      { repo: "owner/repo-a", number: 1, author: "vibecoderst" },
    ]).gh,
  });

  const calls: string[][] = [];
  const open = await fetchOpenPRsForFleet(
    "owner/repo-a",
    ["VibeCoderST"],
    cache,
    recordingGh(calls),
  );
  assertEquals(open.map((pr) => pr.number), [1]);
  assertEquals(calls, []);
});

Deno.test("prefetch - each owner gets its own search", async () => {
  const cache = testCache();
  const fake = fakeGithubPrSearch([
    { repo: "owner-a/one", number: 1, author: "VibeCoderST" },
    { repo: "owner-b/three", number: 3, author: "VibeCoderST" },
  ]);
  const result = await prefetchFleetOpenPrs({
    repos: ["owner-a/one", "owner-a/two", "owner-b/three"],
    guardAuthors: ["VibeCoderST"],
    cache,
    ghCommandFn: fake.gh,
  });

  assertEquals(result.searchCalls, 2, "one per owner, not one per repo");
  assertEquals(result.ownersServed, ["owner-a", "owner-b"]);

  const calls: string[][] = [];
  for (
    const [repo, numbers] of [
      ["owner-a/one", [1]],
      ["owner-a/two", []],
      ["owner-b/three", [3]],
    ] as const
  ) {
    const open = await fetchOpenPRsForFleet(
      repo,
      ["VibeCoderST"],
      cache,
      recordingGh(calls),
    );
    assertEquals(open.map((pr) => pr.number), [...numbers]);
  }
  assertEquals(calls, []);
});

Deno.test("prefetch - no authors means no search and no writes", async () => {
  const cache = testCache();
  const fake = fakeGithubPrSearch([]);
  const result = await prefetchFleetOpenPrs({
    repos: REPOS,
    guardAuthors: [],
    maintenanceAuthors: [],
    invitationAuthors: [],
    cache,
    ghCommandFn: fake.gh,
  });

  assertEquals(fake.queries.length, 0);
  assertEquals(result.entriesWritten, 0);
});

Deno.test("prefetch - one login in several sets is searched once", async () => {
  const cache = testCache();
  const fake = fakeGithubPrSearch([
    // The fleet login is required in allowed_authors for PR dedup, so it
    // routinely appears in more than one of these sets.
    { repo: "owner/repo-a", number: 1, author: "VibeCoderST" },
    { repo: "owner/repo-a", number: 2, author: "alice" },
  ]);
  const result = await prefetchFleetOpenPrs({
    repos: ["owner/repo-a"],
    guardAuthors: ["VibeCoderST", "alice"],
    maintenanceAuthors: ["vibecoderst"],
    invitationAuthors: ["Alice"],
    cache,
    ghCommandFn: fake.gh,
  });

  assertEquals(fake.queries.length, 1);
  // 1 repo x (2 guard + 1 maintenance + 1 invitation) = 4 entries.
  assertEquals(result.entriesWritten, 4);

  // Both logins were really searched for: each one's PR came back.
  const calls: string[][] = [];
  const open = await fetchOpenPRsForFleet(
    "owner/repo-a",
    ["VibeCoderST", "alice"],
    cache,
    recordingGh(calls),
  );
  assertEquals(open.map((pr) => pr.number).sort(), [1, 2]);
  assertEquals(calls, []);
});
