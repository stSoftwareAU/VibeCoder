/**
 * Signal-cleanup integration test (Issue #3502).
 *
 * Spawns the entrypoint fixture (which installs the Deno SIGINT/SIGTERM cleanup
 * handlers and holds a long-lived child process), sends each signal, and
 * asserts that the descendant is terminated and the PID file removed — the
 * acceptance criteria for replacing the bash `cleanup_on_exit` trap with Deno
 * signal handlers. Ctrl-C (SIGINT) and SIGTERM are both covered.
 *
 * Australian English spelling throughout (behaviour, organisation, authorised).
 */

import { assertEquals } from "@std/assert";
import { isRunning } from "../lib/pid_guard.ts";

const FIXTURE = new URL(
  "./fixtures/signal_cleanup_entrypoint.ts",
  import.meta.url,
).pathname;

/** Poll until `predicate` is true or the timeout elapses. */
async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 10000,
  intervalMs = 100,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

/** Whether a path exists on disk. */
async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function runSignalCleanupScenario(
  signal: Deno.Signal,
): Promise<void> {
  const tmpDir = await Deno.makeTempDir({ prefix: "signal_cleanup_" });
  const pidFile = `${tmpDir}/.run.pid`;
  const childPidFile = `${tmpDir}/child.pid`;
  const readyFile = `${tmpDir}/ready`;

  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", FIXTURE, pidFile, childPidFile, readyFile],
    stdout: "null",
    stderr: "null",
  });
  const proc = cmd.spawn();

  try {
    // Wait for the fixture to finish wiring up.
    const ready = await waitFor(() => exists(readyFile));
    assertEquals(ready, true, "fixture failed to become ready");

    const childPid = parseInt(
      (await Deno.readTextFile(childPidFile)).trim(),
      10,
    );
    // The descendant is alive before the signal.
    assertEquals(
      await isRunning(childPid),
      true,
      "child not running pre-signal",
    );

    // Deliver the signal — the Deno handler performs the cleanup.
    proc.kill(signal);
    await proc.status;

    // The PID file was removed by the Deno cleanup handler.
    assertEquals(
      await exists(pidFile),
      false,
      "PID file was not removed on cleanup",
    );

    // The descendant was terminated (no orphaned child left behind).
    const childGone = await waitFor(async () => !(await isRunning(childPid)));
    assertEquals(childGone, true, "descendant was not terminated");
  } finally {
    // Best-effort teardown if the assertions bailed early.
    try {
      proc.kill("SIGKILL");
    } catch {
      // Already exited.
    }
    try {
      await proc.status;
    } catch {
      // Already reaped.
    }
    await Deno.remove(tmpDir, { recursive: true });
  }
}

Deno.test("signal cleanup - SIGTERM terminates descendants and removes PID file", async () => {
  await runSignalCleanupScenario("SIGTERM");
});

Deno.test("signal cleanup - SIGINT terminates descendants and removes PID file", async () => {
  await runSignalCleanupScenario("SIGINT");
});
