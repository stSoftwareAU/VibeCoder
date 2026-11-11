/**
 * Tests for the pre-push gate's `deno test` baseline and outage handling
 * (Issue #4930, PR #5034 review).
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type DenoTestBaseline,
  denoTestFailureKeys,
  hasUncaughtError,
  isDenoFetchFailure,
  judgeDenoTestCheck,
  judgeDenoTestFailure,
  serialPassSkipped,
  unitTestCommand,
  worktreeBaseline,
} from "../lib/deno_test_baseline.ts";
import {
  PreFlightGateError,
  type PreFlightRunner,
} from "../lib/pre_flight_gate.ts";
import { defaultPrePushGit } from "../lib/pre_push_gate.ts";

// Output shape observed from `deno test` 2.x (ERRORS then FAILURES sections).
const OBSERVED = `running 3 tests from ./a_test.ts
boom one ... FAILED (403µs)
nested ...
  inner ... FAILED (0ms)

 ERRORS 

boom one => ./a_test.ts:1:6
error: Error: x

nested ... inner => ./a_test.ts:3:44
error: Error: y

 FAILURES 

boom one => ./a_test.ts:1:6
nested ... inner => ./a_test.ts:3:44

FAILED | 1 passed | 2 failed (1 step) (4ms)
`;

function failure(
  output: string,
  reason: PreFlightGateError["reason"] = "non-zero-exit",
): PreFlightGateError {
  return new PreFlightGateError({
    reason,
    command: "deno task test:unit",
    exitCode: 1,
    output,
    message: `blocked: ${output.slice(0, 20)}`,
  });
}

const command = (files: string[]) => unitTestCommand(files);

Deno.test("denoTestFailureKeys: names failed tests and steps, ignoring line and colour", () => {
  assertEquals(
    [...denoTestFailureKeys(OBSERVED)].sort(),
    ["boom one => ./a_test.ts", "nested ... inner => ./a_test.ts"],
  );
  assertEquals(
    [...denoTestFailureKeys("\x1b[31mboom one => ./a_test.ts:9:6\x1b[0m\n")],
    ["boom one => ./a_test.ts"],
  );
  assertEquals(denoTestFailureKeys("error: boom\n").size, 0);
});

Deno.test("isDenoFetchFailure: observed fetch errors are outages, a 404 and a named failure are not", () => {
  for (
    const line of [
      "error: JSR package manifest for '@std/path' failed to load. Import 'http://127.0.0.1:9/@std/path/meta.json' failed.",
      "error: Import 'https://127.0.0.1:9/x.ts' failed.",
      'error: Failed loading http://127.0.0.1:9/left-pad for package "left-pad"',
      "    0: error sending request for url (https://x/y): client error (Connect)",
      "error: Failed caching npm package 'x@1'",
      "error: unexpected 503 Service Unavailable",
    ]
  ) {
    assert(isDenoFetchFailure(`Download x\n${line}\n`), line);
  }
  assertEquals(
    isDenoFetchFailure("error: JSR package not found: @std/nonexistent-zzz\n"),
    false,
  );
  assertEquals(
    isDenoFetchFailure(
      "error sending request for url (https://x)\n" + OBSERVED,
    ),
    false,
    "a named failed test is a test verdict",
  );
  // A long run that no pattern matches stays linear and unmatched.
  assertEquals(isDenoFetchFailure("e".repeat(200_000) + "\n"), false);
});

Deno.test("judgeDenoTestFailure: an outage and a missing deno are infrastructure", async () => {
  const outage = await judgeDenoTestFailure(
    failure(
      "error: JSR package manifest for '@std/path' failed to load. Import 'x' failed.\n",
    ),
    null,
    command,
  );
  assertEquals(outage.kind, "infrastructure");
  assertStringIncludes(
    (outage as { message: string }).message,
    "JSR package manifest",
  );
  const missing = await judgeDenoTestFailure(
    failure("deno: command not found", "not-started"),
    null,
    command,
  );
  assertEquals(missing.kind, "infrastructure");
  // A timeout is a verdict: a hung test is the branch's to fix.
  const timeout = await judgeDenoTestFailure(
    failure("", "timeout"),
    null,
    command,
  );
  assertEquals(timeout.kind, "verdict");
});

Deno.test("judgeDenoTestFailure: base-only needs every failed test red at the base", async () => {
  const baseline = (
    output: string | null,
    ranFiles = ["./a_test.ts"],
  ): DenoTestBaseline => ({
    runAtBase: () =>
      Promise.resolve({
        ranFiles,
        error: output === null ? null : failure(output),
      }),
  });
  const same = await judgeDenoTestFailure(
    failure(OBSERVED),
    baseline(OBSERVED),
    command,
  );
  assertEquals(same.kind, "base-only");

  // The base passes: the branch broke it.
  assertEquals(
    (await judgeDenoTestFailure(failure(OBSERVED), baseline(null), command))
      .kind,
    "verdict",
  );
  // The base fails only one of the two tests.
  assertEquals(
    (await judgeDenoTestFailure(
      failure(OBSERVED),
      baseline("boom one => ./a_test.ts:1:6\n"),
      command,
    )).kind,
    "verdict",
  );
  // The file does not exist at the base.
  assertEquals(
    (await judgeDenoTestFailure(
      failure(OBSERVED),
      baseline(OBSERVED, []),
      command,
    )).kind,
    "verdict",
  );
  // No baseline, an unavailable baseline, and output naming no test.
  assertEquals(
    (await judgeDenoTestFailure(failure(OBSERVED), null, command)).kind,
    "verdict",
  );
  assertEquals(
    (await judgeDenoTestFailure(
      failure(OBSERVED),
      { runAtBase: () => Promise.resolve(null) },
      command,
    )).kind,
    "verdict",
  );
  assertEquals(
    (await judgeDenoTestFailure(failure("boom"), baseline("boom"), command))
      .kind,
    "verdict",
  );
  // A test path that is not a plain relative _test.ts is never re-run, even
  // when the base would report it ran and failed the same way. Control: the
  // same shape with a plain path is base-only, so only the path decides.
  assertEquals(
    (await judgeDenoTestFailure(
      failure("x => ./ok_test.ts:1:1\n"),
      baseline("x => ./ok_test.ts:1:1\n", ["./ok_test.ts"]),
      command,
    )).kind,
    "base-only",
  );
  assertEquals(
    (await judgeDenoTestFailure(
      failure("x => ./../evil_test.ts:1:1\n"),
      baseline("x => ./../evil_test.ts:1:1\n", ["./../evil_test.ts"]),
      command,
    )).kind,
    "verdict",
  );
});

Deno.test("unitTestCommand: quotes each path and refuses one it cannot quote", () => {
  assertEquals(
    unitTestCommand(["./tests/a_test.ts", "tests/b_test.ts"]),
    "deno task test:unit 'tests/a_test.ts' 'tests/b_test.ts'",
  );
  assertEquals(unitTestCommand([`tests/a'"_test.ts`]), null);
});

Deno.test("judgeDenoTestFailure: a timeout is never an outage or a base-only failure", async () => {
  // A timeout whose output carries a fetch error is still the branch's to fix.
  const fetchOnTimeout = await judgeDenoTestFailure(
    failure(
      "error: JSR package manifest for '@std/path' failed to load. Import 'x' failed.\n",
      "timeout",
    ),
    null,
    command,
  );
  assertEquals(fetchOnTimeout.kind, "verdict");
  // A timeout that names tests red at the base is not waved through: control,
  // the same output as a plain failure is base-only.
  const redAtBase: DenoTestBaseline = {
    runAtBase: () =>
      Promise.resolve({
        ranFiles: ["./a_test.ts"],
        error: failure(OBSERVED),
      }),
  };
  assertEquals(
    (await judgeDenoTestFailure(failure(OBSERVED), redAtBase, command)).kind,
    "base-only",
  );
  assertEquals(
    (await judgeDenoTestFailure(
      failure(OBSERVED, "timeout"),
      redAtBase,
      command,
    )).kind,
    "verdict",
  );
});

// Output shape observed from `deno test` 2.9: a named failure beside a module
// that failed outside any test (a missing named export).
const WITH_UNCAUGHT = `${OBSERVED.split("\nFAILED |")[0]}
./b_test.ts (uncaught error)
error: SyntaxError: The requested module './a_test.ts' does not provide an export named 'nothing'
This error was not caught from a test and caused the test runner to fail on the referenced module.

 FAILURES 

boom one => ./a_test.ts:1:6
./b_test.ts (uncaught error)

FAILED | 1 passed | 3 failed (1 step) (4ms)
`;

const redAtBase: DenoTestBaseline = {
  runAtBase: () =>
    Promise.resolve({
      ranFiles: ["./a_test.ts", "./b_test.ts"],
      error: failure(OBSERVED),
    }),
};

Deno.test("hasUncaughtError: both uncaught-error forms count, a named failure and a long run do not", () => {
  assert(hasUncaughtError(WITH_UNCAUGHT));
  assert(hasUncaughtError("Uncaught error from ./c_test.ts FAILED\n"));
  assert(hasUncaughtError("\x1b[31m./tests/x_test.ts (uncaught error)\x1b[0m"));
  assertEquals(hasUncaughtError(OBSERVED), false);
  // A long run of the shared character, then a character the pattern rejects.
  assertEquals(hasUncaughtError("./" + "a".repeat(200_000) + " x\n"), false);
  assertEquals(
    hasUncaughtError("Uncaught error from " + "a ".repeat(100_000) + "\n"),
    false,
  );
});

Deno.test("judgeDenoTestFailure: a module that failed outside a test blocks even when every named failure is red at the base", async () => {
  // Control: the named failures alone are base-only.
  assertEquals(
    (await judgeDenoTestFailure(failure(OBSERVED), redAtBase, command)).kind,
    "base-only",
  );
  // The same named failures plus a new uncaught-error file are not.
  const mixed = await judgeDenoTestFailure(
    failure(WITH_UNCAUGHT),
    redAtBase,
    command,
  );
  assertEquals(mixed.kind, "verdict");
});

const PARALLEL_FAILED = `=== deno test: parallel pass — the parallel-safe files
boom one => ./a_test.ts:1:6
nested ... inner => ./a_test.ts:3:44
=== parallel pass: FAILED in 3.2s
`;

Deno.test("serialPassSkipped: only a failed parallel pass with no serial result skipped it", () => {
  assert(serialPassSkipped(PARALLEL_FAILED));
  assertEquals(
    serialPassSkipped(
      PARALLEL_FAILED +
        "=== deno test: serial pass — x\n=== serial pass: FAILED in 1s\n",
    ),
    false,
  );
  assertEquals(
    serialPassSkipped(
      "=== parallel pass: PASSED in 3s\n=== serial pass: FAILED in 1s\n",
    ),
    false,
  );
  // A runner that prints no pass lines is not ours to judge.
  assertEquals(serialPassSkipped(OBSERVED), false);
});

Deno.test("judgeDenoTestCheck: a base-only parallel failure still runs the serial pass the runner skipped", async () => {
  const parallelOutput = OBSERVED + PARALLEL_FAILED;
  const check = (
    serial: (command: string) => ReturnType<typeof serialOutcome>,
    output = parallelOutput,
  ) =>
    judgeDenoTestCheck({
      error: failure(output),
      command: "deno task test:unit",
      baseline: redAtBase,
      baseCommand: command,
      run: (cmd) => Promise.resolve(serial(cmd)),
    });
  const serialOutcome = (output: string | null) =>
    output === null
      ? { ok: true as const, value: undefined }
      : { ok: false as const, error: failure(output) };
  // Answers the serial command; any other command fails a test the base does
  // not, so running the wrong one changes the outcome.
  const onlySerial = (output: string | null) => (cmd: string) =>
    cmd.endsWith(" --serial-only")
      ? serialOutcome(output)
      : serialOutcome("wrong command => ./w_test.ts:1:1\n");

  // The serial pass passes: the base-only warning stands.
  assertEquals((await check(onlySerial(null))).kind, "base-only");
  // The serial pass fails a test the base does not: the push is blocked.
  const broken = await check(
    onlySerial(
      "serial one => ./c_test.ts:2:6\n=== serial pass: FAILED in 1s\n",
    ),
  );
  assertEquals(broken.kind, "verdict");
  assertStringIncludes((broken as { message: string }).message, "serial one");
  // The serial pass fails only on a test red at the base: both are warned.
  const both = await check(
    onlySerial("boom one => ./a_test.ts:1:6\n=== serial pass: FAILED in 1s\n"),
  );
  assertEquals(both.kind, "base-only");
  assertStringIncludes(
    (both as { warning: string }).warning,
    "boom one => ./a_test.ts",
  );
  // The serial pass cannot start: not a pass.
  const lost = await judgeDenoTestCheck({
    error: failure(parallelOutput),
    command: "deno task test:unit",
    baseline: redAtBase,
    baseCommand: command,
    run: () =>
      Promise.resolve({
        ok: false as const,
        error: failure("deno: command not found", "not-started"),
      }),
  });
  assertEquals(lost.kind, "infrastructure");
  // A run that did reach its serial pass is not run again.
  const reached = await judgeDenoTestCheck({
    error: failure(
      OBSERVED + PARALLEL_FAILED +
        "=== deno test: serial pass — x\n=== serial pass: FAILED in 1s\n",
    ),
    command: "deno task test:unit",
    baseline: redAtBase,
    baseCommand: command,
    // Running the serial pass again would fail a test the base does not.
    run: () => Promise.resolve(serialOutcome("rerun => ./w_test.ts:1:1\n")),
  });
  assertEquals(reached.kind, "base-only");
  // A verdict on the first run is returned without running anything else.
  const fresh = await judgeDenoTestCheck({
    error: failure("new one => ./z_test.ts:1:1\n" + PARALLEL_FAILED),
    command: "deno task test:unit",
    baseline: redAtBase,
    baseCommand: command,
    run: () => Promise.resolve(serialOutcome(null)),
  });
  assertEquals(fresh.kind, "verdict");
});

// ---- worktreeBaseline against a real git repository -------------------------

async function sh(cwd: string, ...args: string[]): Promise<string> {
  const out = await new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!out.success) {
    throw new Error(
      `git ${args.join(" ")}: ${new TextDecoder().decode(out.stderr)}`,
    );
  }
  return new TextDecoder().decode(out.stdout).trim();
}

/**
 * A repository whose fork commit holds `a_test.ts` at the top and under
 * `worker/deno`, each beside a marker file (`fork`, and `fork-nested` under
 * `worker/deno`), and whose head commit changes the markers to `head` and
 * `head-nested` and adds `gone_test.ts` in both places.
 */
