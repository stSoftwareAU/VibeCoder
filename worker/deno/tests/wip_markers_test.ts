/**
 * The WIP marker vocabulary (Issue #148).
 *
 * These predicates decide whether a branch carries only parked work (so a
 * PR must not be raised from it) and whether a released claim's resume
 * pointer survives (so the preserved work can actually be resumed).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  describesPreservedWip,
  isWipCommitSubject,
  isWipOnlyRange,
  WIP_CHECKPOINT_COMMIT_PREFIX,
  WIP_PRESERVED_RELEASE_MARKER,
  WIP_TIMEOUT_COMMIT_PREFIX,
} from "../lib/wip_markers.ts";
import { WIP_CHECKPOINT_COMMIT_MESSAGE } from "../lib/wip_checkpoint.ts";

Deno.test("wip markers #148 - the periodic checkpoint message is a WIP subject", () => {
  assert(isWipCommitSubject(WIP_CHECKPOINT_COMMIT_MESSAGE));
  assert(
    WIP_CHECKPOINT_COMMIT_MESSAGE.startsWith(WIP_CHECKPOINT_COMMIT_PREFIX),
  );
});

Deno.test("wip markers #148 - the timeout preservation subject is a WIP subject", () => {
  assert(
    isWipCommitSubject(
      `${WIP_TIMEOUT_COMMIT_PREFIX} execute timed out after 1800s at the ` +
        `cycle deadline — preserving 4 uncommitted file(s) (Issue #47)`,
    ),
  );
  // Leading whitespace and casing must not defeat the match.
  assert(isWipCommitSubject("  WIP: parked halfway"));
});

Deno.test("wip markers #148 - a real commit subject is not a WIP subject", () => {
  for (
    const subject of [
      "Add the claim-runway floor (Issue #47)",
      "Fix the wiper blade telemetry", // 'wip' as a substring, not the prefix
      "docs: describe WIP checkpoints",
      "",
    ]
  ) {
    assertFalse(isWipCommitSubject(subject), subject);
  }
});

Deno.test("wip markers #148 - a range of only WIP commits is WIP-only", () => {
  assert(isWipOnlyRange([
    `${WIP_TIMEOUT_COMMIT_PREFIX} execute timed out after 900s`,
    WIP_CHECKPOINT_COMMIT_MESSAGE,
  ]));
});

Deno.test("wip markers #148 - one real commit makes the range not WIP-only", () => {
  assertFalse(isWipOnlyRange([
    WIP_CHECKPOINT_COMMIT_MESSAGE,
    "Implement the parser (Issue #99)",
  ]));
});

Deno.test("wip markers #148 - an empty range is not WIP-only", () => {
  assertEquals(isWipOnlyRange([]), false);
  assertEquals(isWipOnlyRange(["", "   "]), false);
});

Deno.test("wip markers #148 - a preserved-WIP failure reason is recognised", () => {
  assert(
    describesPreservedWip(
      `Claude timed out with uncommitted changes (3 files) — ` +
        `${WIP_PRESERVED_RELEASE_MARKER} committed and pushed to 'issue-1-x'`,
    ),
  );
});

Deno.test("wip markers #148 - a failed preservation is NOT a preserved-WIP reason", () => {
  assertFalse(
    describesPreservedWip(
      "Claude timed out with uncommitted changes (3 files) — WIP " +
        "preservation failed (push rejected) — uncommitted work remains " +
        "only in the local clone (Issue #47)",
    ),
  );
  assertFalse(describesPreservedWip(undefined));
  assertFalse(describesPreservedWip("Quality checks failed"));
});
