/**
 * Tests for run_housekeeping.ts — startup housekeeping orchestration and
 * signal-driven cleanup (Issue #3502).
 *
 * Covers the canonical housekeeping order, best-effort failure handling (a
 * failing/throwing step is logged loud but never aborts the sequence), the
 * one-shot signal cleanup (terminate descendants + remove PID file), and the
 * Deno signal-handler install/dispose path.
 *
 * Australian English spelling throughout (behaviour, organisation, authorised).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildHousekeepingSteps,
  CLEANUP_SIGNALS,
  createDefaultHousekeepingDeps,
  HOUSEKEEPING_STEP_IDS,
  type HousekeepingDeps,
  type HousekeepingOptions,
  installCleanupHandlers,
  runSignalCleanup,
  runStartupHousekeeping,
  type SignalHandlerDeps,
  sweepVolatileCliState,
} from "../lib/run_housekeeping.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { DEFAULT_SIDE_REPO_MAX_AGE_DAYS } from "../lib/work_volume_tiers.ts";
import {
  DEFAULT_HARD_CAP_COUNT,
  DEFAULT_MAX_AGE_DAYS,
} from "../lib/worker_log_cleanup.ts";

function baseOptions(
  overrides: Partial<HousekeepingOptions> = {},
): HousekeepingOptions {
  return {
    workDir: "/tmp/work",
    logDir: "/tmp/logs",
    tmpDir: "/tmp",
    defaultBranch: "Develop",
    githubUser: "vibe-bot",
    ...overrides,
  };
}

/**
 * Build a recording dependency set. Every step appends its id to `order` and
 * successes are returned by default, so tests can assert the sequence without
 * dispatching to the real commands.
 */
function recordingDeps(
  order: string[],
  logs: string[],
  overrides: Partial<HousekeepingDeps> = {},
): HousekeepingDeps {
  return {
    runStep: (step, _config) => {
      order.push(step.id);
      return Promise.resolve({ success: true, message: `${step.id} ok` });
    },
    log: (msg) => logs.push(`log:${msg}`),
    logError: (msg) => logs.push(`err:${msg}`),
    ...overrides,
  };
}

Deno.test("buildHousekeepingSteps - produces the canonical order", () => {
  const steps = buildHousekeepingSteps(baseOptions());
  assertEquals(steps.map((s) => s.id), [...HOUSEKEEPING_STEP_IDS]);
});

Deno.test("buildHousekeepingSteps - wires directories and branch into args", () => {
  const steps = buildHousekeepingSteps(
    baseOptions({ workDir: "/w", logDir: "/l", tmpDir: "/t" }),
  );
  const argOf = (id: string, key: string): unknown =>
    steps.find((s) => s.id === id)?.args[key];

  assertEquals(argOf("disk-space", "work-dir"), "/w");
  assertEquals(argOf("log-rotation", "log-dir"), "/l");
  assertEquals(argOf("cleanup-stale-temp-files", "directory"), "/t");
  assertEquals(argOf("stale-workdir", "work-dir"), "/w");
  assertEquals(argOf("worktree-cleanup", "work-dir"), "/w");
  assertEquals(argOf("session-sweep", "work-dir"), "/w");
  assertEquals(
    argOf("branch-cleanup-orphaned", "operation"),
    "cleanup-orphaned",
  );
  assertEquals(argOf("branch-cleanup-orphaned", "default-branch"), "Develop");
  assertEquals(argOf("branch-cleanup-stale", "operation"), "cleanup-stale");
  assertEquals(argOf("branch-cleanup-stale", "github-user"), "vibe-bot");
});

Deno.test("runStartupHousekeeping - runs every step in canonical order", async () => {
  const order: string[] = [];
  const logs: string[] = [];
  const result = await runStartupHousekeeping(
    baseOptions(),
    buildDefaultWorkerConfig(),
    recordingDeps(order, logs),
  );

  assertEquals(order, [...HOUSEKEEPING_STEP_IDS]);
  assertEquals(result.stepsRun, [...HOUSEKEEPING_STEP_IDS]);
  assertEquals(result.failures, []);
});

