/**
 * Tests for `held_issue_gate_comment.ts` (Issue #2531, part of #2527).
 *
 * The held-issue gate comment is the fleet's only voice on an issue it is
 * deliberately not working yet, and it must be *one* comment: posted once,
 * edited in place when the gate changes, never duplicated. Every test calls
 * the real builder/upsert with literal inputs and asserts on the returned
 * value or the recorded `gh` argv — never on source text.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildHeldIssueGateComment,
  HELD_ISSUE_GATE_MARKER,
  upsertHeldIssueGateComment,
} from "../lib/held_issue_gate_comment.ts";

const DEP = { repo: "owner/repo-b", number: 42 };
/** The logins the fleet itself posts as — the only markers it may trust. */
const FLEET = ["vibe-bot"];

/** The `body=` value of a recorded write call. */
function bodyArg(args: string[]): string {
  const flag = args.indexOf("-f");
  return (args[flag + 1] ?? "").replace(/^body=/, "");
}

/**
 * A `gh` stub backed by a mutable comment thread, so a sequence of upserts
 * sees the effect of the previous one — the only way to prove the second
 * upsert writes nothing and the third edits rather than posts.
 */
function fakeThread(
  initial: Array<{ id: number; body: string; author: string | null }> = [],
) {
  const rows = initial.map((r) => ({ ...r }));
  const calls: string[][] = [];
  let nextId = 900;

  const ghFn = (args: string[]): Promise<string> => {
    calls.push([...args]);
    if (args.includes("POST")) {
      rows.push({ id: nextId++, body: bodyArg(args), author: "vibe-bot" });
      return Promise.resolve("{}");
    }
    if (args.includes("PATCH")) {
      const id = Number((args[3] ?? "").split("/").pop());
      const row = rows.find((r) => r.id === id);
      if (row === undefined) {
        return Promise.reject(new Error(`gh: no such comment ${id}`));
      }
      row.body = bodyArg(args);
      return Promise.resolve("{}");
    }
    return Promise.resolve(JSON.stringify(
      rows.map((r) => ({
        id: r.id,
        body: r.body,
        created_at: "2026-09-22T12:00:00Z",
        author: r.author,
      })),
    ));
  };

  return { rows, calls, ghFn };
}

const writes = (calls: string[][]) =>
  calls.filter((a) => a.includes("POST") || a.includes("PATCH"));
const posts = (calls: string[][]) => calls.filter((a) => a.includes("POST"));
const patches = (calls: string[][]) => calls.filter((a) => a.includes("PATCH"));

// =============================================================================
// buildHeldIssueGateComment — one sentence and one stable key per gate kind
// =============================================================================

Deno.test("buildHeldIssueGateComment - names the open PR on the stream", () => {
  const comment = buildHeldIssueGateComment({ kind: "pr-open", prNumber: 77 });

  assertStringIncludes(
    comment.body,
    "PR #77 is open on this stream; this issue is worked once it lands",
  );
  assertEquals(comment.key, "held-gate-pr-open-77");
});

Deno.test("buildHeldIssueGateComment - names the milestone a closed dependency waits on", () => {
  const comment = buildHeldIssueGateComment({
    kind: "milestone-wait",
    dependency: DEP,
    milestone: "milestone/2527-held-gate",
  });

  assertStringIncludes(
    comment.body,
    "waits on milestone milestone/2527-held-gate — owner/repo-b#42 is " +
      "closed but its code only reaches the default branch when " +
      "milestone/2527-held-gate merges",
  );
  assertEquals(
    comment.key,
    "held-gate-milestone-wait-owner/repo-b#42-milestone/2527-held-gate",
  );
});

Deno.test("buildHeldIssueGateComment - names the dependency it waits on", () => {
  const comment = buildHeldIssueGateComment({
    kind: "dependency",
    dependency: DEP,
  });

  assertStringIncludes(comment.body, "waits on dependency owner/repo-b#42");
  assertEquals(comment.key, "held-gate-dependency-owner/repo-b#42");
});

Deno.test("buildHeldIssueGateComment - adds the chain-root reason when the chain ends unworkable", () => {
  const comment = buildHeldIssueGateComment({
    kind: "dependency",
    dependency: DEP,
    rootReason: "assigned",
    rootDetail: "alice",
  });

  // The sentence is `chain_root_comment.ts`'s, reused rather than restated.
  assertStringIncludes(
    comment.body,
    "waiting on @alice, who is assigned to owner/repo-b#42",
  );
  assertEquals(
    comment.key,
    "held-gate-dependency-owner/repo-b#42-assigned-owner/repo-b#42-alice",
  );
});

