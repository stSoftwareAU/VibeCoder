/**
 * Tests for milestone_conflict_dedup.ts — identifying an unresolvable
 * milestone-sync conflict by the conflict itself (Issue #1786).
 *
 * The escalation used to be keyed on the default branch's tip. On a busy
 * repository that tip moves every few minutes, so the identical "only a
 * human can settle this" analysis was posted again on every cycle —
 * stSoftwareAU/VibeCoder#1653 collected four copies in 36 minutes.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  conflictEscalationKey,
  conflictEscalationMarker,
  hasConflictEscalationComment,
} from "../lib/milestone_conflict_dedup.ts";

const BRANCH = "milestone/1653-session-limit";
const SHA = "8308311aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

// ---------------------------------------------------------------------------
// conflictEscalationKey
// ---------------------------------------------------------------------------

Deno.test("conflictEscalationKey - the same conflict yields the same key regardless of file order", () => {
  const a = conflictEscalationKey({
    milestoneBranch: BRANCH,
    milestoneSha: SHA,
    files: ["b.ts", "a.ts"],
  });
  const b = conflictEscalationKey({
    milestoneBranch: BRANCH,
    milestoneSha: SHA,
    files: ["a.ts", "b.ts"],
  });
  assertEquals(a, b);
});

Deno.test("conflictEscalationKey - a duplicated path does not change the key", () => {
  const a = conflictEscalationKey({
    milestoneBranch: BRANCH,
    milestoneSha: SHA,
    files: ["a.ts"],
  });
  const b = conflictEscalationKey({
    milestoneBranch: BRANCH,
    milestoneSha: SHA,
    files: ["a.ts", "a.ts"],
  });
  assertEquals(a, b);
});

Deno.test("conflictEscalationKey - a different conflicting file set is a different conflict", () => {
  const a = conflictEscalationKey({
    milestoneBranch: BRANCH,
    milestoneSha: SHA,
    files: ["a.ts"],
  });
  const b = conflictEscalationKey({
    milestoneBranch: BRANCH,
    milestoneSha: SHA,
    files: ["a.ts", "b.ts"],
  });
  assertNotEquals(a, b);
});

Deno.test("conflictEscalationKey - a moved milestone branch is a new conflict", () => {
  const a = conflictEscalationKey({
    milestoneBranch: BRANCH,
    milestoneSha: SHA,
    files: ["a.ts"],
  });
  const b = conflictEscalationKey({
    milestoneBranch: BRANCH,
    milestoneSha: "c".repeat(40),
    files: ["a.ts"],
  });
  assertNotEquals(a, b);
});

Deno.test("conflictEscalationKey - a missing milestone sha still yields a stable key", () => {
  const a = conflictEscalationKey({ milestoneBranch: BRANCH, files: ["a.ts"] });
  const b = conflictEscalationKey({ milestoneBranch: BRANCH, files: ["a.ts"] });
  assertEquals(a, b);
  assert(a.length > 0);
});

Deno.test("conflictEscalationKey - an empty conflict set is still keyed by branch and sha", () => {
  const key = conflictEscalationKey({
    milestoneBranch: BRANCH,
    milestoneSha: SHA,
    files: [],
  });
  assert(key.includes(BRANCH));
});

Deno.test("conflictEscalationKey - characters that would break the HTML marker are stripped", () => {
  const key = conflictEscalationKey({
    milestoneBranch: BRANCH,
    milestoneSha: SHA,
    files: ['we<ird>"path".ts'],
  });
  assert(!key.includes('"'), "no quote survives");
  assert(!key.includes("<"), "no angle bracket survives");
  assert(!key.includes(">"), "no angle bracket survives");
});

// ---------------------------------------------------------------------------
// conflictEscalationMarker
// ---------------------------------------------------------------------------

Deno.test("conflictEscalationMarker - is a single-line HTML comment carrying the key", () => {
  const marker = conflictEscalationMarker("some-key");
  assertEquals(marker.includes("\n"), false);
  assert(marker.startsWith("<!--"));
  assert(marker.endsWith("-->"));
  assert(marker.includes("some-key"));
});

// ---------------------------------------------------------------------------
// hasConflictEscalationComment
// ---------------------------------------------------------------------------

Deno.test("hasConflictEscalationComment - true when another host already posted the marker", async () => {
  const marker = conflictEscalationMarker("k1");
  const found = await hasConflictEscalationComment({
    repo: "owner/repo",
    issueNumber: 1653,
    marker,
    ghCommandFn: () =>
      Promise.resolve(
        JSON.stringify({ comments: [{ body: `${marker}\nanalysis` }] }),
      ),
    log: () => undefined,
  });
  assertEquals(found, true);
});

Deno.test("hasConflictEscalationComment - false when the thread carries a different conflict's marker", async () => {
  const found = await hasConflictEscalationComment({
    repo: "owner/repo",
    issueNumber: 1653,
    marker: conflictEscalationMarker("k1"),
    ghCommandFn: () =>
      Promise.resolve(
        JSON.stringify({
          comments: [{ body: `${conflictEscalationMarker("k2")}\nanalysis` }],
        }),
      ),
    log: () => undefined,
  });
  assertEquals(found, false);
});

Deno.test("hasConflictEscalationComment - an unreadable thread reports not-posted and says so", async () => {
  const logs: string[] = [];
  const found = await hasConflictEscalationComment({
    repo: "owner/repo",
    issueNumber: 1653,
    marker: conflictEscalationMarker("k1"),
    ghCommandFn: () => Promise.reject(new Error("gh exploded")),
    log: (m) => logs.push(m),
  });
  assertEquals(found, false, "an escalation is never lost to an unread thread");
  assert(
    logs.some((l) => l.includes("gh exploded")),
    `the failure is named in the log, got ${JSON.stringify(logs)}`,
  );
});

Deno.test("hasConflictEscalationComment - a payload with no comments array is reported, not read as empty", async () => {
  const logs: string[] = [];
  const found = await hasConflictEscalationComment({
    repo: "owner/repo",
    issueNumber: 1653,
    marker: conflictEscalationMarker("k1"),
    ghCommandFn: () => Promise.resolve("{}"),
    log: (m) => logs.push(m),
  });
  assertEquals(found, false);
  assert(logs.length > 0, "the unreadable answer is not swallowed");
});
