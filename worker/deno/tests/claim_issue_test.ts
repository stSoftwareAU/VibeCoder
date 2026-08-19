/**
 * Tests for claim_issue.ts — atomic issue claiming with verification
 * (Issue #433, #604, #911).
 *
 * Uses injectable gh command function for testability.
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  checkClaimChurn,
  CLAIM_MARKER_PREFIX,
  claimIssue,
  classifyGhAssignError,
  extractWorkerIdFromComment,
  fetchIssueState,
  releaseClaimWithCooldown,
  resolveTrustedClaimAuthors,
} from "../lib/claim_issue.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** No-op sleep for fast tests. */
const noSleep = () => Promise.resolve();

/** Create a mock gh command function that records calls and returns scripted responses. */
function createMockGh(responses: Record<string, string | Error> = {}) {
  const calls: string[][] = [];

  const ghCommandFn = async (args: string[]): Promise<string> => {
    calls.push(args);

    // Match on the first few args to determine response
    const key = args.slice(0, 3).join(" ");

    for (const [pattern, response] of Object.entries(responses)) {
      if (key.includes(pattern) || args.join(" ").includes(pattern)) {
        if (response instanceof Error) throw response;
        return response;
      }
    }

    return "";
  };

  return { ghCommandFn, calls };
}

/** Check if a specific pattern was called. */
function wasCalledWith(calls: string[][], pattern: string): boolean {
  return calls.some((call) => call.join(" ").includes(pattern));
}

// ---------------------------------------------------------------------------
// extractWorkerIdFromComment
// ---------------------------------------------------------------------------

Deno.test("claim issue - extractWorkerIdFromComment extracts worker ID", () => {
  const body = "<!-- CLAIM_LOCK:test-worker --> Claimed by test-worker";
  assertEquals(extractWorkerIdFromComment(body), "test-worker");
});

Deno.test("claim issue - extractWorkerIdFromComment returns empty for invalid body", () => {
  assertEquals(extractWorkerIdFromComment("no claim here"), "");
});

Deno.test("claim issue - extractWorkerIdFromComment handles hyphenated names", () => {
  const body = "<!-- CLAIM_LOCK:server-mel-01 --> Claimed by server-mel-01";
  assertEquals(extractWorkerIdFromComment(body), "server-mel-01");
});

// ---------------------------------------------------------------------------
// CLAIM_MARKER_PREFIX
// ---------------------------------------------------------------------------

Deno.test("claim issue - CLAIM_MARKER_PREFIX has correct value", () => {
  assertEquals(CLAIM_MARKER_PREFIX, "<!-- CLAIM_LOCK:");
});

// ---------------------------------------------------------------------------
// claimIssue — pre-claim freshness re-check (Issue #1086)
// ---------------------------------------------------------------------------

Deno.test("claim issue - claimIssue bails out when issue is already assigned (pre-claim check)", async () => {
  const calls: string[][] = [];
  const mockGh = async (args: string[]): Promise<string> => {
    calls.push(args);
    // Issue state check
    if (args[0] === "issue" && args[1] === "view" && args.includes("--jq")) {
      const jqArg = args[args.indexOf("--jq") + 1] ?? "";
      if (jqArg === ".state") return "OPEN";
      // Assignees check — issue already has an assignee
      if (jqArg.includes("assignees")) return '["other-worker"]';
    }
    // Comments check for recent claims
    if (args[0] === "api" && String(args[1]).includes("/comments")) {
      return "[]";
    }
    return "";
  };

  const result = await claimIssue({
    repo: "org/repo",
    issueNumber: 42,
    githubUser: "worker-bot",
    workerId: "my-worker",
    sleepFn: noSleep,
    ghCommandFn: mockGh,
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.claimed, false);
  }

  // Should NOT attempt to assign or post claim comments
  assertEquals(wasCalledWith(calls, "--add-assignee"), false);
  assertEquals(wasCalledWith(calls, "issue comment"), false);
});

Deno.test("claim issue - claimIssue bails out when recent CLAIM_LOCK comment exists (pre-claim check)", async () => {
  const recentTime = new Date(Date.now() - 30_000).toISOString(); // 30 seconds ago
  const recentClaimComments = JSON.stringify([
    {
      id: 99,
      // Same fleet account, different worker id — the shared-username
      // deployment comment-based claiming was built for (Issue #604).
      // The author is now part of the mock because claim markers are only
      // honoured when the fleet posted them (Issue #3664).
      body: "<!-- CLAIM_LOCK:other-worker --> Claimed",
      created_at: recentTime,
      author: "worker-bot",
    },
  ]);

  const calls: string[][] = [];
  const mockGh = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "view" && args.includes("--jq")) {
      const jqArg = args[args.indexOf("--jq") + 1] ?? "";
      if (jqArg === ".state") return "OPEN";
      if (jqArg.includes("assignees")) return "[]"; // No assignees
    }
    // Comments check — return a recent claim comment
    if (
      args[0] === "api" && String(args[1]).includes("/comments") &&
      args.includes("--jq")
    ) {
      const jqArg = args[args.indexOf("--jq") + 1] ?? "";
      if (jqArg.includes("CLAIM_LOCK") && jqArg.includes("created_at")) {
        return recentClaimComments;
      }
    }
    return "";
  };

  const result = await claimIssue({
    repo: "org/repo",
    issueNumber: 42,
    githubUser: "worker-bot",
    workerId: "my-worker",
    sleepFn: noSleep,
    ghCommandFn: mockGh,
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.claimed, false);
  }

  // Should NOT attempt to assign or post claim comments
  assertEquals(wasCalledWith(calls, "--add-assignee"), false);
  assertEquals(wasCalledWith(calls, "issue comment"), false);
});

Deno.test("claim issue - claimIssue proceeds when genuinely unassigned and no recent claims", async () => {
  const singleClaim = JSON.stringify([
    {
      id: 1,
      body: "<!-- CLAIM_LOCK:my-worker --> Claimed",
      created_at: "2026-03-18T00:00:00Z",
      author: "worker-bot",
    },
  ]);

  let apiCallCount = 0;
  const calls: string[][] = [];
  const mockGh = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "view" && args.includes("--jq")) {
      const jqArg = args[args.indexOf("--jq") + 1] ?? "";
      if (jqArg === ".state") return "OPEN";
      if (jqArg.includes("assignees")) return "[]"; // No assignees
    }
    if (
      args[0] === "api" && String(args[1]).includes("/comments") &&
      !args.includes("-X")
    ) {
      apiCallCount++;
      if (apiCallCount === 1) return "[]"; // Pre-claim: no recent claims
      if (apiCallCount === 2) return "[]"; // Cleanup: no stale comments
      return singleClaim; // Verification: single claim
    }
    return "";
  };

  const result = await claimIssue({
    repo: "org/repo",
    issueNumber: 42,
    githubUser: "worker-bot",
    workerId: "my-worker",
    sleepFn: noSleep,
    ghCommandFn: mockGh,
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.claimed, true);
    assertEquals(result.value.winnerId, "my-worker");
  }

  // Should proceed with the full claim process
  assertEquals(wasCalledWith(calls, "--add-assignee worker-bot"), true);
  assertEquals(wasCalledWith(calls, "issue comment"), true);
});

Deno.test("claim issue - claimIssue ignores a forged CLAIM_LOCK from a non-fleet author (Issue #3164)", async () => {
  const recentTime = new Date(Date.now() - 30_000).toISOString();
  const forgedClaim = JSON.stringify([
    {
      id: 99,
      body: "<!-- CLAIM_LOCK:evil --> Claimed",
      created_at: recentTime,
      author: "attacker",
    },
  ]);
  const ownClaim = JSON.stringify([
    {
      id: 1,
      body: "<!-- CLAIM_LOCK:my-worker --> Claimed",
      created_at: "2026-03-18T00:00:00Z",
      author: "worker-bot",
    },
  ]);

  let apiCallCount = 0;
  const calls: string[][] = [];
  const mockGh = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "view" && args.includes("--jq")) {
      const jqArg = args[args.indexOf("--jq") + 1] ?? "";
      if (jqArg === ".state") return "OPEN";
      if (jqArg.includes("assignees")) return "[]";
    }
    if (
      args[0] === "api" && String(args[1]).includes("/comments") &&
      !args.includes("-X")
    ) {
      apiCallCount++;
      if (apiCallCount === 1) return forgedClaim; // Pre-claim: forged lock
      if (apiCallCount === 2) return "[]"; // Cleanup
      return ownClaim; // Verification: our own claim
    }
    return "";
  };

  const result = await claimIssue({
    repo: "org/repo",
    issueNumber: 42,
    githubUser: "worker-bot",
    workerId: "my-worker",
    sleepFn: noSleep,
    ghCommandFn: mockGh,
    fleetAuthors: ["worker-bot", "stsvcbot"], // attacker is not in the fleet
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    // The forged lock is ignored, so the claim proceeds.
    assertEquals(result.value.claimed, true);
  }
  assertEquals(wasCalledWith(calls, "--add-assignee worker-bot"), true);
});

Deno.test("claim issue - claimIssue still bails out on a recent CLAIM_LOCK from a fleet author (Issue #3164)", async () => {
  const recentTime = new Date(Date.now() - 30_000).toISOString();
  const fleetClaim = JSON.stringify([
    {
      id: 7,
      body: "<!-- CLAIM_LOCK:stsvcbot-123 --> Claimed",
      created_at: recentTime,
      author: "stsvcbot",
    },
  ]);

  const calls: string[][] = [];
  const mockGh = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "view" && args.includes("--jq")) {
      const jqArg = args[args.indexOf("--jq") + 1] ?? "";
      if (jqArg === ".state") return "OPEN";
      if (jqArg.includes("assignees")) return "[]";
    }
    if (
      args[0] === "api" && String(args[1]).includes("/comments") &&
      !args.includes("-X")
    ) {
      return fleetClaim;
    }
    return "";
  };

  const result = await claimIssue({
    repo: "org/repo",
    issueNumber: 42,
    githubUser: "worker-bot",
    workerId: "my-worker",
    sleepFn: noSleep,
    ghCommandFn: mockGh,
    fleetAuthors: ["worker-bot", "stsvcbot"],
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.claimed, false);
    assertEquals(result.value.reason, "recent_claim");
  }
  assertEquals(wasCalledWith(calls, "--add-assignee"), false);
});

