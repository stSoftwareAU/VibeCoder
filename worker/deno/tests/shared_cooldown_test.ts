/**
 * Tests for shared_cooldown.ts — cross-worker cooldown signals via
 * GitHub issue comments (Issue #1087).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  buildCooldownComment,
  cleanExpiredCooldownComments,
  COOLDOWN_MARKER_PREFIX,
  COOLDOWN_MARKER_SUFFIX,
  hasActiveCooldownSignal,
  parseCooldownComment,
  postCooldownComment,
} from "../lib/shared_cooldown.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check if a specific pattern was called. */
function wasCalledWith(calls: string[][], pattern: string): boolean {
  return calls.some((call) => call.join(" ").includes(pattern));
}

// ---------------------------------------------------------------------------
// COOLDOWN_MARKER_PREFIX
// ---------------------------------------------------------------------------

Deno.test("shared cooldown - COOLDOWN_MARKER_PREFIX has correct value", () => {
  assertEquals(COOLDOWN_MARKER_PREFIX, "<!-- COOLDOWN:");
});

Deno.test("shared cooldown - COOLDOWN_MARKER_SUFFIX has correct value", () => {
  assertEquals(COOLDOWN_MARKER_SUFFIX, " -->");
});

// ---------------------------------------------------------------------------
// buildCooldownComment
// ---------------------------------------------------------------------------

Deno.test("shared cooldown - buildCooldownComment produces correct format", () => {
  const comment = buildCooldownComment("worker-mel-01", 1700000000);
  assertEquals(comment, "<!-- COOLDOWN:worker-mel-01:1700000000 -->");
});

Deno.test("shared cooldown - buildCooldownComment handles hyphenated worker IDs", () => {
  const comment = buildCooldownComment("aws-us-east-1-prod", 1712345678);
  assertEquals(comment, "<!-- COOLDOWN:aws-us-east-1-prod:1712345678 -->");
});

// ---------------------------------------------------------------------------
// parseCooldownComment
// ---------------------------------------------------------------------------

Deno.test("shared cooldown - parseCooldownComment extracts worker ID and timestamp", () => {
  const result = parseCooldownComment(
    "<!-- COOLDOWN:worker-mel-01:1700000000 -->",
  );
  assertEquals(result, { workerId: "worker-mel-01", timestamp: 1700000000 });
});

Deno.test("shared cooldown - parseCooldownComment returns null for non-cooldown comment", () => {
  const result = parseCooldownComment("Just a regular comment");
  assertEquals(result, null);
});

Deno.test("shared cooldown - parseCooldownComment returns null for CLAIM_LOCK comment", () => {
  const result = parseCooldownComment("<!-- CLAIM_LOCK:worker-01 -->");
  assertEquals(result, null);
});

Deno.test("shared cooldown - parseCooldownComment returns null for malformed timestamp", () => {
  const result = parseCooldownComment("<!-- COOLDOWN:worker:abc -->");
  assertEquals(result, null);
});

Deno.test("shared cooldown - parseCooldownComment handles comment with surrounding text", () => {
  const result = parseCooldownComment(
    "Some text <!-- COOLDOWN:w1:1700000000 --> more text",
  );
  assertEquals(result, { workerId: "w1", timestamp: 1700000000 });
});

Deno.test("shared cooldown - parseCooldownComment roundtrips with buildCooldownComment", () => {
  const comment = buildCooldownComment("test-worker", 1700000000);
  const parsed = parseCooldownComment(comment);
  assertEquals(parsed, { workerId: "test-worker", timestamp: 1700000000 });
});

// ---------------------------------------------------------------------------
// postCooldownComment
// ---------------------------------------------------------------------------

