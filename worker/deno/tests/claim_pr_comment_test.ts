/**
 * Tests for claim_pr_comment.ts — atomic PR comment claiming to prevent
 * duplicate responses from multiple workers (Issue #1061).
 *
 * Uses injectable gh command function for testability.
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  claimPrComment,
  extractClaimInfo,
  PR_COMMENT_CLAIM_PREFIX,
} from "../lib/claim_pr_comment.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** No-op sleep for fast tests. */
const noSleep = () => Promise.resolve();

/**
 * The fleet service account every fixture claim is posted by (Issue #1124).
 *
 * Hosts share a service account and are told apart by the worker-id inside
 * the marker, so a race between `worker-alpha` and `worker-beta` is a race
 * between two comments from the same authenticated author. The planted
 * claim is the one from outside this set.
 */
const FLEET_AUTHOR = "vibe-coder-bot";

/** Author-verification inputs the fixtures pass instead of a config file. */
const FLEET_OPTIONS = { fleetAuthors: [FLEET_AUTHOR] } as const;

/** Check if a specific pattern was called. */
function wasCalledWith(calls: string[][], pattern: string): boolean {
  return calls.some((call) => call.join(" ").includes(pattern));
}

// ---------------------------------------------------------------------------
// PR_COMMENT_CLAIM_PREFIX
// ---------------------------------------------------------------------------

Deno.test("claim pr comment - PR_COMMENT_CLAIM_PREFIX has correct value", () => {
  assertEquals(PR_COMMENT_CLAIM_PREFIX, "<!-- PR_COMMENT_CLAIM:");
});

// ---------------------------------------------------------------------------
// extractClaimInfo
// ---------------------------------------------------------------------------

Deno.test("claim pr comment - extractClaimInfo extracts worker ID and comment ID", () => {
  const body = "<!-- PR_COMMENT_CLAIM:my-worker:12345 -->";
  const info = extractClaimInfo(body);
  assertEquals(info?.workerId, "my-worker");
  assertEquals(info?.commentId, "12345");
});

Deno.test("claim pr comment - extractClaimInfo returns null for non-claim body", () => {
  assertEquals(extractClaimInfo("not a claim"), null);
});

Deno.test("claim pr comment - extractClaimInfo handles complex worker IDs", () => {
  const body = "<!-- PR_COMMENT_CLAIM:server-mel-01@host:98765 -->";
  const info = extractClaimInfo(body);
  assertEquals(info?.workerId, "server-mel-01@host");
  assertEquals(info?.commentId, "98765");
});

// ---------------------------------------------------------------------------
// claimPrComment — sole claimant
// ---------------------------------------------------------------------------

Deno.test("claim pr comment - succeeds when sole claimant", async () => {
  const singleClaim = JSON.stringify([
    {
      id: 100,
      body: "<!-- PR_COMMENT_CLAIM:my-worker:555 -->",
      created_at: "2026-04-01T00:00:00Z",
      author: FLEET_AUTHOR,
    },
  ]);

  let apiCallCount = 0;
  const calls: string[][] = [];
  const mockGh = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "api" && !args.includes("-X")) {
      const endpoint = String(args[1]);
      if (endpoint.includes("/comments")) {
        apiCallCount++;
        if (apiCallCount === 1) return "[]"; // cleanup stale claims
        return singleClaim; // verification
      }
    }
    return "";
  };

  const result = await claimPrComment({
    repo: "org/repo",
    prNumber: 42,
    commentId: "555",
    workerId: "my-worker",
    sleepFn: noSleep,
    ghCommandFn: mockGh,
    authorOptions: FLEET_OPTIONS,
    log: () => {},
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.claimed, true);
    assertEquals(result.value.winnerId, "my-worker");
  }

  // Should post claim comment
  assertEquals(wasCalledWith(calls, "PR_COMMENT_CLAIM:my-worker:555"), true);
  // Should add eyes reaction to mark comment as being processed
  assertEquals(wasCalledWith(calls, "reactions"), true);
});

