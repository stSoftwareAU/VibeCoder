/**
 * Tests for the stale-verdict ladder state model (Issue #2276, parent #2272).
 *
 * The ladder's whole safety property is "each rung runs at most once per head
 * sha": NEAT-AI-Lamarck#239 looped because a rung's own output was read back
 * as a reason to run it again. These tests drive the reader and the decision
 * the way the scan will — decide, append the rung's marker, decide again —
 * and assert the second decision is never the first one.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assertEquals, assertThrows } from "@std/assert";
import type { Logger } from "../types.ts";
import {
  CONFLICT_ATTEMPT_MARKER,
  CONFLICT_FAILED_MARKER,
  CONFLICT_RESOLVED_MARKER,
  conflictNudgeMarker,
  conflictRebaseMarker,
  conflictRungFailedMarker,
} from "../lib/merge_conflict_markers.ts";
import {
  decideLadderRung,
  type LadderState,
  parseLadderState,
} from "../lib/conflict_verdict_ladder.ts";
import { parseConflictAttempts } from "../lib/pr_merge_conflict_scan.ts";

const OLD_HEAD = "094a66ad4f1b0c9d3e2a5b6c7d8e9f0a1b2c3d4e";
const NEW_HEAD = "fbe95ed1122334455667788990aabbccddeeff00";
const THIRD_HEAD = "abc1234def5678901234567890abcdef12345678";

function comment(body: string, createdAt?: string): unknown {
  return createdAt === undefined ? { body } : { body, created_at: createdAt };
}

/** A logger that records only what the reader warns about. */
function recordingLogger(): { logger: Logger; warnings: string[] } {
  const warnings: string[] = [];
  const logger = {
    info() {},
    warn(message: string) {
      warnings.push(message);
    },
    error() {},
    debug() {},
    security() {},
    skipReason() {},
    timing() {},
    scanSummary() {},
  } as unknown as Logger;
  return { logger, warnings };
}

// ---------------------------------------------------------------------------
// Markers
// ---------------------------------------------------------------------------

Deno.test("marker builders use the canonical vibe-* grammar", () => {
  assertEquals(
    conflictNudgeMarker(OLD_HEAD),
    `<!-- vibe-merge-conflict-nudge head="${OLD_HEAD}" -->`,
  );
  assertEquals(
    conflictRebaseMarker(OLD_HEAD, NEW_HEAD),
    `<!-- vibe-merge-conflict-rebase old="${OLD_HEAD}" new="${NEW_HEAD}" -->`,
  );
  assertEquals(
    conflictRungFailedMarker("rebase", OLD_HEAD),
    `<!-- vibe-merge-conflict-rung-failed rung="rebase" head="${OLD_HEAD}" -->`,
  );
});

Deno.test("marker builders refuse a sha they cannot write back", () => {
  assertThrows(() => conflictNudgeMarker("not-a-sha"));
  assertThrows(() => conflictNudgeMarker(""));
  assertThrows(() => conflictRebaseMarker(OLD_HEAD, "zzzzzzz"));
  assertThrows(() => conflictRungFailedMarker("abandon", "094a66"));
});

// ---------------------------------------------------------------------------
// parseLadderState
// ---------------------------------------------------------------------------

Deno.test("parseLadderState - reads one marker of each kind", () => {
  const state = parseLadderState([
    comment(`nudged\n${conflictNudgeMarker(OLD_HEAD)}`),
    comment(`rebased\n${conflictRebaseMarker(OLD_HEAD, NEW_HEAD)}`),
    comment(conflictRungFailedMarker("rebase", NEW_HEAD)),
  ]);

  assertEquals(state, {
    nudgedHead: OLD_HEAD,
    rebasedHead: NEW_HEAD,
    rungFailedAtHead: { rung: "rebase", head: NEW_HEAD },
  });
});

Deno.test("parseLadderState - an empty thread is an empty state", () => {
  assertEquals(parseLadderState([]), {});
  assertEquals(parseLadderState([null, 42, { body: 7 }, comment("hi")]), {});
});

Deno.test("parseLadderState - the latest marker of each kind wins", () => {
  const state = parseLadderState([
    comment(conflictNudgeMarker(OLD_HEAD)),
    comment(conflictRungFailedMarker("rebase", OLD_HEAD)),
    comment(conflictNudgeMarker(NEW_HEAD)),
    comment(conflictRebaseMarker(OLD_HEAD, NEW_HEAD)),
    comment(conflictRebaseMarker(NEW_HEAD, THIRD_HEAD)),
    comment(conflictRungFailedMarker("abandon", THIRD_HEAD)),
  ]);

  assertEquals(state, {
    nudgedHead: NEW_HEAD,
    rebasedHead: THIRD_HEAD,
    rungFailedAtHead: { rung: "abandon", head: THIRD_HEAD },
  });
});