Deno.test("shared cooldown - postCooldownComment posts comment via gh", async () => {
  const calls: string[][] = [];
  const mockGh = async (args: string[]): Promise<string> => {
    calls.push(args);
    return "";
  };

  const result = await postCooldownComment(
    "org/repo",
    42,
    "worker-mel-01",
    mockGh,
  );

  assertEquals(result.ok, true);
  assertEquals(wasCalledWith(calls, "issue comment"), true);
  assertEquals(wasCalledWith(calls, "--repo org/repo"), true);
  assertEquals(wasCalledWith(calls, "42"), true);

  // Verify the comment body contains the cooldown marker
  const commentCall = calls.find((c) =>
    c.includes("issue") && c.includes("comment")
  );
  const bodyArg = commentCall?.find((a) => a.includes("COOLDOWN:"));
  assertEquals(
    bodyArg !== undefined,
    true,
    "Should include COOLDOWN marker in body",
  );
  assertEquals(
    bodyArg!.includes("worker-mel-01"),
    true,
    "Should include worker ID",
  );
});

Deno.test("shared cooldown - postCooldownComment returns error on failure", async () => {
  const mockGh = async (_args: string[]): Promise<string> => {
    throw new Error("API failure");
  };

  const result = await postCooldownComment(
    "org/repo",
    42,
    "worker-mel-01",
    mockGh,
  );

  assertEquals(result.ok, false);
});

// ---------------------------------------------------------------------------
// hasActiveCooldownSignal
// ---------------------------------------------------------------------------

Deno.test("shared cooldown - hasActiveCooldownSignal returns true for recent cooldown", async () => {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const recentTimestamp = nowSeconds - 60; // 60 seconds ago
  const commentsJson = JSON.stringify([
    { body: `<!-- COOLDOWN:other-worker:${recentTimestamp} -->` },
  ]);

  const mockGh = async (_args: string[]): Promise<string> => {
    return commentsJson;
  };

  const result = await hasActiveCooldownSignal(
    "org/repo",
    42,
    600,
    mockGh,
  );

  assertEquals(result, true);
});

Deno.test("shared cooldown - hasActiveCooldownSignal returns false for expired cooldown", async () => {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const expiredTimestamp = nowSeconds - 700; // 700 seconds ago (beyond 600s default)
  const commentsJson = JSON.stringify([
    { body: `<!-- COOLDOWN:other-worker:${expiredTimestamp} -->` },
  ]);

  const mockGh = async (_args: string[]): Promise<string> => {
    return commentsJson;
  };

  const result = await hasActiveCooldownSignal(
    "org/repo",
    42,
    600,
    mockGh,
  );

  assertEquals(result, false);
});

Deno.test("shared cooldown - hasActiveCooldownSignal returns false for no cooldown comments", async () => {
  const mockGh = async (_args: string[]): Promise<string> => {
    return "[]";
  };

  const result = await hasActiveCooldownSignal(
    "org/repo",
    42,
    600,
    mockGh,
  );

  assertEquals(result, false);
});

Deno.test("shared cooldown - hasActiveCooldownSignal fails open on API error", async () => {
  const mockGh = async (_args: string[]): Promise<string> => {
    throw new Error("API failure");
  };

  const result = await hasActiveCooldownSignal(
    "org/repo",
    42,
    600,
    mockGh,
  );

  assertEquals(result, false);
});

Deno.test("shared cooldown - hasActiveCooldownSignal fails open on invalid JSON", async () => {
  const mockGh = async (_args: string[]): Promise<string> => {
    return "not json";
  };

  const result = await hasActiveCooldownSignal(
    "org/repo",
    42,
    600,
    mockGh,
  );

  assertEquals(result, false);
});

Deno.test("shared cooldown - hasActiveCooldownSignal detects cooldown from multiple workers", async () => {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const expiredTimestamp = nowSeconds - 700; // expired
  const recentTimestamp = nowSeconds - 30; // active
  const commentsJson = JSON.stringify([
    { body: `<!-- COOLDOWN:worker-a:${expiredTimestamp} -->` },
    { body: `<!-- COOLDOWN:worker-b:${recentTimestamp} -->` },
  ]);

  const mockGh = async (_args: string[]): Promise<string> => {
    return commentsJson;
  };

  const result = await hasActiveCooldownSignal(
    "org/repo",
    42,
    600,
    mockGh,
  );

  assertEquals(result, true);
});

