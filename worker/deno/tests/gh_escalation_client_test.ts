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
    "repos/owner/repo/issues/9/comments",
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
