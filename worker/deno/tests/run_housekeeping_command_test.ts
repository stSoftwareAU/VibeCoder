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
import { isRunning } from "../lib/pid_guard.ts";
import { reap, withChildlessPid } from "./support/childless_pid.ts";
import type { WorkerConfig } from "../types.ts";

function createMockConfig(): WorkerConfig {
  return buildDefaultWorkerConfig();
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

Deno.test("run-housekeeping command - cleanup touches only the pid it was given (Issue #1055)", async () => {
  // A bystander: the shape of another suite's subprocess, alive in this same
  // test process while the sweep runs. It is what the sweep reached when the
  // pid it was given was the shared one.
  const bystander = new Deno.Command("sleep", {
    args: ["30"],
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).spawn();
  try {
    await withChildlessPid(async (pid) => {
      const result = await runHousekeepingCommand.execute(
        { operation: "cleanup", pid },
        createMockConfig(),
      );
      assertEquals(result.success, true);
    });

    assertEquals(
      await isRunning(bystander.pid),
      true,
      "the sweep reached a process it was not given",
    );
  } finally {
    await reap(bystander);
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
