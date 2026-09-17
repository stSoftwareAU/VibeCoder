/**
 * Busy threads: pagination, litter and expiry for the PR-comment claim
 * (Issue #2266).
 *
 * `claim_pr_comment.ts` carried the same unpaginated read Issue #2265 fixed
 * in `pr_branch_lock.ts`: all three `gh api …/comments` calls read page one,
 * so past the 30 oldest comments the sweep expired nothing, the host could
 * not see the claim it had just posted, and the claim comment it left behind
 * was never removed. These tests serve two pages and assert the claim is
 * seen, the posted comment is taken back, and an expired claim cannot wedge
 * the PR.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  claimPrComment,
  MAX_STALE_CLAIM_DELETIONS,
  parseClaimCommentPages,
} from "../lib/claim_pr_comment.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** No-op sleep for fast tests. */
const noSleep = () => Promise.resolve();

/** The fleet service account every fixture claim is posted by. */
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
  author: string = FLEET_AUTHOR,
) => ({
  id,
  body: `<!-- PR_COMMENT_CLAIM:${workerId}:${targetCommentId} -->\n` +
    `Claiming PR feedback comment ${targetCommentId} for worker ` +
    `\`${workerId}\`.`,
  created_at: createdAt,
  author,
});

/** What `gh api --paginate --jq '[…]'` prints: one JSON array per page. */
const pages = (...pageRows: Array<ReturnType<typeof claimRow>[]>) =>
  pageRows.map((rows) => JSON.stringify(rows)).join("\n");

/** What `gh pr comment` prints — the new comment's URL. */
const postedCommentUrl = (id: number) =>
  `https://github.com/org/repo/pull/42#issuecomment-${id}`;

/** Does this `gh` call read the PR's comment thread? */
const isCommentRead = (args: string[]) =>
  args[0] === "api" && !args.includes("DELETE") &&
  args.some((a) => a.includes("/comments") && !a.includes("/comments/"));

/** The comment id a `-X DELETE` call targets, or null. */
const deletedId = (args: string[]): number | null => {
  const match = args.join(" ").match(/issues\/comments\/(\d+)$/);
  return match ? Number(match[1]) : null;
};

/**
 * A `gh` stub that records every call and scripts the comment reads.
 *
 * The stub behaves like `gh api` does: **without** `--paginate` it answers
 * with the first page only, exactly as GitHub returns the 30 oldest comments.
 * A fake that served every page regardless would let the page-two tests pass
 * against the unpaginated read they exist to catch.
 *
 * @param readPayloads - Payload per comment read, in call order; the last
 *   entry is reused once the list is exhausted
 * @param ownCommentId - The id `gh pr comment` reports for the posted claim
 * @param deleteError - Thrown by every `-X DELETE` when supplied
 */
function createMockGh(options: {
  readPayloads: string[];
  ownCommentId?: number;
  deleteError?: string;
}) {
  const calls: string[][] = [];
  const deletes: number[] = [];
  let reads = 0;

  const ghCommandFn = (args: string[]): Promise<string> => {
    calls.push(args);

    if (isCommentRead(args)) {
      const payload = options.readPayloads[reads] ??
        options.readPayloads[options.readPayloads.length - 1] ?? "[]";
      reads++;
      return Promise.resolve(
        args.includes("--paginate") ? payload : payload.split("\n")[0] ?? "[]",
      );
    }

    const target = deletedId(args);
    if (target !== null) {
      if (options.deleteError) {
        return Promise.reject(new Error(options.deleteError));
      }
      deletes.push(target);
      return Promise.resolve("");
    }

    if (args[0] === "pr" && args[1] === "comment") {
      return Promise.resolve(
        options.ownCommentId === undefined
          ? ""
          : postedCommentUrl(options.ownCommentId),
      );
    }

    return Promise.resolve("");
  };

  return { calls, deletes, ghCommandFn, readCount: () => reads };
}

// ---------------------------------------------------------------------------
// parseClaimCommentPages
// ---------------------------------------------------------------------------

Deno.test("claim pr comment - parseClaimCommentPages flattens one array per page", () => {
  const rows = parseClaimCommentPages(pages(
    [claimRow(1, "worker-alpha", "555", "2026-04-01T00:00:01Z")],
    [claimRow(2, "worker-beta", "555", "2026-04-01T00:00:02Z")],
  ));

  assertEquals(rows.map((r) => r.id), [1, 2]);
  assertEquals(rows[1]?.author, FLEET_AUTHOR);
});

Deno.test("claim pr comment - parseClaimCommentPages throws on an unreadable page", () => {
  // An unreadable page is a failure the caller handles, never an empty
  // result standing in for "no claims".
  assertThrows(() => parseClaimCommentPages("[]\nnot json\n"));
});

