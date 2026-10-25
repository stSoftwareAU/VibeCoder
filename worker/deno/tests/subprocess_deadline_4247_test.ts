/**
 * Subprocess chokepoint budgets (Issue #4247).
 *
 * The `gh` table, the run-timeline clamp and the bounded kill are exercised
 * through the real chokepoints. The timeline is the one from Issue #4242,
 * installed only for the synchronous prefix of a call and then cleared, so a
 * parallel test does not inherit it.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  _resetGhSpawnRunner,
  _setGhSpawnRunner,
  spawnGh,
} from "../lib/gh_spawn.ts";
import { runGitCommand, TIMEOUT_EXIT_CODE } from "../lib/git_timeout.ts";
import {
  resetRunTimelineForTests,
  type RunTimeline,
  setRunTimeline,
} from "../lib/run_timeline.ts";
import {
  _resetChokepointNowForTests,
  _resetKillGraceMsForTests,
  _setChokepointNowForTests,
  _setKillGraceMsForTests,
  HARD_KILL_WRAP_UP_RESERVE_MS,
  runWithTimeout,
} from "../lib/subprocess_timeout.ts";
import {
  DEFAULT_GH_CLONE_TIMEOUT,
  DEFAULT_GH_COMMAND_TIMEOUT,
  DEFAULT_GH_PAGINATED_TIMEOUT,
  GH_TIMEOUT_EXIT_CODE,
} from "../lib/gh_timeout.ts";

const NOW = 1_700_000_000_000;

/** A timeline whose helpers match {@link RunTimeline}. Hard kill may be null. */
function timeline(input: {
  finishMs: number;
  hardKillMs: number | null;
}): RunTimeline {
  const targetMs = input.finishMs - 3_600_000;
  return {
    targetMs,
    finishMs: input.finishMs,
    hardKillMs: input.hardKillMs,
    pastTarget: (now) => now >= targetMs,
    pastFinish: (now) => now >= input.finishMs,
    remainingToFinishMs: (now) => Math.max(0, input.finishMs - now),
    clampToFinishMs: (requestedMs, now, reserveMs) =>
      Math.min(requestedMs, Math.max(0, input.finishMs - now - reserveMs)),
  };
}

/** Install the clock and timeline for the synchronous prefix of one call. */
function pin(t: RunTimeline): void {
  _setChokepointNowForTests(() => NOW);
  setRunTimeline(t);
}

function unpin(): void {
  resetRunTimelineForTests();
  _resetChokepointNowForTests();
}

function captureBudget(): { timeoutMs: number | undefined } {
  const seen: { timeoutMs: number | undefined } = { timeoutMs: undefined };
  _setGhSpawnRunner((_args, options) => {
    seen.timeoutMs = options.timeoutMs;
    return Promise.resolve({
      code: 0,
      success: true,
      stdout: "",
      stderr: "",
    });
  });
  return seen;
}

Deno.test("spawnGh - api and issue view take the seconds-class timeout", async () => {
  resetRunTimelineForTests();
  const api = captureBudget();
  try {
    await spawnGh(["api", "user"]);
    assertEquals(api.timeoutMs, DEFAULT_GH_COMMAND_TIMEOUT * 1000);
  } finally {
    _resetGhSpawnRunner();
  }

  const issue = captureBudget();
  try {
    await spawnGh(["issue", "view", "1"]);
    assertEquals(issue.timeoutMs, DEFAULT_GH_COMMAND_TIMEOUT * 1000);
  } finally {
    _resetGhSpawnRunner();
  }
});

Deno.test("spawnGh - repo clone takes the minutes-class timeout", async () => {
  resetRunTimelineForTests();
  const seen = captureBudget();
  try {
    await spawnGh(["repo", "clone", "me/repo", "dest"]);
    assertEquals(seen.timeoutMs, DEFAULT_GH_CLONE_TIMEOUT * 1000);
    assert(DEFAULT_GH_CLONE_TIMEOUT >= 60);
  } finally {
    _resetGhSpawnRunner();
  }
});

