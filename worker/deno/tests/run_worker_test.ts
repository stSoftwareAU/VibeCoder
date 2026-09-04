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
  checkWorkerCredentials,
  cleanupWaitSeconds,
  runWorker,
  type RunWorkerDeps,
} from "../lib/run_worker.ts";
import { createClaudeBudgetTokenSelector } from "../lib/claude_token_selection.ts";
import {
  CLAUDE_PROVIDER_ID,
  resolveAgentProvider,
} from "../lib/agent_provider.ts";
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
    stepsRun: [
      "path",
      "run-id",
      "log-init",
      "default-branch",
      "software-update",
    ],
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
          stepsRun: ["path", "run-id", "log-init"],
          error: "worker log initialisation failed",
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
// The PID file never lands in the read-only checkout (Issue #514)
// =============================================================================

Deno.test("runWorker - guards, claims and cleans up a PID file in the log directory, never in the checkout (Issue #514)", async () => {
  const rec = newRecorder();
  const seen: Record<string, string> = {};
  await runWorker(
    baseOptions(),
    stubDeps(rec, {
      evaluateRunGuard: (pidFile) => {
        seen.guard = pidFile;
        return Promise.resolve({ action: "proceed", reason: "no PID file" });
      },
      claimPidFile: (pidFile) => {
        seen.claim = pidFile;
        return Promise.resolve();
      },
      cleanup: (pidFile) => {
        seen.cleanup = pidFile;
        return Promise.resolve();
      },
    }),
  );

  // /workspace is mounted read-only, so a PID file under the checkout is an
  // EROFS failure on every containerised launch. All three seams must agree
  // on the log-directory path.
  assertEquals(seen.guard, "/home/worker/logs/.run.pid");
  assertEquals(seen.claim, "/home/worker/logs/.run.pid");
  assertEquals(seen.cleanup, "/home/worker/logs/.run.pid");
  for (const [seam, path] of Object.entries(seen)) {
    assert(
      !path.startsWith("/repo"),
      `${seam} must not put the PID file in the checkout: ${path}`,
    );
  }
});