Deno.test("runStartupHousekeeping - a failing step is logged loud but does not abort", async () => {
  const order: string[] = [];
  const logs: string[] = [];
  const result = await runStartupHousekeeping(
    baseOptions(),
    buildDefaultWorkerConfig(),
    recordingDeps(order, logs, {
      runStep: (step) => {
        order.push(step.id);
        if (step.id === "worktree-cleanup") {
          return Promise.resolve({ success: false, message: "prune failed" });
        }
        return Promise.resolve({ success: true, message: "ok" });
      },
    }),
  );

  // All steps still ran, in order — the failure did not short-circuit.
  assertEquals(order, [...HOUSEKEEPING_STEP_IDS]);
  assertEquals(result.failures, ["worktree-cleanup"]);
  // The failure was logged loud (Issue #3234), not swallowed silently.
  const errLine = logs.find((l) => l.startsWith("err:"));
  assertStringIncludes(errLine ?? "", "worktree-cleanup failed");
  assertStringIncludes(errLine ?? "", "prune failed");
});

Deno.test("runStartupHousekeeping - a throwing step is caught and recorded as failure", async () => {
  const order: string[] = [];
  const logs: string[] = [];
  const result = await runStartupHousekeeping(
    baseOptions(),
    buildDefaultWorkerConfig(),
    recordingDeps(order, logs, {
      runStep: (step) => {
        order.push(step.id);
        if (step.id === "disk-space") {
          throw new Error("boom");
        }
        return Promise.resolve({ success: true, message: "ok" });
      },
    }),
  );

  assertEquals(order, [...HOUSEKEEPING_STEP_IDS]);
  assertEquals(result.failures, ["disk-space"]);
  const diskResult = result.results.find((r) => r.id === "disk-space");
  assertEquals(diskResult?.success, false);
  assertStringIncludes(diskResult?.message ?? "", "boom");
});

Deno.test("runSignalCleanup - terminates descendants and removes the PID file", async () => {
  let terminatedPid = -1;
  let removedPath = "";
  const logs: string[] = [];

  await runSignalCleanup(
    { selfPid: 4242, pidFile: "/tmp/x.pid", maxWaitSeconds: 3 },
    {
      terminateDescendants: (pid, _maxWait) => {
        terminatedPid = pid;
        return Promise.resolve({
          targetedPids: [111],
          message: "Terminated 1 descendant process(es)",
        });
      },
      removeFile: (path) => {
        removedPath = path;
        return Promise.resolve();
      },
      log: (msg) => logs.push(msg),
    },
  );

  assertEquals(terminatedPid, 4242);
  assertEquals(removedPath, "/tmp/x.pid");
});

Deno.test("runSignalCleanup - skips PID removal when no pidFile given", async () => {
  let removeCalled = false;
  await runSignalCleanup(
    { selfPid: 4242 },
    {
      terminateDescendants: () =>
        Promise.resolve({ targetedPids: [], message: "No descendants found" }),
      removeFile: () => {
        removeCalled = true;
        return Promise.resolve();
      },
      log: () => {},
    },
  );
  assertEquals(removeCalled, false);
});

Deno.test("runSignalCleanup - a terminate failure does not throw (best-effort)", async () => {
  const logs: string[] = [];
  await runSignalCleanup(
    { selfPid: 1, pidFile: "/tmp/y.pid" },
    {
      terminateDescendants: () => {
        throw new Error("ps exploded");
      },
      removeFile: () => Promise.resolve(),
      log: (msg) => logs.push(msg),
    },
  );
  // Still logged the failure and continued to remove the PID file.
  assertStringIncludes(logs.join("\n"), "terminate-descendants failed");
  assertStringIncludes(logs.join("\n"), "removed PID file /tmp/y.pid");
});

Deno.test("installCleanupHandlers - registers and disposes SIGINT/SIGTERM handlers", () => {
  const added: string[] = [];
  const removed: string[] = [];
  const registry = new Map<string, () => void>();

  const deps: Partial<SignalHandlerDeps> = {
    addSignalListener: (signal, handler) => {
      added.push(signal);
      registry.set(signal, handler);
    },
    removeSignalListener: (signal) => {
      removed.push(signal);
    },
    terminateDescendants: () =>
      Promise.resolve({ targetedPids: [], message: "none" }),
    removeFile: () => Promise.resolve(),
    log: () => {},
    exit: () => {},
  };

  const dispose = installCleanupHandlers({ selfPid: 99 }, deps);
  assertEquals(added.sort(), [...CLEANUP_SIGNALS].sort());

  dispose();
  assertEquals(removed.sort(), [...CLEANUP_SIGNALS].sort());
});

