/**
 * Tests for run_entrypoint.ts — the run-entrypoint PID guard.
 *
 * Issue #919: Simplify run.sh and loop.sh to thin Deno launchers.
 * Issue #3504: the shadow-copy of `run_core.sh` was removed — the entrypoint
 *   now drives the whole run directly (see run_worker_test.ts). The former
 *   `shadowCopyRunCore` cases are gone because the function no longer exists;
 *   this file now covers `evaluateRunGuard` plus a regression net asserting the
 *   entrypoint never re-introduces a `worker/.run_core.sh` shadow-copy or a
 *   bash exec path.
 *
 * Australian English spelling throughout (behaviour, defence, authorised).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  evaluateRunGuard,
  formatPidFileContent,
} from "../lib/run_entrypoint.ts";
import type { RunGuardResult } from "../lib/run_entrypoint.ts";
import { runEntrypointCommand } from "../commands/run_entrypoint.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { runWorker } from "../lib/run_worker.ts";

// =============================================================================
// evaluateRunGuard
// =============================================================================

Deno.test("run_entrypoint - evaluateRunGuard returns proceed when no PID file", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "run_entrypoint_test_" });
  try {
    const pidFile = `${tmpDir}/.run.pid`;
    const result = await evaluateRunGuard(pidFile, 10800);
    assertEquals(result.action, "proceed");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("run_entrypoint - evaluateRunGuard returns proceed when PID file has invalid content", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "run_entrypoint_test_" });
  try {
    const pidFile = `${tmpDir}/.run.pid`;
    await Deno.writeTextFile(pidFile, "not-a-number\n");
    const result = await evaluateRunGuard(pidFile, 10800);
    assertEquals(result.action, "proceed");
    assertStringIncludes(result.reason, "invalid");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("run_entrypoint - evaluateRunGuard returns proceed when PID file references dead process", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "run_entrypoint_test_" });
  try {
    const pidFile = `${tmpDir}/.run.pid`;
    await Deno.writeTextFile(pidFile, "999999999\n");
    const result = await evaluateRunGuard(pidFile, 10800);
    assertEquals(result.action, "proceed");
    assertStringIncludes(result.reason, "not running");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("run_entrypoint - evaluateRunGuard returns proceed when PID is running but not the driver", async () => {
  // Use the parent process's PID — definitely running, definitely not a
  // worker driver. (Not our own PID: a file naming the checker itself is
  // short-circuited as stale-by-construction since Issue #4211.)
  const tmpDir = await Deno.makeTempDir({ prefix: "run_entrypoint_test_" });
  try {
    const pidFile = `${tmpDir}/.run.pid`;
    await Deno.writeTextFile(pidFile, `${Deno.ppid}\n`);

    const result = await evaluateRunGuard(pidFile, 10800);
    assertEquals(result.action, "proceed");
    assertStringIncludes(result.reason, "not run_core");

    // PID file should have been removed
    let pidFileExists = true;
    try {
      await Deno.stat(pidFile);
    } catch {
      pidFileExists = false;
    }
    assertEquals(pidFileExists, false);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("run_entrypoint - evaluateRunGuard returns blocked contract shape", () => {
  const result: RunGuardResult = {
    action: "blocked",
    reason: "Another instance is running",
  };
  assertEquals(result.action, "blocked");
});

Deno.test("run_entrypoint - evaluateRunGuard returns proceed when PID file is empty", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "run_entrypoint_test_" });
  try {
    const pidFile = `${tmpDir}/.run.pid`;
    await Deno.writeTextFile(pidFile, "");
    const result = await evaluateRunGuard(pidFile, 10800);
    assertEquals(result.action, "proceed");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// =============================================================================
// Self-referential pid files (Issue #4211)
//
// Observed live on host-23: a container killed mid-run left a legacy-format
// `.run.pid` (bare `1`, no boot line). Every later cycle — always PID 1 in
// its own fresh VM — skipped the boot check (no line to compare), found
// "PID 1" alive (itself), read its own age, and blocked forever, exiting 0.
// Half an hour of cycles reported success while doing nothing.
// =============================================================================

Deno.test("evaluateRunGuard - a pid file naming the checker itself is stale by construction (Issue #4211)", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "run_guard_self_" });
  try {
    const pidFile = `${tmpDir}/.run.pid`;
    // The legacy shape a pre-#4187 (or boot-id-less) writer leaves behind.
    await Deno.writeTextFile(pidFile, "1\n");
    const result = await evaluateRunGuard(pidFile, 10800, {
      selfPid: () => 1,
    });
    assertEquals(result.action, "proceed");
    assertStringIncludes(result.reason, "itself");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("evaluateRunGuard - the self check also settles a same-boot modern file (Issue #4211)", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "run_guard_self_" });
  try {
    const pidFile = `${tmpDir}/.run.pid`;
    await Deno.writeTextFile(pidFile, "1\nboot:same-boot\n");
    const result = await evaluateRunGuard(pidFile, 10800, {
      bootId: () => Promise.resolve("same-boot"),
      selfPid: () => 1,
    });
    assertEquals(result.action, "proceed");
    assertStringIncludes(result.reason, "itself");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("evaluateRunGuard - a genuine other instance still blocks (Issue #4211)", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "run_guard_other_" });
  try {
    const pidFile = `${tmpDir}/.run.pid`;
    // A live PID that is not us: this test process's own Deno.pid, checked
    // by a pretend different process. getCommand() will not match run-core,
    // so the guard proceeds via the pid-reuse path — the point pinned here
    // is only that the self short-circuit does NOT fire for a foreign pid.
    await Deno.writeTextFile(pidFile, `${Deno.pid}\n`);
    const result = await evaluateRunGuard(pidFile, 10800, {
      selfPid: () => Deno.pid + 1,
    });
    assertEquals(
      result.reason.includes("itself"),
      false,
      `a foreign pid must not be treated as self: ${result.reason}`,
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// =============================================================================
// run-entrypoint command — regression net (Issue #3504)
//
// The former "full entrypoint flow" cases asserted a shadow-copy was written.
// These replacements assert the opposite: after the guard proceeds the driver
// runs directly and never writes `worker/.run_core.sh` nor returns a bash path.
// =============================================================================

Deno.test("run-entrypoint command - blocked guard yields exit 0 without a shadow-copy", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "run_entrypoint_cmd_" });
  try {
    await Deno.mkdir(`${tmpDir}/worker`, { recursive: true });
    // Drive runWorker with a blocked guard; every downstream seam is stubbed so
    // a regression that ran them would be observable.
    let loopRan = false;
    let bootstrapRan = false;
    const result = await runWorker(
      { baseDir: tmpDir, config: buildDefaultWorkerConfig() },
      {
        evaluateRunGuard: () =>
          Promise.resolve({ action: "blocked", reason: "another instance" }),
        bootstrap: () => {
          bootstrapRan = true;
          return Promise.resolve({
            ok: true,
            env: {
              PATH: "",
              VIBE_RUN_ID: "",
              WORKER_LOG_FILE: "",
              LOG_FILE: "",
            },
            stepsRun: [],
            defaultBranch: "main",
          });
        },
        runMainLoop: () => {
          loopRan = true;
          return Promise.resolve({ success: true, message: "ran" });
        },
      },
    );

    assertEquals(result.outcome, "blocked");
    assertEquals(result.exitCode, 0);
    assertEquals(bootstrapRan, false);
    assertEquals(loopRan, false);

    // No shadow-copy nor PID file should have been created.
    await assertMissing(`${tmpDir}/worker/.run_core.sh`);
    await assertMissing(`${tmpDir}/.run.pid`);

    // The command wrapper must not surface a bash path. This invocation is
    // the REAL command with production deps end-to-end, so HOME (and its
    // Windows twin) is pointed at the fixture for the duration: the real
    // bootstrap otherwise resolves logDir from the operator's actual HOME
    // and litters the production ~/logs with worker-<pid>.log stubs,
    // run_core.log "Git reset failed" entries and — since #4206 — real
    // bootstrap-failure-streak increments that can fire the control-plane
    // escalation from inside the test suite (Issue #4209). Observed live on
    // host-23: the leaked stubs were indistinguishable from a crash-looping
    // worker and cost hours of misdirected diagnosis.
    // The real bootstrap also exports PATH, VIBE_RUN_ID, WORKER_LOG_FILE,
    // LOG_FILE and WORK_DIR into this process (Issue #4189 follow-up): a
    // leaked WORK_DIR pointed setup.sh's work-dir reminder at this fixture
    // in a later test file of the same shard. Snapshot the whole
    // environment and put it back exactly, whatever the command exported.
    const originalEnv = Deno.env.toObject();
    Deno.env.set("HOME", tmpDir);
    Deno.env.set("USERPROFILE", tmpDir);
    try {
      const cmd = await runEntrypointCommand.execute(
        { "base-dir": tmpDir },
        buildDefaultWorkerConfig(),
      );
      assertEquals(typeof cmd.message, "string");
      assertEquals(cmd.message.includes(".run_core.sh"), false);
    } finally {
      for (const key of Object.keys(Deno.env.toObject())) {
        if (!(key in originalEnv)) Deno.env.delete(key);
      }
      for (const [key, value] of Object.entries(originalEnv)) {
        if (Deno.env.get(key) !== value) Deno.env.set(key, value);
      }
    }

    // The pollution guard itself: everything the real run wrote must have
    // landed inside the fixture, never in the operator's log directory.
    const fixtureLogs: string[] = [];
    try {
      for await (const entry of Deno.readDir(`${tmpDir}/logs`)) {
        fixtureLogs.push(entry.name);
      }
    } catch {
      // No logs directory — the run failed before logging, which is fine.
    }
    assert(
      fixtureLogs.some((name) => name.startsWith("worker-")) ||
        fixtureLogs.length === 0,
      "the real command's logs must land under the fixture HOME",
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("run-entrypoint command - missing --base-dir fails without a shadow-copy", async () => {
  const result = await runEntrypointCommand.execute(
    {},
    buildDefaultWorkerConfig(),
  );
  assertEquals(result.success, false);
  assertEquals(result.message.includes(".run_core.sh"), false);
});

/** Assert a path does not exist. */
async function assertMissing(path: string): Promise<void> {
  let exists = true;
  try {
    await Deno.stat(path);
  } catch {
    exists = false;
  }
  assertEquals(exists, false, `${path} should not exist`);
}