Deno.test("claim issue - claimIssue pre-claim check fails open on API error", async () => {
  const singleClaim = JSON.stringify([
    {
      id: 1,
      body: "<!-- CLAIM_LOCK:my-worker --> Claimed",
      created_at: "2026-03-18T00:00:00Z",
      author: "worker-bot",
    },
  ]);

  let apiCallCount = 0;
  let issueViewCount = 0;
  const calls: string[][] = [];
  const mockGh = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "view" && args.includes("--jq")) {
      issueViewCount++;
      const jqArg = args[args.indexOf("--jq") + 1] ?? "";
      if (jqArg === ".state") return "OPEN";
      // Pre-claim assignee check fails
      if (jqArg.includes("assignees")) throw new Error("API failure");
    }
    if (
      args[0] === "api" && String(args[1]).includes("/comments") &&
      !args.includes("-X")
    ) {
      apiCallCount++;
      if (apiCallCount === 1) return "[]"; // Pre-claim: no recent claims (or cleanup)
      if (apiCallCount === 2) return "[]"; // Cleanup
      return singleClaim; // Verification
    }
    return "";
  };

  const result = await claimIssue({
    repo: "org/repo",
    issueNumber: 42,
    githubUser: "worker-bot",
    workerId: "my-worker",
    sleepFn: noSleep,
    ghCommandFn: mockGh,
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    // Should still proceed and succeed — fail open
    assertEquals(result.value.claimed, true);
  }
});

// ---------------------------------------------------------------------------
// claimIssue — sole claimant
// ---------------------------------------------------------------------------

Deno.test("claim issue - claimIssue succeeds when sole claimant", async () => {
  const singleClaim = JSON.stringify([
    {
      id: 1,
      body: "<!-- CLAIM_LOCK:my-worker --> Claimed",
      created_at: "2026-03-18T00:00:00Z",
      author: "worker-bot",
    },
  ]);

  // Override to return specific responses for different API calls
  let apiCallCount = 0;
  const calls: string[][] = [];
  const customGh = async (args: string[]): Promise<string> => {
    calls.push(args);
    // Issue view checks (state + assignees for pre-claim)
    if (args[0] === "issue" && args[1] === "view" && args.includes("--jq")) {
      const jqArg = args[args.indexOf("--jq") + 1] ?? "";
      if (jqArg === ".state") return "OPEN";
      if (jqArg.includes("assignees")) return "[]"; // No assignees
    }
    if (args[0] === "api" && args.length > 1) {
      const endpoint = String(args[1]);
      if (endpoint.includes("/comments") && !args.includes("-X")) {
        apiCallCount++;
        if (apiCallCount <= 2) return "[]"; // pre-claim + cleanup
        return singleClaim; // verification
      }
    }
    return "";
  };

  const result = await claimIssue({
    repo: "org/repo",
    issueNumber: 42,
    githubUser: "worker-bot",
    workerId: "my-worker",
    sleepFn: noSleep,
    ghCommandFn: customGh,
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.claimed, true);
    assertEquals(result.value.winnerId, "my-worker");
  }

  // Verify assignment was called
  assertEquals(wasCalledWith(calls, "--add-assignee worker-bot"), true);
  // Verify claim comment was posted
  assertEquals(wasCalledWith(calls, "issue comment"), true);
});

// ---------------------------------------------------------------------------
// claimIssue — issue already closed
// ---------------------------------------------------------------------------

Deno.test("claim issue - claimIssue returns false when issue is already closed", async () => {
  const calls: string[][] = [];
  const mockGh = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "view" && args.includes("--jq")) {
      const jqArg = args[args.indexOf("--jq") + 1] ?? "";
      if (jqArg === ".state") return "CLOSED";
      if (jqArg.includes("assignees")) return "[]"; // No assignees
    }
    if (args[0] === "api" && String(args[1]).includes("/comments")) return "[]";
    return "";
  };

  const result = await claimIssue({
    repo: "org/repo",
    issueNumber: 42,
    githubUser: "worker-bot",
    workerId: "my-worker",
    sleepFn: noSleep,
    ghCommandFn: mockGh,
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.claimed, false);
  }

  // Should NOT attempt to assign or post comments
  assertEquals(wasCalledWith(calls, "--add-assignee"), false);
  assertEquals(wasCalledWith(calls, "issue comment"), false);
});

// ---------------------------------------------------------------------------
// claimIssue — contested claim (loses)
// ---------------------------------------------------------------------------

Deno.test("claim issue - claimIssue loses when another worker claimed earlier", async () => {
  const contestedClaims = JSON.stringify([
    {
      id: 1,
      body: "<!-- CLAIM_LOCK:worker-alpha --> Claimed",
      created_at: "2026-03-18T00:00:01Z",
      author: "worker-bot",
    },
    {
      id: 2,
      body: "<!-- CLAIM_LOCK:worker-beta --> Claimed",
      created_at: "2026-03-18T00:00:02Z",
      author: "worker-bot",
    },
  ]);

  let apiCallCount = 0;
  const calls: string[][] = [];
  const mockGh = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "view" && args.includes("--jq")) {
      const jqArg = args[args.indexOf("--jq") + 1] ?? "";
      if (jqArg === ".state") return "OPEN";
      if (jqArg.includes("assignees")) return "[]";
    }
    if (args[0] === "api" && !args.includes("-X")) {
      apiCallCount++;
      if (apiCallCount <= 2) return "[]"; // pre-claim + cleanup
      if (apiCallCount >= 3) return contestedClaims; // verification + removal lookup
    }
    return "";
  };

  const result = await claimIssue({
    repo: "org/repo",
    issueNumber: 42,
    githubUser: "worker-bot",
    workerId: "worker-beta",
    sleepFn: noSleep,
    ghCommandFn: mockGh,
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.claimed, false);
    assertEquals(result.value.winnerId, "worker-alpha");
  }

  // Loser should unassign
  assertEquals(wasCalledWith(calls, "--remove-assignee worker-bot"), true);
});

// ---------------------------------------------------------------------------
// claimIssue — contested claim (wins)
// ---------------------------------------------------------------------------

Deno.test("claim issue - claimIssue wins when this worker claimed earliest", async () => {
  const contestedClaims = JSON.stringify([
    {
      id: 1,
      body: "<!-- CLAIM_LOCK:worker-alpha --> Claimed",
      created_at: "2026-03-18T00:00:01Z",
      author: "worker-bot",
    },
    {
      id: 2,
      body: "<!-- CLAIM_LOCK:worker-beta --> Claimed",
      created_at: "2026-03-18T00:00:02Z",
      author: "worker-bot",
    },
  ]);

  let apiCallCount = 0;
  const mockGh = async (args: string[]): Promise<string> => {
    if (args[0] === "issue" && args[1] === "view" && args.includes("--jq")) {
      const jqArg = args[args.indexOf("--jq") + 1] ?? "";
      if (jqArg === ".state") return "OPEN";
      if (jqArg.includes("assignees")) return "[]";
    }
    if (args[0] === "api" && !args.includes("-X")) {
      apiCallCount++;
      if (apiCallCount <= 2) return "[]"; // pre-claim + cleanup
      return contestedClaims;
    }
    return "";
  };

  const result = await claimIssue({
    repo: "org/repo",
    issueNumber: 42,
    githubUser: "worker-bot",
    workerId: "worker-alpha",
    sleepFn: noSleep,
    ghCommandFn: mockGh,
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.claimed, true);
    assertEquals(result.value.winnerId, "worker-alpha");
  }
});

// ---------------------------------------------------------------------------
// claimIssue — three-way race
// ---------------------------------------------------------------------------

Deno.test("claim issue - claimIssue handles three-way race correctly", async () => {
  const threeWayClaims = JSON.stringify([
    {
      id: 1,
      body: "<!-- CLAIM_LOCK:charlie --> Claimed",
      created_at: "2026-03-18T00:00:03Z",
      author: "worker-bot",
    },
    {
      id: 2,
      body: "<!-- CLAIM_LOCK:alice --> Claimed",
      created_at: "2026-03-18T00:00:01Z",
      author: "worker-bot",
    },
    {
      id: 3,
      body: "<!-- CLAIM_LOCK:bob --> Claimed",
      created_at: "2026-03-18T00:00:02Z",
      author: "worker-bot",
    },
  ]);

  let apiCallCount = 0;
  const mockGh = async (args: string[]): Promise<string> => {
    if (args[0] === "issue" && args[1] === "view" && args.includes("--jq")) {
      const jqArg = args[args.indexOf("--jq") + 1] ?? "";
      if (jqArg === ".state") return "OPEN";
      if (jqArg.includes("assignees")) return "[]";
    }
    if (args[0] === "api" && !args.includes("-X")) {
      apiCallCount++;
      if (apiCallCount <= 2) return "[]"; // pre-claim + cleanup
      return threeWayClaims;
    }
    return "";
  };

  // Charlie should lose (alice has earliest)
  const result = await claimIssue({
    repo: "org/repo",
    issueNumber: 42,
    githubUser: "worker-bot",
    workerId: "charlie",
    sleepFn: noSleep,
    ghCommandFn: mockGh,
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.claimed, false);
    assertEquals(result.value.winnerId, "alice");
  }
});

// ---------------------------------------------------------------------------
// claimIssue — assignment failure
// ---------------------------------------------------------------------------

Deno.test("claim issue - claimIssue returns false when assignment fails", async () => {
  const calls: string[][] = [];
  const mockGh = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "view" && args.includes("--jq")) {
      const jqArg = args[args.indexOf("--jq") + 1] ?? "";
      if (jqArg === ".state") return "OPEN";
      if (jqArg.includes("assignees")) return "[]";
    }
    if (args[0] === "api" && !args.includes("-X")) {
      return "[]"; // pre-claim + cleanup
    }
    if (args.includes("--add-assignee")) {
      throw new Error("assignment failed");
    }
    return "";
  };

  const result = await claimIssue({
    repo: "org/repo",
    issueNumber: 42,
    githubUser: "worker-a",
    workerId: "test-host",
    sleepFn: noSleep,
    ghCommandFn: mockGh,
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.claimed, false);
    // Issue #2325: unrecognised gh error message falls back to "api_error"
    // (not a 4xx code we know about).
    assertEquals(result.value.reason, "api_error");
    assertEquals(typeof result.value.reasonDetail, "string");
  }
});

// ---------------------------------------------------------------------------
// classifyGhAssignError (Issue #2325)
// ---------------------------------------------------------------------------

Deno.test("claim issue - classifyGhAssignError flags 422 'assignees invalid' as not_assignable", () => {
  const msg = "gh command failed (exit 1): HTTP 422: Validation Failed " +
    "(https://api.github.com/repos/org/repo/issues/42) - 'assignees' is invalid";
  assertEquals(classifyGhAssignError(msg), "not_assignable");
});

