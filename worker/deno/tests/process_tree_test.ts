/**
 * Tests for the test-harness process-tree kill (Issue #399).
 *
 * The leak this encodes: a supervisor spawned by a test forks its own
 * children, and `Deno.ChildProcess.kill()` reaches only the root. The
 * survivors are re-parented to PID 1 and loop for ever — twenty orphaned
 * `loop.sh` trees had accumulated on one fleet host, the oldest over two
 * days old.
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { isRunning } from "../lib/pid_guard.ts";
import { killProcessTree } from "./fixtures/process_tree.ts";

/** Read a pid a spawned script wrote, or null while it has not yet. */
async function readPid(path: string): Promise<number | null> {
  try {
    const raw = (await Deno.readTextFile(path)).trim();
    const pid = parseInt(raw, 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

/** Wait — bounded — for a pid file to appear, giving up rather than spinning. */
async function waitForPid(path: string): Promise<number | null> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const pid = await readPid(path);
    if (pid !== null) return pid;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

/** Wait — bounded — for a pid to disappear. */
async function waitForExit(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (!(await isRunning(pid))) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

Deno.test({
  name:
    "killProcessTree - a grandchild of the killed process does not survive (Issue #399)",
  ignore: Deno.build.os === "windows",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const tmpDir = await Deno.makeTempDir({ prefix: "vibe_process_tree_" });
    const childPidFile = `${tmpDir}/child.pid`;
    const grandchildPidFile = `${tmpDir}/grandchild.pid`;

    // A root that forks a child, which forks a grandchild — the shape of
    // loop.sh's background probe running beside its run.sh.
    const script = [
      "#!/bin/bash",
      `bash -c 'echo $$ > "${childPidFile}"; ` +
      `bash -c "echo \\$\\$ > \\"${grandchildPidFile}\\"; exec sleep 300" & ` +
      `wait' &`,
      "exec sleep 300",
    ].join("\n");
    const scriptPath = `${tmpDir}/root.sh`;
    await Deno.writeTextFile(scriptPath, script);
    await Deno.chmod(scriptPath, 0o755);

    const child = new Deno.Command("bash", {
      args: [scriptPath],
      stdout: "piped",
      stderr: "piped",
    }).spawn();

    try {
      const childPid = await waitForPid(childPidFile);
      const grandchildPid = await waitForPid(grandchildPidFile);
      assert(childPid !== null, "the child never started");
      assert(grandchildPid !== null, "the grandchild never started");
      assertEquals(
        await isRunning(grandchildPid),
        true,
        "the grandchild should be running before the kill",
      );

      await killProcessTree(child);

      assertEquals(
        await waitForExit(child.pid),
        true,
        "the root must be gone",
      );
      assertEquals(
        await waitForExit(childPid),
        true,
        "the child must not outlive the root",
      );
      assertEquals(
        await waitForExit(grandchildPid),
        true,
        `the grandchild (pid ${grandchildPid}) was orphaned, not killed`,
      );
    } finally {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name: "killProcessTree - a process with no descendants is killed cleanly",
  ignore: Deno.build.os === "windows",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const child = new Deno.Command("bash", {
      args: ["-c", "sleep 300"],
      stdout: "piped",
      stderr: "piped",
    }).spawn();

    await killProcessTree(child);

    assertEquals(
      await waitForExit(child.pid),
      true,
      "a childless process must still be terminated",
    );
  },
});
