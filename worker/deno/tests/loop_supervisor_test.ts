/**
 * Tests for loop.sh — the never-exit supervisor wrapper around run.sh
 * (Issue #1836).
 *
 * loop.sh must:
 *   1. Continue iterating when ./run.sh exits non-zero.
 *   2. Continue iterating when SIGTERM is delivered to the process group
 *      (SIGTERM is what propagates to loop.sh when run_core.sh's
 *      cleanup_on_exit handler fires from a duration-expiry signal).
 *   3. Continue iterating when `git pull` fails.
 *
 * The tests spawn loop.sh in a tmp directory with stub `run.sh` and
 * `git` binaries on PATH, then count how many times the stub `run.sh`
 * gets invoked. They use the LOOP_SLEEP_SECONDS env var to shorten the
 * inter-iteration sleep so the tests run quickly.
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { getCommand, getDescendants, isRunning } from "../lib/pid_guard.ts";
import { killProcessTree } from "./fixtures/process_tree.ts";
import {
  resolveWatchdogSeconds,
  WATCHDOG_MARGIN_SECONDS,
} from "../lib/container_watchdog.ts";
import { DEFAULT_MAX_RUN_SECONDS } from "../lib/run_entrypoint.ts";

// Resolve <repo-root>/loop.sh from this test file's location, without
// depending on @std/path. The test lives at
// worker/deno/tests/loop_supervisor_test.ts so the repo root is four
// directories up.
const TEST_FILE_PATH = new URL(import.meta.url).pathname;
const REPO_ROOT = TEST_FILE_PATH.replace(
  /\/worker\/deno\/tests\/[^/]+$/,
  "",
);
const LOOP_SH = `${REPO_ROOT}/loop.sh`;
const join = (...parts: string[]): string => parts.join("/");

interface Harness {
  tmpDir: string;
  cleanup: () => Promise<void>;
}

async function setupHarness(opts: {
  runStub: string;
  gitStub?: string;
  /** Stub `container` binary for the control-plane probe (Issue #323). */
  containerStub?: string;
}): Promise<Harness> {
  const tmpDir = await Deno.makeTempDir({ prefix: "vibe_loop_test_" });

  // Copy loop.sh into the tmp dir so the SCRIPT_DIR cd points at our stubs.
  const loopContents = await Deno.readTextFile(LOOP_SH);
  const loopPath = join(tmpDir, "loop.sh");
  await Deno.writeTextFile(loopPath, loopContents);
  await Deno.chmod(loopPath, 0o755);

  // Stub run.sh
  const runPath = join(tmpDir, "run.sh");
  await Deno.writeTextFile(runPath, opts.runStub);
  await Deno.chmod(runPath, 0o755);

  // Stub `container` on PATH when the test needs one (Issue #323), so the
  // control-plane probe can be driven without a real container runtime.
  if (opts.containerStub !== undefined) {
    const cDir = join(tmpDir, "bin");
    await Deno.mkdir(cDir, { recursive: true });
    const cPath = join(cDir, "container");
    await Deno.writeTextFile(cPath, opts.containerStub);
    await Deno.chmod(cPath, 0o755);
  }

  // Stub `git` binary on PATH so `git pull` is fast and predictable.
  const gitDir = join(tmpDir, "bin");
  await Deno.mkdir(gitDir, { recursive: true });
  const gitPath = join(gitDir, "git");
  await Deno.writeTextFile(
    gitPath,
    opts.gitStub ?? "#!/bin/bash\nexit 0\n",
  );
  await Deno.chmod(gitPath, 0o755);

  return {
    tmpDir,
    cleanup: async () => {
      try {
        await Deno.remove(tmpDir, { recursive: true });
      } catch { /* best-effort */ }
    },
  };
}

function spawnLoop(
  tmpDir: string,
  extraEnv: Record<string, string> = {},
): Deno.ChildProcess {
  return new Deno.Command("bash", {
    args: [join(tmpDir, "loop.sh")],
    cwd: tmpDir,
    env: {
      LOOP_SLEEP_SECONDS: "1",
      PATH: `${join(tmpDir, "bin")}:${Deno.env.get("PATH") ?? ""}`,
      HOME: tmpDir,
      ...extraEnv,
    },
    stdout: "piped",
    stderr: "piped",
    // Detach into its own process group so signals we send to the child
    // PID do not also hit the test runner.
  }).spawn();
}

async function readInvocationCount(tmpDir: string): Promise<number> {
  try {
    const log = await Deno.readTextFile(join(tmpDir, "invocations.log"));
    return log.split("\n").filter((l) => l.trim().length > 0).length;
  } catch {
    return 0;
  }
}

/**
 * Stop a spawned loop.sh and everything it started (Issue #399).
 *
 * SIGKILL to loop.sh alone left its background control-plane probe and its
 * run.sh behind: re-parented to PID 1, looping on `sleep 120` for ever.
 */
async function killTree(child: Deno.ChildProcess): Promise<void> {
  await killProcessTree(child);
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Spawn loop.sh with its own output redirected into `loop.log` under the
 * temporary directory, so a test can assert on what the supervisor *said*
 * rather than only on how often it iterated.
 */
function spawnLoopLogging(
  tmpDir: string,
  extraEnv: Record<string, string> = {},
): Deno.ChildProcess {
  return new Deno.Command("bash", {
    args: ["-c", `exec ./loop.sh > loop.log 2>&1`],
    cwd: tmpDir,
    env: {
      LOOP_SLEEP_SECONDS: "1",
      PATH: `${join(tmpDir, "bin")}:${Deno.env.get("PATH") ?? ""}`,
      HOME: tmpDir,
      ...extraEnv,
    },
    stdout: "null",
    stderr: "null",
  }).spawn();
}

Deno.test({
  name:
    "loop.sh - a worker already running is reported as by design, not as a failure (Issues #26, #1056)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    // ANOTHER_WORKER_RUNNING_EXIT: the pre-launch reaper found this host's
    // one worker already mid-run, so run.sh stopped before it built or
    // launched anything.
    const harness = await setupHarness({
      runStub:
        '#!/bin/bash\necho "$(date +%s.%N)" >> invocations.log\nexit 4\n',
    });
    const child = spawnLoopLogging(harness.tmpDir);
    try {
      await delay(3500);
      const log = await Deno.readTextFile(join(harness.tmpDir, "loop.log"));

      // Said plainly, and never as a crash the operator should investigate.
      assert(
        log.includes("another worker is already running on this"),
        `the by-design stop must be named, got: ${log}`,
      );
      assert(
        log.includes("this is not a failure"),
        `the by-design stop must not read as a fault, got: ${log}`,
      );
      assertEquals(
        log.includes("exited with status 4 — backing off and retrying"),
        false,
        "a healthy host must not be described as backing off from a failure",
      );

      // And the supervisor keeps supervising: the worker it stood aside for
      // will finish, and the next cycle must be there when it does.
      const count = await readInvocationCount(harness.tmpDir);
      assert(
        count >= 2,
        `expected loop.sh to keep iterating, got ${count}`,
      );
    } finally {
      await killTree(child);
      await harness.cleanup();
    }
  },
});

