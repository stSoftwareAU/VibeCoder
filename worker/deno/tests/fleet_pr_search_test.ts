/**
 * Tests for the cross-repo fleet PR search (Issue #1486).
 *
 * The per-repo per-author `gh pr list` fan-out collapses into one GraphQL
 * search per owner. What must hold:
 *
 *   - one call covers every repo of the owner and every author;
 *   - the returned fields match what `gh pr list` gave the consumers;
 *   - paging follows `endCursor` rather than stopping at page one;
 *   - a result set larger than the page budget is reported as unusable, not
 *     served as a short listing that looks complete.
 *
 * The happy paths run against `fakeGithubPrSearch`, which models the search
 * API's own rules — it reads the `q` variable and the selection set, so a
 * query that named the wrong owner, dropped an author, forgot `is:open` or
 * stopped requesting a field receives a truthfully wrong answer and the
 * assertion goes red. Nothing here asserts the *text* of the query
 * (CODING-STANDARDS: "Fake the external service, do not assert the
 * request"). The failure paths use direct stubs, because what they model is
 * the response, not the request.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildFleetPrSearchQuery,
  normaliseLogins,
  searchOpenFleetPrs,
} from "../lib/fleet_pr_search.ts";
import {
  fakeGithubPrSearch,
  type FakeSearchPr,
} from "./support/github_graphql_fake.ts";

/** The fleet's PRs, as the fake's GitHub holds them. */
const PRS: FakeSearchPr[] = [
  {
    repo: "owner/repo-a",
    number: 7,
    author: "VibeCoderST",
    labels: ["enhancement"],
    autoMergeRequest: {
      enabledAt: "2026-09-02T01:00:00Z",
      mergeMethod: "SQUASH",
    },
    comments: [{ author: "alice", body: "@bot please" }],
  },
  { repo: "owner/repo-b", number: 8, author: "stservice" },
  // Invisible to this fleet's query: another owner, another author, closed.
  { repo: "elsewhere/repo-c", number: 9, author: "VibeCoderST" },
  { repo: "owner/repo-a", number: 10, author: "stranger" },
  { repo: "owner/repo-a", number: 11, author: "VibeCoderST", state: "closed" },
];

Deno.test("normaliseLogins - drops blanks and case-duplicates, keeps casing", () => {
  assertEquals(
    normaliseLogins([" VibeCoderST ", "vibecoderst", "", "   ", "alice"]),
    ["VibeCoderST", "alice"],
  );
});

Deno.test("buildFleetPrSearchQuery - nothing to search yields no query", () => {
  assertEquals(buildFleetPrSearchQuery("", ["a"]), null);
  assertEquals(buildFleetPrSearchQuery("owner", []), null);
  assertEquals(buildFleetPrSearchQuery("owner", ["  "]), null);
});

Deno.test("searchOpenFleetPrs - one call returns every author's open PRs across the owner", async () => {
  const fake = fakeGithubPrSearch(PRS);
  const result = await searchOpenFleetPrs({
    owner: "owner",
    authors: ["VibeCoderST", "stservice"],
    ghCommandFn: fake.gh,
  });

  assert(result.ok, "search should succeed");
  assertEquals(result.calls, 1);
  // #7 and #8 only: the other owner, the other author and the closed PR are
  // all excluded by the query the code actually sent.
  assertEquals(result.prs.map((pr) => pr.number), [7, 8]);
  assertEquals(result.prs.map((pr) => pr.repo), [
    "owner/repo-a",
    "owner/repo-b",
  ]);
  assertEquals(fake.queries.length, 1);
});

Deno.test("searchOpenFleetPrs - an author left out of the query is not returned", async () => {
  const fake = fakeGithubPrSearch(PRS);
  const result = await searchOpenFleetPrs({
    owner: "owner",
    authors: ["VibeCoderST"],
    ghCommandFn: fake.gh,
  });

  assert(result.ok);
  assertEquals(result.prs.map((pr) => pr.number), [7]);
});

Deno.test("searchOpenFleetPrs - returns the fields gh pr list gave consumers", async () => {
  const result = await searchOpenFleetPrs({
    owner: "owner",
    authors: ["VibeCoderST"],
    ghCommandFn: fakeGithubPrSearch(PRS).gh,
  });

  assert(result.ok);
  const pr = result.prs[0]!;
  assertEquals(pr.number, 7);
  assertEquals(pr.title, "PR 7");
  assertEquals(pr.baseRefName, "main");
  assertEquals(pr.headRefName, "branch-7");
  assertEquals(pr.headRefOid, "oid-7");
  assertEquals(pr.mergeable, "MERGEABLE");
  assertEquals(pr.author, "VibeCoderST");
  assertEquals(pr.repo, "owner/repo-a");
  assertEquals(pr.labels, ["enhancement"]);
  assertEquals(pr.autoMergeRequest?.mergeMethod, "SQUASH");
  assertEquals(pr.comments, [
    { author: { login: "alice" }, body: "@bot please" },
  ]);
  assertEquals(pr.reviews, []);
  assertEquals(pr.detailTruncated, false);
});

