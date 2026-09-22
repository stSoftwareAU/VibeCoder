/**
 * Tests for `chain_root_comment.ts` (Issue #2496, part of #2483).
 *
 * The comment is the fleet's only voice on a chain it cannot move: no label
 * is applied, so the body wording, the stable dedup key and the 24-hour
 * window are the whole contract. Every test calls the real builder/poster
 * with literal inputs and asserts on the returned value or the recorded
 * `gh` argv — never on source text.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildChainRootUnworkableComment,
  CHAIN_ROOT_COMMENT_WINDOW_MS,
  CHAIN_ROOT_UNWORKABLE_MARKER,
  postChainRootUnworkableComment,
} from "../lib/chain_root_comment.ts";

const ROOT = { repo: "owner/repo-b", number: 42 };
/** The logins the fleet itself posts as — the only markers that may dedup. */
const FLEET = ["vibe-bot"];
const NOW = Date.parse("2026-09-22T12:00:00Z");

/** A `gh` stub that answers the marker read and records every call. */
function recordingGh(
  commentBodies: Array<{ body: string; createdAt: string }>,
) {
  const calls: string[][] = [];
  const ghFn = (args: string[]): Promise<string> => {
    calls.push(args);
    if (args.includes("-X") && args.includes("POST")) {
      return Promise.resolve("{}");
    }
    return Promise.resolve(
      JSON.stringify(
        commentBodies.map((c, index) => ({
          id: index + 1,
          body: c.body,
          created_at: c.createdAt,
          author: "vibe-bot",
        })),
      ),
    );
  };
  return { calls, ghFn };
}

function postedBody(calls: string[][]): string | undefined {
  const post = calls.find((a) => a.includes("POST"));
  if (!post) return undefined;
  const flag = post.indexOf("-f");
  return post[flag + 1];
}

// =============================================================================
// buildChainRootUnworkableComment — wording and dedup key
// =============================================================================

Deno.test("buildChainRootUnworkableComment - names the assignee being waited on", () => {
  const comment = buildChainRootUnworkableComment({
    blockedNumber: 100,
    root: ROOT,
    reason: "assigned",
    detail: "alice",
  });

  assertStringIncludes(
    comment.body,
    "waiting on @alice, who is assigned to owner/repo-b#42",
  );
  assertEquals(
    comment.dedupKey,
    "chain-root-unworkable-100-owner/repo-b#42-assigned",
  );
});

Deno.test("buildChainRootUnworkableComment - says a root carries no discovery label", () => {
  const comment = buildChainRootUnworkableComment({
    blockedNumber: 100,
    root: ROOT,
    reason: "no-discovery-label",
    detail: "documentation",
  });

  assertStringIncludes(
    comment.body,
    "owner/repo-b#42 carries no discovery label, so the fleet will not pick it up",
  );
  assertEquals(
    comment.dedupKey,
    "chain-root-unworkable-100-owner/repo-b#42-no-discovery-label",
  );
});

Deno.test("buildChainRootUnworkableComment - says a root is needs-human", () => {
  const comment = buildChainRootUnworkableComment({
    blockedNumber: 7,
    root: ROOT,
    reason: "needs-human",
    detail: "needs-human",
  });

  assertStringIncludes(comment.body, "owner/repo-b#42 is `needs-human`");
  assertEquals(
    comment.dedupKey,
    "chain-root-unworkable-7-owner/repo-b#42-needs-human",
  );
});

Deno.test("buildChainRootUnworkableComment - says a cross-repo blocker is unmonitored", () => {
  const comment = buildChainRootUnworkableComment({
    blockedNumber: 7,
    root: { repo: "other/repo", number: 9 },
    reason: "cross-repo-unmonitored",
    detail: "other/repo",
  });

  assertStringIncludes(
    comment.body,
    "cross-repo blocker other/repo#9 is not monitored by this fleet",
  );
  assertEquals(
    comment.dedupKey,
    "chain-root-unworkable-7-other/repo#9-cross-repo-unmonitored",
  );
});

Deno.test("buildChainRootUnworkableComment - carries the hidden marker keyed by the dedup key", () => {
  const comment = buildChainRootUnworkableComment({
    blockedNumber: 100,
    root: ROOT,
    reason: "assigned",
    detail: "alice",
  });

  assertStringIncludes(
    comment.body,
    `<!-- ${CHAIN_ROOT_UNWORKABLE_MARKER} key="${comment.dedupKey}" -->`,
  );
  // A visible heading, so a human reading the thread sees why nothing moves.
  assert(
    comment.body.trimStart().startsWith("#"),
    `expected a visible heading, got: ${comment.body}`,
  );
});

Deno.test("buildChainRootUnworkableComment - never asks for a label change", () => {
  const comment = buildChainRootUnworkableComment({
    blockedNumber: 100,
    root: ROOT,
    reason: "assigned",
    detail: "alice",
  });

  assertEquals(comment.body.includes("needs-human"), false);
  assertEquals(comment.body.includes("top-priority"), false);
});