// ---------------------------------------------------------------------------
// claimPrComment — contested claim (loses)
// ---------------------------------------------------------------------------

Deno.test("claim pr comment - loses when another worker claimed earlier", async () => {
  const contestedClaims = JSON.stringify([
    {
      id: 100,
      body: "<!-- PR_COMMENT_CLAIM:worker-alpha:555 -->",
      created_at: "2026-04-01T00:00:01Z",
      author: FLEET_AUTHOR,
    },
    {
      id: 101,
      body: "<!-- PR_COMMENT_CLAIM:worker-beta:555 -->",
      created_at: "2026-04-01T00:00:02Z",
      author: FLEET_AUTHOR,
    },
  ]);

  let apiCallCount = 0;
  const calls: string[][] = [];
  const mockGh = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "api" && !args.includes("-X")) {
      const endpoint = String(args[1]);
      if (endpoint.includes("/comments")) {
        apiCallCount++;
        if (apiCallCount === 1) return "[]"; // cleanup
        return contestedClaims; // verification + removal
      }
    }
    return "";
  };

  const result = await claimPrComment({
    repo: "org/repo",
    prNumber: 42,
    commentId: "555",
    workerId: "worker-beta",
    sleepFn: noSleep,
    ghCommandFn: mockGh,
    authorOptions: FLEET_OPTIONS,
    log: () => {},
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.claimed, false);
    assertEquals(result.value.winnerId, "worker-alpha");
  }

  // Loser should clean up their claim comment
  assertEquals(wasCalledWith(calls, "-X DELETE"), true);
});

// ---------------------------------------------------------------------------
// claimPrComment — contested claim (wins)
// ---------------------------------------------------------------------------

Deno.test("claim pr comment - wins when this worker claimed earliest", async () => {
  const contestedClaims = JSON.stringify([
    {
      id: 100,
      body: "<!-- PR_COMMENT_CLAIM:worker-alpha:555 -->",
      created_at: "2026-04-01T00:00:01Z",
      author: FLEET_AUTHOR,
    },
    {
      id: 101,
      body: "<!-- PR_COMMENT_CLAIM:worker-beta:555 -->",
      created_at: "2026-04-01T00:00:02Z",
      author: FLEET_AUTHOR,
    },
  ]);

  let apiCallCount = 0;
  const mockGh = async (args: string[]): Promise<string> => {
    if (args[0] === "api" && !args.includes("-X")) {
      const endpoint = String(args[1]);
      if (endpoint.includes("/comments")) {
        apiCallCount++;
        if (apiCallCount === 1) return "[]";
        return contestedClaims;
      }
    }
    return "";
  };

  const result = await claimPrComment({
    repo: "org/repo",
    prNumber: 42,
    commentId: "555",
    workerId: "worker-alpha",
    sleepFn: noSleep,
    ghCommandFn: mockGh,
    authorOptions: FLEET_OPTIONS,
    log: () => {},
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.claimed, true);
    assertEquals(result.value.winnerId, "worker-alpha");
  }
});

// ---------------------------------------------------------------------------
// claimPrComment — only considers claims for the same target comment
// ---------------------------------------------------------------------------