async function makeForkRepo(): Promise<{ repo: string; fork: string }> {
  const repo = await Deno.makeTempDir({ prefix: "vibe_baseline_repo_" });
  await sh(repo, "init", "-q", "-b", "main");
  await sh(repo, "config", "user.email", "t@example.com");
  await sh(repo, "config", "user.name", "t");
  await sh(repo, "config", "commit.gpgsign", "false");
  await Deno.mkdir(`${repo}/worker/deno`, { recursive: true });
  for (const dir of [repo, `${repo}/worker/deno`]) {
    await Deno.writeTextFile(`${dir}/a_test.ts`, "export {};\n");
    await Deno.writeTextFile(
      `${dir}/marker.txt`,
      dir === repo ? "fork\n" : "fork-nested\n",
    );
  }
  await sh(repo, "add", "-A");
  await sh(repo, "commit", "-qm", "fork");
  const fork = await sh(repo, "rev-parse", "HEAD");
  for (const dir of [repo, `${repo}/worker/deno`]) {
    await Deno.writeTextFile(
      `${dir}/marker.txt`,
      dir === repo ? "head\n" : "head-nested\n",
    );
    await Deno.writeTextFile(`${dir}/gone_test.ts`, "export {};\n");
  }
  await sh(repo, "add", "-A");
  await sh(repo, "commit", "-qm", "head");
  return { repo, fork };
}