Deno.test("shared cooldown - hasActiveCooldownSignal ignores non-cooldown comments", async () => {
  const commentsJson = JSON.stringify([
    { body: "<!-- CLAIM_LOCK:worker-01 -->" },
    { body: "Regular comment" },
  ]);

  const mockGh = async (_args: string[]): Promise<string> => {
    return commentsJson;
  };

  const result = await hasActiveCooldownSignal(
    "org/repo",
    42,
    600,
    mockGh,
  );

  assertEquals(result, false);
});

Deno.test("shared cooldown - hasActiveCooldownSignal uses default cooldown period", async () => {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const recentTimestamp = nowSeconds - 300; // 5 minutes ago (within 600s default)
  const commentsJson = JSON.stringify([
    { body: `<!-- COOLDOWN:worker-a:${recentTimestamp} -->` },
  ]);

  const mockGh = async (_args: string[]): Promise<string> => {
    return commentsJson;
  };

  // Use default cooldown period (600s)
  const result = await hasActiveCooldownSignal(
    "org/repo",
    42,
    undefined as unknown as number,
    mockGh,
  );

  // Even without explicit period, should use COOLDOWN_DEFAULTS.issueRetryCooldown (600)
  assertEquals(result, true);
});

Deno.test("shared cooldown - hasActiveCooldownSignal ignores future timestamps", async () => {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const futureTimestamp = nowSeconds + 1000; // future
  const commentsJson = JSON.stringify([
    { body: `<!-- COOLDOWN:worker-a:${futureTimestamp} -->` },
  ]);

  const mockGh = async (_args: string[]): Promise<string> => {
    return commentsJson;
  };

  const result = await hasActiveCooldownSignal(
    "org/repo",
    42,
    600,
    mockGh,
  );

  // age = nowSeconds - futureTimestamp = negative, so age >= 0 is false
  assertEquals(result, false);
});

// ---------------------------------------------------------------------------
// cleanExpiredCooldownComments
// ---------------------------------------------------------------------------

Deno.test("shared cooldown - cleanExpiredCooldownComments deletes expired comments", async () => {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const expiredTimestamp = nowSeconds - 700;
  const recentTimestamp = nowSeconds - 30;
  const commentsJson = JSON.stringify([
    { id: 101, body: `<!-- COOLDOWN:worker-a:${expiredTimestamp} -->` },
    { id: 102, body: `<!-- COOLDOWN:worker-b:${recentTimestamp} -->` },
  ]);

  const calls: string[][] = [];
  const mockGh = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "api" && !args.includes("-X")) {
      return commentsJson;
    }
    return "";
  };

  await cleanExpiredCooldownComments(
    "org/repo",
    42,
    600,
    mockGh,
  );

  // Should delete expired comment (id 101) but not recent one (id 102)
  assertEquals(wasCalledWith(calls, "DELETE"), true);
  assertEquals(wasCalledWith(calls, "101"), true);
  assertEquals(wasCalledWith(calls, "102"), false);
});

Deno.test("shared cooldown - cleanExpiredCooldownComments handles API failure gracefully", async () => {
  const mockGh = async (_args: string[]): Promise<string> => {
    throw new Error("API failure");
  };

  // Should not throw
  await cleanExpiredCooldownComments(
    "org/repo",
    42,
    600,
    mockGh,
  );
});

Deno.test("shared cooldown - cleanExpiredCooldownComments does nothing when no cooldown comments exist", async () => {
  const calls: string[][] = [];
  const mockGh = async (args: string[]): Promise<string> => {
    calls.push(args);
    return "[]";
  };

  await cleanExpiredCooldownComments(
    "org/repo",
    42,
    600,
    mockGh,
  );

  // Should only have the fetch call, no delete calls
  assertEquals(calls.length, 1);
  assertEquals(wasCalledWith(calls, "DELETE"), false);
});
