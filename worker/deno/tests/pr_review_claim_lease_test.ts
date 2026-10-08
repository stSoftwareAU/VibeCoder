/**
 * Tests for the `pr_review` claim lease (Issue #3383).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  claimLeaseLine,
  createClaimLeaseRenewer,
  isLeaseLive,
  PR_REVIEW_CLAIM_LEASE_MS,
  withRenewedLease,
} from "../lib/pr_review_claim_lease.ts";
import { hasLivePrReviewClaim } from "../lib/claim_pr_comment.ts";

// ---------------------------------------------------------------------------
// withRenewedLease
// ---------------------------------------------------------------------------

Deno.test("withRenewedLease replaces an existing lease line", () => {
  const now = Date.parse("2026-04-01T00:10:00Z");
  const body = "<!-- PR_COMMENT_CLAIM:worker-a:700 -->\n" +
    "Claiming PR feedback comment 700 for worker `worker-a`.\n" +
    "<!-- PR_COMMENT_CLAIM_LEASE:2026-04-01T00:00:00.000Z -->";

  const result = withRenewedLease(body, now);

  assertEquals(result.includes(claimLeaseLine(now)), true);
  assertEquals(result.includes("2026-04-01T00:00:00.000Z"), false);
});

Deno.test("withRenewedLease appends a lease line when absent", () => {
  const now = Date.parse("2026-04-01T00:10:00Z");
  const body = "<!-- PR_COMMENT_CLAIM:worker-a:700 -->\n" +
    "Claiming PR feedback comment 700 for worker `worker-a`.";

  const result = withRenewedLease(body, now);

  assertEquals(result.includes(body), true);
  assertEquals(result.includes(claimLeaseLine(now)), true);
});

Deno.test("withRenewedLease handles hostile input without hanging", () => {
  const now = Date.parse("2026-04-01T00:10:00Z");
  const hostile = "<!-- PR_COMMENT_CLAIM_LEASE:" + "x".repeat(50_000);

  const result = withRenewedLease(hostile, now);

  // No closing `-->`, so the pattern cannot match: appended, not replaced.
  assertEquals(result.includes(claimLeaseLine(now)), true);
  assertEquals(result.startsWith(hostile), true);
});

// ---------------------------------------------------------------------------
// isLeaseLive
// ---------------------------------------------------------------------------

Deno.test("isLeaseLive is true for a freshly updated lease", () => {
  const now = Date.parse("2026-04-01T00:10:00Z");
  const claim = {
    createdAt: "2026-04-01T00:00:00Z",
    updatedAt: "2026-04-01T00:09:00Z",
  };

  assertEquals(isLeaseLive(claim, now), true);
});

Deno.test("isLeaseLive is false once the last beat is outside the lease window", () => {
  const now = Date.parse("2026-04-01T00:10:00Z");
  const claim = {
    createdAt: "2026-03-31T23:00:00Z",
    updatedAt: "2026-03-31T23:00:00Z",
  };

  assertEquals(isLeaseLive(claim, now), false);
});

Deno.test("isLeaseLive uses createdAt alone when updatedAt is absent", () => {
  const now = Date.parse("2026-04-01T00:10:00Z");
  const claim = { createdAt: "2026-04-01T00:09:00Z" };

  assertEquals(isLeaseLive(claim, now), true);
});

Deno.test("isLeaseLive is false when neither timestamp parses", () => {
  const now = Date.parse("2026-04-01T00:10:00Z");
  const claim = { createdAt: "not-a-date", updatedAt: "also-not-a-date" };

  assertEquals(isLeaseLive(claim, now), false);
});

Deno.test("isLeaseLive respects the lease window boundary", () => {
  const now = Date.parse("2026-04-01T00:10:00Z");
  const justInside = {
    createdAt: new Date(now - PR_REVIEW_CLAIM_LEASE_MS + 1000).toISOString(),
  };
  const justOutside = {
    createdAt: new Date(now - PR_REVIEW_CLAIM_LEASE_MS - 1000).toISOString(),
  };

  assertEquals(isLeaseLive(justInside, now), true);
  assertEquals(isLeaseLive(justOutside, now), false);
});

// ---------------------------------------------------------------------------
// createClaimLeaseRenewer
// ---------------------------------------------------------------------------

function createGhStub(reject?: string) {
  const calls: string[][] = [];
  const ghCommandFn = (args: string[]): Promise<string> => {
    calls.push(args);
    return reject ? Promise.reject(new Error(reject)) : Promise.resolve("");
  };
  return { calls, ghCommandFn };
}

Deno.test("createClaimLeaseRenewer does nothing before the renew interval", async () => {
  const claimedAtMs = Date.parse("2026-04-01T00:00:00Z");
  const now = claimedAtMs + 60_000; // 1 minute later — not due yet.
  const stub = createGhStub();

  const renewer = createClaimLeaseRenewer({
    repo: "org/repo",
    claimCommentId: 301,
    body: "<!-- PR_COMMENT_CLAIM:worker-a:700 -->",
    claimedAtMs,
    ghCommandFn: stub.ghCommandFn,
    log: () => {},
    nowMsFn: () => now,
  });

  await renewer.renewIfDue();

  assertEquals(stub.calls.length, 0);
});

Deno.test("createClaimLeaseRenewer PATCHes the claim comment once due", async () => {
  const claimedAtMs = Date.parse("2026-04-01T00:00:00Z");
  const now = claimedAtMs + 6 * 60_000; // 6 minutes later — due.
  const stub = createGhStub();

  const renewer = createClaimLeaseRenewer({
    repo: "org/repo",
    claimCommentId: 301,
    body: "<!-- PR_COMMENT_CLAIM:worker-a:700 -->",
    claimedAtMs,
    ghCommandFn: stub.ghCommandFn,
    log: () => {},
    nowMsFn: () => now,
  });

  await renewer.renewIfDue();

  assertEquals(stub.calls.length, 1);
  const [args] = stub.calls;
  assertEquals(args!.includes("PATCH"), true);
  assertEquals(
    args!.some((a) => a === "repos/org/repo/issues/comments/301"),
    true,
  );
  assertEquals(
    args!.some((a) => a.startsWith("body=") && a.includes(claimLeaseLine(now))),
    true,
  );
});

Deno.test("createClaimLeaseRenewer never throws when gh rejects, and names the claim id", async () => {
  const claimedAtMs = Date.parse("2026-04-01T00:00:00Z");
  const now = claimedAtMs + 6 * 60_000;
  const stub = createGhStub("500 Internal Server Error");
  const logged: string[] = [];

  const renewer = createClaimLeaseRenewer({
    repo: "org/repo",
    claimCommentId: 301,
    body: "<!-- PR_COMMENT_CLAIM:worker-a:700 -->",
    claimedAtMs,
    ghCommandFn: stub.ghCommandFn,
    log: (m) => logged.push(m),
    nowMsFn: () => now,
  });

  await renewer.renewIfDue();

  assertEquals(
    logged.some((m) =>
      m.includes("301") && m.includes("500 Internal Server Error")
    ),
    true,
    `expected the claim id and error in the log, got: ${logged.join(" | ")}`,
  );
});

// ---------------------------------------------------------------------------
// hasLivePrReviewClaim
// ---------------------------------------------------------------------------

const FLEET_AUTHOR = "vibe-coder-bot";
const NOW = Date.parse("2026-04-01T00:10:00Z");
const REVIEW_ID = "700";

function leaseClaimRow(
  id: number,
  workerId: string,
  author: string,
  createdAt: string,
  updatedAt?: string,
) {
  return {
    id,
    body: `<!-- PR_COMMENT_CLAIM:${workerId}:${REVIEW_ID} -->\n` +
      `Claiming PR feedback comment ${REVIEW_ID} for worker \`${workerId}\`.\n` +
      `<!-- PR_COMMENT_CLAIM_LEASE:${createdAt} -->`,
    created_at: createdAt,
    updated_at: updatedAt,
    author,
  };
}

function createReadStub(payload: unknown[], fail?: string) {
  return (args: string[]): Promise<string> => {
    if (fail !== undefined) return Promise.reject(new Error(fail));
    if (args[0] === "api" && /comments/.test(args.join(" "))) {
      return Promise.resolve(JSON.stringify(payload));
    }
    return Promise.resolve("");
  };
}

Deno.test("hasLivePrReviewClaim is true for a live fleet lease", async () => {
  const ghCommandFn = createReadStub([
    leaseClaimRow(
      301,
      "worker-alpha",
      FLEET_AUTHOR,
      "2026-04-01T00:00:00Z",
      "2026-04-01T00:09:00Z",
    ),
  ]);

  const result = await hasLivePrReviewClaim({
    repo: "org/repo",
    prNumber: 42,
    reviewId: REVIEW_ID,
    ghCommandFn,
    trustedAuthors: [FLEET_AUTHOR],
    nowMs: NOW,
    log: () => {},
  });

  assertEquals(result, true);
});

Deno.test("hasLivePrReviewClaim is false for a stranger author", async () => {
  const ghCommandFn = createReadStub([
    leaseClaimRow(
      301,
      "worker-alpha",
      "some-rando",
      "2026-04-01T00:00:00Z",
      "2026-04-01T00:09:00Z",
    ),
  ]);

  const result = await hasLivePrReviewClaim({
    repo: "org/repo",
    prNumber: 42,
    reviewId: REVIEW_ID,
    ghCommandFn,
    trustedAuthors: [FLEET_AUTHOR],
    nowMs: NOW,
    log: () => {},
  });

  assertEquals(result, false);
});

Deno.test("hasLivePrReviewClaim is false for a stale lease", async () => {
  const ghCommandFn = createReadStub([
    leaseClaimRow(
      301,
      "worker-alpha",
      FLEET_AUTHOR,
      "2026-03-31T23:00:00Z",
      "2026-03-31T23:00:00Z",
    ),
  ]);

  const result = await hasLivePrReviewClaim({
    repo: "org/repo",
    prNumber: 42,
    reviewId: REVIEW_ID,
    ghCommandFn,
    trustedAuthors: [FLEET_AUTHOR],
    nowMs: NOW,
    log: () => {},
  });

  assertEquals(result, false);
});

Deno.test("hasLivePrReviewClaim is false for a claim on a different review", async () => {
  const ghCommandFn = createReadStub([
    {
      id: 301,
      body: `<!-- PR_COMMENT_CLAIM:worker-alpha:999 -->\n` +
        `Claiming PR feedback comment 999 for worker \`worker-alpha\`.\n` +
        `<!-- PR_COMMENT_CLAIM_LEASE:2026-04-01T00:09:00Z -->`,
      created_at: "2026-04-01T00:00:00Z",
      updated_at: "2026-04-01T00:09:00Z",
      author: FLEET_AUTHOR,
    },
  ]);

  const result = await hasLivePrReviewClaim({
    repo: "org/repo",
    prNumber: 42,
    reviewId: REVIEW_ID,
    ghCommandFn,
    trustedAuthors: [FLEET_AUTHOR],
    nowMs: NOW,
    log: () => {},
  });

  assertEquals(result, false);
});

Deno.test("hasLivePrReviewClaim is false for a non-lease claim", async () => {
  const ghCommandFn = createReadStub([
    {
      id: 301,
      body: `<!-- PR_COMMENT_CLAIM:worker-alpha:${REVIEW_ID} -->\n` +
        `Claiming PR feedback comment ${REVIEW_ID} for worker \`worker-alpha\`.`,
      created_at: "2026-04-01T00:09:59Z",
      author: FLEET_AUTHOR,
    },
  ]);

  const result = await hasLivePrReviewClaim({
    repo: "org/repo",
    prNumber: 42,
    reviewId: REVIEW_ID,
    ghCommandFn,
    trustedAuthors: [FLEET_AUTHOR],
    nowMs: NOW,
    log: () => {},
  });

  assertEquals(result, false);
});

Deno.test("hasLivePrReviewClaim is false and logs on a read failure", async () => {
  const ghCommandFn = createReadStub([], "network error");
  const logged: string[] = [];

  const result = await hasLivePrReviewClaim({
    repo: "org/repo",
    prNumber: 42,
    reviewId: REVIEW_ID,
    ghCommandFn,
    trustedAuthors: [FLEET_AUTHOR],
    nowMs: NOW,
    log: (m) => logged.push(m),
  });

  assertEquals(result, false);
  assertEquals(
    logged.some((m) => m.includes("network error") && m.includes(REVIEW_ID)),
    true,
    `expected the read failure logged, got: ${logged.join(" | ")}`,
  );
});

Deno.test("hasLivePrReviewClaim is false when trustedAuthors is empty", async () => {
  const ghCommandFn = createReadStub([
    leaseClaimRow(
      301,
      "worker-alpha",
      FLEET_AUTHOR,
      "2026-04-01T00:00:00Z",
      "2026-04-01T00:09:00Z",
    ),
  ]);

  const result = await hasLivePrReviewClaim({
    repo: "org/repo",
    prNumber: 42,
    reviewId: REVIEW_ID,
    ghCommandFn,
    trustedAuthors: [],
    nowMs: NOW,
    log: () => {},
  });

  assertEquals(result, false);
});
