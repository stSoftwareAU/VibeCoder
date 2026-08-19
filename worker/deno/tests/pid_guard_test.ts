/**
 * Tests for pid_guard.ts — PID-file guard and process management utilities.
 *
 * Issue #903: Migrate pid_guard.sh to Deno TypeScript.
 * Covers: trim, isRunning, getCommand, isExpectedRunCoreCommand,
 *         parseEtimeToSeconds, getElapsedSeconds, getDescendants,
 *         terminateDescendants, checkPidFile.
 *
 * Australian English spelling throughout (behaviour, defence, authorised).
 */

import { assertEquals } from "@std/assert";
import {
  checkPidFile,
  getCommand,
  getDescendants,
  getElapsedSeconds,
  isExpectedRunCoreCommand,
  isRunning,
  parseEtimeToSeconds,
  type PgidCommandResult,
  terminateDescendants,
  terminateProcessTree,
  type TerminateProcessTreeDeps,
  trim,
} from "../lib/pid_guard.ts";

// =============================================================================
// trim
// =============================================================================

Deno.test("pid_guard - trim removes leading whitespace", () => {
  assertEquals(trim("  hello"), "hello");
});

Deno.test("pid_guard - trim removes trailing whitespace", () => {
  assertEquals(trim("hello  "), "hello");
});

Deno.test("pid_guard - trim removes both leading and trailing whitespace", () => {
  assertEquals(trim("  hello  "), "hello");
});

Deno.test("pid_guard - trim preserves internal whitespace", () => {
  assertEquals(trim("  hello world  "), "hello world");
});

Deno.test("pid_guard - trim handles empty string", () => {
  assertEquals(trim(""), "");
});

Deno.test("pid_guard - trim handles all whitespace", () => {
  assertEquals(trim("   "), "");
});

// =============================================================================
// isRunning
// =============================================================================

Deno.test("pid_guard - isRunning returns true for current process", async () => {
  const result = await isRunning(Deno.pid);
  assertEquals(result, true);
});

Deno.test("pid_guard - isRunning returns false for non-existent PID", async () => {
  const result = await isRunning(999999999);
  assertEquals(result, false);
});

// =============================================================================
// getCommand
// =============================================================================

Deno.test("pid_guard - getCommand returns non-empty for current process", async () => {
  const command = await getCommand(Deno.pid);
  assertEquals(typeof command, "string");
  assertEquals(command.length > 0, true);
});

Deno.test("pid_guard - getCommand returns empty for non-existent PID", async () => {
  const command = await getCommand(999999999);
  assertEquals(command, "");
});

// =============================================================================
// isExpectedRunCoreCommand
// =============================================================================

Deno.test("pid_guard - isExpectedRunCoreCommand matches bash .run_core.sh", () => {
  assertEquals(
    isExpectedRunCoreCommand("bash /path/to/worker/.run_core.sh"),
    true,
  );
});

Deno.test("pid_guard - isExpectedRunCoreCommand matches bash run_core.sh", () => {
  assertEquals(
    isExpectedRunCoreCommand("bash /path/to/worker/run_core.sh"),
    true,
  );
});

Deno.test("pid_guard - isExpectedRunCoreCommand matches /bin/bash .run_core.sh", () => {
  assertEquals(
    isExpectedRunCoreCommand("/bin/bash /path/to/worker/.run_core.sh"),
    true,
  );
});

Deno.test("pid_guard - isExpectedRunCoreCommand matches /bin/bash run_core.sh", () => {
  assertEquals(
    isExpectedRunCoreCommand("/bin/bash /path/to/worker/run_core.sh"),
    true,
  );
});

Deno.test("pid_guard - isExpectedRunCoreCommand matches direct .run_core.sh path", () => {
  assertEquals(
    isExpectedRunCoreCommand("/home/user/project/worker/.run_core.sh"),
    true,
  );
});

Deno.test("pid_guard - isExpectedRunCoreCommand matches direct run_core.sh path", () => {
  assertEquals(
    isExpectedRunCoreCommand("/home/user/project/worker/run_core.sh"),
    true,
  );
});

Deno.test("pid_guard - isExpectedRunCoreCommand matches relative worker/run_core.sh", () => {
  assertEquals(
    isExpectedRunCoreCommand("worker/run_core.sh"),
    true,
  );
});

Deno.test("pid_guard - isExpectedRunCoreCommand rejects empty string", () => {
  assertEquals(isExpectedRunCoreCommand(""), false);
});

