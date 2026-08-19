/**
 * Tests for run_bootstrap.ts — the worker bootstrap prelude (Issue #3501).
 *
 * Covers the canonical prelude order (PATH → run-id → log init → git reset →
 * software-update), that PATH / VIBE_RUN_ID / log-file path are established
 * in-process, fail-loud git-reset handling, the start-of-run compression of
 * prior worker logs (Issue #4027), and the shell-export rendering.
 *
 * Australian English spelling throughout (behaviour, organisation, authorised).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type BootstrapDeps,
  type BootstrapOptions,
  PRELUDE_STEPS,
  resolveOriginDefaultBranch,
  runBootstrap,
  toShellExports,
} from "../lib/run_bootstrap.ts";
import { runGitCommand } from "../lib/git_timeout.ts";
import type { Result } from "../types.ts";
import type { GzipWorkerLogsResult } from "../lib/worker_log_gzip.ts";

/** Build a gzip result with no work done. */
function emptyGzipResult(): GzipWorkerLogsResult {
  return {
    compressed: [],
    skipped: 0,
    failures: [],
    message: "worker log gzip: compressed 0, skipped 0",
  };
}

/** Build baseline options for a bootstrap run. */
function baseOptions(
  overrides: Partial<BootstrapOptions> = {},
): BootstrapOptions {
  return {
    repoDir: "/tmp/repo",
    logDir: "/tmp/logs",
    home: "/home/worker",
    currentPath: "/usr/bin",
    pid: 4242,
    ...overrides,
  };
}

/**
 * Build a recording dependency set. Every step appends its label to `order`
 * and every setEnv call is captured in `env`, so tests can assert both the
 * sequence and the in-process env establishment without real side effects.
 */
function recordingDeps(
  order: string[],
  env: Record<string, string>,
  overrides: Partial<BootstrapDeps> = {},
): BootstrapDeps {
  return {
    resolvePath: (_currentPath, _home, _fallbackPaths) => {
      order.push("resolvePath");
      return Promise.resolve("/bootstrapped/bin:/usr/bin");
    },
    resolveRunId: () => {
      order.push("resolveRunId");
      return "vibe-test-abc123";
    },
    initWorkerLog: (logDir, pid) => {
      order.push("initWorkerLog");
      return Promise.resolve(`${logDir}/worker-${pid}.log`);
    },
    gzipPriorWorkerLogs: (_logDir, _pid) => {
      order.push("gzipPriorWorkerLogs");
      return Promise.resolve(emptyGzipResult());
    },
    appendRunCoreLog: (_logDir, message) => {
      order.push(`log:${message}`);
      return Promise.resolve();
    },
    resolveDefaultBranch: (_repoDir) => {
      order.push("resolveDefaultBranch");
      return Promise.resolve({ ok: true, value: "main" } as Result<string>);
    },
    resetToDefaultBranch: (_repoDir, _branch, _logDir) => {
      order.push("resetToDefaultBranch");
      return Promise.resolve({ ok: true, value: undefined } as Result<void>);
    },
    checkUpdates: (_options) => {
      order.push("checkUpdates");
      return Promise.resolve();
    },
    setEnv: (name, value) => {
      env[name] = value;
    },
    describeCheckoutState: (_repoDir) => {
      order.push("describeCheckoutState");
      return Promise.resolve(null);
    },
    readBootstrapFailureStreak: (_logDir) => {
      order.push("readStreak");
      return Promise.resolve(0);
    },
    writeBootstrapFailureStreak: (_logDir, count) => {
      order.push(`writeStreak:${count}`);
      return Promise.resolve();
    },
    escalateBootstrapFailure: (_context) => {
      order.push("escalate");
      return Promise.resolve();
    },
    ...overrides,
  };
}

/** A resetToDefaultBranch override that always fails. */
function failingReset(order: string[]) {
  return (_repoDir: string, _branch: string, _logDir: string) => {
    order.push("resetToDefaultBranch");
    return Promise.resolve({
      ok: false,
      error: new Error("git checkout Develop failed (exit code 1)"),
    } as Result<void>);
  };
}

