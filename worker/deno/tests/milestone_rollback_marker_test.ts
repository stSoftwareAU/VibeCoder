/**
 * Tests for milestone_rollback_marker.ts (Issue #1770, parent #1730).
 *
 * A child issue reopened because a milestone roll-back reverted its merged
 * PR must not be re-closed by the merged-PR closers. The marker is what tells
 * them, and — like the VibeCoder#42 re-label escape hatch it sits beside — it
 * counts only when the fleet authored it and it postdates the merge.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  buildRollbackMarker,
  findRollbackAfter,
  findRollbackAfterMerge,
  ROLLBACK_MARKER,
  rollbackSkipReason,
} from "../lib/milestone_rollback_marker.ts";

const MERGED_AT = "2026-09-01T10:00:00Z";
const FLEET = ["vibe-bot", "stsvcbot"];

/** One REST comment object, the shape `fetchIssueCommentPages` returns. */
function comment(
  author: string,
  createdAt: string,
  body: string,
): Record<string, unknown> {
  return { user: { login: author }, created_at: createdAt, body };
}

const MARKER = buildRollbackMarker({
  prNumber: 1801,
  revertSha: "abc1234",
  branch: "milestone/1730-resolve-merge-conflicts",
});

// ---------------------------------------------------------------------------
// buildRollbackMarker
// ---------------------------------------------------------------------------

Deno.test('buildRollbackMarker - renders the canonical key="value" grammar', () => {
  assertEquals(
    MARKER,
    '<!-- vibe-milestone-rollback pr="1801" revert="abc1234" ' +
      'branch="milestone/1730-resolve-merge-conflicts" -->',
  );
  assert(MARKER.startsWith(ROLLBACK_MARKER));
});

Deno.test("buildRollbackMarker - normalises an upper-case sha", () => {
  const marker = buildRollbackMarker({
    prNumber: 7,
    revertSha: "ABCDEF01",
    branch: "milestone/x",
  });
  assertEquals(marker.includes('revert="abcdef01"'), true);
});

Deno.test("buildRollbackMarker - rejects a value that would break the grammar", () => {
  assertThrows(
    () =>
      buildRollbackMarker({
        prNumber: 1,
        revertSha: "abc1234",
        branch: 'evil" --><!-- vibe-milestone-rollback',
      }),
    Error,
    "branch",
  );
  assertThrows(
    () =>
      buildRollbackMarker({
        prNumber: 0,
        revertSha: "abc1234",
        branch: "milestone/x",
      }),
    Error,
    "prNumber",
  );
  assertThrows(
    () =>
      buildRollbackMarker({
        prNumber: 1,
        revertSha: "not-a-sha",
        branch: "milestone/x",
      }),
    Error,
    "revertSha",
  );
});

// ---------------------------------------------------------------------------
// findRollbackAfter — the trust rules
// ---------------------------------------------------------------------------

Deno.test("findRollbackAfter - a fleet marker after the merge is honoured", () => {
  const found = findRollbackAfter(
    [comment("vibe-bot", "2026-09-01T11:00:00Z", `Rolled back.\n\n${MARKER}`)],
    MERGED_AT,
    FLEET,
  );
  assert(found, "expected the roll-back to be found");
  assertEquals(found.prNumber, 1801);
  assertEquals(found.revertSha, "abc1234");
  assertEquals(found.branch, "milestone/1730-resolve-merge-conflicts");
  assertEquals(found.author, "vibe-bot");
});

Deno.test("findRollbackAfter - the same marker from a non-fleet author is ignored", () => {
  const found = findRollbackAfter(
    [comment("drive-by", "2026-09-01T11:00:00Z", MARKER)],
    MERGED_AT,
    FLEET,
  );
  assertEquals(found, undefined);
});

Deno.test("findRollbackAfter - a marker dated before the merge does not count", () => {
  const found = findRollbackAfter(
    [comment("vibe-bot", "2026-08-30T09:00:00Z", MARKER)],
    MERGED_AT,
    FLEET,
  );
  assertEquals(found, undefined);
});

Deno.test("findRollbackAfter - a marker dated exactly at the merge does not count", () => {
  const found = findRollbackAfter(
    [comment("vibe-bot", MERGED_AT, MARKER)],
    MERGED_AT,
    FLEET,
  );
  assertEquals(found, undefined);
});

