/**
 * Tests for pr_branch_lock.ts — distributed lock for PR branch updates.
 *
 * Issue #1281: Prevents concurrent workers from updating the same PR
 * branch simultaneously by using hidden GitHub comments as a lock
 * mechanism, consistent with the CLAIM_LOCK pattern in claim_issue.ts.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  acquireBranchUpdateLock,
  BRANCH_UPDATE_LOCK_PREFIX,
  buildLockBody,
  buildLockComment,
  cleanStaleBranchUpdateLocks,
  parseLockComment,
  releaseBranchUpdateLock,
  startBranchUpdateLockRenewal,
} from "../lib/pr_branch_lock.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** No-op sleep for fast tests. */
const noSleep = () => Promise.resolve();

/**
 * The fleet service account every fixture lock is posted by (Issue #1124).
 *
 * Fleet hosts share a service account and are told apart by the worker-id
 * inside the marker, so a race between `worker-01` and `worker-02` is a race
 * between two comments from the same authenticated author. The planted lock
 * is the one from outside this set.
 */
const FLEET_AUTHOR = "vibe-coder-bot";

/** Author-verification inputs the fixtures pass instead of a config file. */
const FLEET_OPTIONS = { fleetAuthors: [FLEET_AUTHOR] } as const;

/**
 * What `gh issue comment` actually prints — the new comment's URL. Since
 * Issue #1249 the `#issuecomment-<id>` fragment is how the worker identifies
 * its own lock, so every stub of that call returns one.
 */
const postedCommentUrl = (id: number) =>
  `https://github.com/org/repo/issues/42#issuecomment-${id}`;

/** Create a mock gh command function that records calls and returns scripted responses. */
function createMockGh(
  handler?: (args: string[]) => string | Error,
) {
  const calls: string[][] = [];

  const ghCommandFn = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (handler) {
      const response = handler(args);
      if (response instanceof Error) throw response;
      return response;
    }
    return "";
  };

  return { ghCommandFn, calls };
}

// ---------------------------------------------------------------------------
// buildLockComment
// ---------------------------------------------------------------------------

Deno.test("pr_branch_lock - buildLockComment produces correct format", () => {
  const comment = buildLockComment("worker-01", 1700000000);
  assertEquals(comment, "<!-- BRANCH_UPDATE_LOCK:worker-01:1700000000 -->");
});

Deno.test("pr_branch_lock - buildLockComment handles hyphenated worker IDs", () => {
  const comment = buildLockComment("server-mel-02", 1700000500);
  assertEquals(comment, "<!-- BRANCH_UPDATE_LOCK:server-mel-02:1700000500 -->");
});

// ---------------------------------------------------------------------------
// parseLockComment
// ---------------------------------------------------------------------------

Deno.test("pr_branch_lock - parseLockComment extracts worker ID and timestamp", () => {
  const result = parseLockComment(
    "<!-- BRANCH_UPDATE_LOCK:worker-01:1700000000 -->",
  );
  assertEquals(result, { workerId: "worker-01", timestamp: 1700000000 });
});

Deno.test("pr_branch_lock - parseLockComment returns null for non-lock comment", () => {
  assertEquals(parseLockComment("Just a normal comment"), null);
  assertEquals(parseLockComment("<!-- CLAIM_LOCK:worker-01 -->"), null);
  assertEquals(parseLockComment(""), null);
});

Deno.test("pr_branch_lock - parseLockComment returns null for malformed timestamp", () => {
  assertEquals(
    parseLockComment("<!-- BRANCH_UPDATE_LOCK:worker-01:abc -->"),
    null,
  );
});

Deno.test("pr_branch_lock - parseLockComment handles complex worker IDs", () => {
  const result = parseLockComment(
    "<!-- BRANCH_UPDATE_LOCK:server-mel-02-prod:1700000999 -->",
  );
  assertEquals(result, {
    workerId: "server-mel-02-prod",
    timestamp: 1700000999,
  });
});

// ---------------------------------------------------------------------------
// BRANCH_UPDATE_LOCK_PREFIX
// ---------------------------------------------------------------------------