Deno.test("runBootstrap - runs prelude steps in canonical order", async () => {
  const order: string[] = [];
  const env: Record<string, string> = {};
  const result = await runBootstrap(baseOptions(), recordingDeps(order, env));

  assertEquals(result.ok, true);
  // Only the significant step markers, in sequence.
  const steps = order.filter((o) => !o.startsWith("log:"));
  assertEquals(steps, [
    "resolvePath",
    "resolveRunId",
    "initWorkerLog",
    "gzipPriorWorkerLogs",
    // No branch named: the checkout's own origin/HEAD is consulted first.
    "resolveDefaultBranch",
    "resetToDefaultBranch",
    // A successful reset ends any bootstrap-failure streak (Issue #4204).
    "writeStreak:0",
    "checkUpdates",
  ]);
  assertEquals(result.stepsRun, [...PRELUDE_STEPS]);
});

Deno.test("runBootstrap - establishes PATH, VIBE_RUN_ID, log path in-process", async () => {
  const order: string[] = [];
  const env: Record<string, string> = {};
  const result = await runBootstrap(baseOptions(), recordingDeps(order, env));

  // Env is set via setEnv (in-process), not merely returned.
  assertEquals(env["PATH"], "/bootstrapped/bin:/usr/bin");
  assertEquals(env["VIBE_RUN_ID"], "vibe-test-abc123");
  assertEquals(env["WORKER_LOG_FILE"], "/tmp/logs/worker-4242.log");
  assertEquals(env["LOG_FILE"], "/tmp/logs/worker-4242.log");

  // Returned env mirrors what was established.
  assertEquals(result.env.PATH, "/bootstrapped/bin:/usr/bin");
  assertEquals(result.env.VIBE_RUN_ID, "vibe-test-abc123");
  assertEquals(result.env.WORKER_LOG_FILE, "/tmp/logs/worker-4242.log");
  assertEquals(result.env.LOG_FILE, "/tmp/logs/worker-4242.log");
});

Deno.test("runBootstrap - PATH is bootstrapped before run-id and update check", async () => {
  const order: string[] = [];
  const env: Record<string, string> = {};
  let pathAtUpdateCheck = "";
  const deps = recordingDeps(order, env, {
    checkUpdates: (_options) => {
      order.push("checkUpdates");
      pathAtUpdateCheck = env["PATH"] ?? "";
      return Promise.resolve();
    },
  });

  await runBootstrap(baseOptions(), deps);

  // The update check runs with the bootstrapped PATH already in-process.
  assertEquals(pathAtUpdateCheck, "/bootstrapped/bin:/usr/bin");
});

Deno.test("runBootstrap - fails loud and skips update check when git reset fails", async () => {
  const order: string[] = [];
  const env: Record<string, string> = {};
  const deps = recordingDeps(order, env, {
    resetToDefaultBranch: (_repoDir, _branch, _logDir) => {
      order.push("resetToDefaultBranch");
      return Promise.resolve({
        ok: false,
        error: new Error("git fetch origin failed (exit code 128)"),
      } as Result<void>);
    },
  });

  const result = await runBootstrap(baseOptions(), deps);

  assertEquals(result.ok, false);
  assertStringIncludes(result.error ?? "", "git fetch origin failed");
  // The software-update step must NOT run after a failed reset.
  assertEquals(order.includes("checkUpdates"), false);
  assertEquals(result.stepsRun.includes("software-update"), false);
  // A "Git reset failed" line is logged (now carrying the detail, #4204).
  assertEquals(
    order.some((entry) => entry.startsWith("log:Git reset failed")),
    true,
  );
});

// ---------------------------------------------------------------------------
// Issue #4204 — the worker checkout colliding with an interactive dev tree
// ---------------------------------------------------------------------------