Deno.test({
  name:
    "loop.sh - a read-only root is named and relaunched, not reported as a crash (Issue #3179)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    // ROOT_FS_FAULT_EXIT: the worker found its container's root filesystem
    // read-only and ended the run for a fresh container.
    const harness = await setupHarness({
      runStub:
        '#!/bin/bash\necho "$(date +%s.%N)" >> invocations.log\nexit 74\n',
    });
    const child = spawnLoopLogging(harness.tmpDir);
    try {
      await delay(3500);
      const log = await Deno.readTextFile(join(harness.tmpDir, "loop.log"));

      assert(
        log.includes("root filesystem went read-only"),
        `the host fault must be named, got: ${log}`,
      );
      assert(
        log.includes("relaunching into a fresh container"),
        `the supervisor must say what it does about it, got: ${log}`,
      );
      assertEquals(
        log.includes("exited with status 74 — backing off and retrying"),
        false,
        "a read-only root must not be described as an ordinary crash",
      );

      // Relaunched without a human: the next cycle comes round.
      const count = await readInvocationCount(harness.tmpDir);
      assert(
        count >= 2,
        `expected loop.sh to relaunch run.sh, got ${count}`,
      );
    } finally {
      await killTree(child);
      await harness.cleanup();
    }
  },
});

Deno.test({
  name:
    "loop.sh - continues iterating when run.sh exits non-zero (Issue #1836)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const harness = await setupHarness({
      runStub:
        '#!/bin/bash\necho "$(date +%s.%N)" >> invocations.log\nexit 17\n',
    });
    const child = spawnLoop(harness.tmpDir);
    try {
      // Allow at least 3 iterations: each is run.sh + 1s sleep + git pull.
      await delay(3500);
      const count = await readInvocationCount(harness.tmpDir);
      assert(
        count >= 2,
        `expected loop.sh to call run.sh at least twice despite exit 17, got ${count}`,
      );
    } finally {
      await killTree(child);
      await harness.cleanup();
    }
  },
});

/** The PIDs of every `sleep` process descended from `pid`. */
async function sleepDescendants(pid: number): Promise<number[]> {
  const sleeps: number[] = [];
  for (const descendant of await getDescendants(pid)) {
    const ps = await new Deno.Command("ps", {
      args: ["-o", "comm=", "-p", String(descendant)],
      stdout: "piped",
      stderr: "null",
    }).output();
    const comm = new TextDecoder().decode(ps.stdout).trim();
    if (comm === "sleep" || comm.endsWith("/sleep")) sleeps.push(descendant);
  }
  return sleeps;
}

Deno.test({
  name:
    "loop.sh - a signal during the failure backoff does not cut it short (Issue #4062)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    // A terminal hangup signals the whole foreground process group: loop.sh
    // survives through its trap, but the backoff `sleep` it is waiting on
    // must not die either, or a host whose launcher fails every cycle is
    // relaunched every few seconds instead of backing off.
    const backoffSeconds = 5;
    const harness = await setupHarness({
      runStub: "#!/bin/bash\necho launched >> invocations.log\nexit 1\n",
    });
    const child = spawnLoop(harness.tmpDir, {
      LOOP_SLEEP_SECONDS: String(backoffSeconds),
    });
    try {
      for (let i = 0; i < 50; i++) {
        if (await readInvocationCount(harness.tmpDir) >= 1) break;
        await delay(100);
      }
      assertEquals(await readInvocationCount(harness.tmpDir), 1);
      const backoffStarted = Date.now();

      // Signal the supervisor and its sleep, as a process-group hangup
      // does, repeatedly through most of the backoff.
      while (Date.now() - backoffStarted < (backoffSeconds - 1.5) * 1000) {
        for (const pid of [child.pid, ...await sleepDescendants(child.pid)]) {
          for (const sig of ["SIGHUP", "SIGTERM"] as const) {
            try {
              Deno.kill(pid, sig);
            } catch { /* already gone */ }
          }
        }
        await delay(300);
      }

      assertEquals(
        await readInvocationCount(harness.tmpDir),
        1,
        "a signal must not end the backoff early and relaunch run.sh",
      );

      // And the backoff still ends: the supervisor relaunches once it has
      // elapsed in full.
      for (let i = 0; i < 60; i++) {
        if (await readInvocationCount(harness.tmpDir) >= 2) break;
        await delay(100);
      }
      assert(
        await readInvocationCount(harness.tmpDir) >= 2,
        "loop.sh must relaunch run.sh once the backoff has elapsed",
      );
    } finally {
      await killTree(child);
      await harness.cleanup();
    }
  },
});

Deno.test({
  name: "loop.sh - survives SIGTERM and continues looping (Issue #1836)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const harness = await setupHarness({
      runStub:
        '#!/bin/bash\necho "$(date +%s.%N)" >> invocations.log\nexit 0\n',
    });
    const child = spawnLoop(harness.tmpDir);
    try {
      // Wait for the first iteration so loop.sh is past the initial cd
      // and into the while body.
      await delay(800);
      const before = await readInvocationCount(harness.tmpDir);
      assert(
        before >= 1,
        `expected at least 1 iteration before SIGTERM, got ${before}`,
      );

      // Deliver SIGTERM. A robust supervisor must not die from this —
      // run_core.sh propagates SIGTERM through its process group when a
      // duration-expiry shutdown happens, and we observed loop.sh dying
      // with it (Issue #1836).
      child.kill("SIGTERM");

      // Give loop.sh time to ignore the signal and run several more
      // iterations.
      await delay(3500);

      const after = await readInvocationCount(harness.tmpDir);
      assert(
        after > before,
        `expected loop.sh to keep iterating after SIGTERM (before=${before}, after=${after})`,
      );

      // Confirm the process is still alive by sending SIGTERM again and
      // observing that further iterations happen. If SIGTERM had killed
      // it, no further invocations would land.
      child.kill("SIGTERM");
      await delay(2000);
      const afterSecond = await readInvocationCount(harness.tmpDir);
      assert(
        afterSecond > after,
        `expected loop.sh to survive a second SIGTERM (after=${after}, afterSecond=${afterSecond})`,
      );
    } finally {
      await killTree(child);
      await harness.cleanup();
    }
  },
});