Deno.test("buildHeldIssueGateComment - names the chain root, not the dependency, when they differ", () => {
  const comment = buildHeldIssueGateComment({
    kind: "dependency",
    dependency: DEP,
    rootReason: "cross-repo-unmonitored",
    root: { repo: "other/repo-c", number: 7 },
    rootDetail: "other/repo-c",
  });

  // A chain is often more than one hop: the reason belongs to the root, so
  // attributing it to the dependency would state something untrue of it.
  assertStringIncludes(comment.body, "waits on dependency owner/repo-b#42");
  assertStringIncludes(
    comment.body,
    "cross-repo blocker other/repo-c#7 is not monitored by this fleet",
  );
  assert(
    !comment.body.includes("blocker owner/repo-b#42"),
    `expected the root to own the reason, got: ${comment.body}`,
  );
  assertStringIncludes(comment.key, "other/repo-c#7");
});

Deno.test("buildHeldIssueGateComment - a changed assignee changes the key", () => {
  const alice = buildHeldIssueGateComment({
    kind: "dependency",
    dependency: DEP,
    rootReason: "assigned",
    rootDetail: "alice",
  });
  const bob = buildHeldIssueGateComment({
    kind: "dependency",
    dependency: DEP,
    rootReason: "assigned",
    rootDetail: "bob",
  });

  // Same reason, different person: the visible sentence changed, so the key
  // must too — otherwise the comment names @alice for ever.
  assert(
    alice.key !== bob.key,
    `expected distinct keys, both were ${alice.key}`,
  );
});

Deno.test("buildHeldIssueGateComment - keys a needs-human root apart from a plain dependency", () => {
  const plain = buildHeldIssueGateComment({
    kind: "dependency",
    dependency: DEP,
  });
  const unworkable = buildHeldIssueGateComment({
    kind: "dependency",
    dependency: DEP,
    rootReason: "needs-human",
    rootDetail: "needs-human",
  });

  assertStringIncludes(unworkable.body, "owner/repo-b#42 is `needs-human`");
  assert(
    plain.key !== unworkable.key,
    `expected distinct keys, both were ${plain.key}`,
  );
});

Deno.test("buildHeldIssueGateComment - carries the hidden marker keyed by its key", () => {
  const comment = buildHeldIssueGateComment({ kind: "pr-open", prNumber: 5 });

  assertStringIncludes(
    comment.body,
    `<!-- ${HELD_ISSUE_GATE_MARKER} key="${comment.key}" -->`,
  );
  // A visible heading, so a human reading the thread sees why nothing moves.
  assert(
    comment.body.trimStart().startsWith("#"),
    `expected a visible heading, got: ${comment.body}`,
  );
});

Deno.test("buildHeldIssueGateComment - strips markup from a crafted dependency reference", () => {
  const comment = buildHeldIssueGateComment({
    kind: "dependency",
    dependency: { repo: 'owner/repo" --> injected', number: 9 },
  });

  // The reference is parsed out of an attacker-writable issue body and lands
  // inside the marker's `key="…"` attribute, so it keeps only the characters
  // a repository name may actually use.
  assertEquals(comment.key, "held-gate-dependency-owner/repo--injected#9");
  assertEquals(comment.body.split("<!--").length, 2);
  assertEquals(comment.body.split("-->").length, 2);
});

Deno.test("buildHeldIssueGateComment - strips markup from a crafted milestone title", () => {
  const comment = buildHeldIssueGateComment({
    kind: "milestone-wait",
    dependency: DEP,
    milestone: 'v1.2" --><!-- injected',
  });

  assertEquals(comment.body.split("<!--").length, 2);
  assertEquals(comment.body.split("-->").length, 2);
  assertEquals(comment.body.split('"').length, 3);
});

// =============================================================================
// upsertHeldIssueGateComment — posted once, edited in place, never duplicated
// =============================================================================