Deno.test("claim pr comment - ignores claims for different target comment IDs", async () => {
  const mixedClaims = JSON.stringify([
    {
      id: 100,
      body: "<!-- PR_COMMENT_CLAIM:other-worker:999 -->",
      created_at: "2026-04-01T00:00:01Z",
      author: FLEET_AUTHOR,
    },
    {
      id: 101,
      body: "<!-- PR_COMMENT_CLAIM:my-worker:555 -->",
      created_at: "2026-04-01T00:00:02Z",
      author: FLEET_AUTHOR,
    },
  ]);

  let apiCallCount = 0;
  const mockGh = async (args: string[]): Promise<string> => {
    if (args[0] === "api" && !args.includes("-X")) {
      const endpoint = String(args[1]);
      if (endpoint.includes("/comments")) {
        apiCallCount++;
        if (apiCallCount === 1) return "[]";
        return mixedClaims;
      }
    }
    return "";
  };

  const result = await claimPrComment({
    repo: "org/repo",
    prNumber: 42,
    commentId: "555",
    workerId: "my-worker",
    sleepFn: noSleep,
    ghCommandFn: mockGh,
    authorOptions: FLEET_OPTIONS,
    log: () => {},
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    // Only one claim for comment 555, so we win
    assertEquals(result.value.claimed, true);
    assertEquals(result.value.winnerId, "my-worker");
  }
});

// ---------------------------------------------------------------------------
// claimPrComment — claim comment posting fails
// ---------------------------------------------------------------------------

Deno.test("claim pr comment - returns false when claim comment fails", async () => {
  const calls: string[][] = [];
  const mockGh = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "api" && !args.includes("-X")) {
      return "[]"; // cleanup
    }
    if (args[0] === "pr" && args[1] === "comment") {
      throw new Error("comment failed");
    }
    return "";
  };

  const result = await claimPrComment({
    repo: "org/repo",
    prNumber: 42,
    commentId: "555",
    workerId: "test-worker",
    sleepFn: noSleep,
    ghCommandFn: mockGh,
    authorOptions: FLEET_OPTIONS,
    log: () => {},
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.claimed, false);
  }
});

// ---------------------------------------------------------------------------
// claimPrComment — three-way race
// ---------------------------------------------------------------------------

Deno.test("claim pr comment - handles three-way race correctly", async () => {
  const threeWayClaims = JSON.stringify([
    {
      id: 100,
      body: "<!-- PR_COMMENT_CLAIM:charlie:555 -->",
      created_at: "2026-04-01T00:00:03Z",
      author: FLEET_AUTHOR,
    },
    {
      id: 101,
      body: "<!-- PR_COMMENT_CLAIM:alice:555 -->",
      created_at: "2026-04-01T00:00:01Z",
      author: FLEET_AUTHOR,
    },
    {
      id: 102,
      body: "<!-- PR_COMMENT_CLAIM:bob:555 -->",
      created_at: "2026-04-01T00:00:02Z",
      author: FLEET_AUTHOR,
    },
  ]);

  let apiCallCount = 0;
  const mockGh = async (args: string[]): Promise<string> => {
    if (args[0] === "api" && !args.includes("-X")) {
      const endpoint = String(args[1]);
      if (endpoint.includes("/comments")) {
        apiCallCount++;
        if (apiCallCount === 1) return "[]";
        return threeWayClaims;
      }
    }
    return "";
  };

  // Charlie should lose (alice has earliest)
  const result = await claimPrComment({
    repo: "org/repo",
    prNumber: 42,
    commentId: "555",
    workerId: "charlie",
    sleepFn: noSleep,
    ghCommandFn: mockGh,
    authorOptions: FLEET_OPTIONS,
    log: () => {},
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.claimed, false);
    assertEquals(result.value.winnerId, "alice");
  }
});

// ---------------------------------------------------------------------------
// claimPrComment — stale claims cleaned up
// ---------------------------------------------------------------------------

Deno.test("claim pr comment - cleans up stale claim comments before claiming", async () => {
  const staleClaims = JSON.stringify([100, 101]);
  const singleClaim = JSON.stringify([
    {
      id: 200,
      body: "<!-- PR_COMMENT_CLAIM:my-worker:555 -->",
      created_at: "2026-04-01T00:00:00Z",
      author: FLEET_AUTHOR,
    },
  ]);

  let apiCallCount = 0;
  const calls: string[][] = [];
  const mockGh = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "api" && !args.includes("-X")) {
      const endpoint = String(args[1]);
      if (endpoint.includes("/comments")) {
        apiCallCount++;
        if (apiCallCount === 1) return staleClaims; // stale claims to clean
        return singleClaim; // verification
      }
    }
    return "";
  };

  const result = await claimPrComment({
    repo: "org/repo",
    prNumber: 42,
    commentId: "555",
    workerId: "my-worker",
    sleepFn: noSleep,
    ghCommandFn: mockGh,
    authorOptions: FLEET_OPTIONS,
    log: () => {},
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.claimed, true);
  }

  // Should have deleted stale claims
  const deleteCalls = calls.filter((c) =>
    c.includes("-X") && c.includes("DELETE")
  );
  assertEquals(deleteCalls.length, 2);
});