Deno.test("pr_branch_lock - BRANCH_UPDATE_LOCK_PREFIX has correct value", () => {
  assertEquals(BRANCH_UPDATE_LOCK_PREFIX, "<!-- BRANCH_UPDATE_LOCK:");
});

// ---------------------------------------------------------------------------
// acquireBranchUpdateLock — successful acquisition (no contention)
// ---------------------------------------------------------------------------

Deno.test("pr_branch_lock - acquireBranchUpdateLock succeeds when no other locks exist", async () => {
  const { ghCommandFn, calls } = createMockGh((args) => {
    // Post lock comment
    if (args[0] === "issue" && args[1] === "comment") {
      return postedCommentUrl(100);
    }
    // Re-read comments — only our lock
    if (args[0] === "api" && String(args[1]).includes("/comments")) {
      return JSON.stringify([
        {
          id: 100,
          body: "<!-- BRANCH_UPDATE_LOCK:worker-01:1700000000 -->",
          created_at: "2023-11-14T22:13:20Z",
          author: FLEET_AUTHOR,
        },
      ]);
    }
    return "";
  });

  const result = await acquireBranchUpdateLock({
    authorOptions: FLEET_OPTIONS,
    log: () => {},
    repo: "org/repo",
    prNumber: 42,
    workerId: "worker-01",
    sleepFn: noSleep,
    ghCommandFn,
    nowFn: () => 1700000000,
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.acquired, true);
    assertEquals(result.value.lockCommentId, 100);
  }
  // Verify comment was posted and re-read
  const postCall = calls.find((c) => c[0] === "issue" && c[1] === "comment");
  assertEquals(postCall !== undefined, true);
});

// ---------------------------------------------------------------------------
// acquireBranchUpdateLock — contention, this worker wins (earliest timestamp)
// ---------------------------------------------------------------------------

Deno.test("pr_branch_lock - acquireBranchUpdateLock wins when earliest lock", async () => {
  const { ghCommandFn } = createMockGh((args) => {
    if (args[0] === "issue" && args[1] === "comment") {
      return postedCommentUrl(100);
    }
    if (args[0] === "api" && String(args[1]).includes("/comments")) {
      return JSON.stringify([
        {
          id: 100,
          body: "<!-- BRANCH_UPDATE_LOCK:worker-01:1700000000 -->",
          created_at: "2023-11-14T22:13:20Z",
          author: FLEET_AUTHOR,
        },
        {
          id: 200,
          body: "<!-- BRANCH_UPDATE_LOCK:worker-02:1700000001 -->",
          created_at: "2023-11-14T22:13:21Z",
          author: FLEET_AUTHOR,
        },
      ]);
    }
    return "";
  });

  const result = await acquireBranchUpdateLock({
    authorOptions: FLEET_OPTIONS,
    log: () => {},
    repo: "org/repo",
    prNumber: 42,
    workerId: "worker-01",
    sleepFn: noSleep,
    ghCommandFn,
    nowFn: () => 1700000000,
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.acquired, true);
    assertEquals(result.value.lockCommentId, 100);
  }
});

// ---------------------------------------------------------------------------
// acquireBranchUpdateLock — contention, this worker loses (later timestamp)
// ---------------------------------------------------------------------------

Deno.test("pr_branch_lock - acquireBranchUpdateLock loses when not earliest lock", async () => {
  const deletedComments: number[] = [];

  const { ghCommandFn } = createMockGh((args) => {
    if (args[0] === "issue" && args[1] === "comment") {
      return postedCommentUrl(200);
    }
    // Re-read comments — competitor has earlier lock
    if (
      args[0] === "api" &&
      String(args[1]).includes("/comments") &&
      !args.includes("DELETE")
    ) {
      return JSON.stringify([
        {
          id: 100,
          body: "<!-- BRANCH_UPDATE_LOCK:worker-01:1700000000 -->",
          created_at: "2023-11-14T22:13:20Z",
          author: FLEET_AUTHOR,
        },
        {
          id: 200,
          body: "<!-- BRANCH_UPDATE_LOCK:worker-02:1700000001 -->",
          created_at: "2023-11-14T22:13:21Z",
          author: FLEET_AUTHOR,
        },
      ]);
    }
    // Delete our losing lock comment
    if (args.includes("DELETE")) {
      const idMatch = args.join(" ").match(/comments\/(\d+)/);
      if (idMatch) deletedComments.push(Number(idMatch[1]));
      return "";
    }
    return "";
  });

  const result = await acquireBranchUpdateLock({
    authorOptions: FLEET_OPTIONS,
    log: () => {},
    repo: "org/repo",
    prNumber: 42,
    workerId: "worker-02",
    sleepFn: noSleep,
    ghCommandFn,
    nowFn: () => 1700000001,
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.acquired, false);
    assertEquals(result.value.winnerId, "worker-01");
  }
  // Verify our lock comment was cleaned up
  assertEquals(deletedComments.includes(200), true);
});