Deno.test({
  name: "loop.sh - continues iterating when git pull fails (Issue #1836)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const harness = await setupHarness({
      runStub:
        '#!/bin/bash\necho "$(date +%s.%N)" >> invocations.log\nexit 0\n',
      // git stub always fails
      gitStub: "#!/bin/bash\necho 'simulated git failure' >&2\nexit 5\n",
    });
    const child = spawnLoop(harness.tmpDir);
    try {
      await delay(3500);
      const count = await readInvocationCount(harness.tmpDir);
      assert(
        count >= 2,
        `expected loop.sh to keep iterating despite failing git pull, got ${count}`,
      );
    } finally {
      await killTree(child);
      await harness.cleanup();
    }
  },
});

Deno.test({
  name:
    "loop.sh - LOOP_SLEEP_SECONDS overrides default 60s sleep (Issue #1836)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    // If the override is honoured, we get >=3 iterations in ~3.5s. If it
    // is not honoured, we get exactly 1 (since the default 60s sleep
    // would dominate).
    const harness = await setupHarness({
      runStub:
        '#!/bin/bash\necho "$(date +%s.%N)" >> invocations.log\nexit 0\n',
    });
    const child = spawnLoop(harness.tmpDir);
    try {
      await delay(3500);
      const count = await readInvocationCount(harness.tmpDir);
      assert(
        count >= 3,
        `expected LOOP_SLEEP_SECONDS=1 to enable >=3 iterations in 3.5s, got ${count}`,
      );
      assertEquals(typeof count, "number");
    } finally {
      await killTree(child);
      await harness.cleanup();
    }
  },
});

// ===========================================================================
// Issue #322 — the supervisor owns a wall-clock deadline
// ===========================================================================

Deno.test({
  name:
    "loop.sh #322 - a run.sh that never exits is terminated and the next cycle starts",
  // The failure this encodes: run_core's own watchdogs fired 1350s and 2737s
  // late because two agents had starved its event loop, and the cycle ran
  // 2h26m past its deadline until a human killed it. A timer inside the
  // wedged process cannot bound it; the supervisor can.
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const harness = await setupHarness({
      runStub: [
        "#!/bin/bash",
        'echo "$(date +%s)" >> "$(dirname "$0")/invocations.log"',
        // Never exits on its own — exactly the wedged-cycle shape.
        "sleep 300",
      ].join("\n"),
    });
    const child = spawnLoop(harness.tmpDir, {
      VIBE_RUN_MAX_SECONDS: "2",
      VIBE_RUN_KILL_GRACE_SECONDS: "1",
    });
    try {
      // Two caps plus two inter-iteration sleeps is ample for ≥2 invocations
      // if — and only if — the deadline is enforced.
      await new Promise((resolve) => setTimeout(resolve, 12_000));
      const count = await readInvocationCount(harness.tmpDir);
      assert(
        count >= 2,
        `run.sh should have been re-launched after the deadline; ran ${count} time(s)`,
      );
    } finally {
      await killTree(child);
      await harness.cleanup();
    }
  },
});

Deno.test({
  name: "loop.sh #322 - a run that finishes inside the cap is not disturbed",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const harness = await setupHarness({
      runStub: [
        "#!/bin/bash",
        'echo "$(date +%s)" >> "$(dirname "$0")/invocations.log"',
        // Well inside the cap, and exits cleanly.
        "sleep 1",
        "exit 0",
      ].join("\n"),
    });
    const child = spawnLoop(harness.tmpDir, {
      VIBE_RUN_MAX_SECONDS: "30",
      VIBE_RUN_KILL_GRACE_SECONDS: "5",
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 9_000));
      const count = await readInvocationCount(harness.tmpDir);
      assert(
        count >= 2,
        `expected repeated clean cycles; ran ${count} time(s)`,
      );
    } finally {
      await killTree(child);
      await harness.cleanup();
    }
  },
});

Deno.test({
  name:
    "loop.sh #322 - VIBE_RUN_MAX_SECONDS=0 disables the cap rather than capping at zero",
  // A misread of "0" as an immediate deadline would kill every run instantly,
  // which is worse than the bug being fixed. The measure is whether a run
  // *completes*, not how many start — with the cap off, a slow run must reach
  // its own exit.
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const harness = await setupHarness({
      runStub: [
        "#!/bin/bash",
        'echo "$(date +%s)" >> "$(dirname "$0")/invocations.log"',
        "sleep 4",
        'echo done >> "$(dirname "$0")/completed.log"',
        "exit 0",
      ].join("\n"),
    });
    const child = spawnLoop(harness.tmpDir, { VIBE_RUN_MAX_SECONDS: "0" });
    try {
      await new Promise((resolve) => setTimeout(resolve, 9_000));
      let completed = "";
      try {
        completed = await Deno.readTextFile(
          join(harness.tmpDir, "completed.log"),
        );
      } catch { /* absent means nothing completed */ }
      assert(
        completed.includes("done"),
        "with the cap disabled the 4s run must reach its own exit, not be killed",
      );
    } finally {
      await killTree(child);
      await harness.cleanup();
    }
  },
});

// ===========================================================================
// Issue #421 — the cap is published to the worker, not just enforced
// ===========================================================================

/** The `VIBE_RUN_*` environment the stub run.sh actually received. */
async function readRunEnv(tmpDir: string): Promise<Record<string, string>> {
  const text = await Deno.readTextFile(join(tmpDir, "run-env.log"))
    .catch(() => "");
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return env;
}

/** A run.sh stub that records the run-cap environment it was given. */
const ENV_RECORDING_RUN_STUB = [
  "#!/bin/bash",
  'echo "$(date +%s)" >> "$(dirname "$0")/invocations.log"',
  'env | grep "^VIBE_RUN_" >> "$(dirname "$0")/run-env.log" || true',
  "exit 0",
].join("\n");

Deno.test({
  name:
    "loop.sh #421 - the wall-clock cap and the run's start epoch reach run.sh",
  // Without this passthrough the worker cannot see the cap, so progress
  // extensions are unbounded and a progressing run is SIGTERMed by the
  // supervisor with no orderly WIP commit window.
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const harness = await setupHarness({ runStub: ENV_RECORDING_RUN_STUB });
    const child = spawnLoop(harness.tmpDir, {
      VIBE_RUN_MAX_SECONDS: "10800",
      VIBE_RUN_KILL_GRACE_SECONDS: "5",
    });
    try {
      const before = Math.floor(Date.now() / 1000);
      await delay(3000);
      const env = await readRunEnv(harness.tmpDir);
      assertEquals(
        env["VIBE_RUN_MAX_SECONDS"],
        "10800",
        `run.sh must see the supervisor cap; got ${JSON.stringify(env)}`,
      );
      const started = Number(env["VIBE_RUN_STARTED_EPOCH"]);
      assert(
        Number.isInteger(started) && Math.abs(started - before) < 120,
        `run.sh must see this run's start epoch in seconds; got ${
          JSON.stringify(env)
        }`,
      );
    } finally {
      await killTree(child);
      await harness.cleanup();
    }
  },
});

