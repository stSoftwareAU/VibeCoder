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
  adoptProviderSession,
  buildSessionResumeArgs,
  buildSessionResumeFlags,
  codexResumeSessionId,
  createSessionResumeState,
  generateSessionId,
  isPersistableSessionId,
  recordPhaseCompletion,
  sessionResumeForProvider,
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

Deno.test("buildSessionResumeArgs - subsequent phase resumes by id, never pairing --session-id with --resume (Issue #1580)", () => {
  const flags = { sessionId: "test-123", resume: true };
  const args = buildSessionResumeArgs(flags);
  // Claude Code 2.1.261 refuses `--session-id X --resume` at start-up:
  // "--session-id can only be used with --continue or --resume if
  // --fork-session is also specified". `--resume <id>` is the continuation.
  assertEquals(args, ["--resume", "test-123"]);
  assertEquals(args.includes("--session-id"), false);
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

  // Second phase: resume the same id (Issue #1580)
  const secondFlags = buildSessionResumeFlags(afterFirst);
  const secondArgs = buildSessionResumeArgs(secondFlags);
  assertEquals(secondArgs, ["--resume", state.sessionId]);

  // Record completion of second phase
  const afterSecond = recordPhaseCompletion(afterFirst);
  assertEquals(afterSecond.phaseCount, 2);

  // Third phase: still has resume
  const thirdFlags = buildSessionResumeFlags(afterSecond);
  assertEquals(thirdFlags.resume, true);
});

// =============================================================================
// Codex / cross-provider session identity (Issue #1699)
// =============================================================================

Deno.test("adoptProviderSession - captures a Codex thread id without inventing one", () => {
  const state = createSessionResumeState();
  const adopted = adoptProviderSession(state, {
    sessionId: "thread-codex-1",
    providerId: "codex",
    credentialScope: "account-a",
  });
  assertEquals(adopted.sessionId, "thread-codex-1");
  assertEquals(adopted.providerId, "codex");
  assertEquals(adopted.credentialScope, "account-a");
  assertEquals(adopted.phaseCount, 0);
  assertEquals(state.sessionId !== "thread-codex-1", true);
});

Deno.test("adoptProviderSession - a missing capture leaves the worker UUID unlabelled", () => {
  const state = createSessionResumeState();
  const adopted = adoptProviderSession(state, { providerId: "codex" });
  assertEquals(adopted, state);
  assertEquals(adopted.providerId, undefined);
});

Deno.test("codexResumeSessionId - empty until a Codex run has reported an id", () => {
  assertEquals(codexResumeSessionId(undefined), undefined);
  assertEquals(
    codexResumeSessionId({
      sessionId: "uuid",
      phaseCount: 0,
      providerId: "codex",
    }),
    undefined,
  );
  assertEquals(
    codexResumeSessionId({ sessionId: "uuid", phaseCount: 1 }),
    undefined,
  );
  assertEquals(
    codexResumeSessionId({
      sessionId: "uuid",
      phaseCount: 1,
      providerId: "claude",
    }),
    undefined,
  );
  assertEquals(
    codexResumeSessionId({
      sessionId: "thread-1",
      phaseCount: 1,
      providerId: "codex",
    }),
    "thread-1",
  );
});

Deno.test("sessionResumeForProvider - refuses a cross-vendor id", () => {
  const codexState: SessionResumeState = {
    sessionId: "thread-1",
    phaseCount: 1,
    providerId: "codex",
  };
  assertEquals(sessionResumeForProvider(codexState, "codex"), codexState);
  assertEquals(sessionResumeForProvider(codexState, "claude"), undefined);
  const legacy: SessionResumeState = {
    sessionId: "6f1f2c0a-9b7d-4c3e-8a11-2b3c4d5e6f70",
    phaseCount: 1,
  };
  assertEquals(sessionResumeForProvider(legacy, "claude"), legacy);
  assertEquals(sessionResumeForProvider(legacy, "deepseek"), legacy);
  assertEquals(sessionResumeForProvider(legacy, "codex"), undefined);
});

Deno.test("isPersistableSessionId - Codex accepts a non-UUID thread id", () => {
  assertEquals(isPersistableSessionId("thread_abc", "codex"), true);
  assertEquals(isPersistableSessionId("", "codex"), false);
  assertEquals(isPersistableSessionId("thread_abc", "claude"), false);
  assertEquals(
    isPersistableSessionId("6f1f2c0a-9b7d-4c3e-8a11-2b3c4d5e6f70", "claude"),
    true,
  );
});