// ---------------------------------------------------------------------------
// acquireBranchUpdateLock — cleans stale locks before acquiring
// ---------------------------------------------------------------------------

Deno.test("pr_branch_lock - acquireBranchUpdateLock cleans stale locks first", async () => {
  let commentsFetched = 0;
  const deletedComments: number[] = [];

  const { ghCommandFn } = createMockGh((args) => {
    // Post lock comment
    if (args[0] === "issue" && args[1] === "comment") {
      return postedCommentUrl(100);
    }
    // Fetch comments — multiple calls happen
    if (
      args[0] === "api" &&
      String(args[1]).includes("/comments") &&
      !args.includes("DELETE")
    ) {
      commentsFetched++;
      // First call: stale lock cleanup check
      if (commentsFetched === 1) {
        return JSON.stringify([
          {
            id: 50,
            body: "<!-- BRANCH_UPDATE_LOCK:crashed-worker:1699999000 -->",
          },
        ]);
      }
      // Second call: after cleanup, only our lock remains
      return JSON.stringify([
        {
          id: 100,
          body: "<!-- BRANCH_UPDATE_LOCK:worker-01:1700000300 -->",
          created_at: "2023-11-14T22:18:20Z",
          author: FLEET_AUTHOR,
        },
      ]);
    }
    // Delete stale lock
    if (args.includes("DELETE")) {
      const idMatch = args.join(" ").match(/comments\/(\d+)/);
      if (idMatch) deletedComments.push(Number(idMatch[1]));
      return "";
    }
    return "";
  });

  const result = await acquireBranchUpdateLock({
    authorOptions: FLEET_OPTIONS,
    log: () => {},
    repo: "org/repo",
    prNumber: 42,
    workerId: "worker-01",
    sleepFn: noSleep,
    ghCommandFn,
    nowFn: () => 1700000300,
    lockTtlSeconds: 300,
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.acquired, true);
  }
  // Verify the stale lock was deleted
  assertEquals(deletedComments.includes(50), true);
});

// ---------------------------------------------------------------------------
// acquireBranchUpdateLock — fails gracefully on API errors
// ---------------------------------------------------------------------------

Deno.test("pr_branch_lock - acquireBranchUpdateLock returns not-acquired on post failure", async () => {
  const { ghCommandFn } = createMockGh((args) => {
    if (args[0] === "issue" && args[1] === "comment") {
      throw new Error("API error");
    }
    return "";
  });

  const result = await acquireBranchUpdateLock({
    authorOptions: FLEET_OPTIONS,
    log: () => {},
    repo: "org/repo",
    prNumber: 42,
    workerId: "worker-01",
    sleepFn: noSleep,
    ghCommandFn,
    nowFn: () => 1700000000,
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.acquired, false);
  }
});

Deno.test("pr_branch_lock - acquireBranchUpdateLock returns not-acquired on verify failure", async () => {
  const { ghCommandFn } = createMockGh((args) => {
    if (args[0] === "issue" && args[1] === "comment") {
      return postedCommentUrl(100);
    }
    if (args[0] === "api" && String(args[1]).includes("/comments")) {
      // Stale lock check
      if (!args.includes("-X")) {
        throw new Error("API error");
      }
    }
    return "";
  });

  const result = await acquireBranchUpdateLock({
    authorOptions: FLEET_OPTIONS,
    log: () => {},
    repo: "org/repo",
    prNumber: 42,
    workerId: "worker-01",
    sleepFn: noSleep,
    ghCommandFn,
    nowFn: () => 1700000000,
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.acquired, false);
  }
});