Deno.test("claim issue - classifyGhAssignError flags 403 as forbidden", () => {
  assertEquals(
    classifyGhAssignError("gh command failed (exit 1): HTTP 403: Forbidden"),
    "forbidden",
  );
});

Deno.test("claim issue - classifyGhAssignError flags 404 as not_found", () => {
  assertEquals(
    classifyGhAssignError("gh command failed (exit 1): HTTP 404: Not Found"),
    "not_found",
  );
});

Deno.test("claim issue - classifyGhAssignError defaults unknown errors to api_error", () => {
  assertEquals(classifyGhAssignError("connection reset by peer"), "api_error");
  assertEquals(classifyGhAssignError(""), "api_error");
});

// ---------------------------------------------------------------------------
// claimIssue — non-collaborator 422 surfaces not_assignable (Issue #2325)
// ---------------------------------------------------------------------------

Deno.test("claim issue - claimIssue surfaces not_assignable reason for 422 'assignees invalid'", async () => {
  const calls: string[][] = [];
  const ghError = new Error(
    "gh command failed (exit 1): HTTP 422: Validation Failed " +
      "(https://api.github.com/repos/org/repo/issues/42) - 'assignees' is invalid",
  );
  const mockGh = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "view" && args.includes("--jq")) {
      const jqArg = args[args.indexOf("--jq") + 1] ?? "";
      if (jqArg === ".state") return "OPEN";
      if (jqArg.includes("assignees")) return "[]";
    }
    if (args[0] === "api" && !args.includes("-X")) {
      return "[]";
    }
    if (args.includes("--add-assignee")) {
      throw ghError;
    }
    return "";
  };

  const result = await claimIssue({
    repo: "org/repo",
    issueNumber: 42,
    githubUser: "worker-bot",
    workerId: "test-worker",
    sleepFn: noSleep,
    ghCommandFn: mockGh,
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.claimed, false);
    assertEquals(result.value.reason, "not_assignable");
    // The captured gh error must be returned so the caller can log it.
    assertEquals(
      typeof result.value.reasonDetail === "string" &&
        result.value.reasonDetail.includes("422"),
      true,
      `reasonDetail must include the gh stderr; got: ${result.value.reasonDetail}`,
    );
  }

  // No side effects: must not have posted a claim comment and must not
  // have attempted to remove an assignee that was never added.
  assertEquals(wasCalledWith(calls, "issue comment"), false);
  assertEquals(wasCalledWith(calls, "--remove-assignee"), false);
});

Deno.test("claim issue - claimIssue surfaces forbidden reason for 403", async () => {
  const mockGh = async (args: string[]): Promise<string> => {
    if (args[0] === "issue" && args[1] === "view" && args.includes("--jq")) {
      const jqArg = args[args.indexOf("--jq") + 1] ?? "";
      if (jqArg === ".state") return "OPEN";
      if (jqArg.includes("assignees")) return "[]";
    }
    if (args[0] === "api" && !args.includes("-X")) return "[]";
    if (args.includes("--add-assignee")) {
      throw new Error("gh command failed (exit 1): HTTP 403: Forbidden");
    }
    return "";
  };

  const result = await claimIssue({
    repo: "org/repo",
    issueNumber: 42,
    githubUser: "worker-bot",
    workerId: "test-worker",
    sleepFn: noSleep,
    ghCommandFn: mockGh,
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.claimed, false);
    assertEquals(result.value.reason, "forbidden");
  }
});

// ---------------------------------------------------------------------------
// claimIssue — other reason codes (Issue #2325)
// ---------------------------------------------------------------------------

Deno.test("claim issue - claimIssue surfaces already_closed reason when issue is closed", async () => {
  const mockGh = async (args: string[]): Promise<string> => {
    if (args[0] === "issue" && args[1] === "view" && args.includes("--jq")) {
      const jqArg = args[args.indexOf("--jq") + 1] ?? "";
      if (jqArg === ".state") return "CLOSED";
      if (jqArg.includes("assignees")) return "[]";
    }
    if (args[0] === "api" && String(args[1]).includes("/comments")) return "[]";
    return "";
  };

  const result = await claimIssue({
    repo: "org/repo",
    issueNumber: 42,
    githubUser: "worker-bot",
    workerId: "test-worker",
    sleepFn: noSleep,
    ghCommandFn: mockGh,
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.claimed, false);
    assertEquals(result.value.reason, "already_closed");
  }
});

// ---------------------------------------------------------------------------
// fetchIssueState hardening (Issue #3151)
// ---------------------------------------------------------------------------

Deno.test("fetchIssueState - returns OPEN/CLOSED on a successful call", async () => {
  const openGh = (_args: string[]) => Promise.resolve("OPEN");
  assertEquals(
    await fetchIssueState("o/r", 1, openGh, { sleepFn: noSleep }),
    "OPEN",
  );
  const closedGh = (_args: string[]) => Promise.resolve("CLOSED");
  assertEquals(
    await fetchIssueState("o/r", 1, closedGh, { sleepFn: noSleep }),
    "CLOSED",
  );
});

Deno.test("fetchIssueState - retries transient errors then succeeds", async () => {
  let attempts = 0;
  const flakyGh = (_args: string[]): Promise<string> => {
    attempts++;
    if (attempts < 3) return Promise.reject(new Error("HTTP 502"));
    return Promise.resolve("OPEN");
  };
  const state = await fetchIssueState("o/r", 1, flakyGh, {
    maxAttempts: 3,
    sleepFn: noSleep,
  });
  assertEquals(state, "OPEN");
  assertEquals(attempts, 3);
});

Deno.test("fetchIssueState - fails CLOSED (not open) when every attempt errors", async () => {
  // A persistent transient gh failure must NOT fail open into starting work
  // on a possibly-merged issue (Issue #3151).
  let attempts = 0;
  const brokenGh = (_args: string[]): Promise<string> => {
    attempts++;
    return Promise.reject(new Error("network down"));
  };
  const state = await fetchIssueState("o/r", 1, brokenGh, {
    maxAttempts: 3,
    sleepFn: noSleep,
  });
  assertEquals(state, "CLOSED");
  assertEquals(attempts, 3);
});

Deno.test("claim issue - claimIssue surfaces already_assigned reason from pre-claim check", async () => {
  const mockGh = async (args: string[]): Promise<string> => {
    if (args[0] === "issue" && args[1] === "view" && args.includes("--jq")) {
      const jqArg = args[args.indexOf("--jq") + 1] ?? "";
      if (jqArg === ".state") return "OPEN";
      if (jqArg.includes("assignees")) return '["other-worker"]';
    }
    if (args[0] === "api" && String(args[1]).includes("/comments")) return "[]";
    return "";
  };

  const result = await claimIssue({
    repo: "org/repo",
    issueNumber: 42,
    githubUser: "worker-bot",
    workerId: "test-worker",
    sleepFn: noSleep,
    ghCommandFn: mockGh,
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.claimed, false);
    assertEquals(result.value.reason, "already_assigned");
  }
});

Deno.test("claim issue - claimIssue surfaces race_lost reason when another worker wins", async () => {
  const contestedClaims = JSON.stringify([
    {
      id: 1,
      body: "<!-- CLAIM_LOCK:worker-alpha --> Claimed",
      created_at: "2026-03-18T00:00:01Z",
      author: "worker-bot",
    },
    {
      id: 2,
      body: "<!-- CLAIM_LOCK:worker-beta --> Claimed",
      created_at: "2026-03-18T00:00:02Z",
      author: "worker-bot",
    },
  ]);

  let apiCallCount = 0;
  const mockGh = async (args: string[]): Promise<string> => {
    if (args[0] === "issue" && args[1] === "view" && args.includes("--jq")) {
      const jqArg = args[args.indexOf("--jq") + 1] ?? "";
      if (jqArg === ".state") return "OPEN";
      if (jqArg.includes("assignees")) return "[]";
    }
    if (args[0] === "api" && !args.includes("-X")) {
      apiCallCount++;
      if (apiCallCount <= 2) return "[]";
      return contestedClaims;
    }
    return "";
  };

  const result = await claimIssue({
    repo: "org/repo",
    issueNumber: 42,
    githubUser: "worker-bot",
    workerId: "worker-beta",
    sleepFn: noSleep,
    ghCommandFn: mockGh,
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.claimed, false);
    assertEquals(result.value.reason, "race_lost");
    assertEquals(result.value.winnerId, "worker-alpha");
  }
});

Deno.test("claim issue - claimIssue surfaces comment_failed reason when claim comment fails", async () => {
  const mockGh = async (args: string[]): Promise<string> => {
    if (args[0] === "issue" && args[1] === "view" && args.includes("--jq")) {
      const jqArg = args[args.indexOf("--jq") + 1] ?? "";
      if (jqArg === ".state") return "OPEN";
      if (jqArg.includes("assignees")) return "[]";
    }
    if (args[0] === "api" && !args.includes("-X")) return "[]";
    if (args[0] === "issue" && args[1] === "comment") {
      throw new Error("gh command failed (exit 1): could not post comment");
    }
    return "";
  };

  const result = await claimIssue({
    repo: "org/repo",
    issueNumber: 42,
    githubUser: "worker-bot",
    workerId: "test-worker",
    sleepFn: noSleep,
    ghCommandFn: mockGh,
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.claimed, false);
    assertEquals(result.value.reason, "comment_failed");
    assertEquals(typeof result.value.reasonDetail, "string");
  }
});

// ---------------------------------------------------------------------------
// claimIssue — claim comment failure
// ---------------------------------------------------------------------------

Deno.test("claim issue - claimIssue returns false when claim comment fails", async () => {
  const calls: string[][] = [];
  const mockGh = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "view" && args.includes("--jq")) {
      const jqArg = args[args.indexOf("--jq") + 1] ?? "";
      if (jqArg === ".state") return "OPEN";
      if (jqArg.includes("assignees")) return "[]";
    }
    if (args[0] === "api" && !args.includes("-X")) {
      return "[]"; // pre-claim + cleanup
    }
    if (args[0] === "issue" && args[1] === "comment") {
      throw new Error("comment failed");
    }
    return "";
  };

  const result = await claimIssue({
    repo: "org/repo",
    issueNumber: 42,
    githubUser: "worker-bot",
    workerId: "test-host",
    sleepFn: noSleep,
    ghCommandFn: mockGh,
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.claimed, false);
  }
  // Should unassign on failure
  assertEquals(wasCalledWith(calls, "--remove-assignee worker-bot"), true);
});