Deno.test("upsertHeldIssueGateComment - posts when the thread carries no marker", async () => {
  const { calls, ghFn } = fakeThread();

  const outcome = await upsertHeldIssueGateComment({
    repo: "owner/repo-a",
    issueNumber: 100,
    gate: { kind: "pr-open", prNumber: 77 },
    ghFn,
    fleetAuthors: FLEET,
  });

  assertEquals(outcome, "posted");
  const post = posts(calls)[0];
  assert(post !== undefined, `expected a POST, got: ${JSON.stringify(calls)}`);
  assertEquals(post.slice(0, 4), [
    "api",
    "-X",
    "POST",
    "repos/owner/repo-a/issues/100/comments",
  ]);
  assertEquals(
    bodyArg(post),
    buildHeldIssueGateComment({ kind: "pr-open", prNumber: 77 }).body,
  );
  assertEquals(patches(calls), []);
});

Deno.test("upsertHeldIssueGateComment - an unchanged gate writes nothing, a changed gate edits in place", async () => {
  const { rows, calls, ghFn } = fakeThread();
  const upsert = (gate: Parameters<typeof buildHeldIssueGateComment>[0]) =>
    upsertHeldIssueGateComment({
      repo: "owner/repo-a",
      issueNumber: 100,
      gate,
      ghFn,
      fleetAuthors: FLEET,
    });

  assertEquals(await upsert({ kind: "pr-open", prNumber: 77 }), "posted");
  assertEquals(await upsert({ kind: "pr-open", prNumber: 77 }), "unchanged");
  assertEquals(posts(calls).length, 1);
  assertEquals(patches(calls), []);

  const outcome = await upsert({ kind: "dependency", dependency: DEP });

  assertEquals(outcome, "edited");
  assertEquals(posts(calls).length, 1);
  const patch = patches(calls)[0];
  assertEquals(patches(calls).length, 1);
  assert(patch !== undefined, "expected one PATCH call");
  assertEquals(patch.slice(0, 4), [
    "api",
    "-X",
    "PATCH",
    "repos/owner/repo-a/issues/comments/900",
  ]);
  // One comment on the thread the whole way through, now naming the new gate.
  assertEquals(rows.length, 1);
  const row = rows[0];
  assert(row !== undefined, "expected the comment to still be on the thread");
  assertStringIncludes(row.body, "waits on dependency owner/repo-b#42");
});

Deno.test("upsertHeldIssueGateComment - edits the newest fleet marker when several exist", async () => {
  const stale = buildHeldIssueGateComment({ kind: "pr-open", prNumber: 1 });
  const { calls, ghFn } = fakeThread([
    { id: 11, body: stale.body, author: "vibe-bot" },
    { id: 22, body: stale.body, author: "vibe-bot" },
  ]);

  const outcome = await upsertHeldIssueGateComment({
    repo: "owner/repo-a",
    issueNumber: 100,
    gate: { kind: "pr-open", prNumber: 2 },
    ghFn,
    fleetAuthors: FLEET,
  });

  assertEquals(outcome, "edited");
  const patch = patches(calls)[0];
  assert(patch !== undefined, "expected one PATCH call");
  assertEquals(patch[3], "repos/owner/repo-a/issues/comments/22");
});

Deno.test("upsertHeldIssueGateComment - a marker from outside the fleet is neither trusted nor edited", async () => {
  const gate = { kind: "pr-open", prNumber: 77 } as const;
  const forged = buildHeldIssueGateComment(gate);
  const { calls, ghFn } = fakeThread([
    { id: 11, body: forged.body, author: "mallory" },
  ]);

  const outcome = await upsertHeldIssueGateComment({
    repo: "owner/repo-a",
    issueNumber: 100,
    gate,
    ghFn,
    fleetAuthors: FLEET,
  });

  // Same key, so a trusted marker would have suppressed the write entirely —
  // and a different key would have edited a stranger's comment.
  assertEquals(outcome, "posted");
  assertEquals(posts(calls).length, 1);
  assertEquals(patches(calls), []);
});

Deno.test("upsertHeldIssueGateComment - a non-fleet marker is not edited when the gate changes", async () => {
  const forged = buildHeldIssueGateComment({ kind: "pr-open", prNumber: 1 });
  const { rows, calls, ghFn } = fakeThread([
    { id: 11, body: forged.body, author: "mallory" },
  ]);

  const outcome = await upsertHeldIssueGateComment({
    repo: "owner/repo-a",
    issueNumber: 100,
    gate: { kind: "dependency", dependency: DEP },
    ghFn,
    fleetAuthors: FLEET,
  });

  assertEquals(outcome, "posted");
  assertEquals(patches(calls), []);
  const stranger = rows[0];
  assert(stranger !== undefined, "expected the forged comment to survive");
  assertEquals(stranger.body, forged.body);
});