Deno.test("spawnGh - a paginated read takes the paginated timeout", async () => {
  resetRunTimelineForTests();
  const seen = captureBudget();
  try {
    await spawnGh(["api", "--paginate", "/orgs/acme/repos"]);
    assertEquals(seen.timeoutMs, DEFAULT_GH_PAGINATED_TIMEOUT * 1000);
  } finally {
    _resetGhSpawnRunner();
  }
});

Deno.test("spawnGh - an explicit timeout or signal is not replaced by the table", async () => {
  resetRunTimelineForTests();
  const explicit = captureBudget();
  try {
    await spawnGh(["repo", "clone", "me/repo"], { timeoutMs: 12_000 });
    assertEquals(explicit.timeoutMs, 12_000);
  } finally {
    _resetGhSpawnRunner();
  }

  const signalled = captureBudget();
  try {
    await spawnGh(["api", "user"], { signal: new AbortController().signal });
    assertEquals(signalled.timeoutMs, undefined);
  } finally {
    _resetGhSpawnRunner();
  }
});

Deno.test("spawnGh - a timeline clamps the budget to the finish, then to hard kill minus 300s", async () => {
  const beforeFinish = captureBudget();
  pin(timeline({ finishMs: NOW + 5_000, hardKillMs: NOW + 4_000_000 }));
  const pendingFinish = spawnGh(["api", "user"]);
  unpin();
  try {
    await pendingFinish;
    assertEquals(beforeFinish.timeoutMs, 5_000);
  } finally {
    _resetGhSpawnRunner();
  }

  const pastFinish = captureBudget();
  pin(timeline({
    finishMs: NOW - 1,
    hardKillMs: NOW + HARD_KILL_WRAP_UP_RESERVE_MS + 4_000,
  }));
  const pendingPast = spawnGh(["issue", "view", "1"]);
  unpin();
  try {
    await pendingPast;
    assertEquals(pastFinish.timeoutMs, 4_000);
  } finally {
    _resetGhSpawnRunner();
  }
});

Deno.test("spawnGh - a budget that clamps to nothing is refused and names the command", async () => {
  let calls = 0;
  _setGhSpawnRunner(() => {
    calls++;
    return Promise.resolve({ code: 0, success: true, stdout: "", stderr: "" });
  });
  pin(timeline({
    finishMs: NOW - 1,
    hardKillMs: NOW + HARD_KILL_WRAP_UP_RESERVE_MS - 1,
  }));
  const pending = spawnGh(["api", "user"]);
  unpin();
  try {
    const error = await assertRejects(() => pending, Error);
    assertStringIncludes(error.message, "gh api user");
    assertStringIncludes(error.message, "refusing to spawn");
    assertEquals(calls, 0);
  } finally {
    _resetGhSpawnRunner();
  }
});

Deno.test("runWithTimeout - a timeline clamps to the finish and, past it, to hard kill minus 300s", async () => {
  pin(timeline({ finishMs: NOW + 200, hardKillMs: NOW + 4_000_000 }));
  const before = runWithTimeout("sh", ["-c", "sleep 30"], {
    timeoutMs: 10_000,
  });
  unpin();
  const beforeResult = await before;
  assert(beforeResult.ok);
  if (beforeResult.ok) {
    assertEquals(beforeResult.value.timedOut, true);
    assertEquals(beforeResult.value.success, false);
    assertStringIncludes(beforeResult.value.stderr, "Timed out after 200ms");
  }

  pin(timeline({
    finishMs: NOW - 1,
    hardKillMs: NOW + HARD_KILL_WRAP_UP_RESERVE_MS + 180,
  }));
  const past = runWithTimeout("sh", ["-c", "sleep 30"], { timeoutMs: 10_000 });
  unpin();
  const pastResult = await past;
  assert(pastResult.ok);
  if (pastResult.ok) {
    assertEquals(pastResult.value.timedOut, true);
    assertStringIncludes(pastResult.value.stderr, "Timed out after 180ms");
  }
});