// ---------------------------------------------------------------------------
// checkClaimChurn — below threshold
// ---------------------------------------------------------------------------

Deno.test("claim issue - checkClaimChurn returns no escalation below threshold", async () => {
  const recentTime1 = new Date(Date.now() - 50 * 60 * 1000).toISOString(); // 50 min ago
  const recentTime2 = new Date(Date.now() - 15 * 60 * 1000).toISOString(); // 15 min ago
  const events = JSON.stringify([
    {
      event: "unassigned",
      assignee: { login: "testuser" },
      created_at: recentTime1,
    },
    {
      event: "unassigned",
      assignee: { login: "testuser" },
      created_at: recentTime2,
    },
  ]);

  const { ghCommandFn } = createMockGh({ "/events": events });

  const result = await checkClaimChurn({
    repo: "org/repo",
    issueNumber: 42,
    githubUser: "testuser",
    threshold: 3,
    ghCommandFn,
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.churnCount, 2);
    assertEquals(result.value.escalated, false);
  }
});

// ---------------------------------------------------------------------------
// checkClaimChurn — at threshold
// ---------------------------------------------------------------------------

Deno.test("claim issue - checkClaimChurn escalates at threshold", async () => {
  const recentTime1 = new Date(Date.now() - 55 * 60 * 1000).toISOString(); // 55 min ago
  const recentTime2 = new Date(Date.now() - 40 * 60 * 1000).toISOString(); // 40 min ago
  const recentTime3 = new Date(Date.now() - 25 * 60 * 1000).toISOString(); // 25 min ago
  const events = JSON.stringify([
    {
      event: "unassigned",
      assignee: { login: "testuser" },
      created_at: recentTime1,
    },
    {
      event: "unassigned",
      assignee: { login: "testuser" },
      created_at: recentTime2,
    },
    {
      event: "unassigned",
      assignee: { login: "testuser" },
      created_at: recentTime3,
    },
  ]);

  const calls: string[][] = [];
  const mockGh = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args.join(" ").includes("/events")) return events;
    return "";
  };

  const result = await checkClaimChurn({
    repo: "org/repo",
    issueNumber: 42,
    githubUser: "testuser",
    threshold: 3,
    ghCommandFn: mockGh,
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.churnCount, 3);
    assertEquals(result.value.escalated, true);
  }

  // Should post comment, add failed label (via REST API - Issue #976), and unassign
  assertEquals(wasCalledWith(calls, "issue comment"), true);
  assertEquals(
    wasCalledWith(calls, "api -X POST repos/org/repo/issues/42/labels"),
    true,
  );
  assertEquals(wasCalledWith(calls, "--remove-assignee testuser"), true);
});

// ---------------------------------------------------------------------------
// checkClaimChurn — filters by worker user (Issue #869)
// ---------------------------------------------------------------------------

Deno.test("claim issue - checkClaimChurn only counts events for specified user", async () => {
  const recentTime1 = new Date(Date.now() - 55 * 60 * 1000).toISOString();
  const recentTime2 = new Date(Date.now() - 40 * 60 * 1000).toISOString();
  const recentTime3 = new Date(Date.now() - 25 * 60 * 1000).toISOString();
  const events = JSON.stringify([
    {
      event: "unassigned",
      assignee: { login: "testuser" },
      created_at: recentTime1,
    },
    {
      event: "unassigned",
      assignee: { login: "otheruser" },
      created_at: recentTime2,
    },
    {
      event: "unassigned",
      assignee: { login: "testuser" },
      created_at: recentTime3,
    },
  ]);

  const mockGh = async (args: string[]): Promise<string> => {
    if (args.join(" ").includes("/events")) return events;
    return "";
  };

  const result = await checkClaimChurn({
    repo: "org/repo",
    issueNumber: 42,
    githubUser: "testuser",
    threshold: 3,
    ghCommandFn: mockGh,
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    // Only 2 for testuser, not 3
    assertEquals(result.value.churnCount, 2);
    assertEquals(result.value.escalated, false);
  }
});

// ---------------------------------------------------------------------------
// checkClaimChurn — API failure
// ---------------------------------------------------------------------------

Deno.test("claim issue - checkClaimChurn handles API failure gracefully", async () => {
  const mockGh = async (_args: string[]): Promise<string> => {
    throw new Error("API failure");
  };

  const result = await checkClaimChurn({
    repo: "org/repo",
    issueNumber: 42,
    githubUser: "testuser",
    threshold: 3,
    ghCommandFn: mockGh,
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.churnCount, 0);
    assertEquals(result.value.escalated, false);
  }
});

// ---------------------------------------------------------------------------
// checkClaimChurn — zero events
// ---------------------------------------------------------------------------

Deno.test("claim issue - checkClaimChurn returns zero for no events", async () => {
  const mockGh = async (args: string[]): Promise<string> => {
    if (args.join(" ").includes("/events")) return "[]";
    return "";
  };

  const result = await checkClaimChurn({
    repo: "org/repo",
    issueNumber: 42,
    githubUser: "testuser",
    threshold: 3,
    ghCommandFn: mockGh,
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.churnCount, 0);
    assertEquals(result.value.escalated, false);
  }
});

// ---------------------------------------------------------------------------
// checkClaimChurn — default threshold
// ---------------------------------------------------------------------------

Deno.test("claim issue - checkClaimChurn uses default threshold of 3", async () => {
  const recentTime1 = new Date(Date.now() - 55 * 60 * 1000).toISOString(); // 3h ago
  const recentTime2 = new Date(Date.now() - 40 * 60 * 1000).toISOString(); // 2h ago
  const recentTime3 = new Date(Date.now() - 25 * 60 * 1000).toISOString(); // 1h ago
  const events = JSON.stringify([
    {
      event: "unassigned",
      assignee: { login: "testuser" },
      created_at: recentTime1,
    },
    {
      event: "unassigned",
      assignee: { login: "testuser" },
      created_at: recentTime2,
    },
    {
      event: "unassigned",
      assignee: { login: "testuser" },
      created_at: recentTime3,
    },
  ]);

  const calls: string[][] = [];
  const mockGh = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args.join(" ").includes("/events")) return events;
    return "";
  };

  const result = await checkClaimChurn({
    repo: "org/repo",
    issueNumber: 42,
    githubUser: "testuser",
    // No threshold specified — default is 3
    ghCommandFn: mockGh,
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.escalated, true);
  }
});

// ---------------------------------------------------------------------------
// checkClaimChurn — @mentions allowed authors in escalation comment (Issue #999)
// ---------------------------------------------------------------------------

Deno.test("claim issue - checkClaimChurn mentions allowed authors in escalation comment", async () => {
  const recentTime1 = new Date(Date.now() - 55 * 60 * 1000).toISOString();
  const recentTime2 = new Date(Date.now() - 40 * 60 * 1000).toISOString();
  const recentTime3 = new Date(Date.now() - 25 * 60 * 1000).toISOString();
  const events = JSON.stringify([
    {
      event: "unassigned",
      assignee: { login: "testuser" },
      created_at: recentTime1,
    },
    {
      event: "unassigned",
      assignee: { login: "testuser" },
      created_at: recentTime2,
    },
    {
      event: "unassigned",
      assignee: { login: "testuser" },
      created_at: recentTime3,
    },
  ]);

  const calls: string[][] = [];
  const mockGh = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args.join(" ").includes("/events")) return events;
    return "";
  };

  await checkClaimChurn({
    repo: "org/repo",
    issueNumber: 42,
    githubUser: "testuser",
    threshold: 3,
    allowedAuthors: ["alice", "bob"],
    ghCommandFn: mockGh,
  });

  // Find the comment call and check for @mentions
  const commentCall = calls.find((c) => c.join(" ").includes("issue comment"));
  const commentBody = commentCall?.find((arg) =>
    arg.includes("Claim Churn Detected")
  );
  assertEquals(
    commentBody !== undefined,
    true,
    "Should post escalation comment",
  );
  assertEquals(commentBody!.includes("@alice"), true, "Should mention alice");
  assertEquals(commentBody!.includes("@bob"), true, "Should mention bob");
  assertEquals(
    commentBody!.includes("planning"),
    true,
    "Should ask for planning label",
  );
});

Deno.test("claim issue - checkClaimChurn works without allowedAuthors (backward compatible)", async () => {
  const recentTime1 = new Date(Date.now() - 55 * 60 * 1000).toISOString();
  const recentTime2 = new Date(Date.now() - 40 * 60 * 1000).toISOString();
  const recentTime3 = new Date(Date.now() - 25 * 60 * 1000).toISOString();
  const events = JSON.stringify([
    {
      event: "unassigned",
      assignee: { login: "testuser" },
      created_at: recentTime1,
    },
    {
      event: "unassigned",
      assignee: { login: "testuser" },
      created_at: recentTime2,
    },
    {
      event: "unassigned",
      assignee: { login: "testuser" },
      created_at: recentTime3,
    },
  ]);

  const calls: string[][] = [];
  const mockGh = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args.join(" ").includes("/events")) return events;
    return "";
  };

  const result = await checkClaimChurn({
    repo: "org/repo",
    issueNumber: 42,
    githubUser: "testuser",
    threshold: 3,
    // No allowedAuthors — backward compatibility
    ghCommandFn: mockGh,
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.escalated, true);
  }

  // Should still post a comment even without mentions
  assertEquals(wasCalledWith(calls, "issue comment"), true);
});

// ---------------------------------------------------------------------------
// Issue #978 — Label-add failure resilience
// ---------------------------------------------------------------------------

Deno.test("claim issue - checkClaimChurn succeeds even when label-add fails", async () => {
  const recentTime1 = new Date(Date.now() - 55 * 60 * 1000).toISOString();
  const recentTime2 = new Date(Date.now() - 40 * 60 * 1000).toISOString();
  const recentTime3 = new Date(Date.now() - 25 * 60 * 1000).toISOString();
  const events = JSON.stringify([
    {
      event: "unassigned",
      assignee: { login: "testuser" },
      created_at: recentTime1,
    },
    {
      event: "unassigned",
      assignee: { login: "testuser" },
      created_at: recentTime2,
    },
    {
      event: "unassigned",
      assignee: { login: "testuser" },
      created_at: recentTime3,
    },
  ]);

  const calls: string[][] = [];
  const mockGh = async (args: string[]): Promise<string> => {
    calls.push(args);
    const joined = args.join(" ");
    if (joined.includes("/events")) return events;
    // Both REST API and CLI label-add fail
    if (joined.includes("api -X POST") && joined.includes("labels")) {
      throw new Error("REST API 403");
    }
    if (joined.includes("--add-label")) {
      throw new Error("CLI permission denied");
    }
    return "";
  };

  const result = await checkClaimChurn({
    repo: "org/repo",
    issueNumber: 42,
    githubUser: "testuser",
    threshold: 3,
    ghCommandFn: mockGh,
  });

  // Must still succeed — label failure is non-fatal
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.escalated, true);
  }
  // Comment should still have been posted
  assertEquals(wasCalledWith(calls, "issue comment"), true);
});