// ---------------------------------------------------------------------------
// claimPrComment — verification API failure
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// claim body must contain visible text (Issue #1659)
//
// HTML comments alone render as blank on GitHub. If a claim is not cleaned
// up (loser back-off failure, crash mid-claim), the thread shows multiple
// blank comments — confusing readers who report "Multiple blank comments".
// Make the visible portion describe what the comment is.
// ---------------------------------------------------------------------------

Deno.test("claim pr comment - posted body contains visible text, not only HTML comment", async () => {
  let postedBody: string | undefined;
  const mockGh = async (args: string[]): Promise<string> => {
    if (args[0] === "pr" && args[1] === "comment") {
      const bodyIdx = args.indexOf("--body");
      if (bodyIdx >= 0) postedBody = args[bodyIdx + 1];
      return "";
    }
    if (args[0] === "api" && !args.includes("-X")) {
      const endpoint = String(args[1]);
      if (endpoint.includes("/comments")) {
        return JSON.stringify([
          {
            id: 200,
            body: postedBody ?? "",
            created_at: "2026-04-01T00:00:00Z",
            author: FLEET_AUTHOR,
          },
        ]);
      }
    }
    return "";
  };

  const result = await claimPrComment({
    repo: "org/repo",
    prNumber: 42,
    commentId: "555",
    workerId: "my-worker",
    sleepFn: noSleep,
    ghCommandFn: mockGh,
    authorOptions: FLEET_OPTIONS,
    log: () => {},
  });

  assertEquals(result.ok, true);
  // Body must include the HTML comment marker for race detection.
  assertEquals(
    postedBody?.includes("<!-- PR_COMMENT_CLAIM:my-worker:555 -->"),
    true,
  );
  // Body must also include visible (non-HTML-comment) text, otherwise the
  // claim renders as a blank comment on GitHub.
  const visiblePortion = (postedBody ?? "").replace(/<!--[\s\S]*?-->/g, "")
    .trim();
  assertEquals(
    visiblePortion.length > 0,
    true,
    `Claim body has no visible text — would render blank on GitHub. Got: ${
      JSON.stringify(postedBody)
    }`,
  );
  // Visible text should reference the worker so readers can understand it.
  assertEquals(visiblePortion.includes("my-worker"), true);
});

Deno.test("claim pr comment - extractClaimInfo still works with visible text appended", () => {
  const body =
    "<!-- PR_COMMENT_CLAIM:my-worker:12345 -->\nClaiming PR feedback comment for worker `my-worker`.";
  const info = extractClaimInfo(body);
  assertEquals(info?.workerId, "my-worker");
  assertEquals(info?.commentId, "12345");
});

Deno.test("claim pr comment - backs off when verification API fails", async () => {
  let apiGetCallCount = 0;
  const calls: string[][] = [];
  const mockGh = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "api" && !args.includes("-X")) {
      const endpoint = String(args[1]);
      if (endpoint.includes("/comments")) {
        apiGetCallCount++;
        if (apiGetCallCount === 1) return "[]"; // cleanup
        if (apiGetCallCount === 2) throw new Error("API failure"); // verification fails
        // Subsequent calls for cleanup return the claim so it can be deleted
        return JSON.stringify([{
          id: 200,
          body: "<!-- PR_COMMENT_CLAIM:test-worker:555 -->",
          created_at: "2026-04-01T00:00:00Z",
          author: FLEET_AUTHOR,
        }]);
      }
    }
    return "";
  };

  const result = await claimPrComment({
    repo: "org/repo",
    prNumber: 42,
    commentId: "555",
    workerId: "test-worker",
    sleepFn: noSleep,
    ghCommandFn: mockGh,
    authorOptions: FLEET_OPTIONS,
    log: () => {},
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.claimed, false);
  }
});