Deno.test("searchOpenFleetPrs - a conversation past the page is reported truncated", async () => {
  const result = await searchOpenFleetPrs({
    owner: "owner",
    authors: ["VibeCoderST"],
    conversationSize: 1,
    ghCommandFn: fakeGithubPrSearch([
      {
        repo: "owner/repo-a",
        number: 7,
        author: "VibeCoderST",
        comments: [{ author: "alice", body: "first" }],
        // Two further comments GitHub holds but this page did not return.
        extraComments: 2,
      },
    ]).gh,
  });

  assert(result.ok);
  assertEquals(result.prs[0]!.comments.length, 1);
  assertEquals(
    result.prs[0]!.detailTruncated,
    true,
    "a mention could be sitting in the comments this page did not return",
  );
});

Deno.test("searchOpenFleetPrs - missing author or auto-merge degrade safely", async () => {
  const result = await searchOpenFleetPrs({
    owner: "owner",
    authors: ["VibeCoderST"],
    ghCommandFn: () =>
      Promise.resolve(JSON.stringify({
        data: {
          search: {
            issueCount: 1,
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [{
              number: 7,
              repository: { nameWithOwner: "owner/repo-a" },
              author: null,
              autoMergeRequest: null,
              labels: { nodes: [] },
            }],
          },
        },
      })),
  });

  assert(result.ok);
  assertEquals(result.prs[0]!.author, "");
  assertEquals(result.prs[0]!.autoMergeRequest, null);
  assertEquals(result.prs[0]!.labels, []);
});

Deno.test("searchOpenFleetPrs - pages through every result", async () => {
  const fake = fakeGithubPrSearch(PRS);
  const result = await searchOpenFleetPrs({
    owner: "owner",
    authors: ["VibeCoderST", "stservice"],
    // One PR per page, so the second page is only reached by following the
    // cursor the fake handed back.
    pageSize: 1,
    ghCommandFn: fake.gh,
  });

  assert(result.ok);
  assertEquals(result.calls, 2);
  assertEquals(result.prs.map((pr) => pr.number), [7, 8]);
});

Deno.test("searchOpenFleetPrs - refuses to serve a truncated result set", async () => {
  const fake = fakeGithubPrSearch(PRS);
  const result = await searchOpenFleetPrs({
    owner: "owner",
    authors: ["VibeCoderST", "stservice"],
    pageSize: 1,
    maxPages: 1,
    ghCommandFn: fake.gh,
  });

  assertEquals(result.ok, false, "a page budget short of the result set fails");
  if (!result.ok) assertStringIncludes(result.reason, "truncated");
});

Deno.test("searchOpenFleetPrs - a next page with no cursor is a failure", async () => {
  const result = await searchOpenFleetPrs({
    owner: "owner",
    authors: ["VibeCoderST"],
    ghCommandFn: () =>
      Promise.resolve(JSON.stringify({
        data: {
          search: {
            issueCount: 2,
            pageInfo: { hasNextPage: true, endCursor: null },
            nodes: [],
          },
        },
      })),
  });

  assertEquals(result.ok, false);
  if (!result.ok) assertStringIncludes(result.reason, "cursor");
});

Deno.test("searchOpenFleetPrs - GraphQL errors are reported, not swallowed", async () => {
  const result = await searchOpenFleetPrs({
    owner: "owner",
    authors: ["VibeCoderST"],
    ghCommandFn: () =>
      Promise.resolve(
        JSON.stringify({ errors: [{ message: "rate limited" }] }),
      ),
  });

  assertEquals(result.ok, false);
  if (!result.ok) assertStringIncludes(result.reason, "rate limited");
});

Deno.test("searchOpenFleetPrs - a thrown gh call is reported, not swallowed", async () => {
  const result = await searchOpenFleetPrs({
    owner: "owner",
    authors: ["VibeCoderST"],
    ghCommandFn: () => Promise.reject(new Error("gh exploded")),
  });

  assertEquals(result.ok, false);
  if (!result.ok) assertStringIncludes(result.reason, "gh exploded");
});

Deno.test("searchOpenFleetPrs - unparseable output is a failure", async () => {
  const result = await searchOpenFleetPrs({
    owner: "owner",
    authors: ["VibeCoderST"],
    ghCommandFn: () => Promise.resolve("not json"),
  });

  assertEquals(result.ok, false);
  if (!result.ok) assertStringIncludes(result.reason, "unparseable");
});

Deno.test("searchOpenFleetPrs - no author means no call at all", async () => {
  let calls = 0;
  const result = await searchOpenFleetPrs({
    owner: "owner",
    authors: [],
    ghCommandFn: () => {
      calls++;
      return Promise.resolve("{}");
    },
  });

  assertEquals(result.ok, false);
  assertEquals(calls, 0);
});
