/**
 * Tests for git_timeout.ts — Git operation timeout management (Issue #619, #912).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  _resetAuditCaches,
  auditFilePath,
  loadEntries,
} from "../lib/audit_journal.ts";
import {
  capturePushCommits,
  getTimeoutForOperation,
  isGitTimeout,
  runGitCommand,
  runGitCommandChecked,
  TIMEOUT_EXIT_CODE,
} from "../lib/git_timeout.ts";
import { envFrom } from "./support/env_lookup.ts";

Deno.test("git timeout - push provenance excludes remote owner commits even with a stale tracking ref", async () => {
  const dir = await Deno.makeTempDir({ prefix: "push-provenance-" });
  const cwd = `${dir}/local`;
  const env = {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    VIBE_AUDIT_DISABLED: "true",
  };
  const git = async (...args: string[]) => {
    const result = await runGitCommand(args, { cwd, env });
    assertEquals(result.ok, true);
    if (!result.ok) throw result.error;
    assertEquals(result.value.code, 0, result.value.stderr);
    return result.value.stdout.trim();
  };
  try {
    await Deno.mkdir(cwd);
    await git("init", "--quiet", "--initial-branch=feature");
    await git("config", "user.name", "Test");
    await git("config", "user.email", "test@example.invalid");
    await git("config", "commit.gpgsign", "false");
    await git("init", "--quiet", "--bare", `${dir}/remote.git`);
    await git("remote", "add", "origin", `${dir}/remote.git`);
    await git("commit", "--quiet", "--allow-empty", "-m", "initial");
    const initial = await git("rev-parse", "HEAD");
    assertEquals(
      await capturePushCommits(["push", "-u", "origin", "feature"], {
        cwd,
        env,
      }),
      [initial],
    );
    await git("push", "origin", "feature");
    await git("commit", "--quiet", "--allow-empty", "-m", "owner repair");
    const owner = await git("rev-parse", "HEAD");
    await git("push", "origin", "feature");
    // Simulate a stale local tracking ref: the remote itself remains authoritative.
    await git("update-ref", "refs/remotes/origin/feature", initial);
    await git("commit", "--quiet", "--allow-empty", "-m", "fleet repair");
    const repair = await git("rev-parse", "HEAD");
    assertEquals(
      await capturePushCommits(["push", "origin", "feature"], { cwd, env }),
      [repair],
    );
    const auditEnv = {
      WORK_DIR: dir,
      WORKER_UNIQUE_ID: "push-provenance",
      VIBE_RUN_ID: "push-provenance",
      VIBE_AUDIT_DISABLED: "0",
    };
    try {
      _resetAuditCaches();
      const pushed = await runGitCommand(["push", "origin", "feature"], {
        cwd,
        env: { ...env, ...auditEnv },
      });
      assertEquals(pushed.ok, true);
      if (!pushed.ok) throw pushed.error;
      assertEquals(pushed.value.code, 0, pushed.value.stderr);
      const journal = await loadEntries(
        auditFilePath({ env: envFrom(auditEnv) }),
      );
      assertEquals(journal.ok, true);
      if (!journal.ok) throw journal.error;
      assertEquals(journal.value.length, 1);
      assertEquals(journal.value[0]?.deliveredCommits, [repair]);
    } finally {
      _resetAuditCaches();
    }
    assertEquals(
      await capturePushCommits(["push", "origin", "feature"], { cwd, env }),
      [],
    );
    assertEquals(
      await capturePushCommits(["push", "--force", "origin", "feature"], {
        cwd,
        env,
      }),
      undefined,
    );
    assertEquals(
      await capturePushCommits(["push", "origin", "HEAD"], { cwd, env }),
      undefined,
    );
    assertEquals(
      await capturePushCommits(["push", "missing", "feature"], { cwd, env }),
      undefined,
    );
    assertEquals(
      await capturePushCommits(["push", "origin", "feature:other"], {
        cwd,
        env,
      }),
      [repair, owner, initial],
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// getTimeoutForOperation
// ---------------------------------------------------------------------------

Deno.test("git timeout - getTimeoutForOperation returns merge timeout for merge", () => {
  const timeout = getTimeoutForOperation("merge");
  assertEquals(timeout, 120);
});

Deno.test("git timeout - getTimeoutForOperation returns merge timeout for rebase", () => {
  const timeout = getTimeoutForOperation("rebase");
  assertEquals(timeout, 120);
});

Deno.test("git timeout - getTimeoutForOperation returns merge timeout for pull", () => {
  const timeout = getTimeoutForOperation("pull");
  assertEquals(timeout, 120);
});

Deno.test("git timeout - getTimeoutForOperation returns default timeout for fetch", () => {
  const timeout = getTimeoutForOperation("fetch");
  assertEquals(timeout, 60);
});

Deno.test("git timeout - getTimeoutForOperation returns default timeout for push", () => {
  const timeout = getTimeoutForOperation("push");
  assertEquals(timeout, 60);
});

Deno.test("git timeout - getTimeoutForOperation returns default timeout for unknown commands", () => {
  const timeout = getTimeoutForOperation("status");
  assertEquals(timeout, 60);
});

// ---------------------------------------------------------------------------
// isGitTimeout
// ---------------------------------------------------------------------------

Deno.test("git timeout - isGitTimeout returns true for timeout exit code", () => {
  assertEquals(isGitTimeout(TIMEOUT_EXIT_CODE), true);
});

Deno.test("git timeout - isGitTimeout returns false for zero", () => {
  assertEquals(isGitTimeout(0), false);
});

Deno.test("git timeout - isGitTimeout returns false for other non-zero codes", () => {
  assertEquals(isGitTimeout(1), false);
  assertEquals(isGitTimeout(128), false);
});

// ---------------------------------------------------------------------------
// TIMEOUT_EXIT_CODE
// ---------------------------------------------------------------------------

Deno.test("git timeout - TIMEOUT_EXIT_CODE is 124", () => {
  assertEquals(TIMEOUT_EXIT_CODE, 124);
});

// ---------------------------------------------------------------------------
// runGitCommand — real git invocations
// ---------------------------------------------------------------------------

Deno.test("git timeout - runGitCommand runs a simple git command", async () => {
  const result = await runGitCommand(["--version"]);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.code, 0);
    assertStringIncludes(result.value.stdout, "git version");
  }
});

Deno.test("git timeout - runGitCommand returns non-zero for invalid command", async () => {
  const result = await runGitCommand(["nonexistent-subcommand"]);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.code !== 0, true);
  }
});

Deno.test("git timeout - runGitCommand reports a killed call as a timeout (Issue #1378)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "git-timeout-" });
  try {
    await runGitCommand(["init", "--quiet"], { cwd: dir });
    // `core.fsmonitor` points at a sleeping hook, so `git status` blocks on
    // it. Aborting the signal kills the child instead of throwing, so the
    // call resolves with git's signal exit code — it must still be reported
    // as a timeout, not as a plain non-zero failure.
    const hook = `${dir}/slow-fsmonitor.sh`;
    await Deno.writeTextFile(hook, "#!/bin/sh\nsleep 2\n");
    await Deno.chmod(hook, 0o755);
    await runGitCommand(["config", "core.fsmonitor", hook], { cwd: dir });

    const result = await runGitCommand(["status", "--porcelain"], {
      cwd: dir,
      timeoutSeconds: 1,
    });

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.code, TIMEOUT_EXIT_CODE);
      assertEquals(isGitTimeout(result.value.code), true);
      assertStringIncludes(result.value.stderr, "timed out after 1s");
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// runGitCommandChecked
// ---------------------------------------------------------------------------

Deno.test("git timeout - runGitCommandChecked returns stdout on success", async () => {
  const result = await runGitCommandChecked(["--version"]);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertStringIncludes(result.value, "git version");
  }
});

Deno.test("git timeout - runGitCommandChecked returns error for invalid command", async () => {
  const result = await runGitCommandChecked(["nonexistent-subcommand"]);
  assertEquals(result.ok, false);
});
