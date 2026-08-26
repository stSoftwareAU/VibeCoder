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

async function killTree(child: Deno.ChildProcess): Promise<void> {
  try {
    child.kill("SIGKILL");
  } catch { /* already dead */ }
  try {
    await child.status;
  } catch { /* ignore */ }
  // Drain pipes so the test runner does not leak file descriptors.
  try {
    await child.stdout.cancel();
  } catch { /* ignore */ }
  try {
    await child.stderr.cancel();
  } catch { /* ignore */ }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

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
      try {
        child.kill("SIGKILL");
        await child.status;
      } catch { /* best-effort */ }
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
      try {
        child.kill("SIGKILL");
        await child.status;
      } catch { /* best-effort */ }
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
      try {
        child.kill("SIGKILL");
        await child.status;
      } catch { /* best-effort */ }
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
      assertEquals(env["VIBE_RUN_MAX_SECONDS"], "5400");
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
      try {
        child.kill("SIGKILL");
        await child.status;
      } catch { /* best-effort */ }
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
      try {
        child.kill("SIGKILL");
        await child.status;
      } catch { /* best-effort */ }
      await harness.cleanup();
    }
  },
});
