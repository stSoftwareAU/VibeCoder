/**
 * Tests for the per-stream session record (Issue #2332).
 *
 * The session id belongs to the (repository, stream) conversation, not to any
 * one issue: it outlives the issue that opened it, so it has no 24-hour expiry,
 * survives PR creation and claim release, and is never touched by the per-issue
 * sweep. One stream may hold one session per provider side by side.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  deleteResumeState,
  deleteStreamSession,
  loadResumeState,
  loadStreamSession,
  RESUME_STATE_MAX_AGE_MS,
  resumeStatePath,
  saveResumeState,
  saveStreamSession,
  streamSessionPath,
} from "../lib/resume_state_store.ts";
import { resolveStreamId } from "../lib/stream_identity.ts";

const REPO = "stSoftwareAU/VibeCoder";
const STREAM = resolveStreamId(REPO, "#2319 session resume on by default");
const BLANK_STREAM = resolveStreamId(REPO, undefined);

/** A session id the Claude CLI accepts — the store drops non-UUIDs (#204). */
const SESSION_ID = "6f1f2c0a-9b7d-4c3e-8a11-2b3c4d5e6f70";
const OTHER_SESSION_ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

const HOUR_MS = 60 * 60 * 1000;

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

Deno.test("stream session - path is stream-<streamKey>.json beside the per-issue records", () => {
  const path = streamSessionPath("/work", BLANK_STREAM);
  assertEquals(
    path,
    "/work/.claude-sessions/resume/stream-stsoftwareau__vibecoder__blank.json",
  );
  // Both records live in the one directory.
  assert(
    path.startsWith("/work/.claude-sessions/resume/"),
    "stream record shares the resume directory",
  );
});

