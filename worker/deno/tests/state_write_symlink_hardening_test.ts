/**
 * Symlink-hardening tests for state and cache writers (Issue #3682).
 *
 * Finding SEC-1d6a95f38c04: thirteen state/cache writers built their
 * temporary file path from the process id (`<target>.tmp.${Deno.pid}`) and
 * wrote it with `Deno.writeTextFile`, which follows symlinks. A co-located
 * attacker who can guess the PID pre-positions a symlink at that path and
 * the worker writes through it, clobbering an arbitrary file the worker can
 * reach — and then renames the symlink over the state file.
 *
 * The hardened `atomicWrite`/`atomicWriteSync` helpers in `file_utils.ts`
 * use a kernel-random suffix and `createNew` (O_EXCL), so the trap is never
 * followed. Every test below pre-positions the trap and asserts the victim
 * file is untouched and the state file is a regular file.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { atomicWriteSync } from "../lib/file_utils.ts";
import { recordZeroProgress } from "../lib/circuit_breaker.ts";
import { recordIssueCooldown } from "../lib/cooldown_state.ts";
import { trackFailure } from "../lib/failure_tracker.ts";
import { writeScanCursor } from "../lib/scan_cursor.ts";
import { recordRepoBlocked } from "../lib/repo_blocked_alert.ts";
import { recordRepoTimeout } from "../lib/timeout_tracker.ts";
import {
  recordRepoFailure,
  recordRepoTimeout as recordRepoFailureTimeout,
} from "../lib/repo_failure_tracker.ts";
import { saveContentApprovalState } from "../lib/content_approval_tracker.ts";
import {
  healthCacheFilePath,
  recordFableAvailability,
  recordHealthCheckSuccess,
} from "../lib/health_check_cache.ts";

const VICTIM_CONTENT = "victim-original";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "symlink_hardening_" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

/**
 * Pre-position the attacker's symlink at the PID-predictable temp path and
 * return the victim path the trap points at.
 */
async function armTrap(dir: string, targetFile: string): Promise<string> {
  const victim = `${dir}/victim.txt`;
  await Deno.writeTextFile(victim, VICTIM_CONTENT);
  await Deno.symlink(victim, `${targetFile}.tmp.${Deno.pid}`);
  return victim;
}

/** Assert the trap did not fire: victim untouched, target a regular file. */
async function assertTrapDidNotFire(
  victim: string,
  targetFile: string,
): Promise<void> {
  assertEquals(
    await Deno.readTextFile(victim),
    VICTIM_CONTENT,
    "victim file was written through the pre-positioned symlink",
  );
  const stat = await Deno.lstat(targetFile);
  assertEquals(stat.isSymlink, false, "state file is a symlink");
  assertEquals(stat.isFile, true, "state file is not a regular file");
}

// ---------------------------------------------------------------------------
// atomicWriteSync
// ---------------------------------------------------------------------------

Deno.test("atomicWriteSync - writes content and replaces an existing file", async () => {
  await withTempDir(async (dir) => {
    const target = `${dir}/state.json`;
    const first = atomicWriteSync({ targetFile: target, content: "one" });
    assertEquals(first.ok, true);
    assertEquals(await Deno.readTextFile(target), "one");

    const second = atomicWriteSync({ targetFile: target, content: "two" });
    assertEquals(second.ok, true);
    assertEquals(await Deno.readTextFile(target), "two");
  });
});

Deno.test("atomicWriteSync - applies the requested mode and leaves no temp file", async () => {
  await withTempDir(async (dir) => {
    const target = `${dir}/state.json`;
    assertEquals(
      atomicWriteSync({ targetFile: target, content: "x", mode: 0o600 }).ok,
      true,
    );
    const stat = await Deno.stat(target);
    assertEquals((stat.mode ?? 0) & 0o777, 0o600);

    const leftovers: string[] = [];
    for await (const entry of Deno.readDir(dir)) leftovers.push(entry.name);
    assertEquals(leftovers, ["state.json"]);
  });
});

Deno.test("atomicWriteSync - fails loudly when the target directory is missing", () => {
  const result = atomicWriteSync({
    targetFile: "/nonexistent-dir-3682/state.json",
    content: "x",
  });
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(result.error.message, "atomicWriteSync");
  }
});

Deno.test("atomicWriteSync - does not follow a symlink at the predictable temp path", async () => {
  await withTempDir(async (dir) => {
    const target = `${dir}/state.json`;
    const victim = await armTrap(dir, target);
    assertEquals(
      atomicWriteSync({ targetFile: target, content: "safe" }).ok,
      true,
    );
    await assertTrapDidNotFire(victim, target);
    assertEquals(await Deno.readTextFile(target), "safe");
  });
});

// ---------------------------------------------------------------------------
// State writers
// ---------------------------------------------------------------------------

Deno.test("circuit_breaker - persistState ignores a symlink trap at the temp path", async () => {
  await withTempDir(async (dir) => {
    const target = `${dir}/.circuit_breaker_state.json`;
    const victim = await armTrap(dir, target);
    const result = await recordZeroProgress({
      workDir: dir,
      threshold: 3,
      sleepInterval: 30,
      creditWaitInterval: 300,
      stateExpirySeconds: 3600,
      operationBackoffThreshold: 2,
    });
    assertEquals(result.ok, true);
    await assertTrapDidNotFire(victim, target);
  });
});

