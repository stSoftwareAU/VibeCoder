/**
 * Tests for WIP-marker commit recognition (Issue #148).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  isWipCommitSubject,
  isWipOnlyCommitLog,
} from "../lib/wip_commit_marker.ts";
import {
  buildInterruptedWipCommitMessage,
  WIP_CHECKPOINT_COMMIT_MESSAGE,
  type WipPreservationCause,
} from "../lib/wip_checkpoint.ts";

/** Every cause the one-shot preservation builds a subject for. */
const CAUSES: readonly WipPreservationCause[] = [
  "timed-out",
  "killed",
  "external-sigterm",
  "scheduled-release",
];

Deno.test("wip_commit_marker - recognises every worker-authored WIP subject", () => {
  // The messages the worker actually writes must be recognised — this is the
  // drift guard between the builders and the completion gate.
  assertEquals(isWipCommitSubject(WIP_CHECKPOINT_COMMIT_MESSAGE), true);
  for (const cause of CAUSES) {
    assertEquals(
      isWipCommitSubject(
        buildInterruptedWipCommitMessage({
          cause,
          elapsedSeconds: 1800,
          dirtyFiles: 7,
        }),
      ),
      true,
      `subject for '${cause}' must still read as parked work`,
    );
  }
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

Deno.test("wip_commit_marker - the subject names the cause, never a timeout the run did not have (Issue #424)", () => {
  const scheduled = buildInterruptedWipCommitMessage({
    cause: "scheduled-release",
    elapsedSeconds: 10800,
    dirtyFiles: 3,
  });
  assertStringIncludes(scheduled, "released on schedule");
  assertStringIncludes(scheduled, "run hard cap");
  assertStringIncludes(scheduled, "after 10800s");
  assertStringIncludes(scheduled, "preserving 3 uncommitted file(s)");
  assertEquals(scheduled.includes("timed out"), false);
  // Nothing may assert the cycle deadline bounded a run it did not bound
  // (Issue #420 removed the truncation that made that true).
  assertEquals(scheduled.includes("at the cycle deadline"), false);

  const killed = buildInterruptedWipCommitMessage({
    cause: "killed",
    elapsedSeconds: 539,
    dirtyFiles: 1,
  });
  assertStringIncludes(killed, "was killed (SIGKILL, no watchdog)");
  assertEquals(killed.includes("timed out"), false);

  const external = buildInterruptedWipCommitMessage({
    cause: "external-sigterm",
    elapsedSeconds: 120,
    dirtyFiles: 2,
  });
  assertStringIncludes(external, "external SIGTERM");
  assertEquals(external.includes("timed out"), false);

  // A genuine timeout keeps the wording it has always had.
  assertEquals(
    buildInterruptedWipCommitMessage({
      cause: "timed-out",
      elapsedSeconds: 3600,
      dirtyFiles: 4,
    }),
    "wip: execute timed out after 3600s — preserving 4 uncommitted " +
      "file(s) (Issue #47)",
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
