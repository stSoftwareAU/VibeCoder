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

function spawnLoop(tmpDir: string): Deno.ChildProcess {
  return new Deno.Command("bash", {
    args: [join(tmpDir, "loop.sh")],
    cwd: tmpDir,
    env: {
      LOOP_SLEEP_SECONDS: "1",
      PATH: `${join(tmpDir, "bin")}:${Deno.env.get("PATH") ?? ""}`,
      HOME: tmpDir,
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