Deno.test("cooldown_state - persistState ignores a symlink trap at the temp path", async () => {
  await withTempDir(async (dir) => {
    const target = `${dir}/.cooldown_state.json`;
    const victim = await armTrap(dir, target);
    const result = await recordIssueCooldown(
      { workDir: dir, issueRetryCooldown: 600 },
      "owner/repo",
      42,
    );
    assertEquals(result.ok, true);
    await assertTrapDidNotFire(victim, target);
  });
});

Deno.test("failure_tracker - persistState ignores a symlink trap at the temp path", async () => {
  await withTempDir(async (dir) => {
    const target = `${dir}/.failure_state.json`;
    const victim = await armTrap(dir, target);
    const result = await trackFailure(
      { workDir: dir, maxConsecutiveFailures: 3, stateExpirySeconds: 3600 },
      "some-failure",
    );
    assertEquals(result.ok, true);
    await assertTrapDidNotFire(victim, target);
  });
});

Deno.test("scan_cursor - writeScanCursor ignores a symlink trap at the temp path", async () => {
  await withTempDir(async (dir) => {
    const target = `${dir}/.scan_cursor.json`;
    const victim = await armTrap(dir, target);
    const result = await writeScanCursor(
      target,
      { priority: 1, repoIndex: 2 },
      () => 1000,
    );
    assertEquals(result.ok, true);
    await assertTrapDidNotFire(victim, target);
    assertStringIncludes(await Deno.readTextFile(target), '"repoIndex":2');
  });
});

Deno.test("repo_blocked_alert - writeStateEntries ignores a symlink trap at the temp path", async () => {
  await withTempDir(async (dir) => {
    const target = `${dir}/.repo_blocked_state`;
    const victim = await armTrap(dir, target);
    const result = await recordRepoBlocked(
      { workDir: dir, alertHours: 24 },
      "owner/repo",
      3,
      "[1,2]",
      () => 1000,
    );
    assertEquals(result.ok, true);
    await assertTrapDidNotFire(victim, target);
  });
});

Deno.test("timeout_tracker - writeTimeoutMap ignores a symlink trap at the temp path", async () => {
  await withTempDir(async (dir) => {
    const target = `${dir}/.timeout_state.json`;
    const victim = await armTrap(dir, target);
    const result = await recordRepoTimeout(
      {
        stateFile: target,
        baseCooldownSeconds: 300,
        maxCooldownSeconds: 3600,
      },
      "owner/repo",
      () => 1000,
    );
    assertEquals(result.ok, true);
    await assertTrapDidNotFire(victim, target);
  });
});

Deno.test("repo_failure_tracker - writeFailureMap ignores a symlink trap at the temp path", async () => {
  await withTempDir(async (dir) => {
    const target = `${dir}/.repo_failures`;
    const victim = await armTrap(dir, target);
    const result = await recordRepoFailure(
      { failureFile: target, threshold: 3 },
      "owner/repo",
      7,
    );
    assertEquals(result.ok, true);
    await assertTrapDidNotFire(victim, target);
  });
});

Deno.test("repo_failure_tracker - writeTimeoutMap ignores a symlink trap at the temp path", async () => {
  await withTempDir(async (dir) => {
    const failureFile = `${dir}/.repo_failures`;
    const target = `${failureFile}.timeouts`;
    const victim = await armTrap(dir, target);
    const result = await recordRepoFailureTimeout(
      { failureFile, threshold: 3 },
      "owner/repo",
    );
    assertEquals(result.ok, true);
    await assertTrapDidNotFire(victim, target);
  });
});

Deno.test("content_approval_tracker - saveContentApprovalState ignores a symlink trap", async () => {
  await withTempDir(async (dir) => {
    const target = `${dir}/.content_approval_state.json`;
    const victim = await armTrap(dir, target);
    const result = await saveContentApprovalState(dir, { snapshots: {} });
    assertEquals(result.ok, true);
    await assertTrapDidNotFire(victim, target);
  });
});

Deno.test("health_check_cache - recordHealthCheckSuccess ignores a symlink trap", async () => {
  await withTempDir(async (dir) => {
    const target = healthCacheFilePath(dir, "github");
    const victim = await armTrap(dir, target);
    const result = recordHealthCheckSuccess(dir, "github", () => 1000);
    assertEquals(result.ok, true);
    await assertTrapDidNotFire(victim, target);
    assertEquals(await Deno.readTextFile(target), "1000");
  });
});

Deno.test("health_check_cache - recordFableAvailability ignores a symlink trap", async () => {
  await withTempDir(async (dir) => {
    const target = healthCacheFilePath(dir, "fable");
    const victim = await armTrap(dir, target);
    const result = recordFableAvailability(dir, true, () => 1000);
    assertEquals(result.ok, true);
    await assertTrapDidNotFire(victim, target);
    assertEquals(await Deno.readTextFile(target), "1000 available");
  });
});