// ---------------------------------------------------------------------------
// Competing-claim author verification (Issue #1124)
// ---------------------------------------------------------------------------

Deno.test("claim pr comment - asks GitHub who posted each competing claim", async () => {
  const calls: string[][] = [];
  let apiCallCount = 0;
  const mockGh = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "api" && !args.includes("-X")) {
      apiCallCount++;
      return apiCallCount === 1 ? "[]" : "[]";
    }
    return "";
  };
  await claimPrComment({
    repo: "org/repo",
    prNumber: 42,
    commentId: "555",
    workerId: "worker-beta",
    sleepFn: noSleep,
    ghCommandFn: mockGh,
    authorOptions: FLEET_OPTIONS,
    log: () => {},
  });
  const verification =
    calls.filter((args) => args[0] === "api" && !args.includes("-X"))[1];
  const jq = verification![verification!.indexOf("--jq") + 1] ?? "";
  assertEquals(
    jq.includes(".user.login"),
    true,
    "a claim marker is text anyone may post; without the commenter there " +
      "is nothing to check it against",
  );
});

Deno.test("claim pr comment - a planted claim does not cost this host the race", async () => {
  // Issue #1124: an outsider's `PR_COMMENT_CLAIM:` sorts earliest and hands
  // the PR to nobody. It must not be counted as a competing claim at all.
  const claims = JSON.stringify([
    {
      id: 100,
      body: "<!-- PR_COMMENT_CLAIM:squatter:555 -->",
      created_at: "2026-04-01T00:00:01Z",
      author: "drive-by-account",
    },
    {
      id: 101,
      body: "<!-- PR_COMMENT_CLAIM:worker-beta:555 -->",
      created_at: "2026-04-01T00:00:02Z",
      author: FLEET_AUTHOR,
    },
  ]);
  let apiCallCount = 0;
  const mockGh = async (args: string[]): Promise<string> => {
    if (args[0] === "api" && !args.includes("-X")) {
      apiCallCount++;
      return apiCallCount === 1 ? "[]" : claims;
    }
    return "";
  };

  const result = await claimPrComment({
    repo: "org/repo",
    prNumber: 42,
    commentId: "555",
    workerId: "worker-beta",
    sleepFn: noSleep,
    ghCommandFn: mockGh,
    authorOptions: FLEET_OPTIONS,
    log: () => {},
  });

  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value.claimed, true);
});

Deno.test("claim pr comment - an unresolvable fleet leaves the work claimable", async () => {
  // The chosen fail direction, asserted: two hosts answering the same
  // feedback comment is a wasted run; a comment no host may ever claim is
  // feedback nobody answers.
  const claims = JSON.stringify([
    {
      id: 100,
      body: "<!-- PR_COMMENT_CLAIM:worker-alpha:555 -->",
      created_at: "2026-04-01T00:00:01Z",
      author: FLEET_AUTHOR,
    },
    {
      id: 101,
      body: "<!-- PR_COMMENT_CLAIM:worker-beta:555 -->",
      created_at: "2026-04-01T00:00:02Z",
      author: FLEET_AUTHOR,
    },
  ]);
  let apiCallCount = 0;
  const lines: string[] = [];
  const mockGh = async (args: string[]): Promise<string> => {
    if (args[0] === "api" && !args.includes("-X")) {
      apiCallCount++;
      return apiCallCount === 1 ? "[]" : claims;
    }
    return "";
  };

  const result = await claimPrComment({
    repo: "org/repo",
    prNumber: 42,
    commentId: "555",
    workerId: "worker-beta",
    sleepFn: noSleep,
    ghCommandFn: mockGh,
    authorOptions: { fleetAuthors: [] },
    log: (message) => lines.push(message),
  });

  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value.claimed, true);
  assertEquals(lines.length, 1);
  assertEquals(lines[0]?.includes("the work stays claimable"), true);
});
