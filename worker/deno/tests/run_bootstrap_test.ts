/**
 * Tests for run_bootstrap.ts — the worker bootstrap prelude (Issue #3501).
 *
 * Covers the canonical prelude order (PATH → run-id → side-repo clone args →
 * log init → default branch → software-update), that PATH / VIBE_RUN_ID /
 * `VIBE_SIDE_REPO_CLONE_ARGS` (Issue #243) / log-file path are established
 * in-process, that the prelude writes **nothing** to the worker checkout
 * (Issue #513 — the git reset now runs host-side), the start-of-run
 * compression of prior worker logs (Issue #4027), and the shell-export
 * rendering.
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
    logDir: "/tmp/logs",
    candidates: 0,
    compressed: [],
    skipped: 0,
    skippedByReason: { belowSizeFloor: 0, ownerStillRunning: 0 },
    currentRunLogs: 0,
    failures: [],
    message: "worker log gzip: /tmp/logs: 0 worker log(s) present",
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
    checkUpdates: (_options) => {
      order.push("checkUpdates");
      return Promise.resolve();
    },
    setEnv: (name, value) => {
      env[name] = value;
    },
    ...overrides,
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
    // No branch named: the checkout's own origin/HEAD is read (never written).
    "resolveDefaultBranch",
    "checkUpdates",
  ]);
  assertEquals(result.stepsRun, [...PRELUDE_STEPS]);
});

Deno.test("runBootstrap - the prelude has no git-reset step (Issue #513)", () => {
  // The checkout is updated on the host, before the container launches, so
  // nothing in the prelude may write to it — that is what lets /workspace be
  // mounted read-only (Issue #509).
  assertEquals(PRELUDE_STEPS.includes("git-reset" as never), false);
  assertEquals([...PRELUDE_STEPS], [
    "path",
    "run-id",
    "side-repo-clone-args",
    "log-init",
    "default-branch",
    "software-update",
  ]);
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

Deno.test("runBootstrap - exports the blobless side-repo clone arguments (Issue #243)", async () => {
  const order: string[] = [];
  const env: Record<string, string> = {};
  const result = await runBootstrap(
    baseOptions(),
    recordingDeps(order, env, { readEnv: (_name) => undefined }),
  );

  assertEquals(env["VIBE_SIDE_REPO_CLONE_ARGS"], "--filter=blob:none");
  assertEquals(result.env.VIBE_SIDE_REPO_CLONE_ARGS, "--filter=blob:none");
});

Deno.test("runBootstrap - an operator override of the clone arguments wins verbatim", async () => {
  const order: string[] = [];
  const env: Record<string, string> = {};
  const result = await runBootstrap(
    baseOptions(),
    recordingDeps(order, env, {
      readEnv: (name) =>
        name === "VIBE_SIDE_REPO_CLONE_ARGS" ? "--filter=tree:0" : undefined,
    }),
  );

  assertEquals(env["VIBE_SIDE_REPO_CLONE_ARGS"], "--filter=tree:0");
  assertEquals(result.env.VIBE_SIDE_REPO_CLONE_ARGS, "--filter=tree:0");
});

Deno.test("runBootstrap - an unsafe clone-argument override is refused loudly", async () => {
  const order: string[] = [];
  const env: Record<string, string> = {};
  await runBootstrap(
    baseOptions(),
    recordingDeps(order, env, {
      readEnv: (name) =>
        name === "VIBE_SIDE_REPO_CLONE_ARGS"
          ? "--filter=blob:none && id"
          : undefined,
    }),
  );

  // The default stands and the refusal is on the record — never silent.
  assertEquals(env["VIBE_SIDE_REPO_CLONE_ARGS"], "--filter=blob:none");
  assert(
    order.some((entry) =>
      entry.startsWith("log:VIBE_SIDE_REPO_CLONE_ARGS override refused")
    ),
  );
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

Deno.test("runBootstrap - reports the supplied default branch", async () => {
  const order: string[] = [];
  const env: Record<string, string> = {};

  const result = await runBootstrap(
    baseOptions({ defaultBranch: "main" }),
    recordingDeps(order, env),
  );
  assertEquals(result.defaultBranch, "main");
});

Deno.test("runBootstrap - with no branch named, reads the checkout's own origin/HEAD — no repository or branch name is assumed", async () => {
  const order: string[] = [];
  const env: Record<string, string> = {};
  const deps = recordingDeps(order, env, {
    resolveDefaultBranch: (_repoDir) => {
      order.push("resolveDefaultBranch");
      return Promise.resolve({ ok: true, value: "release" } as Result<string>);
    },
  });

  const result = await runBootstrap(baseOptions(), deps);
  assertEquals(result.defaultBranch, "release");
  assertStringIncludes(order.join(","), "log:Default branch: release");
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

Deno.test("runBootstrap - an unreadable default branch is logged loud but does not fail the run (Issue #513)", async () => {
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
  // The prelude no longer resets the checkout, so an unreadable origin/HEAD
  // costs the orphaned-branch clean-up, not the whole run.
  assertEquals(result.ok, true);
  assertEquals(result.defaultBranch, "");
  assertEquals(order.includes("checkUpdates"), true);
  const logged =
    order.find((entry) => entry.startsWith("log:Default branch unresolved")) ??
      "";
  assertStringIncludes(logged, "origin/HEAD is unset");
  assertStringIncludes(logged, "--default-branch");
});

Deno.test("runBootstrap - leaves a dirty checkout on another branch exactly as it is (Issue #513)", async () => {
  // The regression this guards: while the prelude reset the checkout, a
  // bootstrap run against a dirty tree or a non-default branch either
  // destroyed that work or crash-looped. The checkout is updated host-side
  // now, so the prelude must run clean and touch nothing.
  const tmp = await Deno.makeTempDir({ prefix: "run_bootstrap_no_write_" });
  try {
    const remote = `${tmp}/remote.git`;
    const seed = `${tmp}/seed`;
    const clone = `${tmp}/clone`;
    const logDir = `${tmp}/logs`;
    await runGitCommand(["init", "--bare", "--initial-branch=trunk", remote]);
    await runGitCommand(["init", "--initial-branch=trunk", seed]);
    await Deno.writeTextFile(`${seed}/file.txt`, "one\n");
    await runGitCommand(["add", "file.txt"], { cwd: seed });
    await runGitCommand(
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "one"],
      { cwd: seed },
    );
    await runGitCommand(["push", remote, "trunk"], { cwd: seed });
    await runGitCommand(["clone", "--quiet", remote, clone]);

    // An active development tree: another branch, a modified file, and an
    // untracked one — everything the old reset would have destroyed.
    await runGitCommand(["checkout", "-b", "fix/in-flight"], { cwd: clone });
    await Deno.writeTextFile(`${clone}/file.txt`, "work in progress\n");
    await Deno.writeTextFile(`${clone}/scratch.txt`, "untracked\n");
    const headBefore = await runGitCommand(["rev-parse", "HEAD"], {
      cwd: clone,
    });
    assert(headBefore.ok && headBefore.value.code === 0);

    const result = await runBootstrap(
      {
        repoDir: clone,
        logDir,
        home: `${tmp}/home`,
        currentPath: "/usr/bin",
        pid: 99,
        skipSoftwareUpdate: true,
      },
      {
        resolvePath: () => Promise.resolve("/usr/bin"),
        resolveRunId: () => "vibe-no-write",
        setEnv: () => {},
        checkUpdates: () => Promise.resolve(),
      },
    );

    assertEquals(result.ok, true, result.error ?? "");
    // origin/HEAD is read, not repaired, and reported for housekeeping.
    assertEquals(result.defaultBranch, "trunk");

    // Nothing moved: same branch, same commit, same working tree.
    const branchAfter = await runGitCommand(
      ["rev-parse", "--abbrev-ref", "HEAD"],
      { cwd: clone },
    );
    assert(branchAfter.ok);
    assertEquals(branchAfter.value.stdout.trim(), "fix/in-flight");
    const headAfter = await runGitCommand(["rev-parse", "HEAD"], {
      cwd: clone,
    });
    assert(headAfter.ok);
    assertEquals(headAfter.value.stdout, headBefore.value.stdout);
    assertEquals(
      await Deno.readTextFile(`${clone}/file.txt`),
      "work in progress\n",
    );
    assertEquals(
      await Deno.readTextFile(`${clone}/scratch.txt`),
      "untracked\n",
    );

    // And `pull.log` — the reset's own log — was never written.
    let pullLogWritten = true;
    try {
      await Deno.stat(`${logDir}/pull.log`);
    } catch {
      pullLogWritten = false;
    }
    assertEquals(pullLogWritten, false, "the prelude must not run a git reset");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
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
    VIBE_SIDE_REPO_CLONE_ARGS: "--filter=blob:none",
    WORKER_LOG_FILE: "/home/worker/logs/worker-9.log",
    LOG_FILE: "/home/worker/logs/worker-9.log",
  });

  assertStringIncludes(exports, "export PATH='/opt/bin:/usr/bin'");
  assertStringIncludes(exports, "export VIBE_RUN_ID='vibe-xyz'");
  // Issue #243 — the gates a shell step launches inherit the clone arguments.
  assertStringIncludes(
    exports,
    "export VIBE_SIDE_REPO_CLONE_ARGS='--filter=blob:none'",
  );
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
    VIBE_SIDE_REPO_CLONE_ARGS: "--filter=blob:none",
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
        logDir,
        candidates: 1,
        compressed: [`${logDir}/worker-1.log.gz`],
        message: `worker log gzip: ${logDir}: 1 worker log(s) present`,
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
    order.some((o) =>
      o.startsWith("log:worker log gzip: ") && o.includes("1 worker log(s)")
    ),
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
        ...emptyGzipResult(),
        failures: [{ path: "/tmp/logs/worker-7.log", error: "disk full" }],
        message: "worker log gzip: /tmp/logs: 1 worker log(s) present; " +
          "failures: /tmp/logs/worker-7.log: disk full",
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