// ---------------------------------------------------------------------------
// The claim sees every page (Issue #2266)
// ---------------------------------------------------------------------------

Deno.test("claim pr comment - a competing claim on page two costs this host the race", async () => {
  const mock = createMockGh({
    ownCommentId: 301,
    readPayloads: [
      "[]", // the sweep finds nothing to expire
      pages(
        [claimRow(301, "worker-beta", "555", "2026-04-01T00:09:59Z")],
        [claimRow(300, "worker-alpha", "555", "2026-04-01T00:09:58Z")],
      ),
    ],
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
  // Losing takes this host's own claim comment with it.
  assertEquals(mock.deletes, [301]);
});

Deno.test("claim pr comment - the sweep expires a stale claim that only exists on page two", async () => {
  const mock = createMockGh({
    ownCommentId: 301,
    readPayloads: [
      pages(
        [claimRow(100, "crashed-worker", "555", "2026-04-01T00:00:00Z")],
        [claimRow(101, "crashed-worker", "556", "2026-04-01T00:01:00Z")],
      ),
      pages([claimRow(301, "worker-beta", "555", "2026-04-01T00:09:59Z")]),
    ],
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
  assertEquals(mock.deletes, [100, 101]);
});

Deno.test("claim pr comment - both comment reads are paginated at 100 per page", async () => {
  const mock = createMockGh({
    ownCommentId: 301,
    readPayloads: [
      "[]",
      pages([claimRow(301, "worker-beta", "555", "2026-04-01T00:09:59Z")]),
    ],
  });

  await claimPrComment({
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

  const reads = mock.calls.filter(isCommentRead);
  assertEquals(reads.length, 2);
  for (const args of reads) {
    assertEquals(
      args.includes("--paginate"),
      true,
      "a single page hides every claim on a thread longer than 30 comments",
    );
    assertStringIncludes(
      args.find((a) => a.includes("/comments")) ?? "",
      "per_page=100",
    );
  }
});

// ---------------------------------------------------------------------------
// The posted comment is taken back on every not-claimed path (Issue #2266)
// ---------------------------------------------------------------------------

Deno.test("claim pr comment - deletes the posted comment when the re-read comes back empty", async () => {
  const mock = createMockGh({
    ownCommentId: 402,
    readPayloads: ["[]", "[]"],
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
  assertEquals(
    mock.deletes,
    [402],
    "a claim comment nobody can see must not be left on the thread",
  );
});

Deno.test("claim pr comment - with no comment URL back, the newest fleet-authored match is deleted", async () => {
  // `gh` printed no URL, so the only evidence left is the marker. A
  // previous run's leftover carries the same marker: deleting that one would
  // leave this run's comment on the PR, which is the litter being fixed. A
  // stranger's copy must not be deleted at all — a marker anyone can quote
  // must not drive a destructive write.
  const thread = pages(
    [claimRow(100, "worker-beta", "555", "2026-04-01T00:00:00Z")], // leftover
    [
      claimRow(900, "worker-beta", "555", "2026-04-01T00:05:00Z", "outsider"),
      claimRow(301, "worker-beta", "555", "2026-04-01T00:09:59Z"), // this run
      claimRow(300, "worker-alpha", "555", "2026-04-01T00:09:58Z"),
    ],
  );
  const mock = createMockGh({ readPayloads: ["[]", thread, thread] });

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
  assertEquals(mock.deletes, [301]);
});

Deno.test("claim pr comment - the stale sweep caps its deletions per pass", async () => {
  const backlog = Array.from(
    { length: MAX_STALE_CLAIM_DELETIONS + 50 },
    (_unused, i) =>
      claimRow(i + 1, "crashed-worker", "555", "2026-04-01T00:00:00Z"),
  );
  const mock = createMockGh({
    ownCommentId: 999,
    readPayloads: [
      JSON.stringify(backlog),
      pages([claimRow(999, "worker-beta", "555", "2026-04-01T00:09:59Z")]),
    ],
  });
  const logs: string[] = [];

  await claimPrComment({
    repo: "org/repo",
    prNumber: 42,
    commentId: "555",
    workerId: "worker-beta",
    sleepFn: noSleep,
    ghCommandFn: mock.ghCommandFn,
    authorOptions: FLEET_OPTIONS,
    log: (message) => logs.push(message),
    nowMsFn: () => NOW,
  });

  // A backlog from the blind days must not turn one claim into 150 deletes.
  assertEquals(mock.deletes.length, MAX_STALE_CLAIM_DELETIONS);
  assertEquals(logs.length, 1);
  assertStringIncludes(logs[0]!, "50");
});

Deno.test("claim pr comment - deletes its own comment by id, not by matching the body", async () => {
  // A stranger copied this host's claim body onto the thread. Deleting by
  // body match would take the copy — or nothing at all past page one — and
  // leave this host's real claim comment behind for ever.
  const planted = claimRow(
    900,
    "worker-beta",
    "555",
    "2026-04-01T00:00:01Z",
    "drive-by-account",
  );
  const mock = createMockGh({
    ownCommentId: 301,
    readPayloads: [
      "[]",
      pages(
        [planted],
        [
          claimRow(301, "worker-beta", "555", "2026-04-01T00:09:59Z"),
          claimRow(300, "worker-alpha", "555", "2026-04-01T00:09:58Z"),
        ],
      ),
    ],
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
  assertEquals(mock.deletes, [301]);
});

// ---------------------------------------------------------------------------
// An expired claim cannot wedge the PR (Issue #2266)
// ---------------------------------------------------------------------------

Deno.test("claim pr comment - an expired claim the sweep could not delete is ignored", async () => {
  // The sweep's delete fails (403), so the stale claim is still on the
  // thread at verification time. It always sorts earliest, so counting it
  // would mean no host ever claims this comment again.
  const stale = claimRow(200, "crashed-worker", "555", "2026-04-01T00:00:00Z");
  const mock = createMockGh({
    ownCommentId: 301,
    deleteError: "403 Forbidden",
    readPayloads: [
      JSON.stringify([stale]),
      pages([
        stale,
        claimRow(301, "worker-beta", "555", "2026-04-01T00:09:59Z"),
      ]),
    ],
  });
  const logs: string[] = [];

  const result = await claimPrComment({
    repo: "org/repo",
    prNumber: 42,
    commentId: "555",
    workerId: "worker-beta",
    sleepFn: noSleep,
    ghCommandFn: mock.ghCommandFn,
    authorOptions: FLEET_OPTIONS,
    log: (message) => logs.push(message),
    nowMsFn: () => NOW,
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.claimed, true);
    assertEquals(result.value.winnerId, "worker-beta");
  }
  // The failed delete is reported rather than hidden.
  assertEquals(logs.some((l) => l.includes("403 Forbidden")), true);
});

Deno.test("claim pr comment - a same-second tie is broken by comment id, not by whose claim it is", async () => {
  // `created_at` has one-second granularity and two racing hosts land in the
  // same second routinely. Both hosts must pick the same winner, so the
  // lower comment id — the order GitHub assigned — wins for everyone.
  const sameSecond = "2026-04-01T00:09:59Z";
  const thread = JSON.stringify([
    claimRow(300, "worker-alpha", "555", sameSecond),
    claimRow(301, "worker-beta", "555", sameSecond),
  ]);

  const loser = await claimPrComment({
    repo: "org/repo",
    prNumber: 42,
    commentId: "555",
    workerId: "worker-beta",
    sleepFn: noSleep,
    ghCommandFn:
      createMockGh({ ownCommentId: 301, readPayloads: ["[]", thread] })
        .ghCommandFn,
    authorOptions: FLEET_OPTIONS,
    log: () => {},
    nowMsFn: () => NOW,
  });

  assertEquals(loser.ok, true);
  if (loser.ok) {
    assertEquals(loser.value.claimed, false);
    assertEquals(loser.value.winnerId, "worker-alpha");
  }

  const winner = await claimPrComment({
    repo: "org/repo",
    prNumber: 42,
    commentId: "555",
    workerId: "worker-alpha",
    sleepFn: noSleep,
    ghCommandFn:
      createMockGh({ ownCommentId: 300, readPayloads: ["[]", thread] })
        .ghCommandFn,
    authorOptions: FLEET_OPTIONS,
    log: () => {},
    nowMsFn: () => NOW,
  });

  assertEquals(winner.ok, true);
  if (winner.ok) {
    assertEquals(winner.value.claimed, true);
    assertEquals(winner.value.winnerId, "worker-alpha");
  }
});

Deno.test("claim pr comment - a live claim posted seconds earlier still wins", async () => {
  // The expiry rule must not hand every race to the latest claimant: a
  // fleet claim posted a second before ours is live and wins.
  const mock = createMockGh({
    ownCommentId: 301,
    readPayloads: [
      "[]",
      JSON.stringify([
        claimRow(300, "worker-alpha", "555", "2026-04-01T00:09:58Z"),
        claimRow(301, "worker-beta", "555", "2026-04-01T00:09:59Z"),
      ]),
    ],
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
  assertEquals(mock.deletes, [301]);
});
