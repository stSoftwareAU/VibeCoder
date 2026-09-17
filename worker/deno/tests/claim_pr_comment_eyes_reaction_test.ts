/**
 * The eyes reaction must not outlive a claim nobody won (Issue #2269).
 *
 * `claimPrComment` adds the processed marker (👀) in step 3, before the claim
 * is verified, so the marker is on the feedback comment even when the claim is
 * then dropped with **no winner** — a failed verification read, or a re-read
 * that cannot see this host's own claim. That marker is what stops
 * `findActionableComment` rediscovering the comment, so the feedback was
 * answered by nobody. These tests drive both no-winner paths and assert the
 * comment is left rediscoverable, while a claim genuinely lost to another host
 * keeps its marker — the winner answers it.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { claimPrComment } from "../lib/claim_pr_comment.ts";
import { removeProcessedMark } from "../lib/pr_comments.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** No-op sleep for fast tests. */
const noSleep = () => Promise.resolve();

/** The fleet service account every fixture claim and reaction belongs to. */
const FLEET_AUTHOR = "vibe-coder-bot";

/** Author-verification inputs the fixtures pass instead of a config file. */
const FLEET_OPTIONS = { fleetAuthors: [FLEET_AUTHOR] } as const;

/** The wall-clock instant every fixture is anchored to. */
const NOW = Date.parse("2026-04-01T00:10:00Z");

/** A claim comment row as the `--jq` filter shapes it. */
const claimRow = (
  id: number,
  workerId: string,
  targetCommentId: string,
  createdAt: string,
) => ({
  id,
  body: `<!-- PR_COMMENT_CLAIM:${workerId}:${targetCommentId} -->\n` +
    `Claiming PR feedback comment ${targetCommentId} for worker ` +
    `\`${workerId}\`.`,
  created_at: createdAt,
  author: FLEET_AUTHOR,
});

/** Does this `gh` call read the PR's comment thread? */
const isCommentRead = (args: string[]) =>
  args[0] === "api" && !args.includes("DELETE") &&
  args.some((a) => a.includes("/comments") && !a.includes("/reactions"));

/** Does this `gh` call read the reactions on a comment? */
const isReactionRead = (args: string[]) =>
  args[0] === "api" && !args.includes("-X") &&
  args.some((a) => a.includes("/reactions"));

/** The reaction id a `-X DELETE …/reactions/<id>` call targets, or null. */
const deletedReactionId = (args: string[]): number | null => {
  const match = args.join(" ").match(/reactions\/(\d+)$/);
  return match ? Number(match[1]) : null;
};

/**
 * A `gh` stub for the claim's full call sequence.
 *
 * @param options.commentReads - Payload per comment-thread read, in order;
 *   the last entry is reused once the list is exhausted
 * @param options.commentReadError - Thrown by the verification read when set
 * @param options.reactions - Rows the reactions read answers with
 */
function createMockGh(options: {
  commentReads: string[];
  commentReadError?: string;
  reactions?: Array<{ id: number; login: string }>;
}) {
  const calls: string[][] = [];
  const deletedReactions: number[] = [];
  let reads = 0;

  const ghCommandFn = (args: string[]): Promise<string> => {
    calls.push(args);

    if (isCommentRead(args)) {
      reads++;
      // The stale sweep reads first; the verification read is the second.
      if (reads === 2 && options.commentReadError) {
        return Promise.reject(new Error(options.commentReadError));
      }
      return Promise.resolve(
        options.commentReads[reads - 1] ??
          options.commentReads[options.commentReads.length - 1] ?? "[]",
      );
    }

    if (isReactionRead(args)) {
      return Promise.resolve(JSON.stringify(options.reactions ?? []));
    }

    const reactionId = deletedReactionId(args);
    if (reactionId !== null) {
      deletedReactions.push(reactionId);
      return Promise.resolve("");
    }

    if (args[0] === "api" && args[1] === "user") {
      return Promise.resolve(`${FLEET_AUTHOR}\n`);
    }

    if (args[0] === "pr" && args[1] === "comment") {
      return Promise.resolve(
        "https://github.com/org/repo/pull/42#issuecomment-402",
      );
    }

    return Promise.resolve("");
  };

  return { calls, deletedReactions, ghCommandFn };
}

/** Was the processed marker (👀) added by this run? */
const addedEyes = (calls: string[][]) =>
  calls.some((c) =>
    c.includes("POST") && c.includes("content=eyes") &&
    c.some((a) => a.includes("/reactions"))
  );