Deno.test("runBootstrap - a reset failure on a development checkout names the collision (Issue #4204)", async () => {
  const order: string[] = [];
  const env: Record<string, string> = {};
  const deps = recordingDeps(order, env, {
    resetToDefaultBranch: failingReset(order),
    describeCheckoutState: (_repoDir) => {
      order.push("describeCheckoutState");
      return Promise.resolve({ branch: "fix/some-feature", dirtyFiles: 3 });
    },
  });

  const result = await runBootstrap(baseOptions(), deps);

  assertEquals(result.ok, false);
  const error = result.error ?? "";
  assertStringIncludes(error, "active development tree");
  assertStringIncludes(error, "fix/some-feature");
  assertStringIncludes(error, "3 uncommitted change");
  assertStringIncludes(error, "4204");
  // The enriched detail reaches run_core.log too, not only the return value.
  assertEquals(
    order.some((entry) =>
      entry.startsWith("log:Git reset failed") &&
      entry.includes("active development tree")
    ),
    true,
  );
});

Deno.test("runBootstrap - a clean on-branch checkout failure keeps the plain git error (Issue #4204)", async () => {
  const order: string[] = [];
  const env: Record<string, string> = {};
  const deps = recordingDeps(order, env, {
    resetToDefaultBranch: failingReset(order),
    describeCheckoutState: (_repoDir) => {
      order.push("describeCheckoutState");
      return Promise.resolve({ branch: "main", dirtyFiles: 0 });
    },
  });

  const result = await runBootstrap(baseOptions(), deps);

  assertEquals(result.ok, false);
  assertEquals(
    (result.error ?? "").includes("active development tree"),
    false,
    "a clean checkout on the default branch is not a dev-tree collision",
  );
});

Deno.test("runBootstrap - the third consecutive reset failure escalates, once (Issue #4204)", async () => {
  // Streak 2 -> this failure makes 3 -> escalate.
  {
    const order: string[] = [];
    const deps = recordingDeps(order, {}, {
      resetToDefaultBranch: failingReset(order),
      readBootstrapFailureStreak: (_logDir) => Promise.resolve(2),
    });
    const result = await runBootstrap(baseOptions(), deps);
    assertEquals(result.ok, false);
    assertEquals(order.includes("writeStreak:3"), true);
    assertEquals(order.includes("escalate"), true);
  }

  // First failure (streak 0 -> 1): no escalation yet.
  {
    const order: string[] = [];
    const deps = recordingDeps(order, {}, {
      resetToDefaultBranch: failingReset(order),
    });
    await runBootstrap(baseOptions(), deps);
    assertEquals(order.includes("writeStreak:1"), true);
    assertEquals(order.includes("escalate"), false);
  }

  // Fourth failure (streak 3 -> 4): already escalated this streak — stay quiet.
  {
    const order: string[] = [];
    const deps = recordingDeps(order, {}, {
      resetToDefaultBranch: failingReset(order),
      readBootstrapFailureStreak: (_logDir) => Promise.resolve(3),
    });
    await runBootstrap(baseOptions(), deps);
    assertEquals(order.includes("writeStreak:4"), true);
    assertEquals(
      order.includes("escalate"),
      false,
      "one escalation per streak — a crash-loop must not spam the repo",
    );
  }
});

Deno.test("runBootstrap - a successful reset clears the failure streak (Issue #4204)", async () => {
  const order: string[] = [];
  const env: Record<string, string> = {};
  const deps = recordingDeps(order, env, {
    readBootstrapFailureStreak: (_logDir) => Promise.resolve(2),
  });

  const result = await runBootstrap(baseOptions(), deps);

  assertEquals(result.ok, true);
  assertEquals(order.includes("writeStreak:0"), true);
});

