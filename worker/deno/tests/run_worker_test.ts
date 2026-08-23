/**
 * Tests for run_worker.ts — the full Deno worker driver (Issue #3504).
 *
 * These cover the orchestration order and fail-loud behaviour of the conductor
 * that replaced `worker/run_core.sh`: PID guard → claim → bootstrap → validate
 * → GitHub user → gh scopes → housekeeping → main loop →
 * cleanup. Every side effect is injected so the sequence is asserted without
 * touching git, the process table, or the network.
 *
 * Australian English spelling throughout (behaviour, defence, authorised).
 */

import { assert, assertEquals } from "@std/assert";
import {
  cleanupWaitSeconds,
  runWorker,
  type RunWorkerDeps,
} from "../lib/run_worker.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type {
  BootstrapOptions,
  BootstrapResult,
} from "../lib/run_bootstrap.ts";
import {
  QUOTA_PAUSE_EXIT_STATUS,
  type QuotaPauseMarker,
} from "../lib/quota_pause.ts";

/** Recording harness capturing the order and arguments of every seam. */
interface Recorder {
  calls: string[];
  setEnv: Record<string, string>;
  pidClaimed: number | null;
  cleanupCalled: boolean;
  /** Quota-pause declaration the driver wrote, when it made one (#342). */
  quotaPause?: { dir: string; marker: QuotaPauseMarker };
}

function okBootstrap(): BootstrapResult {
  return {
    ok: true,
    env: {
      PATH: "/bin",
      VIBE_RUN_ID: "run-1",
      VIBE_SIDE_REPO_CLONE_ARGS: "--filter=blob:none",
      WORKER_LOG_FILE: "",
      LOG_FILE: "",
    },
    stepsRun: ["path", "run-id", "log-init", "git-reset", "software-update"],
    defaultBranch: "main",
  };
}

/**
 * Build a fully-stubbed dependency set. Every seam records into `rec`; override
 * individual seams via `over` for the branch under test.
 */
function stubDeps(
  rec: Recorder,
  over: Partial<RunWorkerDeps> = {},
): Partial<RunWorkerDeps> {
  const base: RunWorkerDeps = {
    evaluateRunGuard: () => {
      rec.calls.push("guard");
      return Promise.resolve({ action: "proceed", reason: "no PID file" });
    },
    claimPidFile: (_pidFile, pid) => {
      rec.calls.push("claim");
      rec.pidClaimed = pid;
      return Promise.resolve();
    },
    bootstrap: () => {
      rec.calls.push("bootstrap");
      return Promise.resolve(okBootstrap());
    },
    validateConfig: () => {
      rec.calls.push("validate");
    },
    checkCredentials: () => {
      rec.calls.push("credentials");
      return Promise.resolve(null);
    },
    resolveGithubUser: () => {
      rec.calls.push("github-user");
      return Promise.resolve("octocat");
    },
    assertIdentity: () => {
      rec.calls.push("identity");
      return null;
    },
    logGhScopes: () => {
      rec.calls.push("gh-scopes");
      return Promise.resolve();
    },
    runHousekeeping: () => {
      rec.calls.push("housekeeping");
      return Promise.resolve();
    },
    runMainLoop: () => {
      rec.calls.push("loop");
      return Promise.resolve({ success: true, message: "planned shutdown" });
    },
    declareQuotaPause: (dir, marker) => {
      rec.calls.push("quota-pause");
      rec.quotaPause = { dir, marker };
      return Promise.resolve();
    },
    cleanup: () => {
      rec.calls.push("cleanup");
      rec.cleanupCalled = true;
      return Promise.resolve();
    },
    setEnv: (name, value) => {
      rec.setEnv[name] = value;
    },
    log: () => {},
    logError: () => {},
  };
  return { ...base, ...over };
}

function newRecorder(): Recorder {
  return {
    calls: [],
    setEnv: {},
    pidClaimed: null,
    cleanupCalled: false,
  };
}

const baseOptions = () => ({
  baseDir: "/repo",
  config: buildDefaultWorkerConfig(),
  pid: 4242,
  env: (
    name: string,
  ) => ({ HOME: "/home/worker", PATH: "/bin", WORK_DIR: "/work" }[name]),
});