// ---------------------------------------------------------------------------
// releaseBranchUpdateLock
// ---------------------------------------------------------------------------

Deno.test("pr_branch_lock - releaseBranchUpdateLock deletes the lock comment", async () => {
  const deletedComments: number[] = [];
  const { ghCommandFn } = createMockGh((args) => {
    if (args.includes("DELETE")) {
      const idMatch = args.join(" ").match(/comments\/(\d+)/);
      if (idMatch) deletedComments.push(Number(idMatch[1]));
    }
    return "";
  });

  const result = await releaseBranchUpdateLock({
    repo: "org/repo",
    prNumber: 42,
    lockCommentId: 100,
    ghCommandFn,
  });

  assertEquals(result.ok, true);
  assertEquals(deletedComments.includes(100), true);
});

Deno.test("pr_branch_lock - releaseBranchUpdateLock handles API error gracefully", async () => {
  const { ghCommandFn } = createMockGh(() => {
    throw new Error("API error");
  });

  const result = await releaseBranchUpdateLock({
    repo: "org/repo",
    prNumber: 42,
    lockCommentId: 100,
    ghCommandFn,
  });

  // Should still return ok (best-effort release)
  assertEquals(result.ok, true);
});

// ---------------------------------------------------------------------------
// cleanStaleBranchUpdateLocks
// ---------------------------------------------------------------------------

Deno.test("pr_branch_lock - cleanStaleBranchUpdateLocks removes expired locks", async () => {
  const deletedComments: number[] = [];
  const { ghCommandFn } = createMockGh((args) => {
    if (
      args[0] === "api" &&
      String(args[1]).includes("/comments") &&
      !args.includes("DELETE")
    ) {
      return JSON.stringify([
        {
          id: 50,
          body: "<!-- BRANCH_UPDATE_LOCK:old-worker:1699999000 -->",
        },
        {
          id: 60,
          body: "<!-- BRANCH_UPDATE_LOCK:recent-worker:1700000280 -->",
        },
      ]);
    }
    if (args.includes("DELETE")) {
      const idMatch = args.join(" ").match(/comments\/(\d+)/);
      if (idMatch) deletedComments.push(Number(idMatch[1]));
    }
    return "";
  });

  await cleanStaleBranchUpdateLocks({
    repo: "org/repo",
    prNumber: 42,
    ghCommandFn,
    nowFn: () => 1700000300,
    lockTtlSeconds: 300,
  });

  // Only the old lock (age = 1300s > 300s TTL) should be deleted
  assertEquals(deletedComments.includes(50), true);
  // The recent lock (age = 20s < 300s TTL) should NOT be deleted
  assertEquals(deletedComments.includes(60), false);
});

Deno.test("pr_branch_lock - cleanStaleBranchUpdateLocks handles empty response", async () => {
  const { ghCommandFn } = createMockGh((args) => {
    if (
      args[0] === "api" &&
      String(args[1]).includes("/comments") &&
      !args.includes("DELETE")
    ) {
      return "[]";
    }
    return "";
  });

  // Should not throw
  await cleanStaleBranchUpdateLocks({
    repo: "org/repo",
    prNumber: 42,
    ghCommandFn,
    nowFn: () => 1700000300,
  });
});

Deno.test("pr_branch_lock - cleanStaleBranchUpdateLocks handles API error gracefully", async () => {
  const { ghCommandFn } = createMockGh(() => {
    throw new Error("API error");
  });

  // Should not throw — best-effort cleanup
  await cleanStaleBranchUpdateLocks({
    repo: "org/repo",
    prNumber: 42,
    ghCommandFn,
    nowFn: () => 1700000300,
  });
});

// ---------------------------------------------------------------------------
// acquireBranchUpdateLock — tie-breaking by created_at
// ---------------------------------------------------------------------------