/**
 * A runner that answers by the marker file in the checkout it was asked to run
 * in: `codeFor(marker)` is its exit code. `cwds` collects the checkouts, only
 * to look for leftovers afterwards.
 */
function markerRunner(
  codeFor: (marker: string) => number,
  cwds: string[] = [],
): PreFlightRunner {
  return async (_command, options) => {
    cwds.push(options.cwd ?? "");
    const marker = (await Deno.readTextFile(`${options.cwd}/marker.txt`))
      .trim();
    return {
      started: true,
      code: codeFor(marker),
      stdout: `boom one => ./a_test.ts:1:6\nmarker=${marker}\n`,
      stderr: "",
    };
  };
}

async function onlyMainWorktree(repo: string): Promise<boolean> {
  return (await sh(repo, "worktree", "list")).split("\n").length === 1;
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

Deno.test("worktreeBaseline: a nested root runs only the files present at the fork, in a checkout of the fork", async () => {
  const { repo, fork } = await makeForkRepo();
  try {
    const tempDirs: string[] = [];
    const result = await worktreeBaseline({
      cwd: repo,
      root: "worker/deno",
      forkSha: fork,
      git: defaultPrePushGit,
      // Red only in the nested root's checkout of the fork.
      runner: markerRunner((marker) => marker === "fork-nested" ? 1 : 0),
      makeTempDir: async () => {
        const dir = await Deno.makeTempDir({ prefix: "vibe_baseline_t_" });
        tempDirs.push(dir);
        return dir;
      },
    }).runAtBase(command, ["./a_test.ts", "./gone_test.ts"]);

    assertEquals(result?.ranFiles, ["./a_test.ts"]);
    assertEquals(result?.error?.reason, "non-zero-exit");
    // The marker shows the base command ran at the fork, in the nested root.
    assertStringIncludes(result?.error?.output ?? "", "marker=fork-nested");
    assert(await onlyMainWorktree(repo), "the throwaway worktree is removed");
    assertEquals(await exists(tempDirs[0]!), false);
    // The head checkout is untouched.
    assertEquals(
      (await Deno.readTextFile(`${repo}/worker/deno/marker.txt`)).trim(),
      "head-nested",
    );
  } finally {
    await Deno.remove(repo, { recursive: true });
  }
});

Deno.test("worktreeBaseline: the top-level root runs in the tree itself; a passing base has no error", async () => {
  const { repo, fork } = await makeForkRepo();
  try {
    // Passes only in the top-level checkout of the fork.
    const result = await worktreeBaseline({
      cwd: repo,
      root: ".",
      forkSha: fork,
      git: defaultPrePushGit,
      runner: markerRunner((marker) => marker === "fork" ? 0 : 1),
    }).runAtBase(command, ["./a_test.ts"]);

    assertEquals(result, { ranFiles: ["./a_test.ts"], error: null });
    assert(await onlyMainWorktree(repo));
  } finally {
    await Deno.remove(repo, { recursive: true });
  }
});

Deno.test("worktreeBaseline: a fork that holds none of the files runs nothing", async () => {
  const { repo, fork } = await makeForkRepo();
  try {
    // Any run would be red, so a run would show as an error.
    const result = await worktreeBaseline({
      cwd: repo,
      root: "worker/deno",
      forkSha: fork,
      git: defaultPrePushGit,
      runner: markerRunner(() => 1),
    }).runAtBase(command, ["./gone_test.ts"]);

    assertEquals(result, { ranFiles: [], error: null });
    assert(await onlyMainWorktree(repo));
  } finally {
    await Deno.remove(repo, { recursive: true });
  }
});

Deno.test("worktreeBaseline: a fork that cannot be checked out is unavailable and leaves nothing behind", async () => {
  const { repo } = await makeForkRepo();
  try {
    const tempDirs: string[] = [];
    const result = await worktreeBaseline({
      cwd: repo,
      root: ".",
      forkSha: "0".repeat(40),
      git: defaultPrePushGit,
      runner: markerRunner(() => 1),
      makeTempDir: async () => {
        const dir = await Deno.makeTempDir({ prefix: "vibe_baseline_t_" });
        tempDirs.push(dir);
        return dir;
      },
    }).runAtBase(command, ["./a_test.ts"]);

    assertEquals(result, null);
    assert(await onlyMainWorktree(repo));
    assertEquals(await exists(tempDirs[0]!), false);
  } finally {
    await Deno.remove(repo, { recursive: true });
  }
});

Deno.test("worktreeBaseline: a git lookup that fails is unavailable, but the worktree is still removed", async () => {
  const { repo, fork } = await makeForkRepo();
  try {
    const result = await worktreeBaseline({
      cwd: repo,
      root: ".",
      forkSha: fork,
      // The real git, except that listing the fork's files fails.
      git: (args, cwd) =>
        args[0] === "ls-tree"
          ? Promise.resolve({ code: 128, stdout: "", stderr: "fatal" })
          : defaultPrePushGit(args, cwd),
      runner: markerRunner(() => 1),
    }).runAtBase(command, ["./a_test.ts"]);

    assertEquals(result, null);
    assert(await onlyMainWorktree(repo));
  } finally {
    await Deno.remove(repo, { recursive: true });
  }
});

Deno.test("worktreeBaseline: a command that cannot be built is unavailable and runs nothing", async () => {
  const { repo, fork } = await makeForkRepo();
  try {
    const result = await worktreeBaseline({
      cwd: repo,
      root: ".",
      forkSha: fork,
      git: defaultPrePushGit,
      runner: markerRunner(() => 1),
    }).runAtBase(() => null, ["./a_test.ts"]);

    assertEquals(result, null);
    assert(await onlyMainWorktree(repo));
  } finally {
    await Deno.remove(repo, { recursive: true });
  }
});

Deno.test("worktreeBaseline: the default temp directory is removed after the run", async () => {
  const { repo, fork } = await makeForkRepo();
  try {
    const cwds: string[] = [];
    await worktreeBaseline({
      cwd: repo,
      root: ".",
      forkSha: fork,
      git: defaultPrePushGit,
      runner: markerRunner(() => 1, cwds),
    }).runAtBase(command, ["./a_test.ts"]);

    // The checkout the run used is gone, and git no longer lists it.
    assertEquals(cwds.length > 0, true, "the run reached a checkout");
    assertEquals(await exists(cwds[0]!), false);
    assert(await onlyMainWorktree(repo));
  } finally {
    await Deno.remove(repo, { recursive: true });
  }
});
