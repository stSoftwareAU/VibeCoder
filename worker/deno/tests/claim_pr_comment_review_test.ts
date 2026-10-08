/**
 * Claiming a `pr_review` (Issue #2697, revised by Issue #3383).
 *
 * The scan no longer drops a change request once the PR head moves, so a
 * live claim is what stops it being rediscovered. The claim no longer
 * dismisses the review at claim time (Issue #3383): it posts a lease claim
 * instead, which the processor renews and which lapses — becoming
 * reclaimable — if the run goes silent. These tests pin the claim race for a
 * review id and the lease's interaction with the stale sweep.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { claimPrComment } from "../lib/claim_pr_comment.ts";
import { PR_REVIEW_CLAIM_LEASE_MS } from "../lib/pr_review_claim_lease.ts";

const noSleep = () => Promise.resolve();
const FLEET_AUTHOR = "vibe-coder-bot";
const FLEET_OPTIONS = { fleetAuthors: [FLEET_AUTHOR] } as const;
const NOW = Date.parse("2026-04-01T00:10:00Z");
const REVIEW_ID = "700";

const claimRow = (
  id: number,
  workerId: string,
  createdAt: string,
  options?: { lease?: boolean; updatedAt?: string },
) => {
  const lease = options?.lease ?? false;
  const body = `<!-- PR_COMMENT_CLAIM:${workerId}:${REVIEW_ID} -->\n` +
    `Claiming PR feedback comment ${REVIEW_ID} for worker \`${workerId}\`.` +
    (lease ? `\n<!-- PR_COMMENT_CLAIM_LEASE:${createdAt} -->` : "");
  return {
    id,
    body,
    created_at: createdAt,
    updated_at: options?.updatedAt,
    author: FLEET_AUTHOR,
  };
};

/**
 * A `gh` stub: comment reads answer from `readPayloads` in order (the last
 * is reused), `gh pr comment` reports claim comment 301.
 */
function createMockGh(readPayloads: string[]) {
  const calls: string[] = [];
  let reads = 0;
  const ghCommandFn = (args: string[]): Promise<string> => {
    const key = args.join(" ");
    calls.push(key);
    if (args[0] === "api" && /issues\/42\/comments/.test(key)) {
      const payload = readPayloads[reads] ?? readPayloads.at(-1) ?? "[]";
      reads++;
      return Promise.resolve(payload);
    }
    if (args[0] === "pr" && args[1] === "comment") {
      return Promise.resolve(
        "https://github.com/org/repo/pull/42#issuecomment-301",
      );
    }
    if (args[0] === "api" && key.includes("DELETE")) {
      return Promise.resolve("");
    }
    return Promise.resolve("");
  };
  return { calls, ghCommandFn };
}

function claim(
  ghCommandFn: (args: string[]) => Promise<string>,
  log: (m: string) => void,
) {
  return claimPrComment({
    repo: "org/repo",
    prNumber: 42,
    commentId: REVIEW_ID,
    commentType: "pr_review",
    workerId: "worker-beta",
    sleepFn: noSleep,
    ghCommandFn,
    authorOptions: FLEET_OPTIONS,
    log,
    nowMsFn: () => NOW,
  });
}

Deno.test("claim pr comment - a pr_review with no competitor is claimed without dismissing it", async () => {
  const mock = createMockGh([
    "[]",
    JSON.stringify([claimRow(301, "worker-beta", "2026-04-01T00:09:59Z")]),
  ]);

  const result = await claim(mock.ghCommandFn, () => {});

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.claimed, true);
    assertEquals(result.value.claimCommentId, 301);
  }
  assertEquals(
    mock.calls.some((c) => c.includes("/dismissals")),
    false,
  );
  const postedBodyCall = mock.calls.find((c) =>
    c.startsWith("pr comment") && c.includes("--body")
  );
  assertEquals(postedBodyCall !== undefined, true);
  if (result.ok) {
    assertEquals(
      result.value.claimBody?.includes("PR_COMMENT_CLAIM_LEASE:") ?? false,
      true,
    );
  }
});