Deno.test("runBootstrap - escalation problems never mask the bootstrap error (Issue #4204)", async () => {
  const order: string[] = [];
  const deps = recordingDeps(order, {}, {
    resetToDefaultBranch: failingReset(order),
    readBootstrapFailureStreak: (_logDir) => Promise.resolve(2),
    escalateBootstrapFailure: (_context) => {
      order.push("escalate");
      return Promise.reject(new Error("gh is not authenticated"));
    },
  });

  const result = await runBootstrap(baseOptions(), deps);

  assertEquals(result.ok, false);
  assertStringIncludes(result.error ?? "", "git checkout Develop failed");
  // The escalation failure is logged, best-effort, and never thrown.
  assertEquals(
    order.some((entry) =>
      entry.startsWith("log:") && entry.includes("escalation failed")
    ),
    true,
  );
});

Deno.test("runBootstrap - skipSoftwareUpdate omits the update check", async () => {
  const order: string[] = [];
  const env: Record<string, string> = {};
  const result = await runBootstrap(
    baseOptions({ skipSoftwareUpdate: true }),
    recordingDeps(order, env),
  );

  assertEquals(result.ok, true);
  assertEquals(order.includes("checkUpdates"), false);
  assertEquals(result.stepsRun.includes("software-update"), false);
});

Deno.test("runBootstrap - resets to the supplied default branch", async () => {
  const order: string[] = [];
  const env: Record<string, string> = {};
  let resetBranch = "";
  const deps = recordingDeps(order, env, {
    resetToDefaultBranch: (_repoDir, branch, _logDir) => {
      resetBranch = branch;
      return Promise.resolve({ ok: true, value: undefined } as Result<void>);
    },
  });

  await runBootstrap(baseOptions({ defaultBranch: "main" }), deps);
  assertEquals(resetBranch, "main");
});

Deno.test("runBootstrap - with no branch named, resets to the checkout's own origin/HEAD — no repository or branch name is assumed", async () => {
  const order: string[] = [];
  const env: Record<string, string> = {};
  let resetBranch = "";
  const deps = recordingDeps(order, env, {
    resolveDefaultBranch: (_repoDir) =>
      Promise.resolve({ ok: true, value: "release" } as Result<string>),
    resetToDefaultBranch: (_repoDir, branch, _logDir) => {
      resetBranch = branch;
      return Promise.resolve({ ok: true, value: undefined } as Result<void>);
    },
  });

  const result = await runBootstrap(baseOptions(), deps);
  assertEquals(resetBranch, "release");
  assertEquals(result.defaultBranch, "release");
  assertStringIncludes(order.join(","), "log:Resetting repo to origin/release");
});

Deno.test("runBootstrap - a named branch is used as given and origin/HEAD is not consulted", async () => {
  const order: string[] = [];
  const env: Record<string, string> = {};
  const deps = recordingDeps(order, env);

  const result = await runBootstrap(
    baseOptions({ defaultBranch: "main" }),
    deps,
  );
  assertEquals(result.defaultBranch, "main");
  assertEquals(order.includes("resolveDefaultBranch"), false);
});

Deno.test("runBootstrap - an unresolvable default branch fails the prelude loud, naming the escape hatch", async () => {
  const order: string[] = [];
  const env: Record<string, string> = {};
  const deps = recordingDeps(order, env, {
    resolveDefaultBranch: (_repoDir) =>
      Promise.resolve({
        ok: false,
        error: new Error("refs/remotes/origin/HEAD is unset"),
      } as Result<string>),
  });

  const result = await runBootstrap(baseOptions(), deps);
  assertEquals(result.ok, false);
  assertEquals(result.defaultBranch, "");
  assertEquals(order.includes("resetToDefaultBranch"), false);
  assertStringIncludes(
    result.error ?? "",
    "cannot resolve the checkout's default branch",
  );
  assertStringIncludes(result.error ?? "", "origin/HEAD is unset");
  assertStringIncludes(result.error ?? "", "--default-branch");
});