// ---------------------------------------------------------------------------
// claimPrComment — the no-winner paths
// ---------------------------------------------------------------------------

Deno.test("claim pr comment - a failed verification read takes the eyes reaction back", async () => {
  const mock = createMockGh({
    commentReads: ["[]"],
    commentReadError: "API rate limit exceeded",
    reactions: [{ id: 7001, login: FLEET_AUTHOR }],
  });

  const result = await claimPrComment({
    repo: "org/repo",
    prNumber: 42,
    commentId: "555",
    workerId: "worker-beta",
    sleepFn: noSleep,
    ghCommandFn: mock.ghCommandFn,
    authorOptions: FLEET_OPTIONS,
    log: () => {},
    nowMsFn: () => NOW,
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.claimed, false);
    assertEquals(result.value.winnerId, undefined);
  }
  assertEquals(addedEyes(mock.calls), true, "step 3 adds the marker");
  assertEquals(
    mock.deletedReactions,
    [7001],
    "nobody won the claim, so the feedback comment must stay rediscoverable",
  );
});

Deno.test("claim pr comment - an unseen own claim takes the eyes reaction back", async () => {
  const mock = createMockGh({
    commentReads: ["[]", "[]"],
    reactions: [{ id: 7002, login: FLEET_AUTHOR }],
  });

  const result = await claimPrComment({
    repo: "org/repo",
    prNumber: 42,
    commentId: "555",
    workerId: "worker-beta",
    sleepFn: noSleep,
    ghCommandFn: mock.ghCommandFn,
    authorOptions: FLEET_OPTIONS,
    log: () => {},
    nowMsFn: () => NOW,
  });

  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value.claimed, false);
  assertEquals(mock.deletedReactions, [7002]);
});

Deno.test("claim pr comment - a claim lost to a real winner keeps the eyes reaction", async () => {
  const thread = JSON.stringify([
    claimRow(300, "worker-alpha", "555", "2026-04-01T00:09:58Z"),
    claimRow(402, "worker-beta", "555", "2026-04-01T00:09:59Z"),
  ]);
  const mock = createMockGh({
    commentReads: ["[]", thread],
    reactions: [{ id: 7003, login: FLEET_AUTHOR }],
  });

  const result = await claimPrComment({
    repo: "org/repo",
    prNumber: 42,
    commentId: "555",
    workerId: "worker-beta",
    sleepFn: noSleep,
    ghCommandFn: mock.ghCommandFn,
    authorOptions: FLEET_OPTIONS,
    log: () => {},
    nowMsFn: () => NOW,
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.claimed, false);
    assertEquals(result.value.winnerId, "worker-alpha");
  }
  assertEquals(
    mock.deletedReactions,
    [],
    "the winner answers the comment, so its marker must stand",
  );
});

Deno.test("claim pr comment - a won claim keeps the eyes reaction", async () => {
  const thread = JSON.stringify([
    claimRow(402, "worker-beta", "555", "2026-04-01T00:09:59Z"),
  ]);
  const mock = createMockGh({
    commentReads: ["[]", thread],
    reactions: [{ id: 7004, login: FLEET_AUTHOR }],
  });

  const result = await claimPrComment({
    repo: "org/repo",
    prNumber: 42,
    commentId: "555",
    workerId: "worker-beta",
    sleepFn: noSleep,
    ghCommandFn: mock.ghCommandFn,
    authorOptions: FLEET_OPTIONS,
    log: () => {},
    nowMsFn: () => NOW,
  });

  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value.claimed, true);
  assertEquals(mock.deletedReactions, []);
});

Deno.test("claim pr comment - a reaction that cannot be taken back is said out loud", async () => {
  const messages: string[] = [];
  const mock = createMockGh({
    commentReads: ["[]"],
    commentReadError: "API rate limit exceeded",
  });
  const ghCommandFn = (args: string[]): Promise<string> =>
    isReactionRead(args)
      ? Promise.reject(new Error("reactions unavailable"))
      : mock.ghCommandFn(args);

  await claimPrComment({
    repo: "org/repo",
    prNumber: 42,
    commentId: "555",
    workerId: "worker-beta",
    sleepFn: noSleep,
    ghCommandFn,
    authorOptions: FLEET_OPTIONS,
    log: (m) => messages.push(m),
    nowMsFn: () => NOW,
  });

  assertStringIncludes(messages.join("\n"), "555");
  assertStringIncludes(messages.join("\n"), "rediscover");
});

// ---------------------------------------------------------------------------
// removeProcessedMark
// ---------------------------------------------------------------------------