// =============================================================================
// Blocked guard — exits cleanly, does nothing else.
// =============================================================================

Deno.test("runWorker - blocked guard exits 0 and claims nothing", async () => {
  const rec = newRecorder();
  const result = await runWorker(
    baseOptions(),
    stubDeps(rec, {
      evaluateRunGuard: () => {
        rec.calls.push("guard");
        return Promise.resolve({
          action: "blocked",
          reason: "another instance is running",
        });
      },
    }),
  );

  assertEquals(result.outcome, "blocked");
  assertEquals(result.exitCode, 0);
  // Only the guard ran — no claim, bootstrap, loop, or cleanup.
  assertEquals(rec.calls, ["guard"]);
  assertEquals(rec.pidClaimed, null);
  assertEquals(rec.cleanupCalled, false);
});

// =============================================================================
// Quota pause (Issue #342) — a scheduled stop, declared twice.
// =============================================================================

Deno.test("runWorker - an out-of-quota run exits on its own status and declares the pause", async () => {
  const rec = newRecorder();
  const resetEpochMs = 1_700_000_000_000;
  const result = await runWorker(
    baseOptions(),
    stubDeps(rec, {
      runMainLoop: () => {
        rec.calls.push("loop");
        return Promise.resolve({
          success: true,
          message: "Run complete: Run duration expired",
          quotaPaused: true,
          quotaResetEpochMs: resetEpochMs,
        });
      },
    }),
  );

  // Not "completed": a status shared with a crash is read as a crash.
  assertEquals(result.outcome, "quota-paused");
  assertEquals(result.exitCode, QUOTA_PAUSE_EXIT_STATUS);

  // The durable half of the declaration lands in the host-visible log
  // directory, carrying the reset the supervisor paces its re-probe on.
  assertEquals(rec.quotaPause?.dir, "/home/worker/logs");
  assertEquals(rec.quotaPause?.marker.resetEpochMs, resetEpochMs);
  assertEquals(
    rec.quotaPause?.marker.reason,
    "Run complete: Run duration expired",
  );
  assert(
    (rec.quotaPause?.marker.declaredAtMs ?? 0) > 0,
    "the declaration must be timestamped",
  );
  // Declared before the run tears down, and cleanup still runs.
  assertEquals(rec.calls, [
    "guard",
    "claim",
    "bootstrap",
    "validate",
    "credentials",
    "github-user",
    "identity",
    "gh-scopes",
    "housekeeping",
    "loop",
    "quota-pause",
    "cleanup",
  ]);
});

Deno.test("runWorker - a run that was not out of quota declares nothing", async () => {
  const rec = newRecorder();
  const result = await runWorker(baseOptions(), stubDeps(rec));
  assertEquals(result.outcome, "completed");
  assertEquals(rec.quotaPause, undefined);
});

// =============================================================================
// Happy path — full ordered sequence, cleanup in finally.
// =============================================================================

Deno.test("runWorker - proceed runs the full sequence in order", async () => {
  const rec = newRecorder();
  const result = await runWorker(baseOptions(), stubDeps(rec));

  assertEquals(result.outcome, "completed");
  assertEquals(result.exitCode, 0);
  assertEquals(rec.calls, [
    "guard",
    "claim",
    "bootstrap",
    "validate",
    "credentials",
    "github-user",
    "identity",
    "gh-scopes",
    "housekeeping",
    "loop",
    "cleanup",
  ]);
  assertEquals(rec.pidClaimed, 4242);
  assertEquals(rec.cleanupCalled, true);
  // Baseline environment established before bootstrap.
  assertEquals(rec.setEnv["NO_COLOR"], "true");
  assertEquals(rec.setEnv["GIT_TERMINAL_PROMPT"], "0");
  assertEquals(rec.setEnv["CONFIG_PATH"], "/repo/.config.json");
});