Deno.test({
  name:
    "loop.sh #421 - the default cap is published too, so an unconfigured host is still bounded",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const harness = await setupHarness({ runStub: ENV_RECORDING_RUN_STUB });
    const child = spawnLoop(harness.tmpDir);
    try {
      await delay(3000);
      const env = await readRunEnv(harness.tmpDir);
      assertEquals(env["VIBE_RUN_MAX_SECONDS"], "10800");
      assert(
        (env["VIBE_RUN_STARTED_EPOCH"] ?? "").length > 0,
        `the start epoch must be exported; got ${JSON.stringify(env)}`,
      );
    } finally {
      await killTree(child);
      await harness.cleanup();
    }
  },
});

// ===========================================================================
// Issue #423 — the default cap is 3 h, and the container watchdog clears it
// ===========================================================================

Deno.test({
  name:
    "loop.sh #423 - the default cap is 10800s and the container watchdog clears it by the documented margin",
  // Under #397 a claim taken at the hour runs its full budget with progress
  // extensions on, so the old 5400 s cap became the thing that killed
  // in-progress work. Two numbers have to move together: raising the cap past
  // the launcher's watchdog would have the host reap a container the
  // supervisor would still allow to run. Asserting the relation — rather than
  // each constant alone — is what makes raising one without the other fail
  // here instead of on a host.
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const harness = await setupHarness({ runStub: ENV_RECORDING_RUN_STUB });
    const child = spawnLoop(harness.tmpDir);
    try {
      await delay(3000);
      const env = await readRunEnv(harness.tmpDir);
      const capSeconds = Number(env["VIBE_RUN_MAX_SECONDS"]);
      assertEquals(
        capSeconds,
        10_800,
        `an unset VIBE_RUN_MAX_SECONDS must yield the 3 h cap; got ${
          JSON.stringify(env)
        }`,
      );

      const watchdogSeconds = resolveWatchdogSeconds({
        env: () => undefined,
        maxRunSeconds: DEFAULT_MAX_RUN_SECONDS,
      });
      assertEquals(
        watchdogSeconds,
        capSeconds + WATCHDOG_MARGIN_SECONDS,
        "the launcher's watchdog deadline must be the supervisor cap plus " +
          "the documented margin, or a healthy run is reaped by the host",
      );
      assert(
        watchdogSeconds > capSeconds,
        `the watchdog (${watchdogSeconds}s) must outlast the cap ` +
          `(${capSeconds}s)`,
      );
    } finally {
      await killTree(child);
      await harness.cleanup();
    }
  },
});

Deno.test({
  name:
    "loop.sh #423 - an explicitly set VIBE_RUN_MAX_SECONDS still wins over the default",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const harness = await setupHarness({ runStub: ENV_RECORDING_RUN_STUB });
    const child = spawnLoop(harness.tmpDir, {
      VIBE_RUN_MAX_SECONDS: "1800",
      VIBE_RUN_KILL_GRACE_SECONDS: "5",
    });
    try {
      await delay(3000);
      const env = await readRunEnv(harness.tmpDir);
      assertEquals(env["VIBE_RUN_MAX_SECONDS"], "1800");
    } finally {
      await killTree(child);
      await harness.cleanup();
    }
  },
});

// ===========================================================================
// Issue #323 — the control-plane probe
// ===========================================================================

Deno.test({
  name:
    "loop.sh #323 - a container whose exec keeps failing is recovered, not waited on",
  // The 2026-08-22 shape: `container ls` reports the container healthy and
  // running while `container exec` resets its socket. Liveness was inferred
  // from the worker writing logs — a symptom, not a check — so nothing
  // noticed. The probe must reach its failure threshold and act.
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const harness = await setupHarness({
      runStub: [
        "#!/bin/bash",
        'echo "$(date +%s)" >> "$(dirname "$0")/invocations.log"',
        "sleep 300",
      ].join("\n"),
      containerStub: [
        "#!/bin/bash",
        'log="$(dirname "$0")/../container.log"',
        'echo "$*" >> "$log"',
        'case "$1" in',
        // Reports healthy and running throughout — exactly as it did.
        '  ls) echo "vibe-coder-999  img  linux  arm64  running  ip  6  16384";;',
        // The control plane is dead: every exec fails.
        "  exec) exit 1;;",
        "  kill) exit 0;;",
        "  *) exit 0;;",
        "esac",
      ].join("\n"),
    });
    const child = spawnLoop(harness.tmpDir, {
      VIBE_RUN_MAX_SECONDS: "0",
      VIBE_PROBE_INTERVAL_SECONDS: "1",
      VIBE_PROBE_FAILURES: "2",
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      const out = await Deno.readTextFile(join(harness.tmpDir, "container.log"))
        .catch(() => "");
      // Two failed probes must escalate to a kill of the named container.
      assert(
        out.includes("kill vibe-coder-999"),
        `the probe must recover the container; container calls were:\n${out}`,
      );
    } finally {
      await killTree(child);
      await harness.cleanup();
    }
  },
});

Deno.test({
  name: "loop.sh #323 - a healthy container is probed and left alone",
  // The probe must not become a periodic killer of working containers.
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const harness = await setupHarness({
      runStub: [
        "#!/bin/bash",
        'echo "$(date +%s)" >> "$(dirname "$0")/invocations.log"',
        "sleep 300",
      ].join("\n"),
      containerStub: [
        "#!/bin/bash",
        'log="$(dirname "$0")/../container.log"',
        'echo "$*" >> "$log"',
        'case "$1" in',
        '  ls) echo "vibe-coder-999  img  linux  arm64  running  ip  6  16384";;',
        // A live control plane answers.
        "  exec) exit 0;;",
        "  *) exit 0;;",
        "esac",
      ].join("\n"),
    });
    const child = spawnLoop(harness.tmpDir, {
      VIBE_RUN_MAX_SECONDS: "0",
      VIBE_PROBE_INTERVAL_SECONDS: "1",
      VIBE_PROBE_FAILURES: "2",
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 8_000));
      const out = await Deno.readTextFile(join(harness.tmpDir, "container.log"))
        .catch(() => "");
      assert(out.includes("exec vibe-coder-999"), "the probe must run");
      assert(
        !out.includes("kill vibe-coder-999"),
        `a healthy container must be left alone; got:\n${out}`,
      );
    } finally {
      await killTree(child);
      await harness.cleanup();
    }
  },
});