Deno.test("runWithTimeout - a budget that clamps to nothing names the command and does not spawn", async () => {
  const dir = await Deno.makeTempDir({ prefix: "deadline-4247-" });
  const marker = `${dir}/ran`;
  pin(timeline({
    finishMs: NOW - 1,
    hardKillMs: NOW + HARD_KILL_WRAP_UP_RESERVE_MS - 1,
  }));
  const pending = runWithTimeout("bash", ["-c", `touch ${marker}`], {
    timeoutMs: 5_000,
  });
  unpin();
  try {
    const error = await assertRejects(() => pending, Error);
    assertStringIncludes(error.message, "bash");
    assertStringIncludes(error.message, "refusing to spawn");
    let ran = true;
    try {
      await Deno.stat(marker);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) ran = false;
      else throw error;
    }
    assertEquals(ran, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runGitCommand - a timeline clamps to the finish, and past it to hard kill minus 300s", async () => {
  const dir = await Deno.makeTempDir({ prefix: "git-deadline-" });
  try {
    await runGitCommand(["init", "--quiet"], { cwd: dir });
    const hook = `${dir}/slow-fsmonitor.sh`;
    await Deno.writeTextFile(hook, "#!/bin/sh\nsleep 30\n");
    await Deno.chmod(hook, 0o755);
    await runGitCommand(["config", "core.fsmonitor", hook], { cwd: dir });

    pin(timeline({ finishMs: NOW + 200, hardKillMs: NOW + 4_000_000 }));
    const before = runGitCommand(["status", "--porcelain"], {
      cwd: dir,
      timeoutSeconds: 30,
    });
    unpin();
    const beforeResult = await before;
    assert(beforeResult.ok);
    if (beforeResult.ok) {
      assertEquals(beforeResult.value.code, TIMEOUT_EXIT_CODE);
      assertStringIncludes(beforeResult.value.stderr, "timed out after 0.2s");
    }

    pin(timeline({
      finishMs: NOW - 1,
      hardKillMs: NOW + HARD_KILL_WRAP_UP_RESERVE_MS + 250,
    }));
    const past = runGitCommand(["status", "--porcelain"], {
      cwd: dir,
      timeoutSeconds: 30,
    });
    unpin();
    const pastResult = await past;
    assert(pastResult.ok);
    if (pastResult.ok) {
      assertEquals(pastResult.value.code, TIMEOUT_EXIT_CODE);
      assertStringIncludes(pastResult.value.stderr, "timed out after 0.25s");
    }
  } finally {
    unpin();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runGitCommand - a budget that clamps to nothing names the command", async () => {
  pin(timeline({
    finishMs: NOW - 1,
    hardKillMs: NOW + HARD_KILL_WRAP_UP_RESERVE_MS - 1,
  }));
  const pending = runGitCommand(["status", "--porcelain"], {
    timeoutSeconds: 30,
  });
  unpin();
  const error = await assertRejects(() => pending, Error);
  assertStringIncludes(error.message, "git status --porcelain");
  assertStringIncludes(error.message, "refusing to spawn");
});

Deno.test("chokepoints - with no timeline set the timeout is today's value", async () => {
  pin(timeline({ finishMs: NOW + 50, hardKillMs: NOW + 4_000_000 }));
  unpin();
  const result = await runWithTimeout("sh", ["-c", "sleep 30"], {
    timeoutMs: 200,
  });
  assert(result.ok);
  if (result.ok) {
    assertEquals(result.value.timedOut, true);
    assertEquals(result.value.success, false);
    assertStringIncludes(result.value.stderr, "Timed out after 200ms");
  }
});

/**
 * Budget before the chokepoint timer fires on a child that ignores SIGTERM.
 *
 * The timer is armed before `spawn()`, so a 200 ms budget can elapse while
 * bash is still starting and has not reached `trap`. Two seconds is enough
 * for a cold start; the test still refuses to send SIGTERM until the stub
 * has recorded that the trap is installed.
 */
const TRAP_TIMEOUT_MS = 2_000;

/** Shortened post-SIGTERM grace. The production grace stays 5 s. */
const TRAP_GRACE_MS = 300;

/**
 * A child that ignores SIGTERM. It records the trap before looping, so the
 * caller can see that SIGTERM will meet a process that has the trap in place.
 */
const IGNORE_SIGTERM_SCRIPT =
  "trap '' TERM; : > \"$TRAP_READY\"; while true; do :; done";

/**
 * Resolve once the stub has installed its SIGTERM trap.
 *
 * `deadlineMs` is shorter than {@link TRAP_TIMEOUT_MS}, so a successful
 * return means the chokepoint timer has not fired yet.
 */
async function waitForTrapReady(
  path: string,
  deadlineMs: number,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < deadlineMs) {
    try {
      await Deno.stat(path);
      return;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `SIGTERM trap was not installed within ${deadlineMs}ms (${path})`,
  );
}

Deno.test({
  name:
    "runWithTimeout - a child that ignores SIGTERM is given up inside the grace",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const readyDir = await Deno.makeTempDir({ prefix: "trap-ready-" });
    const ready = `${readyDir}/ready`;
    _setKillGraceMsForTests(TRAP_GRACE_MS);
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(" "));
    };
    const started = Date.now();
    const pending = runWithTimeout(
      "bash",
      ["-c", IGNORE_SIGTERM_SCRIPT],
      {
        timeoutMs: TRAP_TIMEOUT_MS,
        env: {
          PATH: Deno.env.get("PATH") ?? "",
          TRAP_READY: ready,
        },
      },
    );
    try {
      await waitForTrapReady(ready, TRAP_TIMEOUT_MS - 500);
      const result = await pending;
      const elapsed = Date.now() - started;
      assert(result.ok);
      if (result.ok) {
        assertEquals(result.value.timedOut, true);
        assertEquals(result.value.success, false);
        assertEquals(result.value.code, 124);
      }
      const line = lines.find((entry) =>
        entry.includes("did not complete within")
      );
      assert(line !== undefined, lines.join("\n"));
      assertStringIncludes(line, "kill of bash");
      assertEquals(line.includes("WARNING:"), false);
      assertEquals(line.includes("ERROR:"), false);
      assert(
        elapsed < TRAP_TIMEOUT_MS + TRAP_GRACE_MS + 2_000,
        `kill outcome took ${elapsed}ms, past the timeout plus the grace`,
      );
    } finally {
      await pending.then(() => {}, () => {});
      console.error = original;
      _resetKillGraceMsForTests();
      await Deno.remove(readyDir, { recursive: true });
    }
  },
});

