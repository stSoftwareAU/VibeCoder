/**
 * Tests for WIP-marker commit recognition (Issue #148).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  isWipCommitSubject,
  isWipOnlyCommitLog,
} from "../lib/wip_commit_marker.ts";
import {
  buildTimedOutWipCommitMessage,
  WIP_CHECKPOINT_COMMIT_MESSAGE,
} from "../lib/wip_checkpoint.ts";

Deno.test("wip_commit_marker - recognises both worker-authored WIP subjects", () => {
  // The two messages the worker actually writes must be recognised — this is
  // the drift guard between the builders and the completion gate.
  assertEquals(isWipCommitSubject(WIP_CHECKPOINT_COMMIT_MESSAGE), true);
  assertEquals(
    isWipCommitSubject(
      buildTimedOutWipCommitMessage({ elapsedSeconds: 1800, dirtyFiles: 7 }),
    ),
    true,
  );
  assertEquals(
    isWipCommitSubject(
      buildTimedOutWipCommitMessage({ elapsedSeconds: 900, dirtyFiles: 1 }),
    ),
    true,
  );
  // Branches cut before Issue #420 still carry the truncated-run subject, and
  // the completion gate must keep recognising it as parked work.
  assertEquals(
    isWipCommitSubject(
      "wip: execute timed out after 900s at the cycle deadline — preserving " +
        "1 uncommitted file(s) (Issue #47)",
    ),
    true,
  );
});

Deno.test("wip_commit_marker - real work is never mistaken for a WIP marker", () => {
  assertEquals(isWipCommitSubject("Fix the date parser (Issue #148)"), false);
  // A word starting with "wip" is not the marker.
  assertEquals(isWipCommitSubject("Wipe out the stale cache"), false);
  // The marker only counts at the start of the subject.
  assertEquals(isWipCommitSubject("Squash the wip: commits"), false);
  assertEquals(isWipCommitSubject(""), false);
});

Deno.test("wip_commit_marker - isWipOnlyCommitLog needs at least one real commit to pass", () => {
  assertEquals(
    isWipOnlyCommitLog([
      "wip: execute timed out after 1800s — preserving 4 uncommitted file(s)",
      WIP_CHECKPOINT_COMMIT_MESSAGE,
    ]),
    true,
  );
  assertEquals(
    isWipOnlyCommitLog([
      WIP_CHECKPOINT_COMMIT_MESSAGE,
      "Add the claim-runway floor (Issue #47)",
    ]),
    false,
  );
  // Empty input is the zero-commits-ahead case, which has its own guard.
  assertEquals(isWipOnlyCommitLog([]), false);
  assertEquals(isWipOnlyCommitLog(["  ", ""]), false);
});
