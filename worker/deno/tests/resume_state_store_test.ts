/**
 * Tests for the durable resume-state store (Issue #4170).
 *
 * A killed session must resume instead of restarting from zero: the store
 * persists the session id, phase count, and branch per issue so a re-claim
 * can prime `--resume` and pick up the checkpointed branch.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  deleteResumeState,
  loadResumeState,
  RESUME_STATE_MAX_AGE_MS,
  resumeStatePath,
  saveResumeState,
} from "../lib/resume_state_store.ts";

const REPO = "stSoftwareAU/VibeCoder";

Deno.test("resume_state_store - path is slugged under .claude-sessions/resume", () => {
  assertEquals(
    resumeStatePath("/work", REPO, 4170),
    "/work/.claude-sessions/resume/stSoftwareAU-VibeCoder-4170.json",
  );
});

Deno.test("resume_state_store - save then load round-trips", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "resume_store_" });
  try {
    const saved = await saveResumeState(workDir, REPO, 4170, {
      sessionId: "sess-1",
      phaseCount: 2,
      branch: "issue-4170-checkpoint",
    }, 1_000_000);
    assert(saved);
    const loaded = await loadResumeState(workDir, REPO, 4170, 1_000_000);
    assert(loaded);
    assertEquals(loaded.sessionId, "sess-1");
    assertEquals(loaded.phaseCount, 2);
    assertEquals(loaded.branch, "issue-4170-checkpoint");
    assertEquals(loaded.savedAtEpochMs, 1_000_000);
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("resume_state_store - load returns null for missing, corrupt, or invalid files", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "resume_store_" });
  try {
    assertEquals(await loadResumeState(workDir, REPO, 1), null);

    const path = resumeStatePath(workDir, REPO, 2);
    await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(path, "not json");
    assertEquals(await loadResumeState(workDir, REPO, 2), null);

    await Deno.writeTextFile(path, JSON.stringify({ branch: 42 }));
    assertEquals(await loadResumeState(workDir, REPO, 2), null);
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("resume_state_store - a stale file (>24h) loads as null and is removed", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "resume_store_" });
  try {
    const savedAt = 1_000_000;
    await saveResumeState(workDir, REPO, 3, {
      phaseCount: 1,
      branch: "issue-3-old",
    }, savedAt);
    const later = savedAt + RESUME_STATE_MAX_AGE_MS + 1;
    assertEquals(await loadResumeState(workDir, REPO, 3, later), null);
    // The stale file is gone, not just ignored.
    let exists = true;
    try {
      await Deno.stat(resumeStatePath(workDir, REPO, 3));
    } catch {
      exists = false;
    }
    assertEquals(exists, false);
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("resume_state_store - delete is idempotent and removes the file", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "resume_store_" });
  try {
    await saveResumeState(workDir, REPO, 4, {
      phaseCount: 1,
      branch: "issue-4-x",
    }, 5_000);
    await deleteResumeState(workDir, REPO, 4);
    assertEquals(await loadResumeState(workDir, REPO, 4, 5_001), null);
    // Second delete must not throw.
    await deleteResumeState(workDir, REPO, 4);
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("resume_state_store - save sweeps sibling files older than the freshness window", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "resume_store_" });
  try {
    const savedAt = 10_000_000;
    await saveResumeState(workDir, REPO, 5, {
      phaseCount: 1,
      branch: "issue-5-old",
    }, savedAt);
    // A save much later for a different issue sweeps the abandoned sibling.
    const later = savedAt + RESUME_STATE_MAX_AGE_MS + 60_000;
    await saveResumeState(workDir, REPO, 6, {
      phaseCount: 1,
      branch: "issue-6-new",
    }, later);
    assertEquals(await loadResumeState(workDir, REPO, 5, later), null);
    assert(await loadResumeState(workDir, REPO, 6, later));
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("resume_state_store - save is best-effort, returns false on failure", async () => {
  // workDir path that cannot be created (a file blocks the directory).
  const tmp = await Deno.makeTempDir({ prefix: "resume_store_" });
  const blocked = `${tmp}/blocked`;
  await Deno.writeTextFile(blocked, "file, not a dir");
  try {
    const saved = await saveResumeState(blocked, REPO, 7, {
      phaseCount: 1,
      branch: "issue-7-x",
    }, 1);
    assertEquals(saved, false);
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => undefined);
  }
});