Deno.test("pid_guard - isExpectedRunCoreCommand rejects unrelated command", () => {
  assertEquals(isExpectedRunCoreCommand("node server.js"), false);
});

Deno.test("pid_guard - isExpectedRunCoreCommand rejects partial match", () => {
  assertEquals(isExpectedRunCoreCommand("run_core"), false);
});

// Issue #3504: the runtime driver is now the Deno `run-entrypoint` command,
// so a previous run's PID belongs to `deno run … mod.ts run-entrypoint …`.
Deno.test("pid_guard - isExpectedRunCoreCommand matches Deno run-entrypoint driver", () => {
  assertEquals(
    isExpectedRunCoreCommand(
      "deno run --allow-env /home/user/project/worker/deno/mod.ts " +
        "run-entrypoint --base-dir /home/user/project",
    ),
    true,
  );
});

Deno.test("pid_guard - isExpectedRunCoreCommand matches bare mod.ts run-entrypoint", () => {
  assertEquals(
    isExpectedRunCoreCommand("mod.ts run-entrypoint --base-dir /repo"),
    true,
  );
});

Deno.test("pid_guard - isExpectedRunCoreCommand rejects unrelated deno command", () => {
  assertEquals(
    isExpectedRunCoreCommand("deno run mod.ts version"),
    false,
  );
});

// =============================================================================
// parseEtimeToSeconds
// =============================================================================

Deno.test("pid_guard - parseEtimeToSeconds parses MM:SS format", () => {
  assertEquals(parseEtimeToSeconds("05:30"), 330);
});

Deno.test("pid_guard - parseEtimeToSeconds parses HH:MM:SS format", () => {
  assertEquals(parseEtimeToSeconds("1:30:00"), 5400);
});

Deno.test("pid_guard - parseEtimeToSeconds parses DAYS-HH:MM:SS format", () => {
  assertEquals(parseEtimeToSeconds("2-12:00:00"), 216000);
});

Deno.test("pid_guard - parseEtimeToSeconds returns null for empty string", () => {
  assertEquals(parseEtimeToSeconds(""), null);
});

Deno.test("pid_guard - parseEtimeToSeconds returns null for invalid format", () => {
  assertEquals(parseEtimeToSeconds("not-a-time"), null);
});

Deno.test("pid_guard - parseEtimeToSeconds handles whitespace", () => {
  assertEquals(parseEtimeToSeconds("  05:30  "), 330);
});

Deno.test("pid_guard - parseEtimeToSeconds parses 00:00 as zero", () => {
  assertEquals(parseEtimeToSeconds("00:00"), 0);
});

Deno.test("pid_guard - parseEtimeToSeconds parses 1-00:00:00 as one day", () => {
  assertEquals(parseEtimeToSeconds("1-00:00:00"), 86400);
});

Deno.test("pid_guard - parseEtimeToSeconds returns null for whitespace only", () => {
  assertEquals(parseEtimeToSeconds("   "), null);
});

// =============================================================================
// getElapsedSeconds
// =============================================================================

Deno.test("pid_guard - getElapsedSeconds returns a number for current process", async () => {
  const seconds = await getElapsedSeconds(Deno.pid);
  // Should return a number (or null on unusual systems)
  if (seconds !== null) {
    assertEquals(typeof seconds, "number");
    assertEquals(seconds >= 0, true);
  }
});

Deno.test("pid_guard - getElapsedSeconds returns null for non-existent PID", async () => {
  const seconds = await getElapsedSeconds(999999999);
  assertEquals(seconds, null);
});

// =============================================================================
// getDescendants
// =============================================================================

Deno.test("pid_guard - getDescendants returns empty for non-existent PID", async () => {
  const descendants = await getDescendants(999999999);
  assertEquals(descendants, []);
});

Deno.test("pid_guard - getDescendants respects max depth", async () => {
  // Depth 20 should return empty immediately
  const descendants = await getDescendants(Deno.pid, 20);
  assertEquals(descendants, []);
});

Deno.test("pid_guard - getDescendants returns array of numbers", async () => {
  const descendants = await getDescendants(Deno.pid);
  assertEquals(Array.isArray(descendants), true);
  for (const pid of descendants) {
    assertEquals(typeof pid, "number");
    assertEquals(pid > 0, true);
  }
});