// ---------------------------------------------------------------------------
// checkClaimChurn — posts cooldown signal on escalation (Issue #1087)
// ---------------------------------------------------------------------------

Deno.test("claim issue - checkClaimChurn posts cooldown signal on escalation", async () => {
  const recentTime1 = new Date(Date.now() - 55 * 60 * 1000).toISOString();
  const recentTime2 = new Date(Date.now() - 40 * 60 * 1000).toISOString();
  const recentTime3 = new Date(Date.now() - 25 * 60 * 1000).toISOString();
  const events = JSON.stringify([
    {
      event: "unassigned",
      assignee: { login: "testuser" },
      created_at: recentTime1,
    },
    {
      event: "unassigned",
      assignee: { login: "testuser" },
      created_at: recentTime2,
    },
    {
      event: "unassigned",
      assignee: { login: "testuser" },
      created_at: recentTime3,
    },
  ]);

  const calls: string[][] = [];
  const mockGh = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args.join(" ").includes("/events")) return events;
    return "";
  };

  await checkClaimChurn({
    repo: "org/repo",
    issueNumber: 42,
    githubUser: "testuser",
    threshold: 3,
    ghCommandFn: mockGh,
  });

  // Should post both the churn comment AND a cooldown signal comment
  const commentCalls = calls.filter((c) =>
    c[0] === "issue" && c[1] === "comment"
  );
  assertEquals(
    commentCalls.length >= 2,
    true,
    "Should post at least 2 comments (churn + cooldown)",
  );

  // Check that one of the comments is a cooldown marker
  const hasCooldownComment = commentCalls.some((c) =>
    c.some((arg) => arg.includes("COOLDOWN:"))
  );
  assertEquals(hasCooldownComment, true, "Should include a COOLDOWN comment");
});

// ---------------------------------------------------------------------------
// releaseClaimWithCooldown (Issue #1087)
// ---------------------------------------------------------------------------

Deno.test("claim issue - releaseClaimWithCooldown unassigns and posts cooldown", async () => {
  const calls: string[][] = [];
  const mockGh = async (args: string[]): Promise<string> => {
    calls.push(args);
    return "";
  };

  const result = await releaseClaimWithCooldown({
    repo: "org/repo",
    issueNumber: 42,
    githubUser: "worker-bot",
    workerId: "worker-mel-01",
    ghCommandFn: mockGh,
  });

  assertEquals(result.ok, true);

  // Should unassign
  assertEquals(wasCalledWith(calls, "--remove-assignee worker-bot"), true);

  // Should post cooldown comment
  const commentCalls = calls.filter((c) =>
    c[0] === "issue" && c[1] === "comment"
  );
  assertEquals(commentCalls.length, 1);

  const bodyArg = commentCalls[0]?.find((a) => a.includes("COOLDOWN:"));
  assertEquals(bodyArg !== undefined, true, "Should post COOLDOWN marker");
  assertEquals(
    bodyArg!.includes("worker-mel-01"),
    true,
    "Should include worker ID",
  );
});

Deno.test("claim issue - releaseClaimWithCooldown succeeds even when unassign fails", async () => {
  const calls: string[][] = [];
  const mockGh = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args.includes("--remove-assignee")) {
      throw new Error("unassign failed");
    }
    return "";
  };

  const result = await releaseClaimWithCooldown({
    repo: "org/repo",
    issueNumber: 42,
    githubUser: "worker-bot",
    workerId: "worker-mel-01",
    ghCommandFn: mockGh,
  });

  assertEquals(result.ok, true);

  // Should still post cooldown comment despite unassign failure
  const commentCalls = calls.filter((c) =>
    c[0] === "issue" && c[1] === "comment"
  );
  assertEquals(commentCalls.length, 1);
});

// ---------------------------------------------------------------------------
// claimIssue — claim race metrics (Issue #1090)
// ---------------------------------------------------------------------------

Deno.test("claim issue - claimIssue reports competingWorkerCount=0 when sole claimant", async () => {
  const singleClaim = JSON.stringify([
    {
      id: 1,
      body: "<!-- CLAIM_LOCK:my-worker --> Claimed",
      created_at: "2026-03-18T00:00:00Z",
      author: "worker-bot",
    },
  ]);

  let apiCallCount = 0;
  const mockGh = async (args: string[]): Promise<string> => {
    if (args[0] === "issue" && args[1] === "view" && args.includes("--jq")) {
      const jqArg = args[args.indexOf("--jq") + 1] ?? "";
      if (jqArg === ".state") return "OPEN";
      if (jqArg.includes("assignees")) return "[]";
    }
    if (args[0] === "api" && !args.includes("-X")) {
      apiCallCount++;
      if (apiCallCount <= 2) return "[]"; // pre-claim + cleanup
      return singleClaim;
    }
    return "";
  };

  const result = await claimIssue({
    repo: "org/repo",
    issueNumber: 42,
    githubUser: "worker-bot",
    workerId: "my-worker",
    sleepFn: noSleep,
    ghCommandFn: mockGh,
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.claimed, true);
    assertEquals(result.value.competingWorkerCount, 0);
  }
});

Deno.test("claim issue - claimIssue reports competingWorkerCount when losing race", async () => {
  const contestedClaims = JSON.stringify([
    {
      id: 1,
      body: "<!-- CLAIM_LOCK:worker-alpha --> Claimed",
      created_at: "2026-03-18T00:00:01Z",
      author: "worker-bot",
    },
    {
      id: 2,
      body: "<!-- CLAIM_LOCK:worker-beta --> Claimed",
      created_at: "2026-03-18T00:00:02Z",
      author: "worker-bot",
    },
    {
      id: 3,
      body: "<!-- CLAIM_LOCK:worker-gamma --> Claimed",
      created_at: "2026-03-18T00:00:03Z",
      author: "worker-bot",
    },
  ]);

  let apiCallCount = 0;
  const mockGh = async (args: string[]): Promise<string> => {
    if (args[0] === "issue" && args[1] === "view" && args.includes("--jq")) {
      const jqArg = args[args.indexOf("--jq") + 1] ?? "";
      if (jqArg === ".state") return "OPEN";
      if (jqArg.includes("assignees")) return "[]";
    }
    if (args[0] === "api" && !args.includes("-X")) {
      apiCallCount++;
      if (apiCallCount <= 2) return "[]";
      return contestedClaims;
    }
    return "";
  };

  const result = await claimIssue({
    repo: "org/repo",
    issueNumber: 42,
    githubUser: "worker-bot",
    workerId: "worker-gamma",
    sleepFn: noSleep,
    ghCommandFn: mockGh,
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.claimed, false);
    assertEquals(result.value.competingWorkerCount, 2); // 3 total - 1 (self) = 2 competitors
    assertEquals(result.value.winnerId, "worker-alpha");
  }
});

Deno.test("claim issue - claimIssue reports competingWorkerCount when winning race", async () => {
  const contestedClaims = JSON.stringify([
    {
      id: 1,
      body: "<!-- CLAIM_LOCK:worker-alpha --> Claimed",
      created_at: "2026-03-18T00:00:01Z",
      author: "worker-bot",
    },
    {
      id: 2,
      body: "<!-- CLAIM_LOCK:worker-beta --> Claimed",
      created_at: "2026-03-18T00:00:02Z",
      author: "worker-bot",
    },
  ]);

  let apiCallCount = 0;
  const mockGh = async (args: string[]): Promise<string> => {
    if (args[0] === "issue" && args[1] === "view" && args.includes("--jq")) {
      const jqArg = args[args.indexOf("--jq") + 1] ?? "";
      if (jqArg === ".state") return "OPEN";
      if (jqArg.includes("assignees")) return "[]";
    }
    if (args[0] === "api" && !args.includes("-X")) {
      apiCallCount++;
      if (apiCallCount <= 2) return "[]";
      return contestedClaims;
    }
    return "";
  };

  const result = await claimIssue({
    repo: "org/repo",
    issueNumber: 42,
    githubUser: "worker-bot",
    workerId: "worker-alpha",
    sleepFn: noSleep,
    ghCommandFn: mockGh,
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.claimed, true);
    assertEquals(result.value.competingWorkerCount, 1); // 2 total - 1 (self) = 1 competitor
  }
});

Deno.test("claim issue - releaseClaimWithCooldown succeeds even when cooldown post fails", async () => {
  const calls: string[][] = [];
  const mockGh = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "comment") {
      throw new Error("comment failed");
    }
    return "";
  };

  const result = await releaseClaimWithCooldown({
    repo: "org/repo",
    issueNumber: 42,
    githubUser: "worker-bot",
    workerId: "worker-mel-01",
    ghCommandFn: mockGh,
  });

  // Should still succeed — cooldown failure is non-fatal
  assertEquals(result.ok, true);
});

// ---------------------------------------------------------------------------
// checkClaimChurn — escalation applies the churn label to the issue (Issue #1215)
// ---------------------------------------------------------------------------