// ===========================================================================
// Issue #399 — the supervisor's tree must not outlive the test
//
// loop.sh forks a background control-plane probe and a run.sh of its own.
// SIGKILL to loop.sh alone left both behind, re-parented to PID 1 and looping
// on `sleep 120`: around twenty such trees had accumulated on one fleet host,
// the oldest over two days old.
// ===========================================================================

Deno.test({
  name: "loop.sh #399 - killing the supervisor leaves no orphaned descendants",
  ignore: Deno.build.os === "windows",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const harness = await setupHarness({
      runStub: [
        "#!/bin/bash",
        'echo "$(date +%s)" >> "$(dirname "$0")/invocations.log"',
        // Long-lived, exactly like a real cycle mid-run.
        "sleep 300",
      ].join("\n"),
      // A `container` stub keeps the control-plane probe running beside it.
      containerStub: [
        "#!/bin/bash",
        'case "$1" in',
        "  ls) exit 0;;",
        "  *) exit 0;;",
        "esac",
      ].join("\n"),
    });
    const child = spawnLoop(harness.tmpDir, {
      VIBE_RUN_MAX_SECONDS: "0",
      VIBE_PROBE_INTERVAL_SECONDS: "1",
    });
    try {
      // Wait — bounded — for the supervisor to have forked its tree.
      let descendants: number[] = [];
      for (
        let attempt = 0;
        attempt < 60 && descendants.length === 0;
        attempt++
      ) {
        await delay(100);
        descendants = await getDescendants(child.pid);
      }
      assert(
        descendants.length > 0,
        "the supervisor never forked anything — the test proves nothing",
      );

      await killTree(child);

      const survivors: number[] = [];
      for (const pid of descendants) {
        if (await isRunning(pid)) survivors.push(pid);
      }
      assertEquals(
        survivors,
        [],
        `orphaned descendants survived the supervisor: ${survivors.join(",")}`,
      );
    } finally {
      await killTree(child);
      await harness.cleanup();
    }
  },
});

// ===========================================================================
// Issue #4568 — the control-plane probe must not outlive its supervisor
//
// SIGKILL to loop.sh left its background probe running, re-parented to PID 1.
// With no container to watch, the probe never ended: it looped on `container
// ls` for ever, its failure count held at zero. The probe now stops when its
// loop.sh is gone and, once it has seen a container, when that container goes
// away. A fresh loop.sh also reaps a probe that an earlier supervisor orphaned
// from this checkout.
// ===========================================================================

/** A run.sh stub that never exits on its own, as a real cycle mid-run does. */
const LONG_RUN_STUB = [
  "#!/bin/bash",
  'echo "$(date +%s)" >> "$(dirname "$0")/invocations.log"',
  "sleep 300",
].join("\n");

/** A `container` stub with nothing running, and never a container to watch. */
const NO_CONTAINER_STUB = [
  "#!/bin/bash",
  'case "$1" in',
  "  ls) exit 0;;",
  "  *) exit 0;;",
  "esac",
].join("\n");

/**
 * The control-plane probe under loop.sh: the loop.sh-named descendant of
 * `loopPid` that is sleeping for the probe interval.
 *
 * loop.sh's pipeline subshell carries the same command line, but it sleeps on
 * run.sh's own `sleep`, never on the probe interval, so the interval is what
 * tells the two apart. Polled, because the probe may be between sleeps.
 */
async function findProbe(
  loopPid: number,
  intervalSeconds: number,
): Promise<number | undefined> {
  for (let attempt = 0; attempt < 50; attempt++) {
    for (const candidate of await getDescendants(loopPid)) {
      if (!(await getCommand(candidate)).includes("loop.sh")) continue;
      for (const grandchild of await getDescendants(candidate)) {
        if (await getCommand(grandchild) === `sleep ${intervalSeconds}`) {
          return candidate;
        }
      }
    }
    await delay(100);
  }
  return undefined;
}

/** SIGKILL each PID, ignoring any that is already gone. */
function killQuietly(pids: number[]): void {
  for (const pid of pids) {
    try {
      Deno.kill(pid, "SIGKILL");
    } catch { /* already gone */ }
  }
}

/** PIDs whose command line matches `pattern`, as `pgrep -f` reports them. */
async function pgrepFull(pattern: string): Promise<number[]> {
  const out = await new Deno.Command("pgrep", {
    args: ["-f", pattern],
    stdout: "piped",
    stderr: "null",
  }).output();
  return new TextDecoder().decode(out.stdout)
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

/** The parent PID `ps` reports for `pid`, or undefined once it is gone. */
async function parentPidOf(pid: number): Promise<number | undefined> {
  const out = await new Deno.Command("ps", {
    args: ["-o", "ppid=", "-p", String(pid)],
    stdout: "piped",
    stderr: "null",
  }).output();
  const text = new TextDecoder().decode(out.stdout).trim();
  return text === "" ? undefined : Number(text);
}

/**
 * Register a probe the way loop.sh does: `<state dir>/probes/<pid>` holds the
 * checkout directory the probe runs from.
 */
async function registerProbe(
  stateDir: string,
  pid: number,
  checkout: string,
): Promise<void> {
  const probesDir = join(stateDir, "probes");
  await Deno.mkdir(probesDir, { recursive: true });
  await Deno.writeTextFile(join(probesDir, String(pid)), checkout);
}

/**
 * Write `<tmp>/fake/loop.sh`, a stand-in supervisor that only sleeps. The
 * reaper matches on the command line, so the name is what it must look like.
 */
async function writeFakeSupervisor(tmpDir: string): Promise<string> {
  const dir = join(tmpDir, "fake");
  await Deno.mkdir(dir, { recursive: true });
  const path = join(dir, "loop.sh");
  await Deno.writeTextFile(path, "#!/bin/bash\nsleep 300\n");
  await Deno.chmod(path, 0o755);
  return path;
}

/**
 * Start `fakePath` as an orphan: the intermediate shell exits at once, so the
 * fake is re-parented to init, exactly as an orphaned probe would be.
 */
async function startOrphanFake(fakePath: string): Promise<number[]> {
  await new Deno.Command("bash", {
    args: ["-c", `nohup bash ${fakePath} >/dev/null 2>&1 &`],
    stdout: "null",
    stderr: "null",
  }).output();
  return await pgrepFull(fakePath);
}

Deno.test({
  name:
    "loop.sh #4568 - SIGKILL to the supervisor alone takes its control-plane probe down too",
  ignore: Deno.build.os === "windows",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    // No container has ever been up, so only the supervisor's own death can
    // end the probe.
    const harness = await setupHarness({
      runStub: LONG_RUN_STUB,
      containerStub: NO_CONTAINER_STUB,
    });
    const child = spawnLoop(harness.tmpDir, {
      VIBE_RUN_MAX_SECONDS: "0",
      VIBE_PROBE_INTERVAL_SECONDS: "1",
    });
    let tree: number[] = [];
    try {
      const probe = await findProbe(child.pid, 1);
      assert(
        probe !== undefined,
        "the control-plane probe never started — the test proves nothing",
      );
      tree = await getDescendants(child.pid);

      // The supervisor alone, not killTree: that would stop the probe too.
      child.kill("SIGKILL");
      await child.status;

      let alive = true;
      for (let i = 0; i < 80 && alive; i++) {
        await delay(100);
        alive = await isRunning(probe);
      }
      assertEquals(
        alive,
        false,
        `the control-plane probe (PID ${probe}) outlived its SIGKILLed supervisor`,
      );
    } finally {
      await killTree(child);
      killQuietly(tree);
      await harness.cleanup();
    }
  },
});