Deno.test("findRollbackAfter - no configured fleet identity trusts nothing", () => {
  const found = findRollbackAfter(
    [comment("vibe-bot", "2026-09-01T11:00:00Z", MARKER)],
    MERGED_AT,
    [],
  );
  assertEquals(found, undefined);
});

Deno.test("findRollbackAfter - an unparseable merge time blocks nothing", () => {
  const found = findRollbackAfter(
    [comment("vibe-bot", "2026-09-01T11:00:00Z", MARKER)],
    "not a date",
    FLEET,
  );
  assertEquals(found, undefined);
});

Deno.test("findRollbackAfter - a malformed marker is not a roll-back", () => {
  const bodies = [
    `${ROLLBACK_MARKER} -->`,
    `${ROLLBACK_MARKER} pr="0" revert="abc1234" branch="m" -->`,
    `${ROLLBACK_MARKER} pr="9" revert="zz" branch="m" -->`,
    `${ROLLBACK_MARKER} pr="9" revert="abc1234" -->`,
  ];
  for (const body of bodies) {
    assertEquals(
      findRollbackAfter(
        [comment("vibe-bot", "2026-09-01T11:00:00Z", body)],
        MERGED_AT,
        FLEET,
      ),
      undefined,
      `expected ${body} to be rejected`,
    );
  }
});

Deno.test("findRollbackAfter - reads the gh --json comment shape too", () => {
  const found = findRollbackAfter(
    [{
      author: { login: "stsvcbot" },
      createdAt: "2026-09-02T00:00:00Z",
      body: MARKER,
    }],
    MERGED_AT,
    FLEET,
  );
  assertEquals(found?.author, "stsvcbot");
});

Deno.test("findRollbackAfter - returns the newest trusted marker", () => {
  const later = buildRollbackMarker({
    prNumber: 1900,
    revertSha: "beef123",
    branch: "milestone/x",
  });
  const found = findRollbackAfter(
    [
      comment("vibe-bot", "2026-09-01T11:00:00Z", MARKER),
      comment("vibe-bot", "2026-09-03T11:00:00Z", later),
    ],
    MERGED_AT,
    FLEET,
  );
  assertEquals(found?.prNumber, 1900);
});

Deno.test("rollbackSkipReason - opens with the rolled-back reason", () => {
  const found = findRollbackAfter(
    [comment("vibe-bot", "2026-09-01T11:00:00Z", MARKER)],
    MERGED_AT,
    FLEET,
  );
  assert(found);
  const reason = rollbackSkipReason(found);
  assert(reason.startsWith("rolled-back"), reason);
  assert(reason.includes("#1801"), reason);
});

// ---------------------------------------------------------------------------
// findRollbackAfterMerge — the fetch wrapper
// ---------------------------------------------------------------------------

Deno.test("findRollbackAfterMerge - reads the issue's comments through gh", async () => {
  const argv: string[][] = [];
  const found = await findRollbackAfterMerge(
    "org/repo",
    48,
    MERGED_AT,
    FLEET,
    (args) => {
      argv.push(args);
      return Promise.resolve(JSON.stringify([
        comment("vibe-bot", "2026-09-01T11:00:00Z", MARKER),
      ]));
    },
  );
  assertEquals(found?.prNumber, 1801);
  assertEquals(argv[0]?.[0], "api");
  assert(argv[0]?.[1]?.includes("org/repo/issues/48/comments"), "comment path");
});

Deno.test("findRollbackAfterMerge - spends nothing when no fleet is configured", async () => {
  let called = 0;
  const found = await findRollbackAfterMerge(
    "org/repo",
    48,
    MERGED_AT,
    [],
    () => {
      called++;
      return Promise.resolve("[]");
    },
  );
  assertEquals(found, undefined);
  assertEquals(called, 0);
});

Deno.test("findRollbackAfterMerge - an unreadable thread fails loud", async () => {
  let threw = false;
  try {
    await findRollbackAfterMerge(
      "org/repo",
      48,
      MERGED_AT,
      FLEET,
      () => Promise.reject(new Error("gh: 500")),
    );
  } catch (err) {
    threw = true;
    assertEquals((err as Error).message, "gh: 500");
  }
  assert(threw, "expected the unreadable thread to throw");
});
