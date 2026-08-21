/**
 * Tests for session resume support (Issue #1324).
 *
 * Covers:
 * - Session ID generation (a UUID the Claude CLI accepts — Issue #204)
 * - Session state creation and phase tracking
 * - CLI flag construction (first phase vs subsequent phases)
 * - Edge cases (disabled feature, zero phases)
 *
 * The `<repo>-<issue>-<timestamp>` id these tests once asserted was rejected
 * by the CLI ("Invalid session ID. Must be a valid UUID."), so the generation
 * tests now assert the UUID contract instead; see
 * `session_id_uuid_204_test.ts` for the full #204 coverage.
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

Deno.test("generateSessionId - every call produces a distinct ID", () => {
  const id1 = generateSessionId();
  const id2 = generateSessionId();
  assertNotEquals(id1, id2);
});

Deno.test("generateSessionId - produces CLI-safe characters only", () => {
  const id = generateSessionId();
  // Should only contain alphanumeric characters and hyphens
  assertMatch(id, /^[a-zA-Z0-9-]+$/);
});

// =============================================================================
// Session state creation
// =============================================================================

Deno.test("createSessionResumeState - initialises with zero phase count", () => {
  const state = createSessionResumeState();
  assertEquals(state.phaseCount, 0);
});

Deno.test("createSessionResumeState - generates a non-empty session ID", () => {
  const state = createSessionResumeState();
  assertNotEquals(state.sessionId, "");
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
  const state = createSessionResumeState();
  assertEquals(state.phaseCount, 0);

  // First phase: should get session-id only
  const firstFlags = buildSessionResumeFlags(state);
  const firstArgs = buildSessionResumeArgs(firstFlags);
  assertEquals(firstArgs, ["--session-id", state.sessionId]);

  // Record completion of first phase
  const afterFirst = recordPhaseCompletion(state);
  assertEquals(afterFirst.phaseCount, 1);

  // Second phase: should get session-id AND resume
  const secondFlags = buildSessionResumeFlags(afterFirst);
  const secondArgs = buildSessionResumeArgs(secondFlags);
  assertEquals(secondArgs, [
    "--session-id",
    state.sessionId,
    "--resume",
  ]);

  // Record completion of second phase
  const afterSecond = recordPhaseCompletion(afterFirst);
  assertEquals(afterSecond.phaseCount, 2);

  // Third phase: still has resume
  const thirdFlags = buildSessionResumeFlags(afterSecond);
  assertEquals(thirdFlags.resume, true);
});
