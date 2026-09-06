/**
 * Credit log symlink-follow and ceiling-input regression tests (Issue #1239).
 *
 * The credit log was appended with a bare `Deno.writeTextFile(..., { append:
 * true })` at a predictable path directly under the agent-writable work root,
 * so the `agent` account could:
 *
 *   1. plant a symlink at `.credit_log_<date>.json` and redirect every
 *      appended JSON line into any file the worker uid can write; and
 *   2. delete the day's log, zeroing the only input the daily spend ceiling
 *      reads.
 *
 * These tests drive the real functions: they fail against the unfixed code
 * (the append followed the link and the log sat in the shared work root) and
 * pass after the fix.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  LOG_FILE_PREFIX,
  LOG_FILE_SUFFIX,
  logInvocation,
} from "../lib/credit_tracker.ts";

/** Today's log file name, matching the module's own naming. */
function todayLogName(): string {
  return `${LOG_FILE_PREFIX}${
    new Date().toISOString().slice(0, 10)
  }${LOG_FILE_SUFFIX}`;
}

/** Minimal invocation options for the tests below. */
function invocation(logDir: string) {
  return {
    logDir,
    workerName: "worker-1",
    phase: "implementation",
    repo: "org/repo",
    model: "claude-sonnet-4-7",
  };
}

// ---------------------------------------------------------------------------
// logInvocation — the symlink follow
// ---------------------------------------------------------------------------

Deno.test("logInvocation - refuses to append through a planted symlink", async () => {
  const root = await Deno.makeTempDir();
  try {
    const logDir = `${root}/logs`;
    await Deno.mkdir(logDir);
    const victim = `${root}/hosts.yml`;
    await Deno.writeTextFile(victim, "github.com:\n  oauth_token: secret\n");
    await Deno.symlink(victim, `${logDir}/${todayLogName()}`);

    let message = "";
    try {
      await logInvocation(invocation(logDir));
      throw new Error("expected the symlinked append to be refused");
    } catch (err) {
      message = (err as Error).message;
    }

    assertStringIncludes(message, "symlink");
    // The victim file is untouched — no JSON line was appended to it.
    assertEquals(
      await Deno.readTextFile(victim),
      "github.com:\n  oauth_token: secret\n",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("logInvocation - refuses a dangling symlink at the log path", async () => {
  const root = await Deno.makeTempDir();
  try {
    const logDir = `${root}/logs`;
    await Deno.mkdir(logDir);
    const target = `${root}/not-created-yet.json`;
    await Deno.symlink(target, `${logDir}/${todayLogName()}`);

    let refused = false;
    try {
      await logInvocation(invocation(logDir));
    } catch (err) {
      refused = (err as Error).message.includes("symlink");
    }

    assert(refused, "expected a dangling symlink to be refused");
    // The link target was never created by following the link.
    await Deno.lstat(target).then(
      () => {
        throw new Error(
          "the symlink target was created — the link was followed",
        );
      },
      () => {/* NotFound — correct */},
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("logInvocation - creates the log owner-only and still appends", async () => {
  const root = await Deno.makeTempDir();
  try {
    const logDir = `${root}/logs`;
    await logInvocation(invocation(logDir));
    await logInvocation(invocation(logDir));

    const logPath = `${logDir}/${todayLogName()}`;
    const lines = (await Deno.readTextFile(logPath)).trim().split("\n");
    assertEquals(lines.length, 2, "both invocations were appended");
    assertEquals(JSON.parse(lines[0]!).workerName, "worker-1");

    if (Deno.build.os !== "windows") {
      const info = await Deno.lstat(logPath);
      assertEquals(info.mode! & 0o777, 0o600, "log file is owner-only");
      const dirInfo = await Deno.lstat(logDir);
      assertEquals(dirInfo.mode! & 0o777, 0o700, "log directory is owner-only");
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// logInvocation — the directory the spend ceiling reads from
// ---------------------------------------------------------------------------

Deno.test("logInvocation - tightens a log directory another writer left open", async () => {
  if (Deno.build.os === "windows") return;
  const root = await Deno.makeTempDir();
  try {
    // logContextBudget shares this directory and may create it first; a
    // group-writable directory lets the agent account unlink the day's log.
    const logDir = `${root}/logs`;
    await Deno.mkdir(logDir, { mode: 0o775 });

    await logInvocation(invocation(logDir));

    assertEquals(
      (await Deno.lstat(logDir)).mode! & 0o022,
      0,
      "group/other write is removed before the log is written",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("logInvocation - refuses a log directory that is a symlink", async () => {
  const root = await Deno.makeTempDir();
  try {
    const real = `${root}/elsewhere`;
    await Deno.mkdir(real);
    const logDir = `${root}/logs`;
    await Deno.symlink(real, logDir);

    let message = "";
    try {
      await logInvocation(invocation(logDir));
    } catch (err) {
      message = (err as Error).message;
    }

    assertStringIncludes(message, "not a directory this worker created");
    // Nothing was written through the link.
    const entries: string[] = [];
    for await (const entry of Deno.readDir(real)) entries.push(entry.name);
    assertEquals(entries, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