Deno.test("chokepoints - past the finish with no hard kill the spawn is not refused", async () => {
  pin(timeline({ finishMs: NOW - 1, hardKillMs: null }));
  const pending = runWithTimeout("echo", ["still-wrapping-up"], {
    timeoutMs: 5_000,
  });
  unpin();
  const result = await pending;
  assert(result.ok);
  if (result.ok) {
    assertEquals(result.value.timedOut, false);
    assertEquals(result.value.success, true);
    assertStringIncludes(result.value.stdout, "still-wrapping-up");
  }

  const seen = captureBudget();
  pin(timeline({ finishMs: NOW - 1, hardKillMs: null }));
  const ghPending = spawnGh(["api", "user"]);
  unpin();
  try {
    await ghPending;
    assertEquals(seen.timeoutMs, DEFAULT_GH_COMMAND_TIMEOUT * 1000);
  } finally {
    _resetGhSpawnRunner();
  }

  // A caller signal is the only bound. A non-finite clamp must not become
  // an immediate timeout that refuses wrap-up.
  const signalled = captureBudget();
  pin(timeline({ finishMs: NOW - 1, hardKillMs: null }));
  const signalPending = spawnGh(["api", "user"], {
    signal: new AbortController().signal,
  });
  unpin();
  try {
    await signalPending;
    assertEquals(signalled.timeoutMs, undefined);
  } finally {
    _resetGhSpawnRunner();
  }
});

