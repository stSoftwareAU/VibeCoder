/**
 * Tests for `isExpectedSkipResult` (Issue #175).
 *
 * The main loop uses this to decide whether an unsuccessful run cools the
 * issue down quietly (skip) or trips failure tracking, the circuit breaker
 * and the repo-failure record (failure). A merged-PR pre-check that cannot
 * close an issue whose merge never landed must land on the skip side: it is
 * neither a success (which made the scan forget the issue and re-claim it
 * seconds later) nor a fault of the repo.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { isExpectedSkipResult } from "../lib/issue_worker_types.ts";

Deno.test("isExpectedSkipResult - a phase-declared bounce is a skip", () => {
  assertEquals(
    isExpectedSkipResult({
      success: false,
      phase: "merged_pr_precheck",
      reason:
        "merged_pr_did_not_land: PR #27 merged but its change did not land",
      expectedSkip: true,
    }),
    true,
  );
});

Deno.test("isExpectedSkipResult - claim rejections stay skips", () => {
  assertEquals(
    isExpectedSkipResult({
      success: false,
      phase: "setup",
      reason: "Issue not available: already assigned",
    }),
    true,
  );
  assertEquals(
    isExpectedSkipResult({
      success: false,
      phase: "setup",
      reason: "claim_churn_escalation",
    }),
    true,
  );
});

Deno.test("isExpectedSkipResult - a genuine failure is not a skip", () => {
  assertEquals(
    isExpectedSkipResult({
      success: false,
      phase: "quality_gate",
      reason: "quality.sh exited 1",
    }),
    false,
  );
  // A pre-check bounce that did NOT set the flag is not silently skipped.
  assertEquals(
    isExpectedSkipResult({
      success: false,
      phase: "merged_pr_precheck",
      reason: "merged_pr_did_not_land: something",
    }),
    false,
  );
});

Deno.test("isExpectedSkipResult - a successful run is never a skip", () => {
  assertEquals(
    isExpectedSkipResult({
      success: true,
      phase: "merged_pr_precheck",
      reason: "pr_already_merged",
      expectedSkip: true,
    }),
    false,
  );
});