// =============================================================================
// terminateDescendants
// =============================================================================

Deno.test("pid_guard - terminateDescendants returns empty for non-existent PID", async () => {
  const result = await terminateDescendants(999999999);
  assertEquals(result.targetedPids, []);
  assertEquals(result.message, "No descendants found");
});

// =============================================================================
// checkPidFile
// =============================================================================

Deno.test("pid_guard - checkPidFile returns canProceed for non-existent file", async () => {
  const result = await checkPidFile("/tmp/nonexistent-pid-file-test-903");
  assertEquals(result.canProceed, true);
});

Deno.test("pid_guard - checkPidFile detects running process", async () => {
  const tmpFile = await Deno.makeTempFile();
  try {
    // Write our own PID (which is running)
    await Deno.writeTextFile(tmpFile, `${Deno.pid}\n`);
    const result = await checkPidFile(tmpFile);
    assertEquals(result.canProceed, false);
    assertEquals(result.existingPid, Deno.pid);
  } finally {
    await Deno.remove(tmpFile);
  }
});

Deno.test("pid_guard - checkPidFile detects stale PID file", async () => {
  const tmpFile = await Deno.makeTempFile();
  try {
    await Deno.writeTextFile(tmpFile, "999999999\n");
    const result = await checkPidFile(tmpFile);
    assertEquals(result.canProceed, true);
    assertEquals(result.existingPid, 999999999);
  } finally {
    await Deno.remove(tmpFile);
  }
});

Deno.test("pid_guard - checkPidFile handles invalid PID content", async () => {
  const tmpFile = await Deno.makeTempFile();
  try {
    await Deno.writeTextFile(tmpFile, "not-a-pid\n");
    const result = await checkPidFile(tmpFile);
    assertEquals(result.canProceed, true);
  } finally {
    await Deno.remove(tmpFile);
  }
});

Deno.test("pid_guard - checkPidFile handles empty file", async () => {
  const tmpFile = await Deno.makeTempFile();
  try {
    await Deno.writeTextFile(tmpFile, "");
    const result = await checkPidFile(tmpFile);
    assertEquals(result.canProceed, true);
  } finally {
    await Deno.remove(tmpFile);
  }
});

// =============================================================================
// terminateProcessTree (Issue #3284)
//
// WHAT-tests: inject fake command/signal/running/sleep seams and assert
// observable behaviour (which signals were sent to which target) without
// spawning real processes or waiting real seconds.
// =============================================================================

/** A signal sent during a test, captured for assertion. */
interface SentSignal {
  target: number;
  signal: string;
}

/**
 * Build a fake dependency set for terminateProcessTree.
 *
 * @param opts.pgidOutput - Raw stdout the fake `ps` returns for the pgid lookup
 * @param opts.pgidSuccess - Whether the fake `ps` invocation "succeeded"
 * @param opts.runningSequence - `isRunning` return values, consumed in order;
 *   the last value repeats once the sequence is exhausted
 * @returns The deps plus the captured `sent` signal log
 */
const FAKE_SELF_PID = 999_999;

function makeFakeDeps(opts: {
  pgidOutput?: string;
  pgidSuccess?: boolean;
  runningSequence: boolean[];
  /** The worker's own pgid as `ps` reports it (Issue #4369). Default "1". */
  ownPgidOutput?: string;
}): { deps: TerminateProcessTreeDeps; sent: SentSignal[] } {
  const sent: SentSignal[] = [];
  const running = [...opts.runningSequence];

  const deps: TerminateProcessTreeDeps = {
    selfPid: FAKE_SELF_PID,
    runPgidCommand: (pid: number): Promise<PgidCommandResult> =>
      Promise.resolve(
        pid === FAKE_SELF_PID
          ? { success: true, stdout: opts.ownPgidOutput ?? "1\n" }
          : {
            success: opts.pgidSuccess ?? true,
            stdout: opts.pgidOutput ?? "",
          },
      ),
    sendSignal: (target: number, signal: string): Promise<void> => {
      sent.push({ target, signal });
      return Promise.resolve();
    },
    isRunning: (_pid: number): Promise<boolean> => {
      const next = running.length > 1 ? running.shift()! : running[0] ?? false;
      return Promise.resolve(next);
    },
    // No real waiting — resolve immediately so escalation tests are instant.
    sleep: (_ms: number): Promise<void> => Promise.resolve(),
  };

  return { deps, sent };
}