Deno.test("runWorker - applies the optional-feature settings of .config.json before the bootstrap (Issue #535 keys)", async () => {
  const rec = newRecorder();
  const seen: string[] = [];
  await runWorker(
    baseOptions(),
    stubDeps(rec, {
      applyOptionalFeatureEnv: (configPath) => {
        seen.push(configPath);
        rec.calls.push("optional-env");
        return Promise.resolve({});
      },
    }),
  );
  // The config path is the one the driver established for every later Deno
  // command, and the step precedes the bootstrap so the worker sees the
  // variables from its first line.
  assertEquals(seen, ["/repo/.config.json"]);
  assertEquals(
    rec.calls.indexOf("optional-env") < rec.calls.indexOf("bootstrap"),
    true,
    rec.calls.join(","),
  );
});

Deno.test("runWorker - a failing loop surfaces exit 1 but still cleans up", async () => {
  const rec = newRecorder();
  const result = await runWorker(
    baseOptions(),
    stubDeps(rec, {
      runMainLoop: () => {
        rec.calls.push("loop");
        return Promise.resolve({
          success: false,
          message: "exited on failures",
        });
      },
    }),
  );

  assertEquals(result.outcome, "failed");
  assertEquals(result.exitCode, 1);
  assertEquals(rec.cleanupCalled, true);
});

// =============================================================================
// Fail-loud branches — each aborts before the loop but still cleans up.
// =============================================================================

Deno.test("runWorker - bootstrap failure aborts before the loop (fail-loud)", async () => {
  const rec = newRecorder();
  const result = await runWorker(
    baseOptions(),
    stubDeps(rec, {
      bootstrap: () => {
        rec.calls.push("bootstrap");
        return Promise.resolve({
          ok: false,
          env: {
            PATH: "",
            VIBE_RUN_ID: "",
            VIBE_SIDE_REPO_CLONE_ARGS: "",
            WORKER_LOG_FILE: "",
            LOG_FILE: "",
          },
          stepsRun: ["path", "run-id", "log-init", "git-reset"],
          error: "git reset --hard origin/main failed",
          defaultBranch: "main",
        });
      },
    }),
  );

  assertEquals(result.outcome, "bootstrap-failed");
  assertEquals(result.exitCode, 1);
  // Claimed and bootstrapped, then aborted — loop never ran, cleanup still did.
  assertEquals(rec.calls.includes("loop"), false);
  assertEquals(rec.cleanupCalled, true);
});

Deno.test("runWorker - invalid config aborts before the loop (fail-loud)", async () => {
  const rec = newRecorder();
  const result = await runWorker(
    baseOptions(),
    stubDeps(rec, {
      validateConfig: () => {
        rec.calls.push("validate");
        throw new Error("allowed_authors is required");
      },
    }),
  );

  assertEquals(result.outcome, "config-invalid");
  assertEquals(result.exitCode, 1);
  assertEquals(rec.calls.includes("loop"), false);
  assertEquals(rec.cleanupCalled, true);
});

Deno.test("runWorker - missing credentials abort before any work (Issue #4064)", async () => {
  const rec = newRecorder();
  const failure = "Credential preflight failed for /home/worker/" +
    ".vibe-coder/credentials — 3 problem(s): …";
  const result = await runWorker(
    baseOptions(),
    stubDeps(rec, {
      checkCredentials: () => {
        rec.calls.push("credentials");
        return Promise.resolve(failure);
      },
    }),
  );

  assertEquals(result.outcome, "credentials-invalid");
  assertEquals(result.exitCode, 1);
  // The actionable message is carried out for GitHub escalation.
  assertEquals(result.reason, failure);
  // Fail-loud and early: nothing that needs credentials ever ran.
  assertEquals(rec.calls.includes("github-user"), false);
  assertEquals(rec.calls.includes("loop"), false);
  assertEquals(rec.cleanupCalled, true);
});

Deno.test("runWorker - unresolvable GitHub user aborts before the loop (fail-loud)", async () => {
  const rec = newRecorder();
  const result = await runWorker(
    baseOptions(),
    stubDeps(rec, {
      resolveGithubUser: () => {
        rec.calls.push("github-user");
        return Promise.resolve(null);
      },
    }),
  );

  assertEquals(result.outcome, "github-user-failed");
  assertEquals(result.exitCode, 1);
  assertEquals(rec.calls.includes("loop"), false);
  assertEquals(rec.cleanupCalled, true);
});