Deno.test("resolveOriginDefaultBranch - reads origin/HEAD, and records it first when the clone lacks it", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    // A bare remote whose default branch is deliberately not one of the
    // usual names, cloned twice: once as git leaves it (origin/HEAD set),
    // once with origin/HEAD removed as an older or hand-made clone would be.
    const remote = `${tmp}/remote.git`;
    const seed = `${tmp}/seed`;
    await runGitCommand(["init", "--bare", "--initial-branch=trunk", remote]);
    await runGitCommand(["init", "--initial-branch=trunk", seed]);
    await Deno.writeTextFile(`${seed}/f`, "x");
    await runGitCommand(["add", "f"], { cwd: seed });
    await runGitCommand(
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "i"],
      { cwd: seed },
    );
    await runGitCommand(["push", remote, "trunk"], { cwd: seed });

    const clone = `${tmp}/clone`;
    await runGitCommand(["clone", "--quiet", remote, clone]);
    const withHead = await resolveOriginDefaultBranch(clone);
    assertEquals(withHead.ok, true);
    if (withHead.ok) assertEquals(withHead.value, "trunk");

    await runGitCommand(
      ["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"],
      { cwd: clone },
    );
    const recovered = await resolveOriginDefaultBranch(clone);
    assertEquals(recovered.ok, true, JSON.stringify(recovered));
    if (recovered.ok) assertEquals(recovered.value, "trunk");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("runBootstrap - initWorkerLog writes a timestamp-named log with a relative symlink (Issue #4227)", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "run_bootstrap_test_" });
  try {
    const order: string[] = [];
    const env: Record<string, string> = {};
    // Use the real initWorkerLog default by only overriding the other deps.
    const deps: Partial<BootstrapDeps> = {
      resolvePath: () => Promise.resolve("/usr/bin"),
      resolveRunId: () => "vibe-real-log",
      appendRunCoreLog: (_logDir, message) => {
        order.push(`log:${message}`);
        return Promise.resolve();
      },
      resetToDefaultBranch: () =>
        Promise.resolve({ ok: true, value: undefined } as Result<void>),
      checkUpdates: () => Promise.resolve(),
      setEnv: (name, value) => {
        env[name] = value;
      },
    };

    const result = await runBootstrap(
      baseOptions({
        logDir: tmpDir,
        pid: 777,
        skipSoftwareUpdate: true,
        // /tmp/repo is not a clone; name the branch so the real resolver
        // (the only default dep left in place besides initWorkerLog) is
        // not consulted.
        defaultBranch: "main",
      }),
      deps,
    );

    assertEquals(result.ok, true);
    // The name is the run's UTC start time, not the PID (Issue #4227): in
    // container mode the worker is always PID 1, so PID-keyed names piled
    // every run into one eternal worker-1.log that rotation never touched.
    const names: string[] = [];
    for await (const entry of Deno.readDir(tmpDir)) {
      if (entry.isFile) names.push(entry.name);
    }
    const logName = names.find((name) =>
      /^worker-\d{8}-\d{6}\.log$/.test(name)
    );
    assert(logName, `no timestamp-named worker log in: ${names.join(", ")}`);
    const content = await Deno.readTextFile(`${tmpDir}/${logName}`);
    // The PID still lives in the header line, where it always was.
    assertStringIncludes(content, "run_core pid=777 start=");
    assertStringIncludes(content, "Worker timestamps are UTC");

    // The worker.log symlink is RELATIVE, so it resolves identically inside
    // the container and on the host's logs mount (the absolute in-container
    // target dangled on the host).
    const linkTarget = await Deno.readLink(`${tmpDir}/worker.log`);
    assertEquals(linkTarget, logName);
    assertStringIncludes(
      await Deno.readTextFile(`${tmpDir}/worker.log`),
      "run_core pid=777",
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("toShellExports - renders eval-safe export lines", () => {
  const exports = toShellExports({
    PATH: "/opt/bin:/usr/bin",
    VIBE_RUN_ID: "vibe-xyz",
    WORKER_LOG_FILE: "/home/worker/logs/worker-9.log",
    LOG_FILE: "/home/worker/logs/worker-9.log",
  });

  assertStringIncludes(exports, "export PATH='/opt/bin:/usr/bin'");
  assertStringIncludes(exports, "export VIBE_RUN_ID='vibe-xyz'");
  assertStringIncludes(
    exports,
    "export WORKER_LOG_FILE='/home/worker/logs/worker-9.log'",
  );
  assertStringIncludes(
    exports,
    "export LOG_FILE='/home/worker/logs/worker-9.log'",
  );
});

Deno.test("toShellExports - escapes embedded single quotes", () => {
  const exports = toShellExports({
    PATH: "/opt/o'brien/bin",
    VIBE_RUN_ID: "vibe-1",
    WORKER_LOG_FILE: "/logs/w.log",
    LOG_FILE: "/logs/w.log",
  });

  // The single quote is escaped so the line evals safely.
  assertStringIncludes(exports, "export PATH='/opt/o'\\''brien/bin'");
});

Deno.test("runBootstrap - gzips prior worker logs after the current log is initialised", async () => {
  const order: string[] = [];
  const env: Record<string, string> = {};
  let seen: { logDir: string; currentLogFile: string } | undefined;
  const deps = recordingDeps(order, env, {
    gzipPriorWorkerLogs: (logDir, currentLogFile) => {
      order.push("gzipPriorWorkerLogs");
      seen = { logDir, currentLogFile };
      return Promise.resolve({
        ...emptyGzipResult(),
        compressed: [`${logDir}/worker-1.log.gz`],
        message: "worker log gzip: compressed 1, skipped 0",
      });
    },
  });

  const result = await runBootstrap(baseOptions(), deps);

  assertEquals(result.ok, true);
  // The compression pass sees the same log directory and the current run's
  // own log FILE (not a PID — every containerised run is PID 1, #4227), so
  // exactly that file is excluded.
  assertEquals(seen?.logDir, "/tmp/logs");
  assertEquals(seen?.currentLogFile, "/tmp/logs/worker-4242.log");
  // It runs after the current run's log file exists.
  assert(
    order.indexOf("initWorkerLog") < order.indexOf("gzipPriorWorkerLogs"),
  );
  // The outcome is recorded in run_core.log.
  assertEquals(
    order.includes("log:worker log gzip: compressed 1, skipped 0"),
    true,
  );
});

Deno.test("runBootstrap - a gzip failure is logged loud but never aborts the prelude", async () => {
  const order: string[] = [];
  const env: Record<string, string> = {};
  const deps = recordingDeps(order, env, {
    gzipPriorWorkerLogs: (_logDir, _pid) => {
      order.push("gzipPriorWorkerLogs");
      return Promise.resolve({
        compressed: [],
        skipped: 0,
        failures: [{ path: "/tmp/logs/worker-7.log", error: "disk full" }],
        message: "worker log gzip: compressed 0, skipped 0, failed 1",
      });
    },
  });

  const result = await runBootstrap(baseOptions(), deps);

  assertEquals(result.ok, true);
  assertEquals(order.includes("checkUpdates"), true);
  const failureLine = order.find((o) => o.includes("worker-7.log"));
  assertStringIncludes(failureLine ?? "", "disk full");
});

Deno.test("runBootstrap - a throwing gzip step does not abort the prelude", async () => {
  const order: string[] = [];
  const env: Record<string, string> = {};
  const deps = recordingDeps(order, env, {
    gzipPriorWorkerLogs: (_logDir, _pid) => {
      order.push("gzipPriorWorkerLogs");
      return Promise.reject(new Error("readDir exploded"));
    },
  });

  const result = await runBootstrap(baseOptions(), deps);

  assertEquals(result.ok, true);
  assertEquals(order.includes("checkUpdates"), true);
  const failureLine = order.find((o) => o.includes("readDir exploded"));
  assertStringIncludes(failureLine ?? "", "worker log gzip");
});