Deno.test("remove processed mark - deletes only this account's eyes reaction", async () => {
  const deleted: string[] = [];
  const ghCommandFn = (args: string[]): Promise<string> => {
    if (args[0] === "api" && args[1] === "user") {
      return Promise.resolve(FLEET_AUTHOR);
    }
    if (isReactionRead(args)) {
      return Promise.resolve(JSON.stringify([
        { id: 11, login: "outsider" },
        { id: 12, login: FLEET_AUTHOR.toUpperCase() },
      ]));
    }
    deleted.push(args.join(" "));
    return Promise.resolve("");
  };

  const error = await removeProcessedMark(
    "org/repo",
    "issue",
    "555",
    ghCommandFn,
    () => {},
  );

  assertEquals(error, null);
  assertEquals(deleted.length, 1);
  assertStringIncludes(
    deleted[0]!,
    "repos/org/repo/issues/comments/555/reactions/12",
  );
});

Deno.test("remove processed mark - a review comment uses the pulls endpoint", async () => {
  const deleted: string[] = [];
  const ghCommandFn = (args: string[]): Promise<string> => {
    if (args[0] === "api" && args[1] === "user") {
      return Promise.resolve(FLEET_AUTHOR);
    }
    if (isReactionRead(args)) {
      return Promise.resolve(JSON.stringify([{ id: 21, login: FLEET_AUTHOR }]));
    }
    deleted.push(args.join(" "));
    return Promise.resolve("");
  };

  const error = await removeProcessedMark(
    "org/repo",
    "review",
    "555",
    ghCommandFn,
    () => {},
  );

  assertEquals(error, null);
  assertStringIncludes(
    deleted[0]!,
    "repos/org/repo/pulls/comments/555/reactions/21",
  );
});

Deno.test("remove processed mark - no reaction from this account deletes nothing", async () => {
  const calls: string[][] = [];
  const ghCommandFn = (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "api" && args[1] === "user") {
      return Promise.resolve(FLEET_AUTHOR);
    }
    return Promise.resolve(JSON.stringify([{ id: 31, login: "outsider" }]));
  };

  const error = await removeProcessedMark(
    "org/repo",
    "issue",
    "555",
    ghCommandFn,
    () => {},
  );

  assertEquals(error, null);
  assertEquals(calls.some((c) => c.includes("DELETE")), false);
});

Deno.test("remove processed mark - an unreadable reactions list reports the failure", async () => {
  const ghCommandFn = (args: string[]): Promise<string> =>
    args[0] === "api" && args[1] === "user"
      ? Promise.resolve(FLEET_AUTHOR)
      : Promise.reject(new Error("reactions unavailable"));

  const error = await removeProcessedMark(
    "org/repo",
    "issue",
    "555",
    ghCommandFn,
    () => {},
  );

  assertStringIncludes(error?.message ?? "", "reactions unavailable");
});

Deno.test("remove processed mark - an unresolvable acting login reports the failure", async () => {
  const ghCommandFn = (args: string[]): Promise<string> =>
    args[0] === "api" && args[1] === "user"
      ? Promise.reject(new Error("bad credentials"))
      : Promise.resolve("[]");

  const error = await removeProcessedMark(
    "org/repo",
    "issue",
    "555",
    ghCommandFn,
    () => {},
  );

  assertStringIncludes(error?.message ?? "", "bad credentials");
});

Deno.test("remove processed mark - a dismissed review cannot be undismissed", async () => {
  const calls: string[][] = [];
  const error = await removeProcessedMark(
    "org/repo",
    "pr_review",
    "555",
    (args: string[]) => {
      calls.push(args);
      return Promise.resolve("");
    },
    () => {},
  );

  assertStringIncludes(error?.message ?? "", "dismiss");
  assertEquals(calls.length, 0);
});

Deno.test("remove processed mark - a failed delete reports the failure", async () => {
  const ghCommandFn = (args: string[]): Promise<string> => {
    if (args[0] === "api" && args[1] === "user") {
      return Promise.resolve(FLEET_AUTHOR);
    }
    if (isReactionRead(args)) {
      return Promise.resolve(JSON.stringify([{ id: 41, login: FLEET_AUTHOR }]));
    }
    return Promise.reject(new Error("delete refused"));
  };

  const error = await removeProcessedMark(
    "org/repo",
    "issue",
    "555",
    ghCommandFn,
    () => {},
  );

  assertStringIncludes(error?.message ?? "", "delete refused");
});