Deno.test({
  name:
    "loop.sh #4568 - the probe stops once the container it watched is gone, and loop.sh keeps supervising",
  ignore: Deno.build.os === "windows",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    // The container is up for the probe's first look and gone from the second.
    const harness = await setupHarness({
      runStub: LONG_RUN_STUB,
      containerStub: [
        "#!/bin/bash",
        'seen="$(dirname "$0")/../seen"',
        'case "$1" in',
        '  ls) if [[ ! -e "${seen}" ]]; then',
        '         touch "${seen}"',
        '         echo "vibe-coder-999  img  linux  arm64  running  ip  6  16384"',
        "       fi;;",
        "  *) exit 0;;",
        "esac",
      ].join("\n"),
    });
    const child = spawnLoop(harness.tmpDir, {
      VIBE_RUN_MAX_SECONDS: "0",
      VIBE_PROBE_INTERVAL_SECONDS: "1",
    });
    let tree: number[] = [];
    try {
      const probe = await findProbe(child.pid, 1);
      assert(
        probe !== undefined,
        "the control-plane probe never started — the test proves nothing",
      );
      tree = await getDescendants(child.pid);

      // Bounded at about ten seconds: the probe should end within a few of
      // its one-second intervals once the container is gone.
      let alive = true;
      for (let i = 0; i < 100 && alive; i++) {
        await delay(100);
        alive = await isRunning(probe);
      }
      assertEquals(
        alive,
        false,
        `the probe (PID ${probe}) kept running after its container was gone`,
      );
      assert(
        await isRunning(child.pid),
        "loop.sh must keep supervising after its probe has stopped",
      );
    } finally {
      await killTree(child);
      killQuietly(tree);
      await harness.cleanup();
    }
  },
});

Deno.test({
  name:
    "loop.sh #4568 - the probe keeps waiting while no container has been seen yet",
  ignore: Deno.build.os === "windows",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    // An image build can run for minutes before any container exists, so an
    // empty `container ls` at start-up is not the end of the probe's watch.
    const harness = await setupHarness({
      runStub: LONG_RUN_STUB,
      containerStub: NO_CONTAINER_STUB,
    });
    const child = spawnLoop(harness.tmpDir, {
      VIBE_RUN_MAX_SECONDS: "0",
      VIBE_PROBE_INTERVAL_SECONDS: "1",
    });
    let tree: number[] = [];
    try {
      const probe = await findProbe(child.pid, 1);
      assert(
        probe !== undefined,
        "the control-plane probe never started — the test proves nothing",
      );
      tree = await getDescendants(child.pid);

      await delay(4000);
      assert(
        await isRunning(probe),
        "the probe must keep waiting while no container has been seen — run.sh may still be building the image",
      );
      assert(
        await isRunning(child.pid),
        "loop.sh must still be running",
      );
    } finally {
      await killTree(child);
      killQuietly(tree);
      await harness.cleanup();
    }
  },
});

Deno.test({
  name:
    "loop.sh #4568 - a fresh supervisor reaps a probe orphaned from its checkout",
  ignore: Deno.build.os === "windows",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const harness = await setupHarness({ runStub: LONG_RUN_STUB });
    const stateDir = join(harness.tmpDir, ".vibe-coder");
    const fakePath = await writeFakeSupervisor(harness.tmpDir);
    let fakes: number[] = [];
    let leftovers: number[] = [];
    let child: Deno.ChildProcess | undefined;
    try {
      fakes = await startOrphanFake(fakePath);
      const fake = fakes[0];
      assert(
        fakes.length === 1 && fake !== undefined,
        `expected exactly one fake supervisor, found ${fakes.length}`,
      );
      assertEquals(
        await parentPidOf(fake),
        1,
        "the fake must be an orphan re-parented to init, or the test proves nothing",
      );
      leftovers = await getDescendants(fake);
      await registerProbe(stateDir, fake, await Deno.realPath(harness.tmpDir));

      child = spawnLoopLogging(harness.tmpDir, { VIBE_STATE_DIR: stateDir });
      let alive = true;
      for (let i = 0; i < 80 && alive; i++) {
        await delay(100);
        alive = await isRunning(fake);
      }
      const log = await Deno.readTextFile(join(harness.tmpDir, "loop.log"))
        .catch(() => "");
      assertEquals(
        alive,
        false,
        `the orphaned probe (PID ${fake}) survived a fresh supervisor; log:\n${log}`,
      );
      assert(
        log.includes(
          `reaping orphaned control-plane probe PID ${fake} (supervisor gone)`,
        ),
        `the reaping must be logged; got:\n${log}`,
      );
    } finally {
      killQuietly([...fakes, ...leftovers]);
      if (child !== undefined) await killTree(child);
      await harness.cleanup();
    }
  },
});

Deno.test({
  name:
    "loop.sh #4568 - the reaper leaves a probe registered to another checkout alone",
  ignore: Deno.build.os === "windows",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const harness = await setupHarness({ runStub: LONG_RUN_STUB });
    const stateDir = join(harness.tmpDir, ".vibe-coder");
    const fakePath = await writeFakeSupervisor(harness.tmpDir);
    let fakes: number[] = [];
    let leftovers: number[] = [];
    let child: Deno.ChildProcess | undefined;
    try {
      fakes = await startOrphanFake(fakePath);
      const fake = fakes[0];
      assert(
        fakes.length === 1 && fake !== undefined,
        `expected exactly one fake supervisor, found ${fakes.length}`,
      );
      assertEquals(
        await parentPidOf(fake),
        1,
        "the fake must be an orphan re-parented to init, or the test proves nothing",
      );
      leftovers = await getDescendants(fake);
      // Registered to a checkout that is not this one.
      await registerProbe(
        stateDir,
        fake,
        `${await Deno.realPath(harness.tmpDir)}-elsewhere`,
      );

      child = spawnLoopLogging(harness.tmpDir, { VIBE_STATE_DIR: stateDir });
      await delay(3000);
      const log = await Deno.readTextFile(join(harness.tmpDir, "loop.log"))
        .catch(() => "");
      assert(
        await isRunning(child.pid),
        `loop.sh must still be running; log:\n${log}`,
      );
      assert(
        await isRunning(fake),
        "a probe registered to another checkout must not be reaped",
      );
      assertEquals(
        log.includes("reaping orphaned"),
        false,
        `nothing must be reaped; log:\n${log}`,
      );
    } finally {
      killQuietly([...fakes, ...leftovers]);
      if (child !== undefined) await killTree(child);
      await harness.cleanup();
    }
  },
});