Deno.test("claim issue - checkClaimChurn escalation applies the churn label to the issue (Issue #1215)", async () => {
  const recentTime1 = new Date(Date.now() - 55 * 60 * 1000).toISOString();
  const recentTime2 = new Date(Date.now() - 40 * 60 * 1000).toISOString();
  const recentTime3 = new Date(Date.now() - 25 * 60 * 1000).toISOString();
  const events = JSON.stringify([
    {
      event: "unassigned",
      assignee: { login: "testuser" },
      created_at: recentTime1,
    },
    {
      event: "unassigned",
      assignee: { login: "testuser" },
      created_at: recentTime2,
    },
    {
      event: "unassigned",
      assignee: { login: "testuser" },
      created_at: recentTime3,
    },
  ]);

  const callOrder: string[] = [];
  const mockGh = async (args: string[]): Promise<string> => {
    const joined = args.join(" ");
    if (joined.includes("/events")) return events;
    // Label creation (ensureLabelExists) — POST repos/{owner}/{repo}/labels
    if (
      joined.includes("api") && joined.includes("-X") &&
      joined.includes("POST") && joined.includes("repos/org/repo/labels")
    ) {
      callOrder.push("ensureLabelExists");
      return "";
    }
    // Label add to issue (addLabelToIssue) — POST repos/{owner}/{repo}/issues/42/labels
    if (
      joined.includes("api") && joined.includes("-X") &&
      joined.includes("POST") && joined.includes("issues/42/labels")
    ) {
      callOrder.push("addLabelToIssue");
      return "";
    }
    return "";
  };

  const result = await checkClaimChurn({
    repo: "org/repo",
    issueNumber: 42,
    githubUser: "testuser",
    threshold: 3,
    ghCommandFn: mockGh,
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.escalated, true);
  }

  // Assert the observable outcome: escalation applied the churn label to the
  // issue. We check that the label-application call against issues/42/labels
  // happened, but deliberately do not constrain the order or number of
  // underlying gh calls (e.g. whether the label is pre-created, auto-created,
  // or applied via a single GraphQL mutation) — that is an implementation
  // detail, not behaviour.
  assertEquals(
    callOrder.includes("addLabelToIssue"),
    true,
    "escalation must apply the churn label to the issue",
  );
});

// ---------------------------------------------------------------------------
// claimIssue — combined claim + heartbeat comment (Issue #1628)
// ---------------------------------------------------------------------------

Deno.test("claim issue - claimIssue with markerOptions posts a single combined comment", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "vibe-claim-test-" });
  try {
    const myCommentBody =
      "<!-- CLAIM_LOCK:my-worker -->\nClaimed by `my-worker`\n" +
      "<!-- VIBE_CODER_HEARTBEAT:host-A-uuid:1700000000 -->";
    const verificationResponse = JSON.stringify([
      {
        id: 4242,
        body: myCommentBody,
        created_at: "2026-03-18T00:00:00Z",
        author: "worker-bot",
      },
    ]);

    let apiCallCount = 0;
    const calls: string[][] = [];
    const mockGh = async (args: string[]): Promise<string> => {
      calls.push(args);
      if (args[0] === "issue" && args[1] === "view" && args.includes("--jq")) {
        const jqArg = args[args.indexOf("--jq") + 1] ?? "";
        if (jqArg === ".state") return "OPEN";
        if (jqArg.includes("assignees")) return "[]";
      }
      if (args[0] === "api" && !args.includes("-X")) {
        apiCallCount++;
        if (apiCallCount <= 2) return "[]";
        return verificationResponse;
      }
      return "";
    };

    const result = await claimIssue({
      repo: "org/repo",
      issueNumber: 42,
      githubUser: "worker-bot",
      workerId: "my-worker",
      sleepFn: noSleep,
      ghCommandFn: mockGh,
      markerOptions: {
        machineId: "host-A-uuid",
        workDir: tempDir,
        nowFn: () => 1700000000,
      },
    });

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.claimed, true);
    }

    // Exactly one `gh issue comment` call should be made — combined body.
    const commentCalls = calls.filter((c) =>
      c[0] === "issue" && c[1] === "comment"
    );
    assertEquals(
      commentCalls.length,
      1,
      "should post exactly one comment when claiming",
    );

    // The body must contain BOTH the CLAIM_LOCK marker and the heartbeat marker.
    const bodyIdx = commentCalls[0]!.indexOf("--body");
    const body = commentCalls[0]![bodyIdx + 1] ?? "";
    assertEquals(
      body.includes("<!-- CLAIM_LOCK:my-worker -->"),
      true,
      "body must include CLAIM_LOCK marker",
    );
    assertEquals(
      body.includes("<!-- VIBE_CODER_HEARTBEAT:host-A-uuid:1700000000 -->"),
      true,
      "body must include initial heartbeat marker",
    );

    // Marker state file must be written so the heartbeat updater PATCHes
    // this same comment instead of posting another one.
    const safeRepo = "org_repo";
    const stateFile = `${tempDir}/.heartbeat-marker_${safeRepo}_42`;
    const raw = await Deno.readTextFile(stateFile);
    const state = JSON.parse(raw);
    assertEquals(state.commentId, 4242);
    assertEquals(typeof state.claimPrefix, "string");
    assertEquals(
      String(state.claimPrefix).includes("<!-- CLAIM_LOCK:my-worker -->"),
      true,
      "claimPrefix must preserve the CLAIM_LOCK marker for refreshes",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("claim issue - claimIssue without markerOptions keeps legacy single-marker body", async () => {
  const verificationResponse = JSON.stringify([
    {
      id: 9,
      body: "<!-- CLAIM_LOCK:my-worker --> Claimed",
      created_at: "2026-03-18T00:00:00Z",
      author: "worker-bot",
    },
  ]);
  let apiCallCount = 0;
  const calls: string[][] = [];
  const mockGh = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "view" && args.includes("--jq")) {
      const jqArg = args[args.indexOf("--jq") + 1] ?? "";
      if (jqArg === ".state") return "OPEN";
      if (jqArg.includes("assignees")) return "[]";
    }
    if (args[0] === "api" && !args.includes("-X")) {
      apiCallCount++;
      if (apiCallCount <= 2) return "[]";
      return verificationResponse;
    }
    return "";
  };

  const result = await claimIssue({
    repo: "org/repo",
    issueNumber: 42,
    githubUser: "worker-bot",
    workerId: "my-worker",
    sleepFn: noSleep,
    ghCommandFn: mockGh,
  });

  assertEquals(result.ok, true);
  const commentCalls = calls.filter((c) =>
    c[0] === "issue" && c[1] === "comment"
  );
  assertEquals(commentCalls.length, 1);
  const bodyIdx = commentCalls[0]!.indexOf("--body");
  const body = commentCalls[0]![bodyIdx + 1] ?? "";
  assertEquals(
    body.includes("<!-- VIBE_CODER_HEARTBEAT:"),
    false,
    "legacy callers (no markerOptions) must not embed a heartbeat marker",
  );
});

Deno.test("claim issue - claimIssue does not seed marker state when losing race", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "vibe-claim-test-" });
  try {
    const myCommentBody = "<!-- CLAIM_LOCK:loser -->\nClaimed by `loser`\n" +
      "<!-- VIBE_CODER_HEARTBEAT:host-A-uuid:1700000000 -->";
    const winnerCommentBody =
      "<!-- CLAIM_LOCK:winner -->\nClaimed by `winner`\n" +
      "<!-- VIBE_CODER_HEARTBEAT:host-B-uuid:1700000000 -->";
    const contested = JSON.stringify([
      {
        id: 1,
        body: winnerCommentBody,
        created_at: "2026-03-18T00:00:01Z",
        author: "worker-bot",
      },
      {
        id: 2,
        body: myCommentBody,
        created_at: "2026-03-18T00:00:02Z",
        author: "worker-bot",
      },
    ]);

    let apiCallCount = 0;
    const mockGh = async (args: string[]): Promise<string> => {
      if (args[0] === "issue" && args[1] === "view" && args.includes("--jq")) {
        const jqArg = args[args.indexOf("--jq") + 1] ?? "";
        if (jqArg === ".state") return "OPEN";
        if (jqArg.includes("assignees")) return "[]";
      }
      if (args[0] === "api" && !args.includes("-X")) {
        apiCallCount++;
        if (apiCallCount <= 2) return "[]";
        return contested;
      }
      return "";
    };

    const result = await claimIssue({
      repo: "org/repo",
      issueNumber: 42,
      githubUser: "worker-bot",
      workerId: "loser",
      sleepFn: noSleep,
      ghCommandFn: mockGh,
      markerOptions: {
        machineId: "host-A-uuid",
        workDir: tempDir,
        nowFn: () => 1700000000,
      },
    });

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.claimed, false);
      assertEquals(result.value.winnerId, "winner");
    }

    // Loser must NOT seed marker state — it would point at a comment about
    // to be deleted by removeOwnClaimComment.
    const safeRepo = "org_repo";
    const stateFile = `${tempDir}/.heartbeat-marker_${safeRepo}_42`;
    let exists = true;
    try {
      await Deno.stat(stateFile);
    } catch {
      exists = false;
    }
    assertEquals(
      exists,
      false,
      "marker state must not be seeded when losing the race",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// claimIssue — hostname in claim comment (Issue #2034)
// ---------------------------------------------------------------------------

Deno.test("claim issue - claimIssue includes hostname in claim comment body", async () => {
  const singleClaim = JSON.stringify([
    {
      id: 1,
      body: "<!-- CLAIM_LOCK:my-worker --> Claimed",
      created_at: "2026-03-18T00:00:00Z",
      author: "worker-bot",
    },
  ]);

  let apiCallCount = 0;
  const calls: string[][] = [];
  const mockGh = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "view" && args.includes("--jq")) {
      const jqArg = args[args.indexOf("--jq") + 1] ?? "";
      if (jqArg === ".state") return "OPEN";
      if (jqArg.includes("assignees")) return "[]";
    }
    if (args[0] === "api" && !args.includes("-X")) {
      apiCallCount++;
      if (apiCallCount <= 2) return "[]";
      return singleClaim;
    }
    return "";
  };

  const result = await claimIssue({
    repo: "org/repo",
    issueNumber: 42,
    githubUser: "worker-bot",
    workerId: "my-worker",
    hostname: "test-host-mel-01",
    sleepFn: noSleep,
    ghCommandFn: mockGh,
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.claimed, true);
  }

  // Find the claim comment body and confirm the hostname is referenced.
  const commentCalls = calls.filter((c) =>
    c[0] === "issue" && c[1] === "comment"
  );
  assertEquals(commentCalls.length, 1, "should post exactly one claim comment");
  const bodyIdx = commentCalls[0]!.indexOf("--body");
  const body = commentCalls[0]![bodyIdx + 1] ?? "";
  assertEquals(
    body.includes("test-host-mel-01"),
    true,
    `claim comment body must reference the hostname so operators can find the logs; got: ${body}`,
  );
  // The CLAIM_LOCK marker must still be parseable (existing behaviour).
  assertEquals(body.includes("<!-- CLAIM_LOCK:my-worker -->"), true);
});

