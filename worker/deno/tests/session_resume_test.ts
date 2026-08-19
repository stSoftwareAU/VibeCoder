/**
 * Tests for session resume support (Issue #1324).
 *
 * Covers:
 * - Session ID generation (deterministic, sanitised)
 * - Session state creation and phase tracking
 * - CLI flag construction (first phase vs subsequent phases)
 * - Edge cases (disabled feature, zero phases, special characters)
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertMatch, assertNotEquals } from "@std/assert";
import {
  buildSessionResumeArgs,
  buildSessionResumeFlags,
  createSessionResumeState,
  generateSessionId,
  recordPhaseCompletion,
  type SessionResumeState,
} from "../lib/session_resume.ts";

// =============================================================================
// Session ID generation
// =============================================================================

Deno.test("generateSessionId - produces deterministic ID with fixed timestamp", () => {
  const id1 = generateSessionId("owner/repo", 42, 1700000000000);
  const id2 = generateSessionId("owner/repo", 42, 1700000000000);
  assertEquals(id1, id2);
});

Deno.test("generateSessionId - includes repo name, issue number, and timestamp", () => {
  const id = generateSessionId("owner/repo", 42, 1700000000000);
  assertEquals(id, "owner-repo-42-1700000000000");
});

Deno.test("generateSessionId - sanitises special characters in repo name", () => {
  const id = generateSessionId("my.org/my_repo", 7, 1000);
  assertEquals(id, "my-org-my-repo-7-1000");
});

Deno.test("generateSessionId - different issue numbers produce different IDs", () => {
  const id1 = generateSessionId("owner/repo", 1, 1000);
  const id2 = generateSessionId("owner/repo", 2, 1000);
  assertNotEquals(id1, id2);
});

Deno.test("generateSessionId - different timestamps produce different IDs", () => {
  const id1 = generateSessionId("owner/repo", 42, 1000);
  const id2 = generateSessionId("owner/repo", 42, 2000);
  assertNotEquals(id1, id2);
});

Deno.test("generateSessionId - uses Date.now() when no timestamp provided", () => {
  const before = Date.now();
  const id = generateSessionId("owner/repo", 42);
  const after = Date.now();

  // ID should contain a timestamp between before and after
  const match = id.match(/owner-repo-42-(\d+)/);
  assertEquals(match !== null, true);
  const ts = parseInt(match![1]!, 10);
  assertEquals(ts >= before, true);
  assertEquals(ts <= after, true);
});

Deno.test("generateSessionId - produces CLI-safe characters only", () => {
  const id = generateSessionId("owner/repo.special", 42, 1000);
  // Should only contain alphanumeric characters and hyphens
  assertMatch(id, /^[a-zA-Z0-9-]+$/);
});

// =============================================================================
// Session state creation
// =============================================================================

Deno.test("createSessionResumeState - initialises with zero phase count", () => {
  const state = createSessionResumeState("owner/repo", 42, 1000);
  assertEquals(state.phaseCount, 0);
});

Deno.test("createSessionResumeState - generates session ID from params", () => {
  const state = createSessionResumeState("owner/repo", 42, 1000);
  assertEquals(state.sessionId, "owner-repo-42-1000");
});

// =============================================================================
// CLI flag construction
// =============================================================================

Deno.test("buildSessionResumeFlags - first phase returns sessionId without resume", () => {
  const state: SessionResumeState = { sessionId: "test-123", phaseCount: 0 };
  const flags = buildSessionResumeFlags(state);
  assertEquals(flags.sessionId, "test-123");
  assertEquals(flags.resume, false);
});

Deno.test("buildSessionResumeFlags - subsequent phase returns sessionId with resume", () => {
  const state: SessionResumeState = { sessionId: "test-123", phaseCount: 1 };
  const flags = buildSessionResumeFlags(state);
  assertEquals(flags.sessionId, "test-123");
  assertEquals(flags.resume, true);
});

Deno.test("buildSessionResumeFlags - third phase also returns resume", () => {
  const state: SessionResumeState = { sessionId: "test-123", phaseCount: 2 };
  const flags = buildSessionResumeFlags(state);
  assertEquals(flags.resume, true);
});

Deno.test("buildSessionResumeFlags - undefined state returns empty flags", () => {
  const flags = buildSessionResumeFlags(undefined);
  assertEquals(flags.sessionId, undefined);
  assertEquals(flags.resume, false);
});

// =============================================================================
// Phase completion tracking
// =============================================================================

Deno.test("recordPhaseCompletion - increments phase count", () => {
  const state: SessionResumeState = { sessionId: "test-123", phaseCount: 0 };
  const updated = recordPhaseCompletion(state);
  assertEquals(updated.phaseCount, 1);
});

Deno.test("recordPhaseCompletion - preserves session ID", () => {
  const state: SessionResumeState = { sessionId: "test-123", phaseCount: 0 };
  const updated = recordPhaseCompletion(state);
  assertEquals(updated.sessionId, "test-123");
});

Deno.test("recordPhaseCompletion - does not mutate original state", () => {
  const state: SessionResumeState = { sessionId: "test-123", phaseCount: 0 };
  const updated = recordPhaseCompletion(state);
  assertEquals(state.phaseCount, 0);
  assertEquals(updated.phaseCount, 1);
});

Deno.test("recordPhaseCompletion - increments from non-zero", () => {
  const state: SessionResumeState = { sessionId: "test-123", phaseCount: 3 };
  const updated = recordPhaseCompletion(state);
  assertEquals(updated.phaseCount, 4);
});

// =============================================================================
// CLI argument building
// =============================================================================

Deno.test("buildSessionResumeArgs - first phase produces only --session-id args", () => {
  const flags = { sessionId: "test-123", resume: false };
  const args = buildSessionResumeArgs(flags);
  assertEquals(args, ["--session-id", "test-123"]);
});

Deno.test("buildSessionResumeArgs - subsequent phase includes --resume", () => {
  const flags = { sessionId: "test-123", resume: true };
  const args = buildSessionResumeArgs(flags);
  assertEquals(args, ["--session-id", "test-123", "--resume"]);
});

Deno.test("buildSessionResumeArgs - no sessionId produces empty args", () => {
  const flags = { resume: false };
  const args = buildSessionResumeArgs(flags);
  assertEquals(args, []);
});

Deno.test("buildSessionResumeArgs - resume without sessionId produces only --resume", () => {
  const flags = { resume: true };
  const args = buildSessionResumeArgs(flags);
  assertEquals(args, ["--resume"]);
});

// =============================================================================
// Integration: full lifecycle
// =============================================================================

Deno.test("session resume lifecycle - first phase then subsequent phase", () => {
  // Create initial state
  const state = createSessionResumeState("org/my-app", 99, 1700000000000);
  assertEquals(state.phaseCount, 0);

  // First phase: should get session-id only
  const firstFlags = buildSessionResumeFlags(state);
  const firstArgs = buildSessionResumeArgs(firstFlags);
  assertEquals(firstArgs, ["--session-id", "org-my-app-99-1700000000000"]);

  // Record completion of first phase
  const afterFirst = recordPhaseCompletion(state);
  assertEquals(afterFirst.phaseCount, 1);

  // Second phase: should get session-id AND resume
  const secondFlags = buildSessionResumeFlags(afterFirst);
  const secondArgs = buildSessionResumeArgs(secondFlags);
  assertEquals(secondArgs, [
    "--session-id",
    "org-my-app-99-1700000000000",
    "--resume",
  ]);

  // Record completion of second phase
  const afterSecond = recordPhaseCompletion(afterFirst);
  assertEquals(afterSecond.phaseCount, 2);

  // Third phase: still has resume
  const thirdFlags = buildSessionResumeFlags(afterSecond);
  assertEquals(thirdFlags.resume, true);
});
