/**
 * Tests for the cross-repo fleet PR search (Issue #1486).
 *
 * The per-repo per-author `gh pr list` fan-out collapses into one GraphQL
 * search per owner. What must hold:
 *
 *   - one call covers every author (repeated `author:` qualifiers are ORed);
 *   - the returned fields match what `gh pr list` gave the consumers;
 *   - paging follows `endCursor` rather than stopping at page one;
 *   - a result set larger than the page budget is reported as unusable, not
 *     served as a short listing that looks complete.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildFleetPrSearchQuery,
  searchOpenFleetPrs,
} from "../lib/fleet_pr_search.ts";

/** Build one GraphQL search node as GitHub returns it. */
function node(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    number: 7,
    title: "Fix the thing (Issue #1)",
    baseRefName: "main",
    headRefName: "issue-1-fix",
    headRefOid: "abc123",
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-02T00:00:00Z",
    isDraft: false,
    mergeable: "MERGEABLE",
    author: { login: "VibeCoderST" },
    repository: { nameWithOwner: "owner/repo-a" },
    labels: { nodes: [{ name: "enhancement" }] },
    autoMergeRequest: {
      enabledAt: "2026-09-02T01:00:00Z",
      mergeMethod: "SQUASH",
    },
    comments: { nodes: [{ author: { login: "alice" }, body: "@bot please" }] },
    reviews: { nodes: [] },
    ...overrides,
  };
}

/** A GraphQL search response envelope. */
function response(
  nodes: unknown[],
  hasNextPage = false,
  endCursor: string | null = null,
): string {
  return JSON.stringify({
    data: {
      search: {
        issueCount: nodes.length,
        pageInfo: { hasNextPage, endCursor },
        nodes,
      },
    },
  });
}

Deno.test("buildFleetPrSearchQuery - ORs every author into one query", () => {
  const query = buildFleetPrSearchQuery("stSoftwareAU", [
    "VibeCoderST",
    "stservice",
    "alice",
  ]);
  assertEquals(
    query,
    "is:pr is:open user:stSoftwareAU author:VibeCoderST author:stservice " +
      "author:alice",
  );
});

Deno.test("buildFleetPrSearchQuery - drops blanks and case-duplicates", () => {
  const query = buildFleetPrSearchQuery("owner", [
    " VibeCoderST ",
    "vibecoderst",
    "",
    "   ",
  ]);
  assertEquals(query, "is:pr is:open user:owner author:VibeCoderST");
});

Deno.test("buildFleetPrSearchQuery - null when nothing to search", () => {
  assertEquals(buildFleetPrSearchQuery("", ["a"]), null);
  assertEquals(buildFleetPrSearchQuery("owner", []), null);
  assertEquals(buildFleetPrSearchQuery("owner", ["  "]), null);
});

Deno.test("searchOpenFleetPrs - one call covers every repo and author", async () => {
  const calls: string[][] = [];
  const result = await searchOpenFleetPrs({
    owner: "owner",
    authors: ["VibeCoderST", "stservice"],
    ghCommandFn: (args) => {
      calls.push(args);
      return Promise.resolve(
        response([
          node(),
          node({
            number: 8,
            repository: { nameWithOwner: "owner/repo-b" },
            author: { login: "stservice" },
          }),
        ]),
      );
    },
  });

  assert(result.ok, "search should succeed");
  assertEquals(result.calls, 1);
  assertEquals(result.prs.length, 2);
  assertEquals(result.prs.map((pr) => pr.repo), [
    "owner/repo-a",
    "owner/repo-b",
  ]);
  assertEquals(calls.length, 1);
  assertEquals(calls[0]![0], "api");
  assertEquals(calls[0]![1], "graphql");
  const queryArg = calls[0]!.find((a) => a.startsWith("q="));
  assert(queryArg !== undefined, "query variable must be passed");
  assertStringIncludes(queryArg, "author:VibeCoderST");
  assertStringIncludes(queryArg, "author:stservice");
});

Deno.test("searchOpenFleetPrs - returns the fields gh pr list gave consumers", async () => {
  const result = await searchOpenFleetPrs({
    owner: "owner",
    authors: ["VibeCoderST"],
    ghCommandFn: () => Promise.resolve(response([node()])),
  });

  assert(result.ok);
  const pr = result.prs[0]!;
  assertEquals(pr.number, 7);
  assertEquals(pr.title, "Fix the thing (Issue #1)");
  assertEquals(pr.baseRefName, "main");
  assertEquals(pr.headRefName, "issue-1-fix");
  assertEquals(pr.headRefOid, "abc123");
  assertEquals(pr.mergeable, "MERGEABLE");
  assertEquals(pr.author, "VibeCoderST");
  assertEquals(pr.labels, ["enhancement"]);
  assertEquals(pr.autoMergeRequest?.mergeMethod, "SQUASH");
  assertEquals(pr.comments, [
    { author: { login: "alice" }, body: "@bot please" },
  ]);
  assertEquals(pr.reviews, []);
});

Deno.test("searchOpenFleetPrs - missing author or auto-merge degrade safely", async () => {
  const result = await searchOpenFleetPrs({
    owner: "owner",
    authors: ["VibeCoderST"],
    ghCommandFn: () =>
      Promise.resolve(
        response([
          node({ author: null, autoMergeRequest: null, labels: { nodes: [] } }),
        ]),
      ),
  });

  assert(result.ok);
  assertEquals(result.prs[0]!.author, "");
  assertEquals(result.prs[0]!.autoMergeRequest, null);
  assertEquals(result.prs[0]!.labels, []);
});

Deno.test("searchOpenFleetPrs - pages through every result", async () => {
  const calls: string[][] = [];
  const result = await searchOpenFleetPrs({
    owner: "owner",
    authors: ["VibeCoderST"],
    pageSize: 1,
    ghCommandFn: (args) => {
      calls.push(args);
      if (calls.length === 1) {
        return Promise.resolve(response([node()], true, "CURSOR1"));
      }
      return Promise.resolve(response([node({ number: 8 })]));
    },
  });

  assert(result.ok);
  assertEquals(result.calls, 2);
  assertEquals(result.prs.map((pr) => pr.number), [7, 8]);
  // The first page carries no cursor; the second resumes from endCursor.
  assertEquals(calls[0]!.some((a) => a.startsWith("after=")), false);
  assert(calls[1]!.includes("after=CURSOR1"));
});

Deno.test("searchOpenFleetPrs - refuses to serve a truncated result set", async () => {
  let calls = 0;
  const result = await searchOpenFleetPrs({
    owner: "owner",
    authors: ["VibeCoderST"],
    pageSize: 1,
    maxPages: 2,
    ghCommandFn: () => {
      calls++;
      return Promise.resolve(
        response([node({ number: calls })], true, `CURSOR${calls}`),
      );
    },
  });

  assertEquals(result.ok, false);
  assertEquals(calls, 2);
  if (!result.ok) assertStringIncludes(result.reason, "truncated");
});

Deno.test("searchOpenFleetPrs - a next page with no cursor is a failure", async () => {
  const result = await searchOpenFleetPrs({
    owner: "owner",
    authors: ["VibeCoderST"],
    ghCommandFn: () => Promise.resolve(response([node()], true, null)),
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
      return Promise.resolve(response([]));
    },
  });

  assertEquals(result.ok, false);
  assertEquals(calls, 0);
});