Deno.test("upsertHeldIssueGateComment - an empty fleet-author list posts rather than trusting a marker", async () => {
  const gate = { kind: "pr-open", prNumber: 77 } as const;
  const existing = buildHeldIssueGateComment(gate);
  const { calls, ghFn } = fakeThread([
    { id: 11, body: existing.body, author: "vibe-bot" },
  ]);

  const outcome = await upsertHeldIssueGateComment({
    repo: "owner/repo-a",
    issueNumber: 100,
    gate,
    ghFn,
    fleetAuthors: [],
  });

  // Fail towards the action that cannot hide a fault.
  assertEquals(outcome, "posted");
  assertEquals(posts(calls).length, 1);
});

Deno.test("upsertHeldIssueGateComment - matches a fleet login case-insensitively", async () => {
  const gate = { kind: "pr-open", prNumber: 77 } as const;
  const existing = buildHeldIssueGateComment(gate);
  const { calls, ghFn } = fakeThread([
    { id: 11, body: existing.body, author: "Vibe-Bot" },
  ]);

  const outcome = await upsertHeldIssueGateComment({
    repo: "owner/repo-a",
    issueNumber: 100,
    gate,
    ghFn,
    fleetAuthors: FLEET,
  });

  assertEquals(outcome, "unchanged");
  assertEquals(writes(calls), []);
});

Deno.test("upsertHeldIssueGateComment - finds the marker on a later page", async () => {
  const gate = { kind: "pr-open", prNumber: 77 } as const;
  const existing = buildHeldIssueGateComment(gate);
  const calls: string[][] = [];
  // `gh api --paginate --jq '[…]'` prints one JSON array per page.
  const ghFn = (args: string[]): Promise<string> => {
    calls.push([...args]);
    return Promise.resolve([
      JSON.stringify([]),
      JSON.stringify([{
        id: 7,
        body: existing.body,
        created_at: "2026-09-22T12:00:00Z",
        author: "vibe-bot",
      }]),
    ].join("\n"));
  };

  const outcome = await upsertHeldIssueGateComment({
    repo: "owner/repo-a",
    issueNumber: 100,
    gate,
    ghFn,
    fleetAuthors: FLEET,
  });

  assertEquals(outcome, "unchanged");
  assertEquals(writes(calls), []);
  const read = calls[0];
  assert(read !== undefined, "expected one read call");
  assert(
    read.includes("--paginate"),
    `expected a paginated read, got: ${JSON.stringify(read)}`,
  );
});

Deno.test("upsertHeldIssueGateComment - an unreadable thread fails loud", async () => {
  const ghFn = (): Promise<string> =>
    Promise.reject(new Error("gh: API rate limit exceeded"));

  let thrown: unknown;
  try {
    await upsertHeldIssueGateComment({
      repo: "owner/repo-a",
      issueNumber: 100,
      gate: { kind: "pr-open", prNumber: 77 },
      ghFn,
      fleetAuthors: FLEET,
    });
  } catch (err) {
    thrown = err;
  }

  assert(thrown instanceof Error, "expected the read failure to surface");
  assertStringIncludes(thrown.message, "rate limit");
});

Deno.test("upsertHeldIssueGateComment - a failed edit fails loud", async () => {
  const stale = buildHeldIssueGateComment({ kind: "pr-open", prNumber: 1 });
  const ghFn = (args: string[]): Promise<string> => {
    if (args.includes("PATCH")) {
      return Promise.reject(new Error("gh: HTTP 403 forbidden"));
    }
    return Promise.resolve(JSON.stringify([{
      id: 11,
      body: stale.body,
      created_at: "2026-09-22T12:00:00Z",
      author: "vibe-bot",
    }]));
  };

  let thrown: unknown;
  try {
    await upsertHeldIssueGateComment({
      repo: "owner/repo-a",
      issueNumber: 100,
      gate: { kind: "pr-open", prNumber: 2 },
      ghFn,
      fleetAuthors: FLEET,
    });
  } catch (err) {
    thrown = err;
  }

  assert(thrown instanceof Error, "expected the edit failure to surface");
  assertStringIncludes(thrown.message, "403");
});