Deno.test("stream session - save then load round-trips every field", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "resume_stream_" });
  try {
    const saved = await saveStreamSession(workDir, STREAM, {
      providerId: "claude",
      sessionId: SESSION_ID,
      credentialScope: "max-20x",
      holderHost: "fleet-host-3",
    }, 1_000_000);
    assert(saved);
    const loaded = await loadStreamSession(workDir, STREAM, "claude");
    assert(loaded);
    assertEquals(loaded.sessionId, SESSION_ID);
    assertEquals(loaded.credentialScope, "max-20x");
    assertEquals(loaded.holderHost, "fleet-host-3");
    assertEquals(loaded.savedAtEpochMs, 1_000_000);
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("stream session - a record written 48 hours ago still loads", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "resume_stream_" });
  try {
    const savedAt = 10_000_000;
    await saveStreamSession(workDir, STREAM, {
      providerId: "claude",
      sessionId: SESSION_ID,
    }, savedAt);
    // Well past the per-issue freshness window — the stream never expires.
    const later = savedAt + 48 * HOUR_MS;
    assert(later - savedAt > RESUME_STATE_MAX_AGE_MS);
    const loaded = await loadStreamSession(workDir, STREAM, "claude");
    assert(loaded, "a 48-hour-old stream session still loads");
    assertEquals(loaded.sessionId, SESSION_ID);
    assert(await exists(streamSessionPath(workDir, STREAM)));
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("stream session - two providers hold sessions side by side", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "resume_stream_" });
  try {
    await saveStreamSession(workDir, STREAM, {
      providerId: "claude",
      sessionId: SESSION_ID,
      credentialScope: "max-20x",
    }, 1_000);
    await saveStreamSession(workDir, STREAM, {
      providerId: "codex",
      sessionId: "thread_not_a_uuid",
      credentialScope: "chatgpt-plus",
    }, 2_000);

    const claude = await loadStreamSession(workDir, STREAM, "claude");
    const codex = await loadStreamSession(workDir, STREAM, "codex");
    assert(claude);
    assert(codex);
    // Writing the fallback provider left the first provider untouched.
    assertEquals(claude.sessionId, SESSION_ID);
    assertEquals(claude.credentialScope, "max-20x");
    assertEquals(claude.savedAtEpochMs, 1_000);
    assertEquals(codex.sessionId, "thread_not_a_uuid");
    assertEquals(codex.credentialScope, "chatgpt-plus");

    // Rewriting one provider still leaves the other alone.
    await saveStreamSession(workDir, STREAM, {
      providerId: "claude",
      sessionId: OTHER_SESSION_ID,
    }, 3_000);
    assertEquals(
      (await loadStreamSession(workDir, STREAM, "claude"))?.sessionId,
      OTHER_SESSION_ID,
    );
    assertEquals(
      (await loadStreamSession(workDir, STREAM, "codex"))?.sessionId,
      "thread_not_a_uuid",
    );
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("stream session - two streams of one repository do not share a session", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "resume_stream_" });
  try {
    await saveStreamSession(workDir, STREAM, {
      providerId: "claude",
      sessionId: SESSION_ID,
    }, 1_000);
    assertEquals(
      await loadStreamSession(workDir, BLANK_STREAM, "claude"),
      null,
    );
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("stream session - an unknown provider loads as null", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "resume_stream_" });
  try {
    await saveStreamSession(workDir, STREAM, {
      providerId: "claude",
      sessionId: SESSION_ID,
    }, 1_000);
    assertEquals(await loadStreamSession(workDir, STREAM, "gemini"), null);
    assertEquals(
      await loadStreamSession(workDir, BLANK_STREAM, "claude"),
      null,
    );
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("stream session - a non-UUID Claude id is dropped, a Codex thread id is kept", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "resume_stream_" });
  try {
    await saveStreamSession(workDir, STREAM, {
      providerId: "claude",
      sessionId: "session-not-a-uuid",
    }, 1_000);
    assertEquals(await loadStreamSession(workDir, STREAM, "claude"), null);

    await saveStreamSession(workDir, STREAM, {
      providerId: "codex",
      sessionId: "thread_not_a_uuid",
    }, 1_000);
    assertEquals(
      (await loadStreamSession(workDir, STREAM, "codex"))?.sessionId,
      "thread_not_a_uuid",
    );
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("stream session - a corrupt record loads as null and the next save repairs it", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "resume_stream_" });
  try {
    const path = streamSessionPath(workDir, STREAM);
    await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(path, "not json");
    assertEquals(await loadStreamSession(workDir, STREAM, "claude"), null);

    assert(
      await saveStreamSession(workDir, STREAM, {
        providerId: "claude",
        sessionId: SESSION_ID,
      }, 1_000),
    );
    assertEquals(
      (await loadStreamSession(workDir, STREAM, "claude"))?.sessionId,
      SESSION_ID,
    );
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("stream session - save is best-effort, returns false on failure", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "resume_stream_" });
  const blocked = `${tmp}/blocked`;
  await Deno.writeTextFile(blocked, "file, not a dir");
  try {
    const saved = await saveStreamSession(blocked, STREAM, {
      providerId: "claude",
      sessionId: SESSION_ID,
    }, 1);
    assertEquals(saved, false);
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("stream session - delete removes one provider, or the whole record", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "resume_stream_" });
  try {
    await saveStreamSession(workDir, STREAM, {
      providerId: "claude",
      sessionId: SESSION_ID,
    }, 1_000);
    await saveStreamSession(workDir, STREAM, {
      providerId: "codex",
      sessionId: "thread_not_a_uuid",
    }, 1_000);

    // The reset path drops the provider whose session proved unresumable.
    await deleteStreamSession(workDir, STREAM, "claude");
    assertEquals(await loadStreamSession(workDir, STREAM, "claude"), null);
    assert(await loadStreamSession(workDir, STREAM, "codex"));

    // Milestone-close housekeeping drops the whole stream.
    await deleteStreamSession(workDir, STREAM);
    assertEquals(await loadStreamSession(workDir, STREAM, "codex"), null);
    assertEquals(await exists(streamSessionPath(workDir, STREAM)), false);

    // Both spellings are idempotent.
    await deleteStreamSession(workDir, STREAM, "codex");
    await deleteStreamSession(workDir, STREAM);
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("stream session - deleting the last provider removes the empty record", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "resume_stream_" });
  try {
    await saveStreamSession(workDir, STREAM, {
      providerId: "claude",
      sessionId: SESSION_ID,
    }, 1_000);
    await deleteStreamSession(workDir, STREAM, "claude");
    assertEquals(await exists(streamSessionPath(workDir, STREAM)), false);
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("stream session - the per-issue sweep never deletes a stream record", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "resume_stream_" });
  try {
    const savedAt = 10_000_000;
    await saveStreamSession(workDir, STREAM, {
      providerId: "claude",
      sessionId: SESSION_ID,
    }, savedAt);
    await saveResumeState(workDir, REPO, 2332, {
      phaseCount: 1,
      branch: "issue-2332-old",
    }, savedAt);

    // A save two days later sweeps the abandoned per-issue sibling …
    const later = savedAt + 48 * HOUR_MS;
    await saveResumeState(workDir, REPO, 2333, {
      phaseCount: 1,
      branch: "issue-2333-new",
    }, later);
    assertEquals(await loadResumeState(workDir, REPO, 2332, later), null);
    // … and leaves the stream record alone.
    assert(await exists(streamSessionPath(workDir, STREAM)));
    assert(await loadStreamSession(workDir, STREAM, "claude"));
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("stream session - deleting the per-issue record leaves the stream record intact", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "resume_stream_" });
  try {
    await saveStreamSession(workDir, STREAM, {
      providerId: "claude",
      sessionId: SESSION_ID,
    }, 1_000);
    await saveResumeState(workDir, REPO, 2332, {
      sessionId: SESSION_ID,
      phaseCount: 3,
      branch: "issue-2332",
    }, 1_000);

    // What PR creation and claim release do: delete the issue's checkpoint.
    await deleteResumeState(workDir, REPO, 2332);
    assertEquals(await loadResumeState(workDir, REPO, 2332, 1_001), null);
    assertEquals(
      (await loadStreamSession(workDir, STREAM, "claude"))?.sessionId,
      SESSION_ID,
    );
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("stream session - a pre-existing per-issue record keeps loading and is not promoted", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "resume_stream_" });
  try {
    // A record written by an older host, carrying its own session id.
    const path = resumeStatePath(workDir, REPO, 2200);
    await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        sessionId: SESSION_ID,
        phaseCount: 2,
        branch: "issue-2200",
        savedAtEpochMs: 1_000,
      }),
    );

    const loaded = await loadResumeState(workDir, REPO, 2200, 1_500);
    assert(loaded);
    assertEquals(loaded.sessionId, SESSION_ID);
    assertEquals(loaded.branch, "issue-2200");
    // No migration: the stream starts fresh on a host with no stream record.
    assertEquals(await loadStreamSession(workDir, STREAM, "claude"), null);
    assertEquals(await exists(streamSessionPath(workDir, STREAM)), false);
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
});
