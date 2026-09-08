/**
 * Tests for `createGhEscalationClient` (Issue #3093).
 *
 * The shim bridges a thin `ghFn: (args) => Promise<string>` injection point to
 * the `GitHubClient` interface that `escalateToHuman` expects. These tests
 * drive it with a fake `ghFn` and assert observable outcomes — the gh
 * invocations issued and the values returned — rather than internal call order.
 *
 * Australian English used throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { createGhEscalationClient } from "../lib/gh_escalation_client.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Build a fake `ghFn` that records every invocation. `failWhen` lets a test
 * make a specific call throw so the fallback branch is exercised; `responses`
 * supplies the stdout returned for a matching call.
 */
function makeFakeGh(opts: {
  failWhen?: (args: string[]) => boolean;
  response?: (args: string[]) => string;
} = {}): {
  ghFn: (args: string[]) => Promise<string>;
  calls: string[][];
} {
  const calls: string[][] = [];
  const ghFn = (args: string[]): Promise<string> => {
    calls.push(args);
    if (opts.failWhen?.(args)) {
      return Promise.reject(new Error("fake gh: forced failure"));
    }
    return Promise.resolve(opts.response?.(args) ?? "");
  };
  return { ghFn, calls };
}

// ---------------------------------------------------------------------------
// addLabel
// ---------------------------------------------------------------------------

Deno.test("addLabel - posts via the REST API when gh succeeds", async () => {
  const { ghFn, calls } = makeFakeGh();
  const client = createGhEscalationClient(ghFn);

  await client.addLabel("owner/repo", 42, "needs-human");

  assertEquals(calls.length, 1);
  assertEquals(calls[0], [
    "api",
    "-X",
    "POST",
    "repos/owner/repo/issues/42/labels",
    "-f",
    "labels[]=needs-human",
  ]);
});

Deno.test("addLabel - falls back to `issue edit --add-label` when REST throws", async () => {
  const { ghFn, calls } = makeFakeGh({
    // Only the REST `api` call fails; the CLI fallback succeeds.
    failWhen: (args) => args[0] === "api",
  });
  const client = createGhEscalationClient(ghFn);

  await client.addLabel("owner/repo", 7, "needs-human");

  assertEquals(calls.length, 2);
  assertEquals(calls[0]?.[0], "api");
  assertEquals(calls[1], [
    "issue",
    "edit",
    "7",
    "--repo",
    "owner/repo",
    "--add-label",
    "needs-human",
  ]);
});

// ---------------------------------------------------------------------------
// getIssueComments
// ---------------------------------------------------------------------------

Deno.test("getIssueComments - parses valid JSON into GitHubComment shape", async () => {
  const payload = JSON.stringify([
    {
      id: 100,
      body: "first comment",
      created_at: "2026-01-01T00:00:00Z",
      user: { login: "alice" },
    },
    {
      id: 101,
      body: "second comment",
      created_at: "2026-01-02T00:00:00Z",
      user: { login: "bob" },
    },
  ]);
  const { ghFn, calls } = makeFakeGh({ response: () => payload });
  const client = createGhEscalationClient(ghFn);

  const comments = await client.getIssueComments("owner/repo", 9);

  assertEquals(calls[0], [
    "api",
    "repos/owner/repo/issues/9/comments?per_page=100&page=1",
  ]);
  assertEquals(comments.length, 2);
  const [c0, c1] = comments;
  assert(c0 && c1);
  assertEquals(c0.body, "first comment");
  assertEquals(c0.createdAt, "2026-01-01T00:00:00Z");
  assertEquals(c0.author, "alice");
  assertEquals(c1.body, "second comment");
});

Deno.test("getIssueComments - returns [] for malformed JSON without throwing", async () => {
  const { ghFn } = makeFakeGh({ response: () => "not json {{" });
  const client = createGhEscalationClient(ghFn);

  const comments = await client.getIssueComments("owner/repo", 1);

  assertEquals(comments, []);
});

Deno.test("getIssueComments - returns [] when ghFn throws", async () => {
  const { ghFn } = makeFakeGh({ failWhen: () => true });
  const client = createGhEscalationClient(ghFn);

  const comments = await client.getIssueComments("owner/repo", 1);

  assertEquals(comments, []);
});

Deno.test("getIssueComments - degrades a non-array JSON response to []", async () => {
  const { ghFn } = makeFakeGh({ response: () => JSON.stringify({ id: 1 }) });
  const client = createGhEscalationClient(ghFn);

  const comments = await client.getIssueComments("owner/repo", 1);

  assertEquals(comments, []);
});

// ---------------------------------------------------------------------------
// postComment
// ---------------------------------------------------------------------------

Deno.test("postComment - posts to the comments endpoint via REST", async () => {
  const { ghFn, calls } = makeFakeGh();
  const client = createGhEscalationClient(ghFn);

  const result = await client.postComment("owner/repo", 5, "hello");

  assertEquals(calls.length, 1);
  assertEquals(calls[0], [
    "api",
    "-X",
    "POST",
    "repos/owner/repo/issues/5/comments",
    "-f",
    "body=hello",
  ]);
  assertEquals(result, undefined);
});