Deno.test("parseLadderState - a resolved marker resets the ladder", () => {
  const state = parseLadderState([
    comment(conflictNudgeMarker(OLD_HEAD)),
    comment(conflictRebaseMarker(OLD_HEAD, NEW_HEAD)),
    comment(conflictRungFailedMarker("rebase", NEW_HEAD)),
    comment(`✅ merged\n${CONFLICT_RESOLVED_MARKER}`),
  ]);

  assertEquals(state, {});
});

Deno.test("parseLadderState - markers after a reset are read again", () => {
  const state = parseLadderState([
    comment(conflictNudgeMarker(OLD_HEAD)),
    comment(CONFLICT_RESOLVED_MARKER),
    comment(conflictNudgeMarker(THIRD_HEAD)),
  ]);

  assertEquals(state, { nudgedHead: THIRD_HEAD });
});

Deno.test("parseLadderState - a malformed sha is ignored and warned about", () => {
  const { logger, warnings } = recordingLogger();
  const state = parseLadderState([
    comment(conflictNudgeMarker(OLD_HEAD)),
    comment('<!-- vibe-merge-conflict-nudge head="../../etc/passwd" -->'),
    comment('<!-- vibe-merge-conflict-rebase old="094a66ad" new="nope" -->'),
    comment('<!-- vibe-merge-conflict-rung-failed rung="rebase" head="" -->'),
    comment("<!-- vibe-merge-conflict-nudge -->"),
  ], { logger });

  // The good marker still stands; nothing malformed reached the state.
  assertEquals(state, { nudgedHead: OLD_HEAD });
  assertEquals(warnings.length, 4);
});

Deno.test("parseLadderState - an unknown rung name is ignored", () => {
  const { logger, warnings } = recordingLogger();
  const state = parseLadderState([
    comment(
      `<!-- vibe-merge-conflict-rung-failed rung="nudge" head="${OLD_HEAD}" -->`,
    ),
  ], { logger });

  assertEquals(state, {});
  assertEquals(warnings.length, 1);
});

Deno.test("parseLadderState - the ladder markers do not cross-read each other", () => {
  // The rung-failed marker's name contains neither of the other two, and the
  // frozen `vibe-coder:` attempt vocabulary contains none of the three.
  const state = parseLadderState([
    comment(`${CONFLICT_ATTEMPT_MARKER} n="1" -->`),
    comment(`${CONFLICT_FAILED_MARKER} n="1" -->`),
    comment(conflictRungFailedMarker("rebase", OLD_HEAD)),
  ]);

  assertEquals(state, { rungFailedAtHead: { rung: "rebase", head: OLD_HEAD } });
});

// ---------------------------------------------------------------------------
// decideLadderRung
// ---------------------------------------------------------------------------

Deno.test("decideLadderRung - a verdict that is neither CONFLICTING nor MERGEABLE waits", () => {
  const states: LadderState[] = [
    {},
    { nudgedHead: OLD_HEAD },
    { rebasedHead: OLD_HEAD },
    { rungFailedAtHead: { rung: "rebase", head: OLD_HEAD } },
    { rungFailedAtHead: { rung: "abandon", head: OLD_HEAD } },
  ];
  for (const state of states) {
    for (const mergeable of ["UNKNOWN", "", "pending", "conflicting?"]) {
      assertEquals(
        decideLadderRung({ state, currentHead: OLD_HEAD, mergeable }),
        { kind: "wait", reason: "verdict-unknown" },
        `verdict ${mergeable} must not drive a rung`,
      );
    }
  }
});

Deno.test("decideLadderRung - MERGEABLE is not this ladder's business", () => {
  assertEquals(
    decideLadderRung({
      state: { nudgedHead: OLD_HEAD },
      currentHead: OLD_HEAD,
      mergeable: "MERGEABLE",
    }),
    { kind: "not-conflicting" },
  );
});

Deno.test("decideLadderRung - an untouched head starts at the nudge", () => {
  assertEquals(
    decideLadderRung({
      state: {},
      currentHead: OLD_HEAD,
      mergeable: "CONFLICTING",
    }),
    { kind: "nudge" },
  );
});

Deno.test("decideLadderRung - a head no rung pushed starts the ladder over", () => {
  // Every marker names an older head: a human pushed to the branch, so the
  // ladder begins again rather than resuming at the abandon rung.
  assertEquals(
    decideLadderRung({
      state: {
        nudgedHead: OLD_HEAD,
        rebasedHead: NEW_HEAD,
        rungFailedAtHead: { rung: "rebase", head: NEW_HEAD },
      },
      currentHead: THIRD_HEAD,
      mergeable: "CONFLICTING",
    }),
    { kind: "nudge" },
  );
});