Deno.test("claim pr comment - a sibling's earlier claim on the same review wins", async () => {
  const mock = createMockGh([
    "[]",
    JSON.stringify([
      claimRow(300, "worker-alpha", "2026-04-01T00:09:58Z"),
      claimRow(301, "worker-beta", "2026-04-01T00:09:59Z"),
    ]),
  ]);

  const result = await claim(mock.ghCommandFn, () => {});

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.claimed, false);
    assertEquals(result.value.winnerId, "worker-alpha");
  }
});

Deno.test("claim pr comment - the review dismissal endpoint is never called, and claiming still succeeds", async () => {
  const mock = createMockGh([
    "[]",
    JSON.stringify([claimRow(301, "worker-beta", "2026-04-01T00:09:59Z")]),
  ]);
  const logged: string[] = [];

  const result = await claim(mock.ghCommandFn, (m) => logged.push(m));

  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value.claimed, true);
  assertEquals(
    mock.calls.some((c) => c.includes("/dismissals")),
    false,
  );
  assertEquals(
    logged.some((m) => m.toLowerCase().includes("dismiss")),
    false,
  );
});

Deno.test(
  "claim pr comment - a sibling's lease claim renewed within the window still wins and survives the sweep",
  async () => {
    const siblingRow = claimRow(300, "worker-alpha", "2026-04-01T00:02:00Z", {
      lease: true,
      updatedAt: "2026-04-01T00:08:00Z",
    });
    const mock = createMockGh([
      JSON.stringify([siblingRow]),
      JSON.stringify([
        siblingRow,
        claimRow(301, "worker-beta", "2026-04-01T00:09:59Z"),
      ]),
    ]);

    const result = await claim(mock.ghCommandFn, () => {});

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.claimed, false);
      assertEquals(result.value.winnerId, "worker-alpha");
    }
    assertEquals(
      mock.calls.some((c) =>
        c.includes("DELETE") && c.includes("issues/comments/300")
      ),
      false,
    );
  },
);

Deno.test(
  "claim pr comment - a sibling's lapsed lease claim is swept and this host wins",
  async () => {
    const staleUpdatedAt = new Date(NOW - PR_REVIEW_CLAIM_LEASE_MS - 1000)
      .toISOString();
    const siblingRow = claimRow(300, "worker-alpha", staleUpdatedAt, {
      lease: true,
      updatedAt: staleUpdatedAt,
    });
    const mock = createMockGh([
      JSON.stringify([siblingRow]),
      JSON.stringify([claimRow(301, "worker-beta", "2026-04-01T00:09:59Z")]),
    ]);

    const result = await claim(mock.ghCommandFn, () => {});

    assertEquals(result.ok, true);
    if (result.ok) assertEquals(result.value.claimed, true);
    assertEquals(
      mock.calls.some((c) =>
        c.includes("DELETE") && c.includes("issues/comments/300")
      ),
      true,
    );
  },
);

Deno.test(
  "claim pr comment - a sibling's lease claim with no parseable timestamp is neither swept nor a contender",
  async () => {
    const siblingRow = claimRow(300, "worker-alpha", "not-a-date", {
      lease: true,
      updatedAt: "also-not-a-date",
    });
    const mock = createMockGh([
      JSON.stringify([siblingRow]),
      JSON.stringify([
        siblingRow,
        claimRow(301, "worker-beta", "2026-04-01T00:09:59Z"),
      ]),
    ]);

    const result = await claim(mock.ghCommandFn, () => {});

    // Unprovable is not live, so this host wins — but unprovable is not
    // stale either, so the sweep leaves the comment alone.
    assertEquals(result.ok, true);
    if (result.ok) assertEquals(result.value.claimed, true);
    assertEquals(
      mock.calls.some((c) =>
        c.includes("DELETE") && c.includes("issues/comments/300")
      ),
      false,
    );
  },
);

Deno.test(
  "claim pr comment - a sibling's ordinary claim with an unparseable createdAt is not a contender",
  async () => {
    // Sorts before any ISO timestamp, so it would win the race if it counted.
    const siblingRow = claimRow(300, "worker-alpha", "!not-a-date");
    const mock = createMockGh([
      "[]",
      JSON.stringify([
        siblingRow,
        claimRow(301, "worker-beta", "2026-04-01T00:09:59Z"),
      ]),
    ]);

    const result = await claim(mock.ghCommandFn, () => {});

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.claimed, true);
      assertEquals(result.value.winnerId, "worker-beta");
    }
  },
);
