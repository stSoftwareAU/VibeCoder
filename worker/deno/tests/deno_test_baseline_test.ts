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
  isDenoFetchFailure,
  judgeDenoTestFailure,
  unitTestCommand,
  worktreeBaseline,
} from "../lib/deno_test_baseline.ts";
import {
  PreFlightGateError,
  type PreFlightRunner,
} from "../lib/pre_flight_gate.ts";

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
  const seen: string[][] = [];
  const baseline = (
    output: string | null,
    ranFiles = ["./a_test.ts"],
  ): DenoTestBaseline => ({
    runAtBase: (build, files) => {
      seen.push(files);
      assertEquals(build(files), "deno task test:unit 'a_test.ts'");
      return Promise.resolve({
        ranFiles,
        error: output === null ? null : failure(output),
      });
    },
  });
  const same = await judgeDenoTestFailure(
    failure(OBSERVED),
    baseline(OBSERVED),
    command,
  );
  assertEquals(same.kind, "base-only");
  assertEquals(seen, [["./a_test.ts"]]);

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
  // A test path that is not a plain relative _test.ts is never re-run.
  assertEquals(
    (await judgeDenoTestFailure(
      failure("x => ./../evil_test.ts:1:1\n"),
      baseline("x => ./../evil_test.ts:1:1\n"),
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
  // A timeout that names tests red at the base is not compared with the base.
  let baseRuns = 0;
  const timedOut = await judgeDenoTestFailure(
    failure(OBSERVED, "timeout"),
    {
      runAtBase: () => {
        baseRuns++;
        return Promise.resolve({
          ranFiles: ["./a_test.ts"],
          error: failure(OBSERVED),
        });
      },
    },
    command,
  );
  assertEquals(timedOut.kind, "verdict");
  assertEquals(baseRuns, 0);
});

type GitCall = { args: string[]; cwd: string };
type GitResult = { code: number; stdout: string; stderr: string };

function fakeBaselineGit(opts: {
  add?: number;
  lsTree?: GitResult;
  onAdd?: (tree: string) => Promise<void>;
}) {
  const calls: GitCall[] = [];
  return {
    calls,
    git: async (args: string[], cwd: string): Promise<GitResult> => {
      calls.push({ args, cwd });
      if (args[1] === "add") {
        if (opts.add) return { code: opts.add, stdout: "", stderr: "no" };
        await opts.onAdd?.(args[3] ?? "");
      }
      if (args[0] === "ls-tree") {
        return opts.lsTree ?? { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  };
}

function recordingRunner(code: number) {
  const runs: { command: string; cwd?: string; timeoutSeconds: number }[] = [];
  const runner: PreFlightRunner = (cmd, o) => {
    runs.push({
      command: cmd,
      cwd: o.cwd,
      timeoutSeconds: o.timeoutSeconds,
    });
    return Promise.resolve({
      started: true,
      code,
      stdout: "boom one => ./a_test.ts:1:6\n",
      stderr: "",
    });
  };
  return { runs, runner };
}

Deno.test("worktreeBaseline: a nested root runs the present files in the root's directory and removes the worktree", async () => {
  const git = fakeBaselineGit({
    lsTree: { code: 0, stdout: "worker/deno/a_test.ts\n", stderr: "" },
  });
  const { runs, runner } = recordingRunner(1);
  const removed: string[] = [];
  const result = await worktreeBaseline({
    cwd: "/repo",
    root: "worker/deno",
    forkSha: "abc123",
    git: git.git,
    runner,
    timeoutSeconds: 77,
    makeTempDir: () => Promise.resolve("/tmp/base"),
    removeDir: (path) => {
      removed.push(path);
      return Promise.resolve();
    },
  }).runAtBase(command, ["./a_test.ts", "./gone_test.ts"]);

  assertEquals(result?.ranFiles, ["./a_test.ts"]);
  assertEquals(result?.error?.reason, "non-zero-exit");
  assertEquals(git.calls.map((c) => c.args), [
    ["worktree", "add", "--detach", "/tmp/base/tree", "abc123"],
    [
      "ls-tree",
      "-r",
      "--name-only",
      "abc123",
      "--",
      "worker/deno/a_test.ts",
      "worker/deno/gone_test.ts",
    ],
    ["worktree", "remove", "--force", "/tmp/base/tree"],
  ]);
  assertEquals(git.calls.every((c) => c.cwd === "/repo"), true);
  assertEquals(runs, [{
    command: "deno task test:unit 'a_test.ts'",
    cwd: "/tmp/base/tree/worker/deno",
    timeoutSeconds: 77,
  }]);
  assertEquals(removed, ["/tmp/base"]);
});

Deno.test("worktreeBaseline: the top-level root runs in the tree with unprefixed paths; a passing base has no error", async () => {
  const git = fakeBaselineGit({
    lsTree: { code: 0, stdout: "a_test.ts\n", stderr: "" },
  });
  const { runs, runner } = recordingRunner(0);
  const result = await worktreeBaseline({
    cwd: "/repo",
    root: ".",
    forkSha: "abc123",
    git: git.git,
    runner,
    makeTempDir: () => Promise.resolve("/tmp/base"),
    removeDir: () => Promise.resolve(),
  }).runAtBase(command, ["./a_test.ts"]);

  assertEquals(result, { ranFiles: ["./a_test.ts"], error: null });
  assertEquals(git.calls[1]?.args.slice(3), ["abc123", "--", "a_test.ts"]);
  assertEquals(runs.map((r) => r.cwd), ["/tmp/base/tree"]);
});

Deno.test("worktreeBaseline: a failed worktree add is unavailable and removes nothing", async () => {
  const git = fakeBaselineGit({ add: 128 });
  const { runs, runner } = recordingRunner(1);
  const removed: string[] = [];
  const result = await worktreeBaseline({
    cwd: "/repo",
    root: ".",
    forkSha: "abc123",
    git: git.git,
    runner,
    makeTempDir: () => Promise.resolve("/tmp/base"),
    removeDir: (path) => {
      removed.push(path);
      return Promise.resolve();
    },
  }).runAtBase(command, ["./a_test.ts"]);

  assertEquals(result, null);
  assertEquals(git.calls.map((c) => c.args[0] + " " + c.args[1]), [
    "worktree add",
  ]);
  assertEquals(runs.length, 0);
  assertEquals(removed, ["/tmp/base"]);
});

Deno.test("worktreeBaseline: a failed ls-tree is unavailable, but the worktree is still removed", async () => {
  const git = fakeBaselineGit({
    lsTree: { code: 128, stdout: "a_test.ts\n", stderr: "fatal" },
  });
  const { runs, runner } = recordingRunner(1);
  const result = await worktreeBaseline({
    cwd: "/repo",
    root: ".",
    forkSha: "abc123",
    git: git.git,
    runner,
    makeTempDir: () => Promise.resolve("/tmp/base"),
    removeDir: () => Promise.resolve(),
  }).runAtBase(command, ["./a_test.ts"]);

  assertEquals(result, null);
  assertEquals(runs.length, 0);
  assertEquals(git.calls.at(-1)?.args[1], "remove");
});

Deno.test("worktreeBaseline: no file present at the base runs nothing; an unquotable command is unavailable", async () => {
  const none = fakeBaselineGit({});
  const noRun = recordingRunner(1);
  const absent = await worktreeBaseline({
    cwd: "/repo",
    root: ".",
    forkSha: "abc123",
    git: none.git,
    runner: noRun.runner,
    makeTempDir: () => Promise.resolve("/tmp/base"),
    removeDir: () => Promise.resolve(),
  }).runAtBase(command, ["./a_test.ts"]);
  assertEquals(absent, { ranFiles: [], error: null });
  assertEquals(noRun.runs.length, 0);

  const present = fakeBaselineGit({
    lsTree: { code: 0, stdout: "a_test.ts\n", stderr: "" },
  });
  const unquotable = await worktreeBaseline({
    cwd: "/repo",
    root: ".",
    forkSha: "abc123",
    git: present.git,
    runner: noRun.runner,
    makeTempDir: () => Promise.resolve("/tmp/base"),
    removeDir: () => Promise.resolve(),
  }).runAtBase(() => null, ["./a_test.ts"]);
  assertEquals(unquotable, null);
  assertEquals(noRun.runs.length, 0);
});

Deno.test("worktreeBaseline: the default temp directory is removed recursively after the run", async () => {
  let dir = "";
  const git = fakeBaselineGit({
    // The tree holds a file, so only a recursive remove can delete it.
    onAdd: async (tree) => {
      dir = tree.replace(/\/tree$/, "");
      await Deno.mkdir(tree);
      await Deno.writeTextFile(`${tree}/f.txt`, "x");
    },
  });
  await worktreeBaseline({
    cwd: "/repo",
    root: ".",
    forkSha: "abc123",
    git: git.git,
  }).runAtBase(command, ["./a_test.ts"]);
  assert(dir.includes("vibe_deno_test_base_"), dir);
  let exists = true;
  try {
    await Deno.stat(dir);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    exists = false;
  }
  assertEquals(exists, false);
});