Deno.test("pid_guard - terminateProcessTree sends SIGTERM to group and process", async () => {
  // Process reports not-running on the first poll, so no SIGKILL follows.
  const { deps, sent } = makeFakeDeps({
    pgidOutput: "4321\n",
    runningSequence: [false],
  });

  await terminateProcessTree(1234, 30, deps);

  // SIGTERM to the process group (-pgid) and to the process itself.
  assertEquals(sent, [
    { target: -4321, signal: "TERM" },
    { target: 1234, signal: "TERM" },
  ]);
});

Deno.test("pid_guard - terminateProcessTree parses whitespace-padded pgid", async () => {
  const { deps, sent } = makeFakeDeps({
    pgidOutput: "   987  \n",
    runningSequence: [false],
  });

  await terminateProcessTree(1234, 30, deps);

  assertEquals(sent[0], { target: -987, signal: "TERM" });
});

Deno.test("pid_guard - terminateProcessTree skips group signal when pgid unparseable", async () => {
  // Non-numeric ps output → no valid pgid → group signals are skipped.
  const { deps, sent } = makeFakeDeps({
    pgidOutput: "not-a-pgid",
    runningSequence: [false],
  });

  await terminateProcessTree(1234, 30, deps);

  assertEquals(sent, [{ target: 1234, signal: "TERM" }]);
});

Deno.test("pid_guard - terminateProcessTree skips group signal when ps fails", async () => {
  const { deps, sent } = makeFakeDeps({
    pgidSuccess: false,
    pgidOutput: "4321",
    runningSequence: [false],
  });

  await terminateProcessTree(1234, 30, deps);

  assertEquals(sent, [{ target: 1234, signal: "TERM" }]);
});

Deno.test("pid_guard - terminateProcessTree ignores non-positive pgid", async () => {
  // A pgid of 0 must never become a group-wide kill target (-0).
  const { deps, sent } = makeFakeDeps({
    pgidOutput: "0",
    runningSequence: [false],
  });

  await terminateProcessTree(1234, 30, deps);

  assertEquals(sent, [{ target: 1234, signal: "TERM" }]);
});

Deno.test("pid_guard - terminateProcessTree does not SIGKILL when process exits during poll", async () => {
  // Alive for the pre-loop escalation guard is never reached: first poll is
  // running, second poll is dead → loop returns before escalation.
  const { deps, sent } = makeFakeDeps({
    pgidOutput: "4321",
    runningSequence: [true, false],
  });

  await terminateProcessTree(1234, 30, deps);

  // Only the two TERM signals — no KILL.
  assertEquals(sent, [
    { target: -4321, signal: "TERM" },
    { target: 1234, signal: "TERM" },
  ]);
  assertEquals(sent.some((s) => s.signal === "KILL"), false);
});

Deno.test("pid_guard - terminateProcessTree escalates to SIGKILL when process never exits", async () => {
  // Always running: the poll loop exhausts, then escalation fires.
  const { deps, sent } = makeFakeDeps({
    pgidOutput: "4321",
    runningSequence: [true],
  });

  await terminateProcessTree(1234, 2, deps);

  assertEquals(sent, [
    { target: -4321, signal: "TERM" },
    { target: 1234, signal: "TERM" },
    { target: -4321, signal: "KILL" },
    { target: 1234, signal: "KILL" },
  ]);
});

Deno.test("pid_guard - terminateProcessTree escalation without pgid kills only the process", async () => {
  // No valid pgid and process never exits → SIGKILL to the process only.
  const { deps, sent } = makeFakeDeps({
    pgidOutput: "",
    runningSequence: [true],
  });

  await terminateProcessTree(1234, 1, deps);

  assertEquals(sent, [
    { target: 1234, signal: "TERM" },
    { target: 1234, signal: "KILL" },
  ]);
});

Deno.test("pid_guard - terminateProcessTree never signals the worker's own process group: a target sharing our pgid gets the pid signal only (Issue #4369)", async () => {
  // A child spawned without setsid shares the worker's pgid; `kill -TERM
  // -<pgid>` would terminate the worker (and the test runner) with it.
  const { deps, sent } = makeFakeDeps({
    pgidOutput: "4321\n",
    ownPgidOutput: "4321\n",
    runningSequence: [false],
  });
  await terminateProcessTree(1234, 30, deps);
  assertEquals(sent, [{ target: 1234, signal: "TERM" }]);
});