Deno.test("pr_branch_lock - acquireBranchUpdateLock tie-breaks by created_at when timestamps equal", async () => {
  const { ghCommandFn } = createMockGh((args) => {
    if (args[0] === "issue" && args[1] === "comment") {
      return postedCommentUrl(100);
    }
    if (
      args[0] === "api" &&
      String(args[1]).includes("/comments") &&
      !args.includes("DELETE")
    ) {
      return JSON.stringify([
        {
          id: 100,
          body: "<!-- BRANCH_UPDATE_LOCK:worker-01:1700000000 -->",
          created_at: "2023-11-14T22:13:21Z",
          author: FLEET_AUTHOR,
        },
        {
          id: 200,
          body: "<!-- BRANCH_UPDATE_LOCK:worker-02:1700000000 -->",
          created_at: "2023-11-14T22:13:20Z",
          author: FLEET_AUTHOR,
        },
      ]);
    }
    return "";
  });

  // worker-02 posted earlier (created_at) so should win
  const result = await acquireBranchUpdateLock({
    authorOptions: FLEET_OPTIONS,
    log: () => {},
    repo: "org/repo",
    prNumber: 42,
    workerId: "worker-01",
    sleepFn: noSleep,
    ghCommandFn,
    nowFn: () => 1700000000,
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.acquired, false);
    assertEquals(result.value.winnerId, "worker-02");
  }
});

// ---------------------------------------------------------------------------
// acquireBranchUpdateLock — identifies own lock comment ID correctly
// ---------------------------------------------------------------------------

Deno.test("pr_branch_lock - acquireBranchUpdateLock returns correct lockCommentId on win", async () => {
  const { ghCommandFn } = createMockGh((args) => {
    if (args[0] === "issue" && args[1] === "comment") {
      return postedCommentUrl(777);
    }
    if (
      args[0] === "api" &&
      String(args[1]).includes("/comments") &&
      !args.includes("DELETE")
    ) {
      return JSON.stringify([
        {
          id: 777,
          body: "<!-- BRANCH_UPDATE_LOCK:my-worker:1700000000 -->",
          created_at: "2023-11-14T22:13:20Z",
          author: FLEET_AUTHOR,
        },
      ]);
    }
    return "";
  });

  const result = await acquireBranchUpdateLock({
    authorOptions: FLEET_OPTIONS,
    log: () => {},
    repo: "org/repo",
    prNumber: 42,
    workerId: "my-worker",
    sleepFn: noSleep,
    ghCommandFn,
    nowFn: () => 1700000000,
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.acquired, true);
    assertEquals(result.value.lockCommentId, 777);
  }
});

// ---------------------------------------------------------------------------
// buildLockBody / lock notes (Issue #3754)
// ---------------------------------------------------------------------------

Deno.test("pr_branch_lock - buildLockBody appends a visible line under the marker", () => {
  const body = buildLockBody("worker-01", 1700000000, "Locked for a CI fix.");
  assertEquals(
    body,
    "<!-- BRANCH_UPDATE_LOCK:worker-01:1700000000 -->\nLocked for a CI fix.",
  );
  // The marker still parses, so lock arithmetic is unaffected by the note.
  assertEquals(parseLockComment(body)?.workerId, "worker-01");
});

Deno.test("pr_branch_lock - buildLockBody without a note is marker-only", () => {
  assertEquals(
    buildLockBody("worker-01", 1700000000),
    "<!-- BRANCH_UPDATE_LOCK:worker-01:1700000000 -->",
  );
});

Deno.test("pr_branch_lock - acquireBranchUpdateLock posts the note with the marker", async () => {
  let postedBody = "";
  const { ghCommandFn } = createMockGh((args) => {
    if (args[0] === "issue" && args[1] === "comment") {
      const bodyIndex = args.indexOf("--body");
      postedBody = args[bodyIndex + 1] ?? "";
      return postedCommentUrl(900);
    }
    if (
      args[0] === "api" && String(args[1]).includes("/comments") &&
      !args.includes("DELETE")
    ) {
      return JSON.stringify([
        {
          id: 900,
          body: postedBody,
          created_at: "2023-11-14T22:13:20Z",
          author: FLEET_AUTHOR,
        },
      ]);
    }
    return "";
  });

  await acquireBranchUpdateLock({
    authorOptions: FLEET_OPTIONS,
    log: () => {},
    repo: "org/repo",
    prNumber: 42,
    workerId: "worker-01",
    sleepFn: noSleep,
    ghCommandFn,
    nowFn: () => 1700000000,
    note: "Locked PR #42 for a CI fix.",
  });

  assertStringIncludes(postedBody, BRANCH_UPDATE_LOCK_PREFIX);
  assertStringIncludes(postedBody, "Locked PR #42 for a CI fix.");
});

