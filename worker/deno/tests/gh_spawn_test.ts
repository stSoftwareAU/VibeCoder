/**
 * Tests for the shared `gh` spawn chokepoint (Issue #3703).
 *
 * The chokepoint's contract is that no `gh` process starts until the
 * write-repo allowlist has approved the arguments, and that the mutation is
 * journalled afterwards. Both are exercised here through the injectable
 * low-level runner, so no real `gh` binary is spawned.
 *
 * Uses Australian English throughout.
 */

import { assertEquals, assertRejects } from "@std/assert";
import {
  _resetGhSpawnRunner,
  _setGhSpawnRunner,
  runGhOrThrow,
  spawnGh,
} from "../lib/gh_spawn.ts";
import {
  _resetWriteRepoAllowlistSinks,
  _setWriteRepoAllowlistSinks,
  resetWriteRepoAllowlist,
  seedWriteRepoAllowlist,
  WriteRepoBlockedError,
  WriteTargetUndeterminableError,
} from "../lib/write_repo_allowlist.ts";

/** Record the arguments each spawn attempt would have used. */
function recordingRunner(
  result: { code: number; stdout?: string; stderr?: string } = { code: 0 },
): { calls: string[][] } {
  const calls: string[][] = [];
  _setGhSpawnRunner((args) => {
    calls.push([...args]);
    return Promise.resolve({
      code: result.code,
      success: result.code === 0,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    });
  });
  return { calls };
}

/** Silence the allowlist's audit/log sinks for one test. */
function silenceAllowlist(): void {
  _setWriteRepoAllowlistSinks({
    record: () => Promise.resolve({ ok: true, value: undefined as never }),
    log: () => {},
  });
}

function restore(): void {
  _resetGhSpawnRunner();
  resetWriteRepoAllowlist();
  _resetWriteRepoAllowlistSinks();
}

Deno.test("spawnGh - returns the runner's outcome without throwing on failure", async () => {
  const { calls } = recordingRunner({ code: 1, stderr: "boom" });
  try {
    const result = await spawnGh(["issue", "view", "1"]);
    assertEquals(result.code, 1);
    assertEquals(result.success, false);
    assertEquals(result.stderr, "boom");
    assertEquals(calls, [["issue", "view", "1"]]);
  } finally {
    restore();
  }
});

Deno.test("runGhOrThrow - returns stdout and throws with the exit code", async () => {
  const ok = recordingRunner({ code: 0, stdout: "hello" });
  try {
    assertEquals(await runGhOrThrow(["pr", "view", "1"]), "hello");
    assertEquals(ok.calls.length, 1);
  } finally {
    restore();
  }

  recordingRunner({ code: 22, stderr: "HTTP 422" });
  try {
    const error = await assertRejects(
      () => runGhOrThrow(["pr", "view", "1"]),
      Error,
    );
    assertEquals(error.message, "gh command failed (exit 22): HTTP 422");
  } finally {
    restore();
  }
});

Deno.test("spawnGh - refuses an off-allowlist write before spawning gh", async () => {
  const { calls } = recordingRunner();
  silenceAllowlist();
  seedWriteRepoAllowlist("me/target");
  try {
    await assertRejects(
      () =>
        spawnGh([
          "issue",
          "comment",
          "1",
          "-R",
          "victim/repo",
          "--body",
          "leak",
        ]),
      WriteRepoBlockedError,
    );
    // The refusal must happen before the subprocess would have started.
    assertEquals(calls, []);
  } finally {
    restore();
  }
});

Deno.test("spawnGh - refuses an undeterminable write before spawning gh", async () => {
  const { calls } = recordingRunner();
  silenceAllowlist();
  seedWriteRepoAllowlist("me/target");
  try {
    await assertRejects(
      () => spawnGh(["gist", "create", "dump.txt"]),
      WriteTargetUndeterminableError,
    );
    assertEquals(calls, []);
  } finally {
    restore();
  }
});

Deno.test("spawnGh - allows an on-allowlist write through to the runner", async () => {
  const { calls } = recordingRunner();
  silenceAllowlist();
  seedWriteRepoAllowlist("me/target");
  try {
    await spawnGh(["issue", "close", "9", "-R", "me/target"]);
    assertEquals(calls, [["issue", "close", "9", "-R", "me/target"]]);
  } finally {
    restore();
  }
});

// Issue #3748: the production runner passed the caller's stdout/stderr
// options through to Deno.Command but then unconditionally destructured
// both streams from the command output. Deno's CommandOutput getters THROW
// (`TypeError: Cannot get 'stderr': 'stderr' is not piped`) when the stream
// was opened with "null", so every spawnGh call discarding a stream failed
// even when gh itself succeeded — silently breaking heartbeat markers,
// stale-claim recovery scans and claim release. These tests exercise the
// REAL production runner (no injected mock) with a harmless read-only
// command; `gh --version` classifies as a non-mutation so it bypasses the
// write allowlist and audit journal.

Deno.test("spawnGh - production runner tolerates a discarded stderr (Issue #3748)", async () => {
  _resetGhSpawnRunner();
  const result = await spawnGh(["--version"], { stderr: "null" });
  assertEquals(result.success, true);
  assertEquals(result.stderr, "");
  // stdout stays captured — the discarded stream must not blank the piped one.
  assertEquals(result.stdout.includes("gh version"), true);
});

Deno.test("spawnGh - production runner tolerates discarding both streams (Issue #3748)", async () => {
  _resetGhSpawnRunner();
  const result = await spawnGh(["--version"], {
    stdout: "null",
    stderr: "null",
  });
  assertEquals(result.success, true);
  assertEquals(result.stdout, "");
  assertEquals(result.stderr, "");
});

Deno.test("spawnGh - production runner tolerates discarded streams on the stdin path (Issue #3748)", async () => {
  _resetGhSpawnRunner();
  // `gh --version` ignores stdin; supplying it routes through the spawn()
  // branch of the production runner, which had the same throwing getters.
  const result = await spawnGh(["--version"], {
    stdin: "",
    stderr: "null",
  });
  assertEquals(result.success, true);
  assertEquals(result.stderr, "");
  assertEquals(result.stdout.includes("gh version"), true);
});

Deno.test("spawnGh - forwards stdin and stream options to the runner", async () => {
  const seen: Array<Record<string, unknown>> = [];
  _setGhSpawnRunner((_args, options) => {
    seen.push({ ...options });
    return Promise.resolve({
      code: 0,
      success: true,
      stdout: "",
      stderr: "",
    });
  });
  try {
    await spawnGh(["api", "repos/me/target/x", "--input", "-"], {
      stdin: '{"a":1}',
      stdout: "null",
    });
    assertEquals(seen[0]?.stdin, '{"a":1}');
    assertEquals(seen[0]?.stdout, "null");
  } finally {
    restore();
  }
});
