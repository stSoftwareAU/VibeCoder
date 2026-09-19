/**
 * Tests for the per-run processed-issue registry (Issue #181).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  isClaimDeferral,
  ProcessedIssueRegistry,
  resetSharedProcessedIssues,
  sharedProcessedIssues,
  withholdsFromIdleDetection,
} from "../lib/processed_issue_registry.ts";

Deno.test("processed registry - records and recalls an issue", () => {
  const registry = new ProcessedIssueRegistry();
  assertFalse(registry.has("o/r", 21));

  registry.record("o/r", 21, "success");

  assert(registry.has("o/r", 21));
  assertEquals(registry.reasonFor("o/r", 21), "success");
  assertEquals(registry.size(), 1);
});

Deno.test("processed registry - other issues are unaffected", () => {
  const registry = new ProcessedIssueRegistry();
  registry.record("o/r", 21, "success");

  assertFalse(registry.has("o/r", 22));
  assertFalse(registry.has("o/other", 21));
});

Deno.test("processed registry - repo matching is case-insensitive", () => {
  const registry = new ProcessedIssueRegistry();
  registry.record("stSoftwareAU/NEAT-AI-Forests", 21, "closed");

  assert(registry.has("stsoftwareau/neat-ai-forests", 21));
  assert(registry.wasClosedByWorker("STSOFTWAREAU/NEAT-AI-FORESTS", 21));
});

Deno.test("processed registry - a close is never downgraded by a later outcome", () => {
  const registry = new ProcessedIssueRegistry();
  registry.record("o/r", 21, "closed");
  registry.record("o/r", 21, "success");

  assertEquals(registry.reasonFor("o/r", 21), "closed");
  assert(registry.wasClosedByWorker("o/r", 21));
});

Deno.test("processed registry - a non-close outcome is upgraded by a close", () => {
  const registry = new ProcessedIssueRegistry();
  registry.record("o/r", 21, "failure");
  assertFalse(registry.wasClosedByWorker("o/r", 21));

  registry.record("o/r", 21, "closed");
  assert(registry.wasClosedByWorker("o/r", 21));
});

Deno.test("processed registry - forget drops the entry (reopened issue)", () => {
  const registry = new ProcessedIssueRegistry();
  registry.record("o/r", 21, "closed");

  registry.forget("O/R", 21);

  assertFalse(registry.has("o/r", 21));
  assertEquals(registry.size(), 0);
});

Deno.test("processed registry - list reports every entry", () => {
  const registry = new ProcessedIssueRegistry();
  registry.record("o/r", 1, "success");
  registry.record("o/r", 2, "skip");

  const entries = registry.list();
  assertEquals(entries.length, 2);
  assertEquals(entries.map((e) => e.issueNumber).sort(), [1, 2]);
});

Deno.test("processed registry - shared instance is process-wide and resettable", () => {
  resetSharedProcessedIssues();
  sharedProcessedIssues().record("o/r", 99, "closed");

  assert(sharedProcessedIssues().wasClosedByWorker("o/r", 99));

  resetSharedProcessedIssues();
  assertFalse(sharedProcessedIssues().has("o/r", 99));
});

// =============================================================================
// Why a hold exists (Issue #2405)
//
// A skip puts an issue on hold for the rest of the run. "We ran it" and "the
// claim path would not let us run it" were the same record, so the idle census
// could not tell a finished run from a day of stream-affinity deferrals.
// =============================================================================

Deno.test("ProcessedIssueRegistry - a skip remembers the claim refusal that caused it (Issue #2405)", () => {
  const registry = new ProcessedIssueRegistry();
  registry.record("org/repo", 1, "skip", { claimRefusal: "stream_affinity" });
  registry.record("org/repo", 2, "skip");
  registry.record("org/repo", 3, "success");

  assertEquals(registry.claimRefusalFor("org/repo", 1), "stream_affinity");
  assertEquals(registry.claimRefusalFor("org/repo", 2), undefined);
  assertEquals(registry.claimRefusalFor("org/repo", 3), undefined);
  assertEquals(registry.claimRefusalFor("org/repo", 99), undefined);
});

Deno.test("ProcessedIssueRegistry - a later outcome replaces the refusal; it is not a permanent mark (Issue #2405)", () => {
  const registry = new ProcessedIssueRegistry();
  registry.record("org/repo", 1, "skip", { claimRefusal: "stream_affinity" });
  registry.record("org/repo", 1, "success");
  assertEquals(registry.claimRefusalFor("org/repo", 1), undefined);
});

Deno.test("isClaimDeferral - only a refusal that leaves the issue with nobody working it (Issue #2405)", () => {
  assertEquals(isClaimDeferral("stream_affinity"), true);
  // Someone else IS working these: a healthy fleet, never an inversion.
  for (
    const reason of ["already_assigned", "stream_busy", "recent_claim", "other"]
  ) {
    assertEquals(isClaimDeferral(reason), false, reason);
  }
  assertEquals(isClaimDeferral(undefined), false);
});

Deno.test("withholdsFromIdleDetection - a hold hides an issue from the idle detectors unless the claim path deferred it (Issue #2405)", () => {
  const registry = new ProcessedIssueRegistry();
  registry.record("org/repo", 1, "skip", { claimRefusal: "stream_affinity" });
  registry.record("org/repo", 2, "skip", { claimRefusal: "stream_busy" });
  registry.record("org/repo", 3, "failure");
  const held = () => true;

  // Deferred: nobody is working it, so the detectors must go on seeing it.
  assertEquals(
    withholdsFromIdleDetection(registry, held, "org/repo", 1),
    false,
  );
  // A sibling holds the stream, and a run that failed: legitimate holds.
  assertEquals(withholdsFromIdleDetection(registry, held, "org/repo", 2), true);
  assertEquals(withholdsFromIdleDetection(registry, held, "org/repo", 3), true);
  // Not held at all is not withheld, whatever the registry says.
  assertEquals(
    withholdsFromIdleDetection(registry, () => false, "org/repo", 2),
    false,
  );
});
