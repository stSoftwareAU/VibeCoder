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
import { appendNoFollow } from "../lib/file_utils.ts";
import {
  CREDIT_LOG_DIR_NAME,
  resolveCreditLogDir,
} from "../lib/spend_ceiling.ts";

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
// resolveCreditLogDir — the ceiling's input is no longer in the shared root
// ---------------------------------------------------------------------------

Deno.test("resolveCreditLogDir - defaults to a worker-private subdirectory", () => {
  assertEquals(
    resolveCreditLogDir("/work", undefined),
    `/work/${CREDIT_LOG_DIR_NAME}`,
  );
  assertEquals(
    resolveCreditLogDir("/work", "  "),
    `/work/${CREDIT_LOG_DIR_NAME}`,
  );
  // A trailing slash on the work dir must not double up.
  assertEquals(
    resolveCreditLogDir("/work/", undefined),
    `/work/${CREDIT_LOG_DIR_NAME}`,
  );
});

Deno.test("resolveCreditLogDir - honours an explicit override", () => {
  assertEquals(resolveCreditLogDir("/work", "/var/credit"), "/var/credit");
  assertEquals(resolveCreditLogDir("/work", " /var/credit "), "/var/credit");
});

// ---------------------------------------------------------------------------
// appendNoFollow — the shared primitive
// ---------------------------------------------------------------------------

Deno.test("appendNoFollow - appends to a regular file, creating it 0600", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const target = `${dir}/log.json`;
    const first = await appendNoFollow({ targetFile: target, content: "a\n" });
    assert(first.ok, "first append succeeded");
    const second = await appendNoFollow({ targetFile: target, content: "b\n" });
    assert(second.ok, "second append succeeded");

    assertEquals(await Deno.readTextFile(target), "a\nb\n");
    if (Deno.build.os !== "windows") {
      assertEquals((await Deno.lstat(target)).mode! & 0o777, 0o600);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("appendNoFollow - refuses a symlink and a non-regular target", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const victim = `${dir}/victim`;
    await Deno.writeTextFile(victim, "original");
    const link = `${dir}/link`;
    await Deno.symlink(victim, link);

    const linked = await appendNoFollow({ targetFile: link, content: "x\n" });
    assert(!linked.ok, "a symlink target is refused");
    assertStringIncludes(linked.error.message, "symlink");
    assertEquals(await Deno.readTextFile(victim), "original");

    const asDir = `${dir}/subdir`;
    await Deno.mkdir(asDir);
    const directory = await appendNoFollow({
      targetFile: asDir,
      content: "x\n",
    });
    assert(!directory.ok, "a directory target is refused");
    assertStringIncludes(directory.error.message, "not a regular file");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