Deno.test("runWorker - identity mismatch aborts before the loop (Issue #3528)", async () => {
  const rec = newRecorder();
  const result = await runWorker(
    baseOptions(),
    stubDeps(rec, {
      assertIdentity: () => {
        rec.calls.push("identity");
        return "[SECURITY] worker identity MISMATCH on host 'host-x'";
      },
    }),
  );

  assertEquals(result.outcome, "identity-mismatch");
  assertEquals(result.exitCode, 1);
  // Fail-loud: the loop and later write phases never ran.
  assertEquals(rec.calls.includes("loop"), false);
  assertEquals(rec.calls.includes("gh-scopes"), false);
  assertEquals(rec.calls.includes("housekeeping"), false);
  // Cleanup still fired in the finally block.
  assertEquals(rec.cleanupCalled, true);
});

// =============================================================================
// The driver never re-introduces the shadow-copy mechanism.
// =============================================================================

Deno.test("runWorker - never writes a worker/.run_core.sh shadow-copy", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "run_worker_test_" });
  try {
    await Deno.mkdir(`${tmpDir}/worker`, { recursive: true });
    const rec = newRecorder();
    await runWorker(
      {
        baseDir: tmpDir,
        config: buildDefaultWorkerConfig(),
        pid: 5,
        env: (name: string) => ({ HOME: tmpDir }[name]),
      },
      stubDeps(rec),
    );

    let exists = true;
    try {
      await Deno.stat(`${tmpDir}/worker/.run_core.sh`);
    } catch {
      exists = false;
    }
    assertEquals(exists, false);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// =============================================================================
// Software-update opt-outs are forwarded to the bootstrap prelude (Issue #3655)
// =============================================================================

Deno.test("runWorker - forwards the SKIP_* update opt-outs to bootstrap", async () => {
  const rec = newRecorder();
  let seen: BootstrapOptions | null = null;
  const env: Record<string, string> = {
    HOME: "/home/worker",
    PATH: "/bin",
    WORK_DIR: "/work",
    SKIP_CLAUDE_UPDATE: "true",
    SKIP_GH_UPDATE: "true",
    SKIP_DENO_UPDATE: "true",
    VIBE_BUMP_QUARANTINE_HOURS: "48",
  };
  await runWorker(
    { ...baseOptions(), env: (name: string) => env[name] },
    stubDeps(rec, {
      bootstrap: (options) => {
        rec.calls.push("bootstrap");
        seen = options;
        return Promise.resolve(okBootstrap());
      },
    }),
  );

  const options = seen as unknown as BootstrapOptions;
  assertEquals(options.skipSoftwareUpdate, false);
  assertEquals(options.softwareUpdate?.skipClaude, true);
  assertEquals(options.softwareUpdate?.skipGh, true);
  assertEquals(options.softwareUpdate?.skipDeno, true);
  assertEquals(options.softwareUpdate?.quarantineHours, 48);
  assertEquals(options.softwareUpdate?.timestampDir, "/home/worker");
});

Deno.test("runWorker - SKIP_SOFTWARE_UPDATE suppresses the whole update step", async () => {
  const rec = newRecorder();
  let seen: BootstrapOptions | null = null;
  const env: Record<string, string> = {
    HOME: "/home/worker",
    PATH: "/bin",
    SKIP_SOFTWARE_UPDATE: "true",
  };
  await runWorker(
    { ...baseOptions(), env: (name: string) => env[name] },
    stubDeps(rec, {
      bootstrap: (options) => {
        rec.calls.push("bootstrap");
        seen = options;
        return Promise.resolve(okBootstrap());
      },
    }),
  );

  assertEquals((seen as unknown as BootstrapOptions).skipSoftwareUpdate, true);
});

Deno.test("runWorker - forwards the configured version floors", async () => {
  const rec = newRecorder();
  let seen: BootstrapOptions | null = null;
  const config = buildDefaultWorkerConfig();
  await runWorker(
    { ...baseOptions(), config },
    stubDeps(rec, {
      bootstrap: (options) => {
        rec.calls.push("bootstrap");
        seen = options;
        return Promise.resolve(okBootstrap());
      },
    }),
  );

  assertEquals(
    (seen as unknown as BootstrapOptions).softwareUpdate?.minVersions,
    config.softwareMinVersions,
  );
});

// =============================================================================
// Concurrent slots: one driver per checkout, cleanup wait scales (Issue #4182)
// =============================================================================

Deno.test("runWorker - a second driver on the same checkout is still blocked by the PID guard with concurrent slots configured (Issue #4182)", async () => {
  const rec = newRecorder();
  const config = { ...buildDefaultWorkerConfig(), maxConcurrentIssues: 4 };
  const result = await runWorker(
    { ...baseOptions(), config },
    stubDeps(rec, {
      evaluateRunGuard: () => {
        rec.calls.push("guard");
        return Promise.resolve({
          action: "blocked",
          reason: "Another instance is running (PID 4100)",
        });
      },
    }),
  );
  assertEquals(result.outcome, "blocked");
  assertEquals(rec.pidClaimed, null, "the pool never claims a second PID file");
  assertEquals(rec.calls, ["guard"]);
});

Deno.test("runWorker - exit cleanup is told the configured slot count so the descendant wait scales; single-slot stays 5 s (Issue #4182)", async () => {
  const seen: (number | undefined)[] = [];
  const stub = (rec: Recorder) =>
    stubDeps(rec, {
      cleanup: (_pidFile, _pid, liveSlots) => {
        seen.push(liveSlots);
        return Promise.resolve();
      },
    });
  // The default is two slots (VibeCoder#170); pin 1 and 3 explicitly.
  await runWorker(
    {
      ...baseOptions(),
      config: { ...buildDefaultWorkerConfig(), maxConcurrentIssues: 1 },
    },
    stub(newRecorder()),
  );
  await runWorker(
    {
      ...baseOptions(),
      config: { ...buildDefaultWorkerConfig(), maxConcurrentIssues: 3 },
    },
    stub(newRecorder()),
  );
  assertEquals(seen, [1, 3]);
  assertEquals(cleanupWaitSeconds(undefined), 5);
  assertEquals(cleanupWaitSeconds(1), 5);
  assertEquals(cleanupWaitSeconds(3), 15);
  assertEquals(cleanupWaitSeconds(1000), 60, "capped");
});

Deno.test("runWorker - exports WORK_DIR for the run so cache consumers never fall back to HOME (Issue #4370)", async () => {
  const rec = newRecorder();
  await runWorker(baseOptions(), stubDeps(rec));
  assertEquals(rec.setEnv["WORK_DIR"], "/work");
});

// ---------------------------------------------------------------------------
// Issue #4189 — the run mode is recorded durably for the green-gate report
// ---------------------------------------------------------------------------

Deno.test("runWorker - records the resolved run mode with the host and run id after bootstrap (Issue #4189)", async () => {
  const rec = newRecorder();
  const recorded: Array<
    { logDir: string; mode: string; host: string; runId: string }
  > = [];
  const options = baseOptions();
  const result = await runWorker(
    { ...options, config: { ...options.config, runMode: "container" } },
    stubDeps(rec, {
      bootstrap: () => {
        rec.calls.push("bootstrap");
        return Promise.resolve({
          ...okBootstrap(),
          env: {
            PATH: "",
            VIBE_RUN_ID: "vibe-test-run",
            VIBE_SIDE_REPO_CLONE_ARGS: "",
            WORKER_LOG_FILE: "",
            LOG_FILE: "",
          },
        });
      },
      recordRunMode: (record) => {
        recorded.push(record);
        rec.calls.push("record-run-mode");
        return Promise.resolve();
      },
    }),
  );
  assertEquals(result.outcome, "completed");
  assertEquals(recorded.length, 1);
  assertEquals(recorded[0]?.mode, "container");
  assertEquals(recorded[0]?.runId, "vibe-test-run");
  assert((recorded[0]?.host ?? "").length > 0, "a host id is recorded");
  assert(recorded[0]?.logDir.endsWith("/logs"), recorded[0]?.logDir);
  // After bootstrap, before the loop.
  assert(
    rec.calls.indexOf("bootstrap") < rec.calls.indexOf("record-run-mode"),
  );
});