// ---------------------------------------------------------------------------
// startBranchUpdateLockRenewal (Issue #3754)
// ---------------------------------------------------------------------------

Deno.test("pr_branch_lock - startBranchUpdateLockRenewal renews until stopped", async () => {
  const patchedBodies: string[] = [];
  const { ghCommandFn } = createMockGh((args) => {
    if (args.includes("PATCH")) {
      const bodyArg = args.find((a) => a.startsWith("body=")) ?? "";
      patchedBodies.push(bodyArg.slice("body=".length));
    }
    return "";
  });

  let clock = 1700000000;
  const handle = startBranchUpdateLockRenewal({
    repo: "org/repo",
    lockCommentId: 777,
    workerId: "worker-01",
    intervalMs: 5,
    ghCommandFn,
    nowFn: () => (clock += 100),
    note: "Locked for a CI fix.",
  });

  await new Promise((resolve) => setTimeout(resolve, 40));
  handle.stop();
  const renewalsWhileRunning = patchedBodies.length;

  // At least one renewal happened, each carrying a fresh timestamp.
  assertEquals(renewalsWhileRunning >= 1, true);
  const first = parseLockComment(patchedBodies[0]!);
  assertEquals(first?.workerId, "worker-01");
  assertEquals((first?.timestamp ?? 0) > 1700000000, true);
  assertStringIncludes(patchedBodies[0]!, "Locked for a CI fix.");

  // Stopping is final — no timer outlives the work it covered.
  await new Promise((resolve) => setTimeout(resolve, 30));
  assertEquals(patchedBodies.length, renewalsWhileRunning);
});

Deno.test("pr_branch_lock - startBranchUpdateLockRenewal reports failures loudly", async () => {
  const errors: string[] = [];
  const { ghCommandFn } = createMockGh(() => new Error("API down"));

  const handle = startBranchUpdateLockRenewal({
    repo: "org/repo",
    lockCommentId: 777,
    workerId: "worker-01",
    intervalMs: 5,
    ghCommandFn,
    onError: (message) => errors.push(message),
  });

  await new Promise((resolve) => setTimeout(resolve, 40));
  handle.stop();

  assertEquals(errors.length >= 1, true);
  assertStringIncludes(errors[0]!, "API down");
});

// ---------------------------------------------------------------------------
// Competing-lock author verification (Issue #1124)
// ---------------------------------------------------------------------------

Deno.test("pr_branch_lock - asks GitHub who posted each lock comment", async () => {
  const calls: string[][] = [];
  const ghCommandFn = (args: string[]): Promise<string> => {
    calls.push(args);
    return Promise.resolve("[]");
  };
  await acquireBranchUpdateLock({
    authorOptions: FLEET_OPTIONS,
    log: () => {},
    repo: "org/repo",
    prNumber: 42,
    workerId: "worker-01",
    sleepFn: noSleep,
    ghCommandFn,
    nowFn: () => 1700000000,
  });
  const read = calls.find((args) => args.includes("--jq"));
  const jq = read![read!.indexOf("--jq") + 1] ?? "";
  assertEquals(
    jq.includes(".user.login"),
    true,
    "a lock marker is text anyone may post; without the commenter there " +
      "is nothing to check it against",
  );
});