Deno.test("decideLadderRung - the ladder climbs one rung per head sha", () => {
  const thread: unknown[] = [];
  const decide = () =>
    decideLadderRung({
      state: parseLadderState(thread),
      currentHead: OLD_HEAD,
      mergeable: "CONFLICTING",
    });

  assertEquals(decide(), { kind: "nudge" });
  // The nudge records the head it produced — here the scan is reading that
  // same head back, because GitHub's verdict is still stale at it.
  thread.push(comment(conflictNudgeMarker(OLD_HEAD)));
  assertEquals(decide(), { kind: "rebase" });
  assertEquals(decide(), { kind: "rebase" }, "a re-scan is not a second rung");

  thread.push(comment(conflictRebaseMarker(OLD_HEAD, OLD_HEAD)));
  assertEquals(decide(), { kind: "abandon" });
  assertEquals(decide(), { kind: "abandon" });

  thread.push(comment(conflictRungFailedMarker("abandon", OLD_HEAD)));
  assertEquals(decide(), { kind: "wait", reason: "ladder-exhausted" });
});

Deno.test("decideLadderRung - a failed rebase rung is not retried at the same head", () => {
  assertEquals(
    decideLadderRung({
      state: {
        nudgedHead: OLD_HEAD,
        rungFailedAtHead: { rung: "rebase", head: OLD_HEAD },
      },
      currentHead: OLD_HEAD,
      mergeable: "CONFLICTING",
    }),
    { kind: "abandon" },
  );
});

Deno.test("decideLadderRung - a failed abandon rung ends the ladder at that head", () => {
  assertEquals(
    decideLadderRung({
      state: {
        nudgedHead: OLD_HEAD,
        rebasedHead: OLD_HEAD,
        rungFailedAtHead: { rung: "abandon", head: OLD_HEAD },
      },
      currentHead: OLD_HEAD,
      mergeable: "CONFLICTING",
    }),
    { kind: "wait", reason: "ladder-exhausted" },
  );
});

Deno.test("decideLadderRung - a sha that is not the head restarts the ladder", () => {
  // Heads are compared exactly, so an abbreviation is not a match. The ladder
  // then repeats the harmless rung rather than skipping to the destructive
  // one — the safe direction for a marker written from `--short` output.
  assertEquals(
    decideLadderRung({
      state: { rebasedHead: OLD_HEAD.slice(0, 7) },
      currentHead: OLD_HEAD,
      mergeable: "CONFLICTING",
    }),
    { kind: "nudge" },
  );
});

Deno.test("decideLadderRung - an unusable current head fails loud", () => {
  // A broken head lookup must not be returned as "GitHub is still computing",
  // which would hold the PR for ever on a caller fault.
  for (const currentHead of ["", "  ", "not-a-sha", "094a66"]) {
    assertThrows(
      () =>
        decideLadderRung({
          state: { nudgedHead: OLD_HEAD },
          currentHead,
          mergeable: "CONFLICTING",
        }),
      Error,
      "must be 7–40 hex characters",
    );
  }
});

// ---------------------------------------------------------------------------
// The attempt budget is untouched by the rungs
// ---------------------------------------------------------------------------

Deno.test("the ladder markers change no parseConflictAttempts count", () => {
  const withoutRungs: unknown[] = [
    comment(`${CONFLICT_ATTEMPT_MARKER} n="1" -->`, "2026-09-14T00:00:00Z"),
    comment(`${CONFLICT_FAILED_MARKER} n="1" -->`, "2026-09-14T00:05:00Z"),
    comment(`${CONFLICT_ATTEMPT_MARKER} n="2" -->`, "2026-09-15T00:00:00Z"),
  ];
  const withRungs: unknown[] = [
    comment(`${CONFLICT_ATTEMPT_MARKER} n="1" -->`, "2026-09-14T00:00:00Z"),
    comment(conflictNudgeMarker(OLD_HEAD), "2026-09-14T00:02:00Z"),
    comment(`${CONFLICT_FAILED_MARKER} n="1" -->`, "2026-09-14T00:05:00Z"),
    comment(conflictRebaseMarker(OLD_HEAD, NEW_HEAD), "2026-09-14T06:00:00Z"),
    comment(
      conflictRungFailedMarker("rebase", NEW_HEAD),
      "2026-09-14T07:00:00Z",
    ),
    comment(
      conflictRungFailedMarker("abandon", NEW_HEAD),
      "2026-09-14T08:00:00Z",
    ),
    comment(`${CONFLICT_ATTEMPT_MARKER} n="2" -->`, "2026-09-15T00:00:00Z"),
  ];

  assertEquals(
    parseConflictAttempts(withRungs),
    parseConflictAttempts(withoutRungs),
  );
  // …and the counts are the real ones, not two identical empties.
  assertEquals(parseConflictAttempts(withRungs), {
    count: 1,
    disruptedCount: 0,
    pendingAttempt: true,
    lastAttemptAt: "2026-09-15T00:00:00Z",
  });
});