Deno.test("runWorker - the real claimPidFile writes into a log directory that does not exist yet (Issue #514)", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "run_worker_pid_" });
  try {
    const rec = newRecorder();
    // No `logs` directory: a first-ever host run reaches the claim before the
    // bootstrap's log init creates one, so the production seam must make it.
    const deps = stubDeps(rec);
    delete (deps as Partial<RunWorkerDeps>).claimPidFile;
    await runWorker(
      {
        baseDir: `${tmpDir}/checkout`,
        config: buildDefaultWorkerConfig(),
        pid: 4242,
        env: (name: string) => ({ HOME: tmpDir }[name]),
      },
      deps,
    );

    const written = await Deno.readTextFile(`${tmpDir}/logs/.run.pid`);
    assertEquals(written.split("\n")[0], "4242");
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

// ---------------------------------------------------------------------------
// Credential preflight wiring: budget-based token selection at worker start
// (Issue #919, parent #902)
//
// What was broken: worker start always exported whichever Claude token
// discovery listed first, so a host with two subscriptions burned one to
// exhaustion while the other sat idle. These tests pin the wiring — the winner
// of the budget probe is the token the run actually carries, the decision is
// taken exactly once per process start, a single-token host still makes no
// request at all, and no token value reaches a log line.
// ---------------------------------------------------------------------------

/** A `200` carrying one well-formed five-hour window, per Issue #918. */
function budgetHeaders(utilisation: number): Response {
  return new Response(JSON.stringify({ content: [] }), {
    headers: {
      "anthropic-ratelimit-unified-5h-utilization": String(utilisation),
      "anthropic-ratelimit-unified-5h-reset": "1788483600",
      "anthropic-ratelimit-unified-representative-claim": "five_hour",
    },
  });
}

/**
 * Provision a credential directory holding a gh token and the given Claude
 * token files, then run `fn` against it. Nothing here mutates process state:
 * the directory, the environment lookup and the setter are all injected.
 */
async function withClaudeTokenPool(
  files: Record<string, string>,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "run_worker_919_" });
  const dir = `${root}/credentials`;
  await Deno.mkdir(`${dir}/gh`, { recursive: true });
  await Deno.mkdir(`${dir}/claude`, { recursive: true });
  await Deno.writeTextFile(
    `${dir}/gh/hosts.yml`,
    "github.com:\n    oauth_token: gho_worker\n",
  );
  for (const [name, content] of Object.entries(files)) {
    await Deno.writeTextFile(`${dir}/claude/${name}`, content);
  }
  if (Deno.build.os !== "windows") {
    await Deno.chmod(`${dir}/gh/hosts.yml`, 0o600);
    for (const name of Object.keys(files)) {
      await Deno.chmod(`${dir}/claude/${name}`, 0o600);
    }
  }
  try {
    await fn(dir);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

/** An OAuth credential file for the pool. */
const oauthFile = (value: string) => `CLAUDE_CODE_OAUTH_TOKEN=${value}\n`;

/** Count probe requests and answer each bearer with its own utilisation. */
function poolFetch(utilisation: Record<string, number>) {
  const bearers: string[] = [];
  return {
    calls: () => bearers.length,
    fetchFn: (_url: string, init: RequestInit) => {
      const headers = (init.headers ?? {}) as Record<string, string>;
      const bearer = (headers["authorization"] ?? "").replace("Bearer ", "");
      bearers.push(bearer);
      return Promise.resolve(budgetHeaders(utilisation[bearer] ?? 1));
    },
  };
}

Deno.test("worker start exports the Claude token with the most remaining budget (Issue #919)", async () => {
  await withClaudeTokenPool({
    "provider.env": oauthFile("tok-primary"),
    "provider-2.env": oauthFile("tok-second"),
    "provider-3.env": oauthFile("tok-third"),
  }, async (dir) => {
    // The primary is nearly spent; provider-3 has the most headroom left.
    const fetcher = poolFetch({
      "tok-primary": 0.97,
      "tok-second": 0.55,
      "tok-third": 0.11,
    });
    const exported: Record<string, string> = {};
    const logs: string[] = [];

    const failure = await checkWorkerCredentials({
      dir,
      env: () => undefined,
      setEnv: (name, value) => {
        exported[name] = value;
      },
      providers: [resolveAgentProvider(CLAUDE_PROVIDER_ID)],
      log: (line) => logs.push(line),
      selectToken: createClaudeBudgetTokenSelector({
        fetchFn: fetcher.fetchFn,
        now: () => Date.UTC(2026, 8, 4),
        log: (line) => logs.push(line),
      }),
    });

    assertEquals(failure, null, "the preflight passed");
    assertEquals(exported["CLAUDE_CODE_OAUTH_TOKEN"], "tok-third");
    assertEquals(fetcher.calls(), 3, "exactly one request per token");
    assert(
      logs.some((line) => line.includes("selected provider-3 (#3) of 3")),
      `the decision was logged: ${logs.join("\n")}`,
    );
  });
});

Deno.test("worker start selects the token once and never re-selects during the run (Issue #919)", async () => {
  await withClaudeTokenPool({
    "provider.env": oauthFile("tok-primary"),
    "provider-2.env": oauthFile("tok-second"),
  }, async (dir) => {
    const fetcher = poolFetch({ "tok-primary": 0.9, "tok-second": 0.2 });
    const logs: string[] = [];
    const selectToken = createClaudeBudgetTokenSelector({
      fetchFn: fetcher.fetchFn,
      now: () => Date.UTC(2026, 8, 4),
      log: (line) => logs.push(line),
    });
    const run = async () => {
      const exported: Record<string, string> = {};
      await checkWorkerCredentials({
        dir,
        env: () => undefined,
        setEnv: (name, value) => {
          exported[name] = value;
        },
        providers: [resolveAgentProvider(CLAUDE_PROVIDER_ID)],
        selectToken,
      });
      return exported["CLAUDE_CODE_OAUTH_TOKEN"];
    };

    assertEquals(await run(), "tok-second");
    const afterStartup = fetcher.calls();
    const decisions = logs.filter((l) => l.includes("selected")).length;
    // Anything later in the run reuses the startup decision: no second round
    // of probes, and the same token for the whole run.
    assertEquals(await run(), "tok-second");
    assertEquals(fetcher.calls(), afterStartup, "no second round of probes");
    assertEquals(decisions, 1, "selection happened exactly once");
    assertEquals(
      logs.filter((l) => l.includes("selected")).length,
      1,
      "and still exactly once after the second call",
    );
  });
});

Deno.test("a single-token host makes no budget request at worker start (Issue #919)", async () => {
  await withClaudeTokenPool({
    "provider.env": oauthFile("tok-only"),
  }, async (dir) => {
    const fetcher = poolFetch({ "tok-only": 0.5 });
    const exported: Record<string, string> = {};
    const logs: string[] = [];

    const failure = await checkWorkerCredentials({
      dir,
      env: () => undefined,
      setEnv: (name, value) => {
        exported[name] = value;
      },
      providers: [resolveAgentProvider(CLAUDE_PROVIDER_ID)],
      log: (line) => logs.push(line),
      selectToken: createClaudeBudgetTokenSelector({
        fetchFn: fetcher.fetchFn,
        now: () => Date.UTC(2026, 8, 4),
        log: (line) => logs.push(line),
      }),
    });

    assertEquals(failure, null);
    assertEquals(exported["CLAUDE_CODE_OAUTH_TOKEN"], "tok-only");
    assertEquals(fetcher.calls(), 0, "nothing to choose between — no request");
    assertEquals(
      logs.filter((l) => l.includes("claude token")).length,
      0,
      "startup is byte-for-byte what it was",
    );
  });
});

Deno.test("no Claude token value reaches worker-start logs (Issue #919)", async () => {
  const alpha = "sk-ant-oat01-ALPHA-STARTUP-TOKEN-919";
  const beta = "sk-ant-oat01-BETA-STARTUP-TOKEN-919";
  await withClaudeTokenPool({
    "provider.env": oauthFile(alpha),
    "provider-2.env": oauthFile(beta),
  }, async (dir) => {
    const fetcher = poolFetch({ [alpha]: 0.8, [beta]: 0.1 });
    const logs: string[] = [];

    await checkWorkerCredentials({
      dir,
      env: () => undefined,
      setEnv: () => {},
      providers: [resolveAgentProvider(CLAUDE_PROVIDER_ID)],
      log: (line) => logs.push(line),
      selectToken: createClaudeBudgetTokenSelector({
        fetchFn: fetcher.fetchFn,
        now: () => Date.UTC(2026, 8, 4),
        log: (line) => logs.push(line),
      }),
    });

    const captured = logs.join("\n");
    assert(captured.includes("selected provider-2"), captured);
    for (const value of [alpha, beta]) {
      assert(!captured.includes(value), `a token value leaked: ${captured}`);
      assert(
        !captured.includes(value.slice(0, 20)),
        `a token prefix leaked: ${captured}`,
      );
      assert(
        !captured.includes(value.slice(-20)),
        `a token suffix leaked: ${captured}`,
      );
    }
  });
});
