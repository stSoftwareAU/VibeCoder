/**
 * Tests for the run-housekeeping command (Issue #3502).
 *
 * CLI-specific tests only — orchestration unit tests live in
 * run_housekeeping_test.ts. Covers metadata, the unknown-operation guard, and
 * the one-shot `cleanup` operation removing a real PID file.
 *
 * Australian English spelling throughout (behaviour, organisation, authorised).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { runHousekeepingCommand } from "../commands/run_housekeeping.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { WorkerConfig } from "../types.ts";

function createMockConfig(): WorkerConfig {
  return buildDefaultWorkerConfig();
}

/**
 * A live PID that really is childless, for the two `cleanup` tests.
 *
 * `cleanup` drives the production path, so it fires a real SIGTERM — then a
 * real SIGKILL after a bounded wait — at every descendant of the PID it is
 * given. `Deno.pid` was that PID, on the stated grounds that the test process
 * is childless. Under `deno test --parallel` it is not: every test file runs
 * inside one process (`Deno.pid` is identical across concurrently running
 * files), so the test process's descendants are the subprocesses of whichever
 * files happen to be running alongside this one, and the sweep killed them.
 *
 * That is what turned the callback suites red under a full parallel pass with
 * `exit 143` — SIGTERM — on hooks that had done nothing wrong: three of four
 * consecutive `--parallel` runs over `run_callbacks_integration_test.ts`,
 * `callback_conformance_test.ts` and this file, against none once this file
 * stopped signalling its siblings (Issue #1055).
 *
 * A `sleep` of our own restores the property the tests were written to rely
 * on: it is alive, it has no descendants of its own, and terminate-descendants
 * is the genuine no-op the assertions assume. It is spawned in this process's
 * own group — never `setsid` — so nothing here can become a group signal.
 */
async function withChildlessPid(
  body: (pid: number) => Promise<void>,
): Promise<void> {
  const child = new Deno.Command("sleep", {
    args: ["30"],
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).spawn();
  try {
    await body(child.pid);
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone — the status below still reaps it.
    }
    await child.status;
  }
}

Deno.test("run-housekeeping command - has correct name", () => {
  assertEquals(runHousekeepingCommand.name, "run-housekeeping");
});

Deno.test("run-housekeeping command - has a description", () => {
  assertEquals(typeof runHousekeepingCommand.description, "string");
  assertEquals(runHousekeepingCommand.description.length > 0, true);
});

Deno.test("run-housekeeping command - rejects an unknown operation", async () => {
  const result = await runHousekeepingCommand.execute(
    { operation: "frobnicate" },
    createMockConfig(),
  );
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "Unknown run-housekeeping operation");
});

Deno.test("run-housekeeping command - cleanup removes an existing PID file", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "run_housekeeping_cmd_" });
  const pidFile = `${tmpDir}/.run.pid`;
  try {
    // A live but childless PID so terminate-descendants is a no-op and the
    // assertion focuses on PID-file removal — see `withChildlessPid`.
    await withChildlessPid(async (pid) => {
      await Deno.writeTextFile(pidFile, `${pid}\n`);

      const result = await runHousekeepingCommand.execute(
        { operation: "cleanup", pid, "pid-file": pidFile },
        createMockConfig(),
      );

      assertEquals(result.success, true);
      // The PID file was removed.
      let stillExists = true;
      try {
        await Deno.stat(pidFile);
      } catch {
        stillExists = false;
      }
      assertEquals(stillExists, false);
    });
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("run-housekeeping command - cleanup tolerates a missing PID file", async () => {
  await withChildlessPid(async (pid) => {
    const result = await runHousekeepingCommand.execute(
      {
        operation: "cleanup",
        pid,
        "pid-file": "/tmp/does-not-exist-3502.pid",
      },
      createMockConfig(),
    );
    assertEquals(result.success, true);
  });
});