Deno.test("installCleanupHandlers - handler runs cleanup then exits with signal code", async () => {
  let terminated = false;
  let exitCode = -1;
  const registry = new Map<string, () => void>();
  let resolveExit: () => void;
  const exited = new Promise<void>((r) => (resolveExit = r));

  const deps: Partial<SignalHandlerDeps> = {
    addSignalListener: (signal, handler) => registry.set(signal, handler),
    removeSignalListener: () => {},
    terminateDescendants: (pid) => {
      terminated = pid === 77;
      return Promise.resolve({ targetedPids: [], message: "none" });
    },
    removeFile: () => Promise.resolve(),
    log: () => {},
    exit: (code) => {
      exitCode = code;
      resolveExit();
    },
  };

  installCleanupHandlers({ selfPid: 77, pidFile: "/tmp/z.pid" }, deps);

  // Simulate a SIGTERM delivery.
  registry.get("SIGTERM")!();
  await exited;

  assertEquals(terminated, true);
  assertEquals(exitCode, 143);
});

// --- Worker-log retention (Issue #4027) ------------------------------------

Deno.test("buildHousekeepingSteps - includes the worker-log-cleanup step", () => {
  // Regression (Issue #4027): the Deno housekeeping migration dropped the
  // age-based worker-log retention that run_core.sh used to invoke, so old
  // worker-PID.log files were never deleted.
  assertEquals(HOUSEKEEPING_STEP_IDS.includes("worker-log-cleanup"), true);

  const steps = buildHousekeepingSteps(baseOptions({ logDir: "/l" }));
  const step = steps.find((s) => s.id === "worker-log-cleanup");
  assertEquals(step?.command, "worker-log-cleanup");
  assertEquals(step?.args["log-dir"], "/l");
  // The retention window stays at the documented 3 days.
  assertEquals(step?.args["max-age-days"], DEFAULT_MAX_AGE_DAYS);
  assertEquals(step?.args["hard-cap-count"], DEFAULT_HARD_CAP_COUNT);
});

Deno.test("buildHousekeepingSteps - worker-log-cleanup honours env overrides", () => {
  const previousAge = Deno.env.get("WORKER_LOG_MAX_AGE_DAYS");
  const previousCap = Deno.env.get("WORKER_LOG_HARD_CAP_COUNT");
  Deno.env.set("WORKER_LOG_MAX_AGE_DAYS", "7");
  Deno.env.set("WORKER_LOG_HARD_CAP_COUNT", "50");
  try {
    const step = buildHousekeepingSteps(baseOptions())
      .find((s) => s.id === "worker-log-cleanup");
    assertEquals(step?.args["max-age-days"], 7);
    assertEquals(step?.args["hard-cap-count"], 50);
  } finally {
    if (previousAge === undefined) {
      Deno.env.delete("WORKER_LOG_MAX_AGE_DAYS");
    } else {
      Deno.env.set("WORKER_LOG_MAX_AGE_DAYS", previousAge);
    }
    if (previousCap === undefined) {
      Deno.env.delete("WORKER_LOG_HARD_CAP_COUNT");
    } else {
      Deno.env.set("WORKER_LOG_HARD_CAP_COUNT", previousCap);
    }
  }
});