Deno.test("buildChainRootUnworkableComment - strips markup from an implausible assignee login", () => {
  const comment = buildChainRootUnworkableComment({
    blockedNumber: 100,
    root: ROOT,
    reason: "assigned",
    detail: 'alice" -->\n<!-- injected',
  });

  // Everything outside GitHub's login alphabet is dropped, so the crafted
  // markup cannot close the marker attribute or open a second comment.
  assertStringIncludes(
    comment.body,
    "waiting on @alice----injected, who is assigned to",
  );
  assertEquals(comment.body.split("<!--").length, 2);
  assertEquals(comment.body.split("-->").length, 2);
});

Deno.test("buildChainRootUnworkableComment - names no mention when the assignee is unusable", () => {
  const comment = buildChainRootUnworkableComment({
    blockedNumber: 100,
    root: ROOT,
    reason: "assigned",
    detail: "   ",
  });

  assertStringIncludes(
    comment.body,
    "waiting on an unnamed account, who is assigned to owner/repo-b#42",
  );
  assertEquals(comment.body.includes("@,"), false);
});

Deno.test("buildChainRootUnworkableComment - strips markup from a crafted repository reference", () => {
  const comment = buildChainRootUnworkableComment({
    blockedNumber: 100,
    root: { repo: 'owner/repo" --> injected', number: 5 },
    reason: "cross-repo-unmonitored",
    detail: 'owner/repo" -->',
  });

  // The reference is parsed out of an attacker-writable issue body and lands
  // inside the marker's `key="…"` attribute, so it keeps only the characters
  // a repository name may actually use — the quote that would close the
  // attribute and the `>` that would close the comment are both gone.
  assertEquals(
    comment.dedupKey,
    "chain-root-unworkable-100-owner/repo--injected#5-cross-repo-unmonitored",
  );
  assertEquals(comment.body.split("-->").length, 2);
  assertEquals(comment.body.includes('"'), true);
  assertEquals(comment.body.split('"').length, 3);
});

// =============================================================================
// postChainRootUnworkableComment — the 24-hour window
// =============================================================================

Deno.test("postChainRootUnworkableComment - posts when the thread carries no marker", async () => {
  const comment = buildChainRootUnworkableComment({
    blockedNumber: 100,
    root: ROOT,
    reason: "assigned",
    detail: "alice",
  });
  const { calls, ghFn } = recordingGh([]);

  const posted = await postChainRootUnworkableComment({
    repo: "owner/repo-a",
    issueNumber: 100,
    comment,
    ghFn,
    fleetAuthors: FLEET,
    now: () => NOW,
  });

  assertEquals(posted, true);
  const post = calls.find((a) => a.includes("POST"));
  assert(post !== undefined, `expected a POST, got: ${JSON.stringify(calls)}`);
  assertEquals(post.slice(0, 4), [
    "api",
    "-X",
    "POST",
    "repos/owner/repo-a/issues/100/comments",
  ]);
  assertEquals(postedBody(calls), `body=${comment.body}`);
});

Deno.test("postChainRootUnworkableComment - skips a same-key comment inside 24 hours", async () => {
  const comment = buildChainRootUnworkableComment({
    blockedNumber: 100,
    root: ROOT,
    reason: "assigned",
    detail: "alice",
  });
  const { calls, ghFn } = recordingGh([{
    body: comment.body,
    createdAt: new Date(NOW - CHAIN_ROOT_COMMENT_WINDOW_MS + 1).toISOString(),
  }]);

  const posted = await postChainRootUnworkableComment({
    repo: "owner/repo-a",
    issueNumber: 100,
    comment,
    ghFn,
    fleetAuthors: FLEET,
    now: () => NOW,
  });

  assertEquals(posted, false);
  assertEquals(calls.filter((a) => a.includes("POST")), []);
});

Deno.test("postChainRootUnworkableComment - posts again once the window has passed", async () => {
  const comment = buildChainRootUnworkableComment({
    blockedNumber: 100,
    root: ROOT,
    reason: "assigned",
    detail: "alice",
  });
  const { calls, ghFn } = recordingGh([{
    body: comment.body,
    createdAt: new Date(NOW - CHAIN_ROOT_COMMENT_WINDOW_MS - 1).toISOString(),
  }]);

  const posted = await postChainRootUnworkableComment({
    repo: "owner/repo-a",
    issueNumber: 100,
    comment,
    ghFn,
    fleetAuthors: FLEET,
    now: () => NOW,
  });

  assertEquals(posted, true);
  assertEquals(calls.filter((a) => a.includes("POST")).length, 1);
});

Deno.test("postChainRootUnworkableComment - a changed reason posts inside the window", async () => {
  const earlier = buildChainRootUnworkableComment({
    blockedNumber: 100,
    root: ROOT,
    reason: "assigned",
    detail: "alice",
  });
  const now = buildChainRootUnworkableComment({
    blockedNumber: 100,
    root: ROOT,
    reason: "needs-human",
    detail: "needs-human",
  });
  const { calls, ghFn } = recordingGh([{
    body: earlier.body,
    createdAt: new Date(NOW - 60 * 1000).toISOString(),
  }]);

  const posted = await postChainRootUnworkableComment({
    repo: "owner/repo-a",
    issueNumber: 100,
    comment: now,
    ghFn,
    fleetAuthors: FLEET,
    now: () => NOW,
  });

  assertEquals(posted, true);
  assertEquals(calls.filter((a) => a.includes("POST")).length, 1);
});