Deno.test({
  name: "loop.sh #4568 - the reaper leaves a probe that is not an orphan alone",
  ignore: Deno.build.os === "windows",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const harness = await setupHarness({ runStub: LONG_RUN_STUB });
    const stateDir = join(harness.tmpDir, ".vibe-coder");
    const fakePath = await writeFakeSupervisor(harness.tmpDir);
    let fakeChild: Deno.ChildProcess | undefined;
    let leftovers: number[] = [];
    let child: Deno.ChildProcess | undefined;
    try {
      // A child of this test, so its parent is alive and it is not re-parented.
      fakeChild = new Deno.Command("bash", {
        args: [fakePath],
        stdout: "null",
        stderr: "null",
      }).spawn();
      const fake = fakeChild.pid;
      assertEquals(
        await parentPidOf(fake),
        Deno.pid,
        "the fake must be a live child of this test, not an orphan, or the test proves nothing",
      );
      leftovers = await getDescendants(fake);
      await registerProbe(stateDir, fake, await Deno.realPath(harness.tmpDir));

      child = spawnLoopLogging(harness.tmpDir, { VIBE_STATE_DIR: stateDir });
      await delay(3000);
      const log = await Deno.readTextFile(join(harness.tmpDir, "loop.log"))
        .catch(() => "");
      assert(
        await isRunning(child.pid),
        `loop.sh must still be running; log:\n${log}`,
      );
      assert(
        await isRunning(fake),
        "a probe still owned by a live parent must not be reaped",
      );
      assertEquals(
        log.includes("reaping orphaned"),
        false,
        `nothing must be reaped; log:\n${log}`,
      );
    } finally {
      if (fakeChild !== undefined) {
        try {
          fakeChild.kill("SIGKILL");
        } catch { /* already gone */ }
        try {
          await fakeChild.status;
        } catch { /* already reaped */ }
      }
      killQuietly(leftovers);
      if (child !== undefined) await killTree(child);
      await harness.cleanup();
    }
  },
});

Deno.test({
  name:
    "loop.sh #4568 - a failed listing and side containers do not end the worker watch",
  ignore: Deno.build.os === "windows",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const harness = await setupHarness({
      runStub: LONG_RUN_STUB,
      containerStub: [
        "#!/bin/bash",
        'count="$(dirname "$0")/../count"',
        'log="$(dirname "$0")/../container.log"',
        'echo "$*" >> "$log"',
        'case "$1" in',
        '  ls) n=$(cat "$count" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$count"',
        '      case "$n" in',
        '        1) echo "vibe-coder-999-egress running";;',
        '        2) echo "vibe-coder-999-init running";;',
        "        3) :;;",
        '        4) echo "vibe-coder-999 running";;',
        "        5) exit 1;;",
        '        *) echo "vibe-coder-999 running";;',
        "      esac;;",
        "  *) exit 0;;",
        "esac",
      ].join("\n"),
    });
    const child = spawnLoop(harness.tmpDir, {
      VIBE_RUN_MAX_SECONDS: "0",
      VIBE_PROBE_INTERVAL_SECONDS: "1",
    });
    try {
      for (let i = 0; i < 100; i++) {
        await delay(100);
        const log = await Deno.readTextFile(
          join(harness.tmpDir, "container.log"),
        ).catch(() => "");
        if (log.split("exec vibe-coder-999 true\n").length >= 3) break;
      }
      const log = await Deno.readTextFile(
        join(harness.tmpDir, "container.log"),
      );
      assert(
        log.split("exec vibe-coder-999 true\n").length >= 3,
        `worker must be probed again after listing failure; got:\n${log}`,
      );
      assert(
        !log.includes("exec vibe-coder-999-egress") &&
          !log.includes("exec vibe-coder-999-init"),
        `side containers must not be probed; got:\n${log}`,
      );
    } finally {
      await killTree(child);
      await harness.cleanup();
    }
  },
});

Deno.test({
  name: "loop.sh #4568 - a registered orphan with a different command survives",
  ignore: Deno.build.os === "windows",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const harness = await setupHarness({ runStub: LONG_RUN_STUB });
    const stateDir = join(harness.tmpDir, ".vibe-coder");
    const marker = join(harness.tmpDir, "unrelated-sleep");
    await Deno.symlink("/bin/sleep", marker);
    let pids: number[] = [];
    let child: Deno.ChildProcess | undefined;
    try {
      await new Deno.Command("bash", {
        args: [
          "-c",
          'cd "$1"; nohup "$2" 300 >/dev/null 2>&1 &',
          "bash",
          harness.tmpDir,
          marker,
        ],
        stdout: "null",
        stderr: "null",
      }).output();
      pids = await pgrepFull(marker);
      assertEquals(pids.length, 1);
      const pid = pids[0];
      assert(pid !== undefined);
      assertEquals(await parentPidOf(pid), 1);
      await registerProbe(stateDir, pid, await Deno.realPath(harness.tmpDir));
      child = spawnLoopLogging(harness.tmpDir, { VIBE_STATE_DIR: stateDir });
      await delay(3000);
      const log = await Deno.readTextFile(join(harness.tmpDir, "loop.log"));
      assert(await isRunning(pid), "unrelated orphan must survive");
      assert(!log.includes("reaping orphaned control-plane probe"), log);
    } finally {
      killQuietly(pids);
      if (child !== undefined) await killTree(child);
      await harness.cleanup();
    }
  },
});