Deno.test("runStartupHousekeeping - deletes an over-age worker log end to end", async () => {
  const logDir = await Deno.makeTempDir({ prefix: "housekeeping-logs-" });
  try {
    const stale = `${logDir}/worker-4027.log.gz`;
    await Deno.writeTextFile(stale, "x".repeat(5000));
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    await Deno.utime(stale, old, old);

    // Run only the worker-log-cleanup step through the real command dispatch.
    const step = buildHousekeepingSteps(baseOptions({ logDir }))
      .find((s) => s.id === "worker-log-cleanup")!;
    const deps = createDefaultHousekeepingDeps();
    const outcome = await deps.runStep(step, buildDefaultWorkerConfig());

    assertEquals(outcome.success, true);
    let exists = true;
    try {
      await Deno.stat(stale);
    } catch {
      exists = false;
    }
    assertEquals(exists, false);
  } finally {
    await Deno.remove(logDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Volatile CLI runtime state sweep (Issue #4245)
// ---------------------------------------------------------------------------

Deno.test("sweepVolatileCliState - container mode removes dead-run registries, keeps transcripts (Issue #4245)", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "cli_state_sweep_" });
  try {
    const cfg = `${workDir}/.claude-config`;
    for (
      const sub of [
        "sessions",
        "session-env",
        "shell-snapshots",
        "tasks",
        "projects",
      ]
    ) {
      await Deno.mkdir(`${cfg}/${sub}`, { recursive: true });
    }
    // The pid-keyed session record observed live: dead generations' records
    // describe recycled PIDs in every fresh VM.
    await Deno.writeTextFile(
      `${cfg}/sessions/54728.json`,
      '{"pid":54728,"procStart":"307923"}',
    );
    await Deno.writeTextFile(`${cfg}/projects/transcript.jsonl`, "{}\n");

    const summary = await sweepVolatileCliState(
      workDir,
      (name) => (name === "VIBE_IMAGE_AGENT_PROVIDERS" ? "claude" : undefined),
    );

    assertStringIncludes(summary, "swept dead-run CLI state");
    for (const sub of ["sessions", "session-env", "shell-snapshots", "tasks"]) {
      let gone = false;
      try {
        await Deno.stat(`${cfg}/${sub}`);
      } catch {
        gone = true;
      }
      assertEquals(gone, true, `${sub} must be swept`);
    }
    // The transcripts survive: they are what #4171 made durable on purpose.
    assertEquals(
      (await Deno.stat(`${cfg}/projects/transcript.jsonl`)).isFile,
      true,
    );
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("sweepVolatileCliState - outside the worker container the CLI state is left alone (Issue #4245)", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "cli_state_host_" });
  try {
    await Deno.mkdir(`${workDir}/.claude-config/sessions`, { recursive: true });
    // A host-side invocation (no image stamp): not this process's to sweep.
    const summary = await sweepVolatileCliState(workDir, () => undefined);
    assertStringIncludes(summary, "not inside the worker container");
    assertEquals(
      (await Deno.stat(`${workDir}/.claude-config/sessions`)).isDirectory,
      true,
    );
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

// --- Two-tier work volume (Issue #242) -------------------------------------

Deno.test("buildHousekeepingSteps - ages the work root's disposable tier out", () => {
  assertEquals(HOUSEKEEPING_STEP_IDS.includes("work-volume-tiers"), true);
  // It runs beside the artefact prune, after it.
  assertEquals(
    HOUSEKEEPING_STEP_IDS.indexOf("work-volume-tiers"),
    HOUSEKEEPING_STEP_IDS.indexOf("work-volume-prune") + 1,
  );

  const step = buildHousekeepingSteps(baseOptions({ workDir: "/w" }))
    .find((s) => s.id === "work-volume-tiers");
  assertEquals(step?.command, "work-volume-tiers");
  assertEquals(step?.args["work-dir"], "/w");
  assertEquals(step?.args["mode"], "age");
  assertEquals(step?.args["max-age-days"], DEFAULT_SIDE_REPO_MAX_AGE_DAYS);
});

Deno.test("buildHousekeepingSteps - work-volume-tiers honours its env override", () => {
  const previous = Deno.env.get("WORK_VOLUME_SIDE_REPO_MAX_AGE_DAYS");
  Deno.env.set("WORK_VOLUME_SIDE_REPO_MAX_AGE_DAYS", "7");
  try {
    const step = buildHousekeepingSteps(baseOptions())
      .find((s) => s.id === "work-volume-tiers");
    assertEquals(step?.args["max-age-days"], 7);
  } finally {
    if (previous === undefined) {
      Deno.env.delete("WORK_VOLUME_SIDE_REPO_MAX_AGE_DAYS");
    } else {
      Deno.env.set("WORK_VOLUME_SIDE_REPO_MAX_AGE_DAYS", previous);
    }
  }
});
