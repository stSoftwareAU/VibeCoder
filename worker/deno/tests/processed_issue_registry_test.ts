/**
 * Tests for the per-run processed-issue registry (Issue #181).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  ProcessedIssueRegistry,
  resetSharedProcessedIssues,
  sharedProcessedIssues,
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
