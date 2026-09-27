/**
 * Claiming a `pr_review` (Issue #2697).
 *
 * The scan no longer drops a change request once the PR head moves, so the
 * claim-time dismissal is the only thing that stops a claimed review being
 * rediscovered. These tests pin the claim race for a review id and make a
 * failed dismissal loud.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { claimPrComment } from "../lib/claim_pr_comment.ts";

const noSleep = () => Promise.resolve();
const FLEET_AUTHOR = "vibe-coder-bot";
const FLEET_OPTIONS = { fleetAuthors: [FLEET_AUTHOR] } as const;
const NOW = Date.parse("2026-04-01T00:10:00Z");
const REVIEW_ID = "700";

const claimRow = (id: number, workerId: string, createdAt: string) => ({
  id,
  body: `<!-- PR_COMMENT_CLAIM:${workerId}:${REVIEW_ID} -->\n` +
    `Claiming PR feedback comment ${REVIEW_ID} for worker \`${workerId}\`.`,
  created_at: createdAt,
  author: FLEET_AUTHOR,
});

/**
 * A `gh` stub: comment reads answer from `readPayloads` in order (the last
 * is reused), `gh pr comment` reports claim comment 301, and the review
 * dismissal fails when `dismissalError` is set.
 */
function createMockGh(readPayloads: string[], dismissalError?: string) {
  const calls: string[] = [];
  let reads = 0;
  const ghCommandFn = (args: string[]): Promise<string> => {
    const key = args.join(" ");
    calls.push(key);
    if (key.includes("/dismissals")) {
      return dismissalError
        ? Promise.reject(new Error(dismissalError))
        : Promise.resolve("");
    }
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

Deno.test("claim pr comment - a pr_review with no competitor is claimed and dismissed", async () => {
  const mock = createMockGh([
    "[]",
    JSON.stringify([claimRow(301, "worker-beta", "2026-04-01T00:09:59Z")]),
  ]);

  const result = await claim(mock.ghCommandFn, () => {});

  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value.claimed, true);
  assertEquals(
    mock.calls.some((c) =>
      c.includes(`PUT repos/org/repo/pulls/42/reviews/${REVIEW_ID}/dismissals`)
    ),
    true,
  );
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

Deno.test("claim pr comment - a failed review dismissal is logged, not swallowed", async () => {
  const mock = createMockGh(
    [
      "[]",
      JSON.stringify([claimRow(301, "worker-beta", "2026-04-01T00:09:59Z")]),
    ],
    "422 Unprocessable Entity",
  );
  const logged: string[] = [];

  await claim(mock.ghCommandFn, (m) => logged.push(m));

  assertEquals(
    logged.some((m) =>
      m.includes(REVIEW_ID) && m.includes("processed") &&
      m.includes("422 Unprocessable Entity")
    ),
    true,
    `expected the dismissal failure in the log, got: ${logged.join(" | ")}`,
  );
});