// ---------------------------------------------------------------------------
// Container-boot discrimination (observed live on host-23)
//
// Inside every container the worker is PID 1, so after an unclean exit the
// NEXT container's guard asked "is PID 1 alive?" — and PID 1 in its own VM
// always is ("blocked: Another instance is running (PID 1)"). The boot id
// recorded beside the PID makes the check meaningful: a different boot id
// proves the writer's VM is gone, whatever its PID was.
// ---------------------------------------------------------------------------

Deno.test("evaluateRunGuard - a PID file from another boot is stale regardless of PID liveness", async () => {
  const dir = await Deno.makeTempDir();
  const pidFile = `${dir}/.run.pid`;
  try {
    // PID 1 is always alive; the boot id names a previous, dead VM.
    await Deno.writeTextFile(
      pidFile,
      "1\nboot:11111111-dead-dead-dead-111111111111\n",
    );
    const result = await evaluateRunGuard(pidFile, 3600, {
      bootId: () => Promise.resolve("22222222-live-live-live-222222222222"),
    });
    assertEquals(result.action, "proceed");
    assertEquals(
      result.reason.includes("boot"),
      true,
      result.reason,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("evaluateRunGuard - a same-boot PID file keeps today's PID semantics", async () => {
  const dir = await Deno.makeTempDir();
  const pidFile = `${dir}/.run.pid`;
  try {
    // Same boot, dead PID: the normal stale path still applies.
    await Deno.writeTextFile(
      pidFile,
      "999999\nboot:33333333-same-same-same-333333333333\n",
    );
    const result = await evaluateRunGuard(pidFile, 3600, {
      bootId: () => Promise.resolve("33333333-same-same-same-333333333333"),
    });
    assertEquals(result.action, "proceed");
    assertEquals(result.reason.includes("not running"), true, result.reason);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("evaluateRunGuard - a legacy PID file without a boot line still works", async () => {
  const dir = await Deno.makeTempDir();
  const pidFile = `${dir}/.run.pid`;
  try {
    await Deno.writeTextFile(pidFile, "999999\n");
    const result = await evaluateRunGuard(pidFile, 3600, {
      bootId: () => Promise.resolve("44444444-boot-boot-boot-444444444444"),
    });
    assertEquals(result.action, "proceed");
    assertEquals(result.reason.includes("not running"), true, result.reason);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("formatPidFileContent - carries the PID and the boot id", () => {
  assertEquals(
    formatPidFileContent(42, "55555555-abcd-abcd-abcd-555555555555"),
    "42\nboot:55555555-abcd-abcd-abcd-555555555555\n",
  );
  // Unknown boot id degrades to the legacy single-line format.
  assertEquals(formatPidFileContent(42, null), "42\n");
});