Deno.test("postComment - falls back to `issue comment` when REST throws", async () => {
  const { ghFn, calls } = makeFakeGh({
    failWhen: (args) => args[0] === "api",
  });
  const client = createGhEscalationClient(ghFn);

  await client.postComment("owner/repo", 8, "escalation body");

  assertEquals(calls.length, 2);
  assertEquals(calls[0]?.[0], "api");
  assertEquals(calls[1], [
    "issue",
    "comment",
    "8",
    "--repo",
    "owner/repo",
    "--body",
    "escalation body",
  ]);
});

// ---------------------------------------------------------------------------
// Unsupported methods reject (the shim is escalateToHuman-only)
// ---------------------------------------------------------------------------

Deno.test("unsupported methods reject with a descriptive error", async () => {
  const { ghFn } = makeFakeGh();
  const client = createGhEscalationClient(ghFn);

  for (
    const call of [
      () => client.getIssue("owner/repo", 1),
      () => client.removeLabel("owner/repo", 1, "x"),
      () => client.editIssue("owner/repo", 1, {}),
      () => client.assignIssue("owner/repo", 1, ["u"]),
      () => client.unassignIssue("owner/repo", 1, ["u"]),
      () => client.closeIssue("owner/repo", 1),
    ]
  ) {
    let threw = false;
    try {
      await call();
    } catch (err) {
      threw = true;
      assert(err instanceof Error);
      assert(err.message.includes("not implemented"));
    }
    assert(threw, "expected the unsupported method to reject");
  }
});

// ---------------------------------------------------------------------------
// getIssueComments paging (Issue #1619)
//
// The default un-paged request returns the OLDEST 30 comments, so on a busy
// issue the dedup marker `escalateToHuman` looks for — always among the
// newest — was never fetched. The shim now pages at 100 per request.
// ---------------------------------------------------------------------------

/** Build `count` REST comment payload entries starting at `startId`. */
function makeRestComments(
  count: number,
  startId: number,
): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_unused, index) => ({
    id: startId + index,
    body: `comment ${startId + index}`,
    created_at: "2026-09-08T00:00:00Z",
    user: { login: "vibe-coder[bot]" },
  }));
}

Deno.test("getIssueComments - requests 100 comments per page", async () => {
  const { ghFn, calls } = makeFakeGh({ response: () => "[]" });
  const client = createGhEscalationClient(ghFn);

  await client.getIssueComments("owner/repo", 593);

  assertEquals(calls.length, 1);
  assertEquals(calls[0], [
    "api",
    "repos/owner/repo/issues/593/comments?per_page=100&page=1",
  ]);
});

Deno.test("getIssueComments - a full page is followed by a page=2 request", async () => {
  const { ghFn, calls } = makeFakeGh({
    response: (args) =>
      args[1]?.endsWith("page=1")
        ? JSON.stringify(makeRestComments(100, 1))
        : JSON.stringify(makeRestComments(17, 101)),
  });
  const client = createGhEscalationClient(ghFn);

  const comments = await client.getIssueComments("owner/repo", 593);

  assertEquals(calls.length, 2);
  assertEquals(calls[1], [
    "api",
    "repos/owner/repo/issues/593/comments?per_page=100&page=2",
  ]);
  assertEquals(comments.length, 117);
});

Deno.test("getIssueComments - a short page stops paging", async () => {
  const { ghFn, calls } = makeFakeGh({
    response: () => JSON.stringify(makeRestComments(47, 1)),
  });
  const client = createGhEscalationClient(ghFn);

  const comments = await client.getIssueComments("owner/repo", 593);

  assertEquals(calls.length, 1);
  assertEquals(comments.length, 47);
});

Deno.test("getIssueComments - returns pages concatenated oldest-first", async () => {
  const { ghFn } = makeFakeGh({
    response: (args) =>
      args[1]?.endsWith("page=1")
        ? JSON.stringify(makeRestComments(100, 1))
        : JSON.stringify(makeRestComments(3, 101)),
  });
  const client = createGhEscalationClient(ghFn);

  const comments = await client.getIssueComments("owner/repo", 593);

  assertEquals(comments.length, 103);
  assertEquals(comments[0]?.body, "comment 1");
  assertEquals(comments[99]?.body, "comment 100");
  assertEquals(comments[102]?.body, "comment 103");
});

Deno.test("getIssueComments - caps paging at 10 pages (1 000 comments)", async () => {
  const { ghFn, calls } = makeFakeGh({
    // Every page is full, so only the cap can stop the loop.
    response: () => JSON.stringify(makeRestComments(100, 1)),
  });
  const client = createGhEscalationClient(ghFn);

  const comments = await client.getIssueComments("owner/repo", 593);

  assertEquals(calls.length, 10);
  assertEquals(comments.length, 1000);
});

Deno.test("getIssueComments - a mid-paging failure returns what was fetched so far", async () => {
  const { ghFn } = makeFakeGh({
    failWhen: (args) => args[1]?.includes("page=2") === true,
    response: () => JSON.stringify(makeRestComments(100, 1)),
  });
  const client = createGhEscalationClient(ghFn);

  const comments = await client.getIssueComments("owner/repo", 593);

  assertEquals(comments.length, 100);
});