Deno.test("pr_branch_lock - a planted lock does not stall the branch", async () => {
  // Issue #1124: an outsider's `BRANCH_UPDATE_LOCK` with a fresh timestamp
  // never expires and sorts earliest, so every host loses the race forever.
  const ghCommandFn = (args: string[]): Promise<string> => {
    if (args[0] === "api" && args.includes("--jq")) {
      return Promise.resolve(JSON.stringify([
        {
          id: 100,
          body: "<!-- BRANCH_UPDATE_LOCK:squatter:1700000000 -->",
          created_at: "2023-11-14T22:13:19Z",
          author: "drive-by-account",
        },
        {
          id: 101,
          body: "<!-- BRANCH_UPDATE_LOCK:worker-01:1700000000 -->",
          created_at: "2023-11-14T22:13:20Z",
          author: FLEET_AUTHOR,
        },
      ]));
    }
    if (args[0] === "issue" && args[1] === "comment") {
      return Promise.resolve(postedCommentUrl(101));
    }
    return Promise.resolve("");
  };

  const result = await acquireBranchUpdateLock({
    authorOptions: FLEET_OPTIONS,
    log: () => {},
    repo: "org/repo",
    prNumber: 42,
    workerId: "worker-01",
    sleepFn: noSleep,
    ghCommandFn,
    nowFn: () => 1700000000,
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.acquired, true);
    assertEquals(result.value.lockCommentId, 101);
  }
});

Deno.test("pr_branch_lock - a sibling fleet host's earlier lock still wins", async () => {
  // The guard that stops the fix becoming "always acquire": a genuine
  // fleet lock is still honoured, which is what the lock exists for.
  const ghCommandFn = (args: string[]): Promise<string> => {
    if (args[0] === "api" && args.includes("--jq")) {
      return Promise.resolve(JSON.stringify([
        {
          id: 100,
          body: "<!-- BRANCH_UPDATE_LOCK:worker-02:1700000000 -->",
          created_at: "2023-11-14T22:13:19Z",
          author: "sibling-fleet-host",
        },
        {
          id: 101,
          body: "<!-- BRANCH_UPDATE_LOCK:worker-01:1700000000 -->",
          created_at: "2023-11-14T22:13:20Z",
          author: FLEET_AUTHOR,
        },
      ]));
    }
    if (args[0] === "issue" && args[1] === "comment") {
      return Promise.resolve(postedCommentUrl(101));
    }
    return Promise.resolve("");
  };

  const result = await acquireBranchUpdateLock({
    authorOptions: { fleetAuthors: [FLEET_AUTHOR, "sibling-fleet-host"] },
    log: () => {},
    repo: "org/repo",
    prNumber: 42,
    workerId: "worker-01",
    sleepFn: noSleep,
    ghCommandFn,
    nowFn: () => 1700000000,
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.acquired, false);
    assertEquals(result.value.winnerId, "worker-02");
  }
});

Deno.test("pr_branch_lock - an unresolvable fleet leaves the branch updatable", async () => {
  // The chosen fail direction, asserted: two hosts updating one branch is
  // a conflict git resolves; a branch no host may update never merges.
  const lines: string[] = [];
  const ghCommandFn = (args: string[]): Promise<string> => {
    if (args[0] === "api" && args.includes("--jq")) {
      return Promise.resolve(JSON.stringify([
        {
          id: 100,
          body: "<!-- BRANCH_UPDATE_LOCK:worker-02:1700000000 -->",
          created_at: "2023-11-14T22:13:19Z",
          author: FLEET_AUTHOR,
        },
        {
          id: 101,
          body: "<!-- BRANCH_UPDATE_LOCK:worker-01:1700000000 -->",
          created_at: "2023-11-14T22:13:20Z",
          author: FLEET_AUTHOR,
        },
      ]));
    }
    if (args[0] === "issue" && args[1] === "comment") {
      return Promise.resolve(postedCommentUrl(101));
    }
    return Promise.resolve("");
  };

  const result = await acquireBranchUpdateLock({
    authorOptions: { fleetAuthors: [] },
    log: (message) => lines.push(message),
    repo: "org/repo",
    prNumber: 42,
    workerId: "worker-01",
    sleepFn: noSleep,
    ghCommandFn,
    nowFn: () => 1700000000,
  });

  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value.acquired, true);
  assertEquals(lines.length, 1);
  assertStringIncludes(lines[0]!, "the branch stays updatable");
});