Deno.test("claim issue - claimIssue defaults to current machine hostname when none provided", async () => {
  const singleClaim = JSON.stringify([
    {
      id: 1,
      body: "<!-- CLAIM_LOCK:my-worker --> Claimed",
      created_at: "2026-03-18T00:00:00Z",
      author: "worker-bot",
    },
  ]);

  let apiCallCount = 0;
  const calls: string[][] = [];
  const mockGh = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "view" && args.includes("--jq")) {
      const jqArg = args[args.indexOf("--jq") + 1] ?? "";
      if (jqArg === ".state") return "OPEN";
      if (jqArg.includes("assignees")) return "[]";
    }
    if (args[0] === "api" && !args.includes("-X")) {
      apiCallCount++;
      if (apiCallCount <= 2) return "[]";
      return singleClaim;
    }
    return "";
  };

  const result = await claimIssue({
    repo: "org/repo",
    issueNumber: 42,
    githubUser: "worker-bot",
    workerId: "my-worker",
    sleepFn: noSleep,
    ghCommandFn: mockGh,
  });

  assertEquals(result.ok, true);
  const commentCalls = calls.filter((c) =>
    c[0] === "issue" && c[1] === "comment"
  );
  const bodyIdx = commentCalls[0]!.indexOf("--body");
  const body = commentCalls[0]![bodyIdx + 1] ?? "";
  // The body should mention "host" so operators know where the logs live,
  // even when no explicit hostname is injected.
  assertEquals(
    /on host\s+`[^`]+`/.test(body),
    true,
    `claim comment body must contain an "on host \`<hostname>\`" line; got: ${body}`,
  );
});

// ---------------------------------------------------------------------------
// claimIssue — live fleet-PR re-check at claim time (Issue #3150)
//
// After winning the earliest-comment claim race and before any token work,
// claimIssue performs a live, cache-bypassing fleet open-PR re-check. A
// sibling PR opened in the discovery→claim window must abort the claim and
// clean up; the single-host no-conflict path must still succeed.
// ---------------------------------------------------------------------------

/**
 * Build a mockGh for the fleet re-check tests. `prsByAuthor` maps a fleet
 * author login to the PR list its `pr list --author <login>` returns. The
 * verification re-read reports this host as the sole claimant.
 */
function makeFleetRecheckMockGh(
  workerId: string,
  prsByAuthor: Record<string, unknown[]>,
  prListThrows = false,
): { ghCommandFn: (args: string[]) => Promise<string>; calls: string[][] } {
  const ownClaim = JSON.stringify([
    {
      id: 11,
      body: `<!-- CLAIM_LOCK:${workerId} --> Claimed`,
      created_at: "2026-07-02T00:00:01Z",
      author: "worker-bot",
    },
  ]);
  let apiCallCount = 0;
  const calls: string[][] = [];
  const ghCommandFn = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "view" && args.includes("--jq")) {
      const jqArg = args[args.indexOf("--jq") + 1] ?? "";
      if (jqArg === ".state") return "OPEN";
      if (jqArg.includes("assignees")) return "[]";
    }
    if (args[0] === "pr" && args[1] === "list") {
      if (prListThrows) throw new Error("simulated gh pr list failure");
      const author = args[args.indexOf("--author") + 1] ?? "";
      return JSON.stringify(prsByAuthor[author] ?? []);
    }
    if (args[0] === "api" && !args.includes("-X")) {
      apiCallCount++;
      if (apiCallCount <= 2) return "[]"; // pre-claim + stale cleanup
      if (apiCallCount === 3) return ownClaim; // verification: sole claimant
      return "11"; // removeOwnClaimComment lookup → comment id
    }
    return "";
  };
  return { ghCommandFn, calls };
}

Deno.test("claim issue - aborts when a sibling fleet PR appears in the discovery→claim window (Issue #3150)", async () => {
  const { ghCommandFn, calls } = makeFleetRecheckMockGh("worker-bot-123", {
    // This host has no open PR; the sibling opened one for the same work
    // stream between this host's discovery and its claim.
    "worker-bot": [],
    "sibling-bot": [
      {
        number: 648,
        title: "Fix bug (#647)",
        baseRefName: "main",
        headRefName: "issue-647-fix-bug",
      },
    ],
  });

  const result = await claimIssue({
    repo: "org/repo",
    issueNumber: 647,
    githubUser: "worker-bot",
    workerId: "worker-bot-123",
    fleetAuthors: ["worker-bot", "sibling-bot"],
    sleepFn: noSleep,
    ghCommandFn,
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.claimed, false);
    assertEquals(result.value.reason, "fleet_pr_exists");
  }
  // Aborting must mirror the claim_race=lost cleanup: release the
  // assignment and delete this worker's claim comment.
  assertEquals(wasCalledWith(calls, "--remove-assignee worker-bot"), true);
  assertEquals(wasCalledWith(calls, "-X DELETE"), true);
});

Deno.test("claim issue - succeeds when the live fleet re-check finds no conflicting PR (Issue #3150)", async () => {
  const { ghCommandFn, calls } = makeFleetRecheckMockGh("worker-bot-123", {
    "worker-bot": [],
    "sibling-bot": [],
  });

  const result = await claimIssue({
    repo: "org/repo",
    issueNumber: 647,
    githubUser: "worker-bot",
    workerId: "worker-bot-123",
    fleetAuthors: ["worker-bot", "sibling-bot"],
    sleepFn: noSleep,
    ghCommandFn,
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.claimed, true);
    assertEquals(result.value.winnerId, "worker-bot-123");
  }
  // A successful claim must NOT release the assignment.
  assertEquals(wasCalledWith(calls, "--remove-assignee worker-bot"), false);
  // The live re-check must actually query the sibling account.
  assertEquals(wasCalledWith(calls, "pr list --repo org/repo"), true);
});

Deno.test("claim issue - live fleet re-check fails open on gh error (Issue #3150)", async () => {
  const { ghCommandFn } = makeFleetRecheckMockGh(
    "worker-bot-123",
    { "worker-bot": [], "sibling-bot": [] },
    true, // pr list throws
  );

  const result = await claimIssue({
    repo: "org/repo",
    issueNumber: 647,
    githubUser: "worker-bot",
    workerId: "worker-bot-123",
    fleetAuthors: ["worker-bot", "sibling-bot"],
    sleepFn: noSleep,
    ghCommandFn,
  });

  // Fail open: a transient re-check failure must not block a legitimate claim.
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value.claimed, true);
});

Deno.test("claim issue - no fleet authors skips the live re-check (Issue #3150)", async () => {
  const { ghCommandFn, calls } = makeFleetRecheckMockGh("worker-bot-123", {
    // A PR exists, but with no fleetAuthors the re-check is skipped so it
    // never runs `pr list` — preserving the prior single-host behaviour.
    "worker-bot": [
      {
        number: 648,
        title: "Fix (#647)",
        baseRefName: "main",
        headRefName: "issue-647",
      },
    ],
  });

  const result = await claimIssue({
    repo: "org/repo",
    issueNumber: 647,
    githubUser: "worker-bot",
    workerId: "worker-bot-123",
    sleepFn: noSleep,
    ghCommandFn,
  });

  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value.claimed, true);
  assertEquals(wasCalledWith(calls, "pr list"), false);
});

Deno.test("claim issue - milestone-aware re-check ignores a PR on a different work stream (Issue #3150)", async () => {
  // Issue is on milestone "My Milestone" (branch milestone/my-milestone).
  // A sibling PR targets the default branch, so it belongs to a different
  // work stream and must NOT abort this claim.
  const { ghCommandFn, calls } = makeFleetRecheckMockGh("worker-bot-123", {
    "worker-bot": [],
    "sibling-bot": [
      {
        number: 700,
        title: "Unrelated non-milestone fix",
        baseRefName: "main",
        headRefName: "issue-999",
      },
    ],
  });

  const result = await claimIssue({
    repo: "org/repo",
    issueNumber: 647,
    githubUser: "worker-bot",
    workerId: "worker-bot-123",
    fleetAuthors: ["worker-bot", "sibling-bot"],
    milestoneTitle: "My Milestone",
    sleepFn: noSleep,
    ghCommandFn,
  });

  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value.claimed, true);
  assertEquals(wasCalledWith(calls, "--remove-assignee worker-bot"), false);
});

Deno.test("claim issue - milestone-aware re-check aborts on a PR targeting the same milestone branch (Issue #3150)", async () => {
  const { ghCommandFn, calls } = makeFleetRecheckMockGh("worker-bot-123", {
    "worker-bot": [],
    "sibling-bot": [
      {
        number: 649,
        title: "Sibling milestone PR",
        baseRefName: "milestone/my-milestone",
        headRefName: "issue-647",
      },
    ],
  });

  const result = await claimIssue({
    repo: "org/repo",
    issueNumber: 647,
    githubUser: "worker-bot",
    workerId: "worker-bot-123",
    fleetAuthors: ["worker-bot", "sibling-bot"],
    milestoneTitle: "My Milestone",
    sleepFn: noSleep,
    ghCommandFn,
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.claimed, false);
    assertEquals(result.value.reason, "fleet_pr_exists");
  }
  assertEquals(wasCalledWith(calls, "--remove-assignee worker-bot"), true);
});

Deno.test(
  "claim issue - live re-check enumerates every fleet account, including a fleet_pr_authors-only sibling (Issue #3150 + #3138)",
  async () => {
    // The claim-time re-check must query the whole fleet union — not just the
    // host and allowed siblings. With three accounts and none holding a PR the
    // claim succeeds, but every account must have been queried so a
    // fleet_pr_authors-only sibling can never be a blind spot.
    const { ghCommandFn, calls } = makeFleetRecheckMockGh("worker-bot-123", {
      "worker-bot": [],
      "sibling-allowed": [],
      "sibling-fleet-only": [],
    });

    const result = await claimIssue({
      repo: "org/repo",
      issueNumber: 647,
      githubUser: "worker-bot",
      workerId: "worker-bot-123",
      fleetAuthors: ["worker-bot", "sibling-allowed", "sibling-fleet-only"],
      sleepFn: noSleep,
      ghCommandFn,
    });

    assertEquals(result.ok, true);
    if (result.ok) assertEquals(result.value.claimed, true);
    // All three fleet accounts must be queried by the live re-check.
    assertEquals(wasCalledWith(calls, "--author worker-bot"), true);
    assertEquals(wasCalledWith(calls, "--author sibling-allowed"), true);
    assertEquals(wasCalledWith(calls, "--author sibling-fleet-only"), true);
  },
);

// ---------------------------------------------------------------------------
// Claim-marker author + staleness filtering (Issue #3664)
//
// A CLAIM_LOCK marker lives in a comment body, which any GitHub user can
// post. The Step-5 race resolution and the stale-claim cleanup must both
// verify the marker's *author* before acting on it, and cleanup must only
// remove genuinely stale markers — never a fleet worker's in-flight claim.
// ---------------------------------------------------------------------------

/** Comment shape returned by the CLAIM_LOCK gh queries. */
interface MockClaimComment {
  id: number;
  body: string;
  created_at: string;
  author: string | null;
}

interface ClaimMockOptions {
  /** Pre-claim freshness re-check response. */
  preFlight?: MockClaimComment[];
  /** Stale-cleanup listing response. */
  cleanup?: MockClaimComment[];
  /** Step-5 verification re-read response. */
  verification?: MockClaimComment[];
  /** Comment id returned by the own-claim lookup when backing off. */
  ownCommentId?: number;
}

/**
 * Mock gh dispatching on the *shape* of each query rather than call order,
 * so the three CLAIM_LOCK reads stay distinguishable as the code evolves.
 */
function makeClaimMockGh(options: ClaimMockOptions = {}) {
  const calls: string[][] = [];
  let claimListReads = 0;

  const ghCommandFn = async (args: string[]): Promise<string> => {
    calls.push(args);
    const jq = args.includes("--jq")
      ? String(args[args.indexOf("--jq") + 1])
      : "";

    if (args[0] === "issue" && args[1] === "view") {
      if (jq === ".state") return "OPEN";
      if (jq.includes("assignees")) return "[]";
      return "";
    }
    if (args[0] === "pr" && args[1] === "list") return "[]";
    if (args.includes("-X")) return ""; // DELETE
    if (args[0] === "api" && String(args[1]).includes("/comments")) {
      if (jq.includes('contains("CLAIM_LOCK:')) {
        return options.ownCommentId ? String(options.ownCommentId) : "";
      }
      if (!jq.includes("body:")) {
        return JSON.stringify(options.cleanup ?? []); // stale cleanup listing
      }
      claimListReads++;
      return claimListReads === 1
        ? JSON.stringify(options.preFlight ?? [])
        : JSON.stringify(options.verification ?? []);
    }
    return "";
  };

  return { ghCommandFn, calls };
}

Deno.test("claim issue - a forged non-fleet CLAIM_LOCK never wins the claim race (Issue #3664)", async () => {
  const { ghCommandFn, calls } = makeClaimMockGh({
    verification: [
      {
        id: 99,
        body: "<!-- CLAIM_LOCK:evil --> Claimed",
        created_at: "2026-07-02T00:00:00Z", // earlier than ours
        author: "attacker",
      },
      {
        id: 11,
        body: "<!-- CLAIM_LOCK:my-worker --> Claimed",
        created_at: "2026-07-02T00:00:01Z",
        author: "worker-bot",
      },
    ],
  });

  const result = await claimIssue({
    repo: "org/repo",
    issueNumber: 42,
    githubUser: "worker-bot",
    workerId: "my-worker",
    fleetAuthors: ["worker-bot", "sibling-bot"],
    sleepFn: noSleep,
    ghCommandFn,
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.claimed, true);
    assertEquals(result.value.winnerId, "my-worker");
  }
  // The worker must not abandon the issue on a forged marker.
  assertEquals(wasCalledWith(calls, "--remove-assignee"), false);
});

Deno.test("claim issue - a forged CLAIM_LOCK never wins when no fleet list is configured (Issue #3664)", async () => {
  const { ghCommandFn, calls } = makeClaimMockGh({
    verification: [
      {
        id: 99,
        body: "<!-- CLAIM_LOCK:evil --> Claimed",
        created_at: "2026-07-02T00:00:00Z",
        author: "attacker",
      },
      {
        id: 11,
        body: "<!-- CLAIM_LOCK:my-worker --> Claimed",
        created_at: "2026-07-02T00:00:01Z",
        author: "worker-bot",
      },
    ],
  });

  // No fleetAuthors — the claiming account itself is the trusted author.
  const result = await claimIssue({
    repo: "org/repo",
    issueNumber: 42,
    githubUser: "worker-bot",
    workerId: "my-worker",
    sleepFn: noSleep,
    ghCommandFn,
  });

  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value.claimed, true);
  assertEquals(wasCalledWith(calls, "--remove-assignee"), false);
});

Deno.test("claim issue - a genuine fleet sibling's earlier CLAIM_LOCK still wins (Issue #3664)", async () => {
  const { ghCommandFn, calls } = makeClaimMockGh({
    ownCommentId: 11,
    verification: [
      {
        id: 7,
        body: "<!-- CLAIM_LOCK:sibling-123 --> Claimed",
        created_at: "2026-07-02T00:00:00Z",
        author: "sibling-bot",
      },
      {
        id: 11,
        body: "<!-- CLAIM_LOCK:my-worker --> Claimed",
        created_at: "2026-07-02T00:00:01Z",
        author: "worker-bot",
      },
    ],
  });

  const result = await claimIssue({
    repo: "org/repo",
    issueNumber: 42,
    githubUser: "worker-bot",
    workerId: "my-worker",
    fleetAuthors: ["worker-bot", "sibling-bot"],
    sleepFn: noSleep,
    ghCommandFn,
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.claimed, false);
    assertEquals(result.value.reason, "race_lost");
    assertEquals(result.value.winnerId, "sibling-123");
  }
  assertEquals(wasCalledWith(calls, "--remove-assignee worker-bot"), true);
});

Deno.test("claim issue - a forged recent CLAIM_LOCK never blocks the pre-claim check without a fleet list (Issue #3664)", async () => {
  const { ghCommandFn, calls } = makeClaimMockGh({
    preFlight: [
      {
        id: 99,
        body: "<!-- CLAIM_LOCK:evil --> Claimed",
        created_at: new Date(Date.now() - 5_000).toISOString(),
        author: "attacker",
      },
    ],
    verification: [
      {
        id: 11,
        body: "<!-- CLAIM_LOCK:my-worker --> Claimed",
        created_at: "2026-07-02T00:00:01Z",
        author: "worker-bot",
      },
    ],
  });

  const result = await claimIssue({
    repo: "org/repo",
    issueNumber: 42,
    githubUser: "worker-bot",
    workerId: "my-worker",
    sleepFn: noSleep,
    ghCommandFn,
  });

  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value.claimed, true);
  assertEquals(wasCalledWith(calls, "--add-assignee worker-bot"), true);
});

Deno.test("claim issue - stale cleanup never deletes a non-fleet CLAIM_LOCK comment (Issue #3664)", async () => {
  const { ghCommandFn, calls } = makeClaimMockGh({
    cleanup: [
      {
        id: 99,
        body: "<!-- CLAIM_LOCK:evil --> Claimed",
        created_at: "2020-01-01T00:00:00Z", // ancient, but not ours
        author: "attacker",
      },
    ],
    verification: [
      {
        id: 11,
        body: "<!-- CLAIM_LOCK:my-worker --> Claimed",
        created_at: "2026-07-02T00:00:01Z",
        author: "worker-bot",
      },
    ],
  });

  const result = await claimIssue({
    repo: "org/repo",
    issueNumber: 42,
    githubUser: "worker-bot",
    workerId: "my-worker",
    fleetAuthors: ["worker-bot", "sibling-bot"],
    sleepFn: noSleep,
    ghCommandFn,
  });

  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value.claimed, true);
  assertEquals(
    wasCalledWith(calls, "DELETE repos/org/repo/issues/comments/99"),
    false,
  );
});

Deno.test("claim issue - stale cleanup deletes a fleet claim comment left by a previous run (Issue #3664)", async () => {
  const { ghCommandFn, calls } = makeClaimMockGh({
    cleanup: [
      {
        id: 55,
        body: "<!-- CLAIM_LOCK:my-worker-old --> Claimed",
        created_at: "2020-01-01T00:00:00Z",
        author: "worker-bot",
      },
    ],
    verification: [
      {
        id: 11,
        body: "<!-- CLAIM_LOCK:my-worker --> Claimed",
        created_at: "2026-07-02T00:00:01Z",
        author: "worker-bot",
      },
    ],
  });

  const result = await claimIssue({
    repo: "org/repo",
    issueNumber: 42,
    githubUser: "worker-bot",
    workerId: "my-worker",
    fleetAuthors: ["worker-bot", "sibling-bot"],
    sleepFn: noSleep,
    ghCommandFn,
  });

  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value.claimed, true);
  assertEquals(
    wasCalledWith(calls, "DELETE repos/org/repo/issues/comments/55"),
    true,
  );
});

Deno.test("claim issue - stale cleanup leaves a fleet sibling's in-flight claim comment alone (Issue #3664)", async () => {
  const { ghCommandFn, calls } = makeClaimMockGh({
    cleanup: [
      {
        id: 77,
        body: "<!-- CLAIM_LOCK:sibling-123 --> Claimed",
        created_at: new Date(Date.now() - 5_000).toISOString(), // in flight
        author: "sibling-bot",
      },
    ],
    verification: [
      {
        id: 11,
        body: "<!-- CLAIM_LOCK:my-worker --> Claimed",
        created_at: "2026-07-02T00:00:01Z",
        author: "worker-bot",
      },
    ],
  });

  const result = await claimIssue({
    repo: "org/repo",
    issueNumber: 42,
    githubUser: "worker-bot",
    workerId: "my-worker",
    fleetAuthors: ["worker-bot", "sibling-bot"],
    sleepFn: noSleep,
    ghCommandFn,
  });

  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value.claimed, true);
  assertEquals(
    wasCalledWith(calls, "DELETE repos/org/repo/issues/comments/77"),
    false,
  );
});

// ---------------------------------------------------------------------------
// resolveTrustedClaimAuthors (Issue #3664)
// ---------------------------------------------------------------------------

Deno.test("claim issue - resolveTrustedClaimAuthors prefers the configured fleet list", () => {
  assertEquals(
    resolveTrustedClaimAuthors("worker-bot", ["worker-bot", "sibling-bot"]),
    ["worker-bot", "sibling-bot"],
  );
});

Deno.test("claim issue - resolveTrustedClaimAuthors falls back to the claiming account", () => {
  assertEquals(resolveTrustedClaimAuthors("worker-bot", []), ["worker-bot"]);
  assertEquals(resolveTrustedClaimAuthors("worker-bot", undefined), [
    "worker-bot",
  ]);
  assertEquals(resolveTrustedClaimAuthors("worker-bot", ["  "]), [
    "worker-bot",
  ]);
});

Deno.test("claim issue - resolveTrustedClaimAuthors disables filtering without any known author", () => {
  assertEquals(resolveTrustedClaimAuthors("", []), []);
  assertEquals(resolveTrustedClaimAuthors("   ", undefined), []);
});
