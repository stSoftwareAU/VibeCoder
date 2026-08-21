/**
 * Session ids must be UUIDs the Claude CLI accepts (Issue #204).
 *
 * The CLI validates `--session-id` as a UUID and refuses anything else with
 * "Error: Invalid session ID. Must be a valid UUID." The worker generated
 * `<repo>-<issue>-<timestamp>` instead, so every planning draft/publish call
 * died 0.2 s after spawn and only the sessionless legacy retry did any work.
 *
 * Covers the three surfaces the fix touches:
 *  - `generateSessionId()` / `createSessionResumeState()` emit real UUIDs;
 *  - `isValidSessionId()` rejects the old format;
 *  - persisted resume state carrying an old-format id loads without it, so
 *    the next attempt never passes `--resume` with a doomed id.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  assert,
  assertEquals,
  assertMatch,
  assertNotEquals,
} from "@std/assert";
import {
  buildSessionResumeArgs,
  buildSessionResumeFlags,
  createSessionResumeState,
  generateSessionId,
  isValidSessionId,
} from "../lib/session_resume.ts";
import {
  loadResumeState,
  resumeStatePath,
  saveResumeState,
} from "../lib/resume_state_store.ts";

/** The shape the Claude CLI accepts: a canonical RFC 4122 UUID. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

Deno.test("generateSessionId - produces a UUID the Claude CLI accepts (Issue #204)", () => {
  assertMatch(generateSessionId(), UUID_RE);
});

Deno.test("generateSessionId - each call produces a distinct id (Issue #204)", () => {
  assertNotEquals(generateSessionId(), generateSessionId());
});

Deno.test("createSessionResumeState - session id is a UUID, phase count zero (Issue #204)", () => {
  const state = createSessionResumeState();
  assertMatch(state.sessionId, UUID_RE);
  assertEquals(state.phaseCount, 0);
});

Deno.test("session resume args - the first phase passes a UUID to --session-id (Issue #204)", () => {
  const state = createSessionResumeState();
  const args = buildSessionResumeArgs(buildSessionResumeFlags(state));
  assertEquals(args[0], "--session-id");
  assertMatch(args[1] ?? "", UUID_RE);
  assertEquals(args.length, 2);
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

Deno.test("isValidSessionId - accepts a generated id, rejects the old format (Issue #204)", () => {
  assert(isValidSessionId(generateSessionId()));
  // The exact id the live worker sent, which the CLI refused.
  assert(!isValidSessionId("stSoftwareAU-VibeCoder-193-1755744446000"));
  assert(!isValidSessionId(""));
  assert(!isValidSessionId("not-a-uuid"));
  // Right shape, wrong characters.
  assert(!isValidSessionId("zzzzzzzz-zzzz-4zzz-8zzz-zzzzzzzzzzzz"));
});

// ---------------------------------------------------------------------------
// Persisted state carrying an old-format id
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "loadResumeState - drops an old-format session id but keeps the branch (Issue #204)",
  permissions: { read: true, write: true },
  async fn() {
    const workDir = await Deno.makeTempDir({ prefix: "resume_uuid_204_" });
    try {
      await saveResumeState(workDir, "owner/repo", 42, {
        sessionId: "owner-repo-42-1755744446000",
        phaseCount: 2,
        branch: "issue-42-thing",
      });

      const loaded = await loadResumeState(workDir, "owner/repo", 42);
      assert(loaded !== null, "the branch checkpoint must still be resumable");
      // No session id survives, so the next attempt cannot pass --resume with
      // an id the CLI will refuse.
      assertEquals(loaded.sessionId, undefined);
      assertEquals(loaded.branch, "issue-42-thing");
      assertEquals(loaded.phaseCount, 2);
    } finally {
      await Deno.remove(workDir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name: "loadResumeState - a UUID session id round-trips intact (Issue #204)",
  permissions: { read: true, write: true },
  async fn() {
    const workDir = await Deno.makeTempDir({ prefix: "resume_uuid_204_" });
    try {
      const sessionId = generateSessionId();
      await saveResumeState(workDir, "owner/repo", 7, {
        sessionId,
        phaseCount: 1,
        branch: "issue-7-thing",
      });

      const loaded = await loadResumeState(workDir, "owner/repo", 7);
      assert(loaded !== null);
      assertEquals(loaded.sessionId, sessionId);
      assert(resumeStatePath(workDir, "owner/repo", 7).endsWith("-7.json"));
    } finally {
      await Deno.remove(workDir, { recursive: true }).catch(() => {});
    }
  },
});