Deno.test("postChainRootUnworkableComment - a changed root posts inside the window", async () => {
  const earlier = buildChainRootUnworkableComment({
    blockedNumber: 100,
    root: ROOT,
    reason: "assigned",
    detail: "alice",
  });
  const now = buildChainRootUnworkableComment({
    blockedNumber: 100,
    root: { repo: "owner/repo-b", number: 99 },
    reason: "assigned",
    detail: "alice",
  });
  const { calls, ghFn } = recordingGh([{
    body: earlier.body,
    createdAt: new Date(NOW - 60 * 1000).toISOString(),
  }]);

  const posted = await postChainRootUnworkableComment({
    repo: "owner/repo-a",
    issueNumber: 100,
    comment: now,
    ghFn,
    fleetAuthors: FLEET,
    now: () => NOW,
  });

  assertEquals(posted, true);
  assertEquals(calls.filter((a) => a.includes("POST")).length, 1);
});

Deno.test("postChainRootUnworkableComment - finds the marker on a later page", async () => {
  const comment = buildChainRootUnworkableComment({
    blockedNumber: 100,
    root: ROOT,
    reason: "assigned",
    detail: "alice",
  });
  const calls: string[][] = [];
  // `gh api --paginate --jq '[…]'` prints one JSON array per page.
  const page = (rows: Record<string, unknown>[]) => JSON.stringify(rows);
  const ghFn = (args: string[]): Promise<string> => {
    calls.push(args);
    if (args.includes("POST")) return Promise.resolve("{}");
    return Promise.resolve(
      [
        page([]),
        page([{
          id: 7,
          body: comment.body,
          created_at: new Date(NOW - 60 * 1000).toISOString(),
          author: "vibe-bot",
        }]),
      ].join("\n"),
    );
  };

  const posted = await postChainRootUnworkableComment({
    repo: "owner/repo-a",
    issueNumber: 100,
    comment,
    ghFn,
    fleetAuthors: FLEET,
    now: () => NOW,
  });

  assertEquals(posted, false);
  assertEquals(calls.filter((a) => a.includes("POST")), []);
  const read = calls[0];
  assert(read !== undefined);
  assert(
    read.some((a) => a === "--paginate"),
    `expected a paginated read, got: ${JSON.stringify(read)}`,
  );
});

Deno.test("postChainRootUnworkableComment - a marker from outside the fleet cannot suppress", async () => {
  const comment = buildChainRootUnworkableComment({
    blockedNumber: 100,
    root: ROOT,
    reason: "assigned",
    detail: "alice",
  });
  const calls: string[][] = [];
  const ghFn = (args: string[]): Promise<string> => {
    calls.push(args);
    if (args.includes("POST")) return Promise.resolve("{}");
    return Promise.resolve(JSON.stringify([{
      id: 1,
      body: comment.body,
      created_at: new Date(NOW - 60 * 1000).toISOString(),
      author: "mallory",
    }]));
  };

  const posted = await postChainRootUnworkableComment({
    repo: "owner/repo-a",
    issueNumber: 100,
    comment,
    ghFn,
    fleetAuthors: FLEET,
    now: () => NOW,
  });

  assertEquals(posted, true);
  assertEquals(calls.filter((a) => a.includes("POST")).length, 1);
});

Deno.test("postChainRootUnworkableComment - a fleet-authored marker still suppresses", async () => {
  const comment = buildChainRootUnworkableComment({
    blockedNumber: 100,
    root: ROOT,
    reason: "assigned",
    detail: "alice",
  });
  const { calls, ghFn } = recordingGh([{
    body: comment.body,
    createdAt: new Date(NOW - 60 * 1000).toISOString(),
  }]);

  const posted = await postChainRootUnworkableComment({
    repo: "owner/repo-a",
    issueNumber: 100,
    comment,
    ghFn,
    fleetAuthors: ["Vibe-Bot"],
    now: () => NOW,
  });

  assertEquals(posted, false);
  assertEquals(calls.filter((a) => a.includes("POST")), []);
});

Deno.test("postChainRootUnworkableComment - an unreadable thread fails loud", async () => {
  const comment = buildChainRootUnworkableComment({
    blockedNumber: 100,
    root: ROOT,
    reason: "assigned",
    detail: "alice",
  });
  const ghFn = (): Promise<string> =>
    Promise.reject(new Error("gh: API rate limit exceeded"));

  let thrown: unknown;
  try {
    await postChainRootUnworkableComment({
      repo: "owner/repo-a",
      issueNumber: 100,
      comment,
      ghFn,
      fleetAuthors: FLEET,
      now: () => NOW,
    });
  } catch (err) {
    thrown = err;
  }

  assert(thrown instanceof Error, "expected the read failure to surface");
  assertStringIncludes(thrown.message, "rate limit");
});