/**
 * A `gh` script on PATH, so the production runner is the code under test.
 *
 * The stub directory is prepended to the inherited PATH. Replacing PATH
 * would hide `sleep` and the shell would exit 127 before the runner's
 * timer or kill path ran.
 */
async function stubGh(
  body: string,
): Promise<{ dir: string; env: { PATH: string } }> {
  const dir = await Deno.makeTempDir({ prefix: "gh-real-runner-" });
  const path = `${dir}/gh`;
  await Deno.writeTextFile(path, `#!/bin/bash\n${body}\n`);
  await Deno.chmod(path, 0o755);
  const inherited = Deno.env.get("PATH") ?? "";
  return { dir, env: { PATH: `${dir}:${inherited}` } };
}

Deno.test({
  name: "spawnGh production runner - a timeout is exit 124 and not success",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const stub = await stubGh("exec /bin/sleep 30");
    _resetGhSpawnRunner();
    resetRunTimelineForTests();
    const started = Date.now();
    try {
      const result = await spawnGh(["api", "user"], {
        timeoutMs: 200,
        env: stub.env,
      });
      const elapsed = Date.now() - started;
      assertEquals(result.code, GH_TIMEOUT_EXIT_CODE);
      assertEquals(result.success, false);
      assert(
        elapsed < 3_000,
        `timed out gh took ${elapsed}ms`,
      );
    } finally {
      _resetGhSpawnRunner();
      await Deno.remove(stub.dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "spawnGh production runner - a caller abort rejects with AbortError",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const stub = await stubGh("exec /bin/sleep 30");
    _resetGhSpawnRunner();
    resetRunTimelineForTests();
    const controller = new AbortController();
    const pending = spawnGh(["api", "user"], {
      signal: controller.signal,
      env: stub.env,
    });
    const abortTimer = setTimeout(() => controller.abort(), 100);
    try {
      const error = await assertRejects(() => pending, DOMException);
      assertEquals(error.name, "AbortError");
    } finally {
      clearTimeout(abortTimer);
      _resetGhSpawnRunner();
      await Deno.remove(stub.dir, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "spawnGh production runner - a gh that ignores SIGTERM is given up inside the grace",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const stub = await stubGh(IGNORE_SIGTERM_SCRIPT);
    const ready = `${stub.dir}/trap-ready`;
    _resetGhSpawnRunner();
    resetRunTimelineForTests();
    _setKillGraceMsForTests(TRAP_GRACE_MS);
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(" "));
    };
    const started = Date.now();
    const pending = spawnGh(["api", "user"], {
      timeoutMs: TRAP_TIMEOUT_MS,
      env: { ...stub.env, TRAP_READY: ready },
    });
    try {
      await waitForTrapReady(ready, TRAP_TIMEOUT_MS - 500);
      const result = await pending;
      const elapsed = Date.now() - started;
      assertEquals(result.code, GH_TIMEOUT_EXIT_CODE);
      assertEquals(result.success, false);
      const line = lines.find((entry) =>
        entry.includes("did not complete within")
      );
      assert(
        line !== undefined,
        `missing kill log (stderr: ${result.stderr}; lines: ${
          lines.join(" | ")
        })`,
      );
      assertStringIncludes(line, "kill of gh");
      assertEquals(line.includes("WARNING:"), false);
      assertEquals(line.includes("ERROR:"), false);
      assert(
        elapsed < TRAP_TIMEOUT_MS + TRAP_GRACE_MS + 2_000,
        `kill outcome took ${elapsed}ms, past the timeout plus the grace`,
      );
    } finally {
      await pending.then(() => {}, () => {});
      console.error = original;
      _resetKillGraceMsForTests();
      _resetGhSpawnRunner();
      await Deno.remove(stub.dir, { recursive: true });
    }
  },
});