Deno.test({
  name:
    "loop.sh #4568 - the probe stops when its living supervisor changes parent",
  ignore: Deno.build.os === "windows",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const harness = await setupHarness({
      runStub: LONG_RUN_STUB,
      containerStub: NO_CONTAINER_STUB,
    });
    const parent = new Deno.Command("bash", {
      args: [
        "-c",
        "./loop.sh > loop.log 2>&1 & echo $! > loop.pid; while [[ ! -e release ]]; do sleep 0.1; done",
      ],
      cwd: harness.tmpDir,
      env: {
        HOME: harness.tmpDir,
        PATH: `${join(harness.tmpDir, "bin")}:${Deno.env.get("PATH") ?? ""}`,
        VIBE_RUN_MAX_SECONDS: "0",
        VIBE_PROBE_INTERVAL_SECONDS: "1",
      },
      stdout: "null",
      stderr: "null",
    }).spawn();
    let tree: number[] = [];
    try {
      let pid = 0;
      for (let i = 0; i < 50 && !pid; i++) {
        await delay(100);
        pid = Number(
          await Deno.readTextFile(join(harness.tmpDir, "loop.pid")).catch(() =>
            "0"
          ),
        );
      }
      assert(pid > 0);
      const probe = await findProbe(pid, 1);
      assert(probe !== undefined, "probe must start before parent exits");
      assertEquals(await parentPidOf(pid), parent.pid);
      tree = [pid, ...await getDescendants(pid)];
      await Deno.writeTextFile(join(harness.tmpDir, "release"), "");
      await parent.status;
      for (let i = 0; i < 80 && await isRunning(probe); i++) await delay(100);
      assert(await isRunning(pid), "supervisor must remain alive");
      assert(!(await isRunning(probe)), "probe must stop after reparenting");
      const log = await Deno.readTextFile(join(harness.tmpDir, "loop.log"));
      assert(log.includes("changed parent"), log);
    } finally {
      killQuietly(tree);
      try {
        parent.kill("SIGKILL");
      } catch { /* already exited */ }
      await parent.status;
      await harness.cleanup();
    }
  },
});

// ===========================================================================
// Issue #1221 — the control-plane probe must not depend on a `timeout` binary
//
// The probe and its recovery spelled `timeout 30 container …` literally, while
// the supervisor had already resolved gtimeout/timeout once for its other
// bounded calls. macOS ships neither (setup.sh treats `timeout` as
// container-owned and never demands it on the host) and Apple `container` —
// the runtime this probe exists for — is macOS-only, so on a stock fleet host
// every one of those calls was a `command not found` with its stderr sent to
// /dev/null: `container ls` never ran, the probe saw no container, the failure
// counter reset, and the Issue #323 recovery could never fire.
// ===========================================================================

/**
 * A PATH holding only the tools loop.sh needs — and deliberately neither
 * `timeout` nor `gtimeout`, which is what a stock macOS host looks like.
 *
 * Symlinked from the first standard location that has each tool, so the
 * directory set is explicit rather than inherited from the test runner's own
 * PATH (which on Linux carries coreutils, and with it `timeout`).
 */
async function minimalToolPath(tmpDir: string): Promise<string> {
  const dir = join(tmpDir, "nobin");
  await Deno.mkdir(dir, { recursive: true });
  const tools = [
    "sleep",
    "date",
    "dirname",
    "mkdir",
    "rm",
    "tee",
    "ps",
    "pgrep",
    "awk",
    "grep",
    "tr",
    "head",
  ];
  const searchDirs = [
    "/bin",
    "/usr/bin",
    "/usr/local/bin",
    "/opt/homebrew/bin",
  ];
  for (const tool of tools) {
    let linked = false;
    for (const searchDir of searchDirs) {
      const candidate = `${searchDir}/${tool}`;
      try {
        await Deno.lstat(candidate);
      } catch {
        continue;
      }
      await Deno.symlink(candidate, join(dir, tool));
      linked = true;
      break;
    }
    // A missing tool would cripple loop.sh and the failure would be reported
    // as "the probe did not recover the container" — a wrong answer, not a
    // missing one. Fail here instead, naming the tool.
    assert(
      linked,
      `${tool} was not found in ${searchDirs.join(", ")} — the minimal PATH ` +
        `cannot run loop.sh, so this test would prove nothing`,
    );
  }
  // The premise of the test, checked the way loop.sh checks it: `command -v`
  // under the PATH the supervisor will actually be given.
  const probe = await new Deno.Command("/bin/bash", {
    args: ["-c", "command -v timeout || command -v gtimeout"],
    env: { PATH: dir },
    stdout: "null",
    stderr: "null",
  }).output();
  assert(
    !probe.success,
    "the minimal PATH must expose no timeout binary, or the test proves nothing",
  );
  return dir;
}

Deno.test({
  name:
    "loop.sh #1221 - the control-plane probe recovers a wedged container on a host with no timeout binary",
  ignore: Deno.build.os === "windows",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const harness = await setupHarness({
      runStub: [
        "#!/bin/bash",
        'echo "$(date +%s)" >> "$(dirname "$0")/invocations.log"',
        "sleep 300",
      ].join("\n"),
      containerStub: [
        "#!/bin/bash",
        'log="$(dirname "$0")/../container.log"',
        'echo "$*" >> "$log"',
        'case "$1" in',
        '  ls) echo "vibe-coder-999  img  linux  arm64  running  ip  6  16384";;',
        // The 2026-08-22 shape: the control plane is dead, every exec fails.
        "  exec) exit 1;;",
        "  kill) exit 0;;",
        "  *) exit 0;;",
        "esac",
      ].join("\n"),
    });
    const toolDir = await minimalToolPath(harness.tmpDir);
    // Spawned through the shebang rather than a `bash` looked up on PATH,
    // because this PATH deliberately holds almost nothing.
    const child = new Deno.Command(join(harness.tmpDir, "loop.sh"), {
      cwd: harness.tmpDir,
      env: {
        LOOP_SLEEP_SECONDS: "1",
        PATH: `${join(harness.tmpDir, "bin")}:${toolDir}`,
        HOME: harness.tmpDir,
        VIBE_RUN_MAX_SECONDS: "0",
        VIBE_PROBE_INTERVAL_SECONDS: "1",
        VIBE_PROBE_FAILURES: "1",
      },
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    try {
      // Wait for the event, under a bound, rather than for a fixed span: the
      // recovery lands about two probe intervals in, and a loaded host that is
      // merely slow must not fail for the wrong reason.
      const readLog = () =>
        Deno.readTextFile(join(harness.tmpDir, "container.log"))
          .catch(() => "");
      let out = "";
      for (let attempt = 0; attempt < 60; attempt++) {
        out = await readLog();
        if (out.includes("kill vibe-coder-999")) break;
        await delay(250);
      }
      assert(
        out.includes("ls"),
        `the probe must actually run \`container ls\` on a host with no timeout binary; container calls were:\n${
          out || "(none)"
        }`,
      );
      assert(
        out.includes("kill vibe-coder-999"),
        `a dead control plane must still be recovered without a timeout binary; container calls were:\n${
          out || "(none)"
        }`,
      );
    } finally {
      await killTree(child);
      await harness.cleanup();
    }
  },
});
