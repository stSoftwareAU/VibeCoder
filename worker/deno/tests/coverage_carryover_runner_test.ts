/**
 * Tests for the coverage carry-over runner (Issue #3795). Most cases drive the
 * runner through fake seams: an in-memory filesystem, scripted git and deno
 * processes, and a controllable clock. One integration test builds a real git
 * repository in a temporary directory and runs the real seams end to end.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import type { CoverageCarryOverResult } from "../lib/coverage_carryover_gate.ts";
import {
  type CoverageCarryOverInput,
  runCoverageCarryOverCheck,
} from "../lib/coverage_carryover_runner.ts";
import {
  defaultMutationRunnerSeams,
  type MutationRunnerSeams,
  type ProcessResult,
} from "../lib/mutation_runner.ts";

const REPO = "/repo";
/** The first temporary directory the fake hands out; not a real path. */
const TMP = "/fake-tmp";
const WT = `${TMP}/base`;
const BASE_SHA = "abc123";

const DENO_JSON = "{}";
const LIB_BASE =
  'export function pick(flag: boolean): string {\n  if (flag) {\n    return "one";\n  }\n  return "two";\n}\n';
const M_TEST_LINES = [
  'import { pick } from "../lib/m.ts";',
  'Deno.test("m", () => pick(true));',
];
const OTHER_TEST =
  'import { pick } from "../lib/m.ts";\nDeno.test("other", () => pick(false));\n';

/** A `--unified=0` section for a modified file, from its hunk lines. */
function section(path: string, ...lines: string[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    ...lines,
  ].join("\n") + "\n";
}

/** A `--unified=0` section for a deleted file whose old text is `oldLines`. */
function deletedSection(path: string, oldLines: string[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    "deleted file mode 100644",
    `--- a/${path}`,
    "+++ /dev/null",
    `@@ -1,${oldLines.length} +0,0 @@`,
    ...oldLines.map((l) => `-${l}`),
  ].join("\n") + "\n";
}

/** The diff for the common scenario: the base test is deleted, lib gains a header line. */
const DELETE_TEST_AND_INSERT_HEADER = deletedSection(
  "tests/m_test.ts",
  M_TEST_LINES,
) + section("lib/m.ts", "@@ -0,0 +1 @@", "+// header");

/** Base lines 2, 3 and 5 of lib/m.ts were reached by the base test. */
const BASE_LCOV = [
  `SF:${WT}/lib/m.ts`,
  "DA:2,1",
  "DA:3,1",
  "DA:5,1",
  "end_of_record",
  `SF:${WT}/tests/m_test.ts`,
  "DA:1,1",
  "end_of_record",
  "",
].join("\n");

interface Call {
  cmd: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  env?: Record<string, string>;
}

interface FakeOptions {
  /** Files at the merge base, repo-relative; copied into the worktree on `worktree add`. */
  base?: Record<string, string>;
  /** Files at head, repo-relative. */
  head?: Record<string, string>;
  baseLcov?: string;
  headLcov?: string;
  /** Milliseconds the clock advances per process call. */
  tickMs?: number;
  /** Return a result to replace the default for a call; undefined keeps it. */
  respond?: (cmd: string, args: string[]) => ProcessResult | undefined;
  /** Make `removeDir` throw, to exercise cleanup failures. */
  removeDirFails?: boolean;
  /** Make `makeTempDir` throw, to exercise the outer error path. */
  makeTempDirThrows?: string;
}

interface Fake {
  seams: MutationRunnerSeams;
  calls: Call[];
  removed: string[];
}

const ok = (stdout = "", stderr = ""): ProcessResult => ({
  code: 0,
  stdout,
  stderr,
  timedOut: false,
});

const fail = (code: number, stderr: string): ProcessResult => ({
  code,
  stdout: "",
  stderr,
  timedOut: false,
});

function fake(opts: FakeOptions = {}): Fake {
  const fs = new Map<string, string>();
  for (const [rel, text] of Object.entries(opts.head ?? {})) {
    fs.set(`${REPO}/${rel}`, text);
  }
  const base = opts.base ?? {};
  const calls: Call[] = [];
  const removed: string[] = [];
  const clock = { t: 0 };

  const defaultResult = (cmd: string, args: string[]): ProcessResult => {
    if (cmd === "git") {
      if (args[0] === "merge-base") return ok(`${BASE_SHA}\n`);
      if (args[0] === "worktree" && args[1] === "add") {
        const wt = args[3] ?? "";
        for (const [rel, text] of Object.entries(base)) {
          fs.set(`${wt}/${rel}`, text);
        }
      }
      return ok();
    }
    if (cmd === "deno" && args[0] === "coverage") {
      const dir = args[2] ?? "";
      return ok(
        dir.includes("cov-base")
          ? (opts.baseLcov ?? "")
          : (opts.headLcov ?? ""),
      );
    }
    return ok();
  };

  const seams: MutationRunnerSeams = {
    runProcess: async (cmd, args, o) => {
      calls.push({
        cmd,
        args,
        cwd: o.cwd,
        timeoutMs: o.timeoutMs,
        ...(o.env === undefined ? {} : { env: o.env }),
      });
      const result = opts.respond?.(cmd, args) ?? defaultResult(cmd, args);
      clock.t += opts.tickMs ?? 0;
      return result;
    },
    now: () => clock.t,
    readTextFile: (p) => {
      const v = fs.get(p);
      return v === undefined
        ? Promise.reject(new Error(`ENOENT ${p}`))
        : Promise.resolve(v);
    },
    writeTextFile: (p, d) => {
      fs.set(p, d);
      return Promise.resolve();
    },
    exists: (p) => Promise.resolve(fs.has(p)),
    realPath: (p) => Promise.resolve(p),
    removeDir: async (p) => {
      removed.push(p);
      if (opts.removeDirFails) throw new Error("cannot remove");
      for (const k of [...fs.keys()]) {
        if (k.startsWith(`${p}/`)) fs.delete(k);
      }
    },
    makeTempDir: async () => {
      if (opts.makeTempDirThrows !== undefined) {
        throw new Error(opts.makeTempDirThrows);
      }
      return TMP;
    },
    listTestFiles: (repoPath) =>
      Promise.resolve(
        [...fs.keys()]
          .filter((k) => k.startsWith(`${repoPath}/`) && k.endsWith("_test.ts"))
          .map((k) => k.slice(repoPath.length + 1)),
      ),
  };
  return { seams, calls, removed };
}

const input = (
  diff: string,
  budgetSeconds = 600,
  extra: Partial<CoverageCarryOverInput> = {},
): CoverageCarryOverInput => ({
  repoPath: REPO,
  base: "origin/main",
  diff,
  budgetSeconds,
  ...extra,
});

const DENO_BASE = {
  "deno.json": DENO_JSON,
  "lib/m.ts": LIB_BASE,
  "tests/m_test.ts": M_TEST_LINES.join("\n") + "\n",
};

const HEAD_WITH_OTHER_TEST = {
  "deno.json": DENO_JSON,
  "lib/m.ts": "// header\n" + LIB_BASE,
  "tests/other_test.ts": OTHER_TEST,
};

function isCall(c: Call, cmd: string, ...prefix: string[]): boolean {
  return c.cmd === cmd && prefix.every((p, i) => c.args[i] === p);
}

// ---------------------------------------------------------------------------
// Early outcomes
// ---------------------------------------------------------------------------

Deno.test("runCoverageCarryOverCheck - a diff that removes no test lines is not applicable and runs nothing", async () => {
  const f = fake();
  const result = await runCoverageCarryOverCheck(
    input(section("lib/m.ts", "@@ -1 +1 @@", "-a", "+b")),
    f.seams,
  );
  assertEquals(result, {
    kind: "not_applicable",
    reason: "the diff removes no lines from an existing Deno test file",
  });
  assertEquals(f.calls, []);
});

Deno.test("runCoverageCarryOverCheck - a removed Rust test line is not applicable with the cargo-llvm-cov reason", async () => {
  const f = fake();
  const result = await runCoverageCarryOverCheck(
    input(deletedSection("crates/x/tests/t.rs", ["fn a() {}"])),
    f.seams,
  );
  assertEquals(result, {
    kind: "not_applicable",
    reason:
      "Rust coverage carry-over needs cargo-llvm-cov, which the worker container does not install",
  });
  assertEquals(f.calls, []);
});

Deno.test("runCoverageCarryOverCheck - edited tests with no Deno project above them are not applicable", async () => {
  const f = fake({ base: { "tests/m_test.ts": "x\n" } });
  const result = await runCoverageCarryOverCheck(
    input(deletedSection("tests/m_test.ts", ["x"])),
    f.seams,
  );
  assertEquals(result, {
    kind: "not_applicable",
    reason: "no Deno project above the edited or removed test files",
  });
  // The worktree is still removed.
  assertEquals(f.removed.includes(TMP), true);
});

// ---------------------------------------------------------------------------
// Git failures
// ---------------------------------------------------------------------------

Deno.test("runCoverageCarryOverCheck - a merge-base failure is an error naming the cause", async () => {
  const f = fake({
    base: DENO_BASE,
    respond: (cmd, args) =>
      cmd === "git" && args[0] === "merge-base"
        ? fail(1, "fatal: Not a valid object name base\n")
        : undefined,
  });
  const result = await runCoverageCarryOverCheck(
    input(DELETE_TEST_AND_INSERT_HEADER),
    f.seams,
  );
  assertEquals(result, {
    kind: "error",
    reason: "git merge-base failed: fatal: Not a valid object name base",
  });
  assertEquals(
    f.calls.some((c) => c.args[0] === "worktree"),
    false,
  );
});

Deno.test("runCoverageCarryOverCheck - a worktree failure is an error naming the cause, and cleanup still runs", async () => {
  const f = fake({
    base: DENO_BASE,
    respond: (cmd, args) =>
      cmd === "git" && args[0] === "worktree" && args[1] === "add"
        ? fail(128, "fatal: 'x' is already checked out\n")
        : undefined,
  });
  const result = await runCoverageCarryOverCheck(
    input(DELETE_TEST_AND_INSERT_HEADER),
    f.seams,
  );
  assertEquals(result, {
    kind: "error",
    reason: "git worktree add failed: fatal: 'x' is already checked out",
  });
  // The removal of the worktree is attempted even though it was never created.
  assertEquals(
    f.calls.some((c) => isCall(c, "git", "worktree", "remove", "--force", WT)),
    true,
  );
  assertEquals(f.removed.includes(TMP), true);
});

Deno.test("runCoverageCarryOverCheck - a merge-base run that times out is an error, even with exit code 0", async () => {
  // A timed-out child is an error whatever exit code it reports.
  const f = fake({
    base: DENO_BASE,
    respond: (cmd, args) =>
      cmd === "git" && args[0] === "merge-base"
        ? { code: 0, stdout: "", stderr: "", timedOut: true }
        : undefined,
  });
  const result = await runCoverageCarryOverCheck(
    input(DELETE_TEST_AND_INSERT_HEADER),
    f.seams,
  );
  assertEquals(result, {
    kind: "error",
    reason: "git merge-base failed: timed out",
  });
  assertEquals(
    f.calls.some((c) => c.args[0] === "worktree"),
    false,
  );
});

Deno.test("runCoverageCarryOverCheck - a worktree add that times out is an error, even with exit code 0", async () => {
  const f = fake({
    base: DENO_BASE,
    respond: (cmd, args) =>
      cmd === "git" && args[0] === "worktree" && args[1] === "add"
        ? { code: 0, stdout: "", stderr: "", timedOut: true }
        : undefined,
  });
  const result = await runCoverageCarryOverCheck(
    input(DELETE_TEST_AND_INSERT_HEADER),
    f.seams,
  );
  assertEquals(result, {
    kind: "error",
    reason: "git worktree add failed: timed out",
  });
});

// ---------------------------------------------------------------------------
// Base test failures and budget
// ---------------------------------------------------------------------------

Deno.test("runCoverageCarryOverCheck - a failing base test is an error whose reason carries the cause", async () => {
  const f = fake({
    base: DENO_BASE,
    respond: (cmd, args) =>
      cmd === "deno" && args[0] === "test"
        ? fail(1, "\x1b[0;31merror\x1b[0m: Uncaught TypeError: boom\n")
        : undefined,
  });
  const result = await runCoverageCarryOverCheck(
    input(DELETE_TEST_AND_INSERT_HEADER),
    f.seams,
  );
  assertEquals(result, {
    kind: "error",
    reason:
      "base tests fail at the merge base (tests/m_test.ts): error: Uncaught TypeError: boom",
  });
});

Deno.test("runCoverageCarryOverCheck - a base test run that times out is budget exhaustion", async () => {
  const f = fake({
    base: DENO_BASE,
    respond: (cmd, args) =>
      cmd === "deno" && args[0] === "test"
        ? { code: 124, stdout: "", stderr: "", timedOut: true }
        : undefined,
  });
  const result = await runCoverageCarryOverCheck(
    input(DELETE_TEST_AND_INSERT_HEADER, 60),
    f.seams,
  );
  assertEquals(result, {
    kind: "budget_exhausted",
    changedTests: ["tests/m_test.ts"],
    budgetSeconds: 60,
  });
});

Deno.test("runCoverageCarryOverCheck - budget spent before the coverage report is budget exhaustion", async () => {
  // Each process call advances the clock by a second: merge-base (1 s),
  // worktree add (2 s), then the base test run uses the remaining 1 s and
  // leaves nothing for the coverage report.
  const f = fake({ base: DENO_BASE, baseLcov: BASE_LCOV, tickMs: 1000 });
  const result = await runCoverageCarryOverCheck(
    input(DELETE_TEST_AND_INSERT_HEADER, 3),
    f.seams,
  );
  assertEquals(result, {
    kind: "budget_exhausted",
    changedTests: ["tests/m_test.ts"],
    budgetSeconds: 3,
  });
  const baseRun = f.calls.find((c) =>
    isCall(c, "deno", "test") &&
    c.args.some((a) => a.startsWith("--coverage=") && a.includes("cov-base"))
  );
  assertEquals(baseRun?.timeoutMs, 1000);
});

Deno.test("runCoverageCarryOverCheck - a failing base coverage report is an error whose reason carries the cause", async () => {
  const f = fake({
    base: DENO_BASE,
    respond: (cmd, args) =>
      cmd === "deno" && args[0] === "coverage" &&
        (args[2] ?? "").includes("cov-base")
        ? fail(1, "\x1b[0;31merror\x1b[0m: no coverage data\n")
        : undefined,
  });
  const result = await runCoverageCarryOverCheck(
    input(DELETE_TEST_AND_INSERT_HEADER),
    f.seams,
  );
  assertEquals(result, {
    kind: "error",
    reason: "deno coverage failed: error: no coverage data",
  });
});

Deno.test("runCoverageCarryOverCheck - a failed base test with no error line reports its first stderr line", async () => {
  const f = fake({
    base: DENO_BASE,
    respond: (cmd, args) =>
      cmd === "deno" && args[0] === "test"
        ? fail(1, "something odd\n")
        : undefined,
  });
  const result = await runCoverageCarryOverCheck(
    input(DELETE_TEST_AND_INSERT_HEADER),
    f.seams,
  );
  assertEquals(result, {
    kind: "error",
    reason:
      "base tests fail at the merge base (tests/m_test.ts): something odd",
  });
});

Deno.test("runCoverageCarryOverCheck - a failed base test with no stderr reports its exit code", async () => {
  const f = fake({
    base: DENO_BASE,
    respond: (cmd, args) =>
      cmd === "deno" && args[0] === "test" ? fail(2, "") : undefined,
  });
  const result = await runCoverageCarryOverCheck(
    input(DELETE_TEST_AND_INSERT_HEADER),
    f.seams,
  );
  assertEquals(result, {
    kind: "error",
    reason: "base tests fail at the merge base (tests/m_test.ts): exit code 2",
  });
});

Deno.test("runCoverageCarryOverCheck - budget spent before the base test run is budget exhaustion", async () => {
  // merge-base and worktree add take 1 s each, which uses the whole 2 s budget.
  const f = fake({ base: DENO_BASE, baseLcov: BASE_LCOV, tickMs: 1000 });
  const result = await runCoverageCarryOverCheck(
    input(DELETE_TEST_AND_INSERT_HEADER, 2),
    f.seams,
  );
  assertEquals(result, {
    kind: "budget_exhausted",
    changedTests: ["tests/m_test.ts"],
    budgetSeconds: 2,
  });
  assertEquals(f.calls.some((c) => c.cmd === "deno"), false);
});

Deno.test("runCoverageCarryOverCheck - a head test run that times out is budget exhaustion", async () => {
  const f = fake({
    base: DENO_BASE,
    head: HEAD_WITH_OTHER_TEST,
    baseLcov: BASE_LCOV,
    respond: (cmd, args) =>
      cmd === "deno" && args[0] === "test" &&
        args.some((a) => a.includes("cov-head"))
        ? { code: 124, stdout: "", stderr: "", timedOut: true }
        : undefined,
  });
  const result = await runCoverageCarryOverCheck(
    input(DELETE_TEST_AND_INSERT_HEADER),
    f.seams,
  );
  assertEquals(result, {
    kind: "budget_exhausted",
    changedTests: ["tests/m_test.ts"],
    budgetSeconds: 600,
  });
});

Deno.test("runCoverageCarryOverCheck - budget spent before the head test run is budget exhaustion", async () => {
  // Each process call takes 1 s. merge-base, worktree add, the base test and
  // the base coverage report use 4 s, so the head run has no time left.
  const f = fake({
    base: DENO_BASE,
    head: HEAD_WITH_OTHER_TEST,
    baseLcov: BASE_LCOV,
    tickMs: 1000,
  });
  const result = await runCoverageCarryOverCheck(
    input(DELETE_TEST_AND_INSERT_HEADER, 4),
    f.seams,
  );
  assertEquals(result, {
    kind: "budget_exhausted",
    changedTests: ["tests/m_test.ts"],
    budgetSeconds: 4,
  });
  assertEquals(
    f.calls.some((c) => c.args.some((a) => a.includes("cov-head"))),
    false,
  );
});

Deno.test("runCoverageCarryOverCheck - budget spent before the head coverage report is budget exhaustion", async () => {
  // The head test run takes the fifth second, so its coverage report has none left.
  const f = fake({
    base: DENO_BASE,
    head: HEAD_WITH_OTHER_TEST,
    baseLcov: BASE_LCOV,
    tickMs: 1000,
  });
  const result = await runCoverageCarryOverCheck(
    input(DELETE_TEST_AND_INSERT_HEADER, 5),
    f.seams,
  );
  assertEquals(result, {
    kind: "budget_exhausted",
    changedTests: ["tests/m_test.ts"],
    budgetSeconds: 5,
  });
  assertEquals(
    f.calls.some((c) =>
      isCall(c, "deno", "test") &&
      c.args.some((a) => a.includes("cov-head"))
    ),
    true,
  );
});

// ---------------------------------------------------------------------------
// Carry-over outcomes
// ---------------------------------------------------------------------------

Deno.test("runCoverageCarryOverCheck - a carried line no head test reaches is reported at its head line number", async () => {
  const f = fake({
    base: DENO_BASE,
    head: HEAD_WITH_OTHER_TEST,
    baseLcov: BASE_LCOV,
    // The head test reaches lines 3 and 4 (base 2 and 3) but not 6 (base 5).
    headLcov: [
      `SF:${REPO}/lib/m.ts`,
      "DA:3,1",
      "DA:4,1",
      "DA:6,0",
      "end_of_record",
      "",
    ].join("\n"),
  });
  const result = await runCoverageCarryOverCheck(
    input(DELETE_TEST_AND_INSERT_HEADER),
    f.seams,
  );
  assertEquals(result, {
    kind: "completed",
    changedTests: ["tests/m_test.ts"],
    carried: 3,
    uncovered: [{ file: "lib/m.ts", line: 6 }],
  });
  // The base run is the edited test, from the worktree; the head run is the
  // importing test, from the repository.
  const baseRun = f.calls.find((c) =>
    isCall(c, "deno", "test") && c.cwd === WT
  );
  assertEquals(baseRun?.args, [
    "test",
    "--no-check",
    "-A",
    `--coverage=${TMP}/cov-base-0`,
    "tests/m_test.ts",
  ]);
  const headRun = f.calls.find((c) =>
    isCall(c, "deno", "test") && c.cwd === REPO
  );
  assertEquals(headRun?.args, [
    "test",
    "--no-check",
    "-A",
    `--coverage=${TMP}/cov-head-0`,
    "tests/other_test.ts",
  ]);
});

Deno.test("runCoverageCarryOverCheck - a carried line still covered at head is not reported", async () => {
  const f = fake({
    base: DENO_BASE,
    head: HEAD_WITH_OTHER_TEST,
    baseLcov: BASE_LCOV,
    headLcov: [
      `SF:${REPO}/lib/m.ts`,
      "DA:3,1",
      "DA:4,1",
      "DA:6,2",
      "end_of_record",
      "",
    ]
      .join("\n"),
  });
  const result = await runCoverageCarryOverCheck(
    input(DELETE_TEST_AND_INSERT_HEADER),
    f.seams,
  );
  assertEquals(result, {
    kind: "completed",
    changedTests: ["tests/m_test.ts"],
    carried: 3,
    uncovered: [],
  });
});

Deno.test("runCoverageCarryOverCheck - lines the diff changed are not carried, so no head run happens", async () => {
  // The base test reached line 2, but the diff replaces it.
  const f = fake({
    base: DENO_BASE,
    head: HEAD_WITH_OTHER_TEST,
    baseLcov: [`SF:${WT}/lib/m.ts`, "DA:2,1", "end_of_record", ""].join("\n"),
  });
  const result = await runCoverageCarryOverCheck(
    input(
      deletedSection("tests/m_test.ts", M_TEST_LINES) +
        section("lib/m.ts", "@@ -2 +2 @@", "-  if (flag) {", "+  if (!flag) {"),
    ),
    f.seams,
  );
  assertEquals(result, {
    kind: "completed",
    changedTests: ["tests/m_test.ts"],
    carried: 0,
    uncovered: [],
  });
  assertEquals(
    f.calls.some((c) => c.args.some((a) => a.includes("cov-head"))),
    false,
  );
});

Deno.test("runCoverageCarryOverCheck - a failing head test is an error naming the head tests", async () => {
  const f = fake({
    base: DENO_BASE,
    head: HEAD_WITH_OTHER_TEST,
    baseLcov: BASE_LCOV,
    respond: (cmd, args) =>
      cmd === "deno" && args.some((a) => a.includes("cov-head"))
        ? fail(1, "error: head boom\n")
        : undefined,
  });
  const result = await runCoverageCarryOverCheck(
    input(DELETE_TEST_AND_INSERT_HEADER),
    f.seams,
  );
  assertEquals(result, {
    kind: "error",
    reason: "head tests fail (tests/other_test.ts): error: head boom",
  });
});

Deno.test("runCoverageCarryOverCheck - the credentials reach the deno test children only", async () => {
  const f = fake({
    base: DENO_BASE,
    head: HEAD_WITH_OTHER_TEST,
    baseLcov: BASE_LCOV,
    headLcov: `SF:${REPO}/lib/m.ts\nDA:6,1\nend_of_record\n`,
  });
  await runCoverageCarryOverCheck(
    input(DELETE_TEST_AND_INSERT_HEADER, 600, {
      credentialEnv: { DEMO_TOKEN: "secret" },
    }),
    f.seams,
  );
  const testRuns = f.calls.filter((c) => isCall(c, "deno", "test"));
  assertEquals(testRuns.length, 2);
  for (const c of testRuns) assertEquals(c.env, { DEMO_TOKEN: "secret" });
  const coverageRuns = f.calls.filter((c) => isCall(c, "deno", "coverage"));
  assertEquals(coverageRuns.length, 2);
  for (const c of coverageRuns) assertEquals(c.env, undefined);
});

Deno.test("runCoverageCarryOverCheck - a base line the base test reached zero times is not carried", async () => {
  const f = fake({
    base: DENO_BASE,
    head: HEAD_WITH_OTHER_TEST,
    baseLcov: [
      `SF:${WT}/lib/m.ts`,
      "DA:2,0",
      "DA:3,1",
      "DA:5,1",
      "end_of_record",
      "",
    ].join("\n"),
    headLcov: [
      `SF:${REPO}/lib/m.ts`,
      "DA:3,1",
      "DA:4,1",
      "DA:6,0",
      "end_of_record",
      "",
    ].join("\n"),
  });
  const result = await runCoverageCarryOverCheck(
    input(DELETE_TEST_AND_INSERT_HEADER),
    f.seams,
  );
  assertEquals(result, {
    kind: "completed",
    changedTests: ["tests/m_test.ts"],
    carried: 2,
    uncovered: [{ file: "lib/m.ts", line: 6 }],
  });
});

/** A path that differs from `root` only in its last character, so it is as long as `root`. */
const sameLengthSibling = (root: string) => `${root.slice(0, -1)}X`;

Deno.test("runCoverageCarryOverCheck - lcov records outside the worktree or repository root are ignored", async () => {
  // The sibling paths are as long as the roots, so slicing by the root length
  // would wrongly read them as lib/m.ts.
  const f = fake({
    base: DENO_BASE,
    head: HEAD_WITH_OTHER_TEST,
    baseLcov: BASE_LCOV +
      `SF:${sameLengthSibling(WT)}/lib/m.ts\nDA:6,1\nend_of_record\n`,
    headLcov: `SF:${REPO}/lib/m.ts\nDA:3,1\nDA:4,1\nDA:6,0\nend_of_record\n` +
      `SF:${sameLengthSibling(REPO)}/lib/m.ts\nDA:6,5\nend_of_record\n`,
  });
  const result = await runCoverageCarryOverCheck(
    input(DELETE_TEST_AND_INSERT_HEADER),
    f.seams,
  );
  assertEquals(result, {
    kind: "completed",
    changedTests: ["tests/m_test.ts"],
    carried: 3,
    uncovered: [{ file: "lib/m.ts", line: 6 }],
  });
});

Deno.test("runCoverageCarryOverCheck - a changed test with no Deno project is skipped and one with a project still runs", async () => {
  const f = fake({
    base: {
      "pkg/deno.json": DENO_JSON,
      "pkg/lib/m.ts": LIB_BASE,
      "pkg/tests/m_test.ts": M_TEST_LINES.join("\n") + "\n",
      "pkg/tests/n_test.ts": 'Deno.test("n", () => {});\n',
      "loose/tests/x_test.ts": 'Deno.test("x", () => {});\n',
    },
    head: {
      "pkg/deno.json": DENO_JSON,
      "pkg/lib/m.ts": "// header\n" + LIB_BASE,
      "pkg/tests/other_test.ts": OTHER_TEST,
      "loose/tests/y_test.ts": 'Deno.test("y", () => {});\n',
    },
    baseLcov: `SF:${WT}/pkg/lib/m.ts\nDA:2,1\nDA:3,1\nDA:5,1\nend_of_record\n`,
    headLcov:
      `SF:${REPO}/pkg/lib/m.ts\nDA:3,1\nDA:4,1\nDA:6,0\nend_of_record\n`,
  });
  const result = await runCoverageCarryOverCheck(
    input(
      deletedSection("loose/tests/x_test.ts", ['Deno.test("x", () => {});']) +
        deletedSection("pkg/tests/m_test.ts", M_TEST_LINES) +
        deletedSection("pkg/tests/n_test.ts", ['Deno.test("n", () => {});']) +
        section("pkg/lib/m.ts", "@@ -0,0 +1 @@", "+// header"),
    ),
    f.seams,
  );
  assertEquals(result, {
    kind: "completed",
    changedTests: [
      "loose/tests/x_test.ts",
      "pkg/tests/m_test.ts",
      "pkg/tests/n_test.ts",
    ],
    carried: 3,
    uncovered: [{ file: "pkg/lib/m.ts", line: 6 }],
  });
  // Only the project's tests run, from the project directory, at base and head.
  const denoRuns = f.calls.filter((c) => isCall(c, "deno", "test"));
  assertEquals(denoRuns.map((c) => [c.cwd, c.args.slice(4)]), [
    [`${WT}/pkg`, ["tests/m_test.ts", "tests/n_test.ts"]],
    [`${REPO}/pkg`, ["tests/other_test.ts"]],
  ]);
});

Deno.test("runCoverageCarryOverCheck - an edited test that no longer imports the module is still run at head, and its own lines are not carried", async () => {
  const f = fake({
    base: {
      ...DENO_BASE,
      "tests/m_test.ts": "// fixture\n" + M_TEST_LINES.join("\n") + "\n",
    },
    head: {
      "deno.json": DENO_JSON,
      "lib/m.ts": "// header\n" + LIB_BASE,
      "tests/m_test.ts":
        '// fixture\nimport { helper } from "../lib/helper.ts";\nDeno.test("m", () => helper());\n',
    },
    baseLcov: BASE_LCOV,
    headLcov: `SF:${REPO}/lib/m.ts\nDA:3,1\nDA:4,1\nDA:6,0\nend_of_record\n`,
  });
  const result = await runCoverageCarryOverCheck(
    input(
      section(
        "tests/m_test.ts",
        "@@ -2,2 +2,2 @@",
        `-${M_TEST_LINES[0]}`,
        `-${M_TEST_LINES[1]}`,
        '+import { helper } from "../lib/helper.ts";',
        '+Deno.test("m", () => helper());',
      ) + section("lib/m.ts", "@@ -0,0 +1 @@", "+// header"),
    ),
    f.seams,
  );
  assertEquals(result, {
    kind: "completed",
    changedTests: ["tests/m_test.ts"],
    carried: 3,
    uncovered: [{ file: "lib/m.ts", line: 6 }],
  });
  const headRun = f.calls.find((c) =>
    isCall(c, "deno", "test") && c.cwd === REPO
  );
  assertEquals(headRun?.args, [
    "test",
    "--no-check",
    "-A",
    `--coverage=${TMP}/cov-head-0`,
    "tests/m_test.ts",
  ]);
});

Deno.test("runCoverageCarryOverCheck - a carried line the head coverage report never records is uncovered", async () => {
  // headLcov is left empty: the head run completes but records no line.
  const f = fake({
    base: DENO_BASE,
    head: HEAD_WITH_OTHER_TEST,
    baseLcov: BASE_LCOV,
  });
  const result = await runCoverageCarryOverCheck(
    input(DELETE_TEST_AND_INSERT_HEADER),
    f.seams,
  );
  assertEquals(result, {
    kind: "completed",
    changedTests: ["tests/m_test.ts"],
    carried: 3,
    uncovered: [
      { file: "lib/m.ts", line: 3 },
      { file: "lib/m.ts", line: 4 },
      { file: "lib/m.ts", line: 6 },
    ],
  });
});

Deno.test("runCoverageCarryOverCheck - several carried files share the head run, and uncovered lines sort by file then line", async () => {
  const f = fake({
    base: DENO_BASE,
    head: {
      "deno.json": DENO_JSON,
      "lib/m.ts": "// header\n" + LIB_BASE,
      "lib/n.ts": LIB_BASE,
      "lib/p.ts": LIB_BASE,
      "tests/other_test.ts":
        'import { pick } from "../lib/m.ts";\nimport { pick as n } from "../lib/n.ts";\nDeno.test("other", () => pick(false));\n',
      // At the root, so its directory is "" and it imports nothing.
      "plain_test.ts": 'Deno.test("plain", () => {});\n',
    },
    // Carried in the order n, m, p, so the uncovered list is out of order.
    baseLcov: [
      `SF:${WT}/lib/n.ts`,
      "DA:2,1",
      "DA:4,1",
      "end_of_record",
      `SF:${WT}/lib/m.ts`,
      "DA:2,1",
      "DA:3,1",
      "DA:5,1",
      "end_of_record",
      `SF:${WT}/lib/p.ts`,
      "DA:1,1",
      "end_of_record",
      `SF:${WT}/tests/m_test.ts`,
      "DA:1,1",
      "end_of_record",
      "",
    ].join("\n"),
    headLcov: [
      `SF:${REPO}/lib/n.ts`,
      "DA:2,0",
      "DA:4,0",
      "end_of_record",
      `SF:${REPO}/lib/m.ts`,
      "DA:3,1",
      "DA:4,1",
      "DA:6,0",
      "end_of_record",
      `SF:${REPO}/lib/p.ts`,
      "DA:1,0",
      "end_of_record",
      "",
    ].join("\n"),
  });
  const result = await runCoverageCarryOverCheck(
    input(DELETE_TEST_AND_INSERT_HEADER),
    f.seams,
  );
  assertEquals(result, {
    kind: "completed",
    changedTests: ["tests/m_test.ts"],
    carried: 6,
    uncovered: [
      { file: "lib/m.ts", line: 6 },
      { file: "lib/n.ts", line: 2 },
      { file: "lib/n.ts", line: 4 },
      { file: "lib/p.ts", line: 1 },
    ],
  });
  const headRuns = f.calls.filter((c) =>
    isCall(c, "deno", "test") && c.args.some((a) => a.includes("cov-head"))
  );
  assertEquals(headRuns.length, 1);
});

Deno.test("runCoverageCarryOverCheck - a line two projects reach has its hits summed, so one reaching run carries it", async () => {
  // Projects are visited in path order: pkg (cov-base-0), then the root (cov-base-1),
  // which reports zero hits. Only the summed hits carry the line.
  const ZERO_LCOV = [
    `SF:${WT}/lib/m.ts`,
    "DA:2,0",
    "DA:3,0",
    "DA:5,0",
    "end_of_record",
    "",
  ].join("\n");
  const f = fake({
    base: {
      "deno.json": DENO_JSON,
      "pkg/deno.json": DENO_JSON,
      "lib/m.ts": LIB_BASE,
      "tests/m_test.ts": M_TEST_LINES.join("\n") + "\n",
      "pkg/tests/k_test.ts": 'Deno.test("k", () => {});\n',
    },
    head: HEAD_WITH_OTHER_TEST,
    baseLcov: BASE_LCOV,
    respond: (cmd, args) =>
      cmd === "deno" && args[0] === "coverage" &&
        args[2] === `${TMP}/cov-base-1`
        ? ok(ZERO_LCOV)
        : undefined,
    headLcov: `SF:${REPO}/lib/m.ts\nDA:3,1\nDA:4,1\nDA:6,0\nend_of_record\n`,
  });
  const result = await runCoverageCarryOverCheck(
    input(
      deletedSection("pkg/tests/k_test.ts", ['Deno.test("k", () => {});']) +
        DELETE_TEST_AND_INSERT_HEADER,
    ),
    f.seams,
  );
  assertEquals(result, {
    kind: "completed",
    changedTests: ["pkg/tests/k_test.ts", "tests/m_test.ts"],
    carried: 3,
    uncovered: [{ file: "lib/m.ts", line: 6 }],
  });
});

// ---------------------------------------------------------------------------
// Head-side narrowing: edited tests first, importers only for what is left
// ---------------------------------------------------------------------------

/** The base test reaches lib/m.ts and lib/n.ts; one of its two cases is removed. */
const TWO_MODULE_TEST_BASE = [
  'import { pick } from "../lib/m.ts";',
  'import { pick as n } from "../lib/n.ts";',
  'Deno.test("m", () => pick(true));',
  'Deno.test("n", () => n(true));',
];
const TWO_MODULE_TEST_HEAD = [
  TWO_MODULE_TEST_BASE[0],
  TWO_MODULE_TEST_BASE[1],
  TWO_MODULE_TEST_BASE[2],
];
const REMOVE_N_CASE = section(
  "tests/m_test.ts",
  "@@ -4 +3,0 @@",
  `-${TWO_MODULE_TEST_BASE[3]}`,
) + section("lib/m.ts", "@@ -0,0 +1 @@", "+// header");
const TWO_MODULE_BASE = {
  "deno.json": DENO_JSON,
  "lib/m.ts": LIB_BASE,
  "lib/n.ts": LIB_BASE,
  "tests/m_test.ts": TWO_MODULE_TEST_BASE.join("\n") + "\n",
};
const TWO_MODULE_HEAD = {
  "deno.json": DENO_JSON,
  "lib/m.ts": "// header\n" + LIB_BASE,
  "lib/n.ts": LIB_BASE,
  "tests/m_test.ts": TWO_MODULE_TEST_HEAD.join("\n") + "\n",
  "tests/other_test.ts": OTHER_TEST,
  "tests/n_other_test.ts":
    'import { pick } from "../lib/n.ts";\nDeno.test("n other", () => pick(true));\n',
};
const TWO_MODULE_BASE_LCOV = [
  `SF:${WT}/lib/m.ts`,
  "DA:2,1",
  "DA:3,1",
  "end_of_record",
  `SF:${WT}/lib/n.ts`,
  "DA:2,1",
  "DA:3,1",
  "end_of_record",
  "",
].join("\n");

Deno.test("runCoverageCarryOverCheck - the edited head test runs first, and importers run only for files it leaves unreached", async () => {
  // The edited head test still reaches lib/m.ts (head lines 3 and 4) but no
  // longer lib/n.ts, so only lib/n.ts's importer runs, and lib/m.ts's does not.
  const f = fake({
    base: TWO_MODULE_BASE,
    head: TWO_MODULE_HEAD,
    baseLcov: TWO_MODULE_BASE_LCOV,
    respond: (cmd, args) => {
      if (cmd !== "deno" || args[0] !== "coverage") return undefined;
      if (args[2] === `${TMP}/cov-head-0`) {
        return ok(
          `SF:${REPO}/lib/m.ts\nDA:3,1\nDA:4,1\nend_of_record\n` +
            `SF:${REPO}/lib/n.ts\nDA:2,0\nDA:3,0\nend_of_record\n`,
        );
      }
      if (args[2] === `${TMP}/cov-head-1`) {
        return ok(`SF:${REPO}/lib/n.ts\nDA:2,1\nDA:3,0\nend_of_record\n`);
      }
      return undefined;
    },
  });
  const result = await runCoverageCarryOverCheck(
    input(REMOVE_N_CASE),
    f.seams,
  );
  assertEquals(result, {
    kind: "completed",
    changedTests: ["tests/m_test.ts"],
    carried: 4,
    uncovered: [{ file: "lib/n.ts", line: 3 }],
  });
  const headRuns = f.calls.filter((c) =>
    isCall(c, "deno", "test") && c.cwd === REPO
  );
  assertEquals(headRuns.map((c) => c.args.slice(3)), [
    [`--coverage=${TMP}/cov-head-0`, "tests/m_test.ts"],
    [`--coverage=${TMP}/cov-head-1`, "tests/n_other_test.ts"],
  ]);
});

Deno.test("runCoverageCarryOverCheck - when the edited head test reaches every carried line, no importer runs", async () => {
  const f = fake({
    base: TWO_MODULE_BASE,
    head: TWO_MODULE_HEAD,
    baseLcov: TWO_MODULE_BASE_LCOV,
    headLcov: `SF:${REPO}/lib/m.ts\nDA:3,1\nDA:4,1\nend_of_record\n` +
      `SF:${REPO}/lib/n.ts\nDA:2,1\nDA:3,1\nend_of_record\n`,
  });
  const result = await runCoverageCarryOverCheck(
    input(REMOVE_N_CASE),
    f.seams,
  );
  assertEquals(result, {
    kind: "completed",
    changedTests: ["tests/m_test.ts"],
    carried: 4,
    uncovered: [],
  });
  const headRuns = f.calls.filter((c) =>
    isCall(c, "deno", "test") && c.cwd === REPO
  );
  assertEquals(headRuns.map((c) => c.args.slice(4)), [["tests/m_test.ts"]]);
});

Deno.test("runCoverageCarryOverCheck - a failing edited head test stops the check before any importer runs", async () => {
  const f = fake({
    base: TWO_MODULE_BASE,
    head: TWO_MODULE_HEAD,
    baseLcov: TWO_MODULE_BASE_LCOV,
    respond: (cmd, args) =>
      cmd === "deno" && args[0] === "test" &&
        args.includes(`--coverage=${TMP}/cov-head-0`)
        ? fail(1, "error: edited boom\n")
        : undefined,
  });
  const result = await runCoverageCarryOverCheck(
    input(REMOVE_N_CASE),
    f.seams,
  );
  assertEquals(result, {
    kind: "error",
    reason: "head tests fail (tests/m_test.ts): error: edited boom",
  });
  assertEquals(
    f.calls.some((c) => c.args.includes(`--coverage=${TMP}/cov-head-1`)),
    false,
  );
});

Deno.test("runCoverageCarryOverCheck - importers run one carried file at a time and a file reached by an earlier batch is skipped", async () => {
  // A deleted test file loaded two modules that share importers: running the
  // importers of the first module also reaches the second, so the second
  // module's own importer must not run.
  const base = {
    "deno.json": DENO_JSON,
    "lib/a.ts": LIB_BASE,
    "lib/b.ts": LIB_BASE,
    "tests/m_test.ts":
      'import { pick } from "../lib/a.ts";\nimport { pick as bp } from "../lib/b.ts";\nDeno.test("m", () => { pick(true); bp(true); });\n',
  };
  const head = {
    "deno.json": DENO_JSON,
    "lib/a.ts": LIB_BASE,
    "lib/b.ts": LIB_BASE,
    "tests/shared1_test.ts":
      'import { pick } from "../lib/a.ts";\nimport { pick as bp } from "../lib/b.ts";\nDeno.test("s1", () => { pick(true); bp(true); });\n',
    "tests/shared2_test.ts":
      'import { pick } from "../lib/a.ts";\nimport { pick as bp } from "../lib/b.ts";\nDeno.test("s2", () => { pick(true); bp(true); });\n',
    "tests/a_only_test.ts":
      'import { pick } from "../lib/a.ts";\nDeno.test("a", () => pick(true));\n',
    "tests/b_only_test.ts":
      'import { pick } from "../lib/b.ts";\nDeno.test("b", () => pick(true));\n',
  };
  const baseLcov = [
    `SF:${WT}/lib/a.ts`,
    "DA:2,1",
    "DA:3,1",
    "end_of_record",
    `SF:${WT}/lib/b.ts`,
    "DA:2,1",
    "DA:3,1",
    "end_of_record",
    "",
  ].join("\n");
  const f = fake({
    base,
    head,
    baseLcov,
    respond: (cmd, args) => {
      if (cmd !== "deno" || args[0] !== "coverage") return undefined;
      // The first importer batch reaches both modules: the shared importers
      // import both a.ts and b.ts.
      if (args[2] === `${TMP}/cov-head-0`) {
        return ok(
          `SF:${REPO}/lib/a.ts\nDA:2,1\nDA:3,1\nend_of_record\n` +
            `SF:${REPO}/lib/b.ts\nDA:2,1\nDA:3,1\nend_of_record\n`,
        );
      }
      return undefined;
    },
  });
  const result = await runCoverageCarryOverCheck(
    input(deletedSection("tests/m_test.ts", [
      'import { pick } from "../lib/a.ts";',
      'import { pick as bp } from "../lib/b.ts";',
      'Deno.test("m", () => { pick(true); bp(true); });',
    ])),
    f.seams,
  );
  assertEquals(result, {
    kind: "completed",
    changedTests: ["tests/m_test.ts"],
    carried: 4,
    uncovered: [],
  });
  const headRuns = f.calls.filter((c) =>
    isCall(c, "deno", "test") && c.args.some((a) => a.includes("cov-head"))
  );
  // Only a.ts's importers run; b.ts's own importer is skipped because the
  // shared importers already reached it.
  assertEquals(headRuns.length, 1);
  assertEquals(headRuns[0]!.args.slice(4), [
    "tests/a_only_test.ts",
    "tests/shared1_test.ts",
    "tests/shared2_test.ts",
  ]);
});

// ---------------------------------------------------------------------------
// Cleanup and unexpected errors
// ---------------------------------------------------------------------------

Deno.test("runCoverageCarryOverCheck - the worktree is removed in cleanup, and cleanup failures do not change the result", async () => {
  const f = fake({
    base: DENO_BASE,
    head: HEAD_WITH_OTHER_TEST,
    baseLcov: BASE_LCOV,
    removeDirFails: true,
    respond: (cmd, args) =>
      cmd === "git" && args[0] === "worktree" && args[1] === "remove"
        ? fail(1, "fatal: remove failed\n")
        : undefined,
    headLcov: [
      `SF:${REPO}/lib/m.ts`,
      "DA:3,1",
      "DA:4,1",
      "DA:6,0",
      "end_of_record",
      "",
    ]
      .join("\n"),
  });
  const result: CoverageCarryOverResult = await runCoverageCarryOverCheck(
    input(DELETE_TEST_AND_INSERT_HEADER),
    f.seams,
  );
  assertEquals(result, {
    kind: "completed",
    changedTests: ["tests/m_test.ts"],
    carried: 3,
    uncovered: [{ file: "lib/m.ts", line: 6 }],
  });
  assertEquals(
    f.calls.some((c) => isCall(c, "git", "worktree", "remove", "--force", WT)),
    true,
  );
  // A failed removal falls back to removing the directory and pruning.
  assertEquals(
    f.calls.some((c) => isCall(c, "git", "worktree", "prune")),
    true,
  );
  assertEquals(f.removed.includes(TMP), true);
});

Deno.test("runCoverageCarryOverCheck - a failing head coverage report is an error naming the cause", async () => {
  const f = fake({
    base: DENO_BASE,
    head: HEAD_WITH_OTHER_TEST,
    baseLcov: BASE_LCOV,
    respond: (cmd, args) =>
      cmd === "deno" && args[0] === "coverage" &&
        (args[2] ?? "").includes("cov-head")
        ? fail(1, "error: bad lcov\n")
        : undefined,
  });
  const result = await runCoverageCarryOverCheck(
    input(DELETE_TEST_AND_INSERT_HEADER),
    f.seams,
  );
  assertEquals(result, {
    kind: "error",
    reason: "deno coverage failed: error: bad lcov",
  });
});

Deno.test("runCoverageCarryOverCheck - a carried file no head test loads is reported uncovered, with no head run", async () => {
  // The project exists at head, but no test there imports lib/m.ts.
  const f = fake({
    base: DENO_BASE,
    head: { "deno.json": DENO_JSON, "lib/m.ts": "// header\n" + LIB_BASE },
    baseLcov: BASE_LCOV,
  });
  const result = await runCoverageCarryOverCheck(
    input(DELETE_TEST_AND_INSERT_HEADER),
    f.seams,
  );
  assertEquals(result, {
    kind: "completed",
    changedTests: ["tests/m_test.ts"],
    carried: 3,
    uncovered: [
      { file: "lib/m.ts", line: 3 },
      { file: "lib/m.ts", line: 4 },
      { file: "lib/m.ts", line: 6 },
    ],
  });
  assertEquals(
    f.calls.some((c) => c.args.some((a) => a.includes("cov-head"))),
    false,
  );
});

Deno.test("runCoverageCarryOverCheck - a carried file with no Deno project at head is reported uncovered, with no head run", async () => {
  // Nothing at head marks a Deno project above lib/m.ts.
  const f = fake({
    base: DENO_BASE,
    head: {
      "lib/m.ts": "// header\n" + LIB_BASE,
      "tests/other_test.ts": OTHER_TEST,
    },
    baseLcov: BASE_LCOV,
  });
  const result = await runCoverageCarryOverCheck(
    input(DELETE_TEST_AND_INSERT_HEADER),
    f.seams,
  );
  assertEquals(result, {
    kind: "completed",
    changedTests: ["tests/m_test.ts"],
    carried: 3,
    uncovered: [
      { file: "lib/m.ts", line: 3 },
      { file: "lib/m.ts", line: 4 },
      { file: "lib/m.ts", line: 6 },
    ],
  });
  assertEquals(
    f.calls.some((c) => c.args.some((a) => a.includes("cov-head"))),
    false,
  );
});

Deno.test("runCoverageCarryOverCheck - an unexpected throw becomes an error result", async () => {
  const f = fake({ base: DENO_BASE, makeTempDirThrows: "disk full" });
  const result = await runCoverageCarryOverCheck(
    input(DELETE_TEST_AND_INSERT_HEADER),
    f.seams,
  );
  assertEquals(result, { kind: "error", reason: "disk full" });
});

Deno.test("runCoverageCarryOverCheck - an unexpected throw that is not an Error is reported as its string", async () => {
  const f = fake({ base: DENO_BASE });
  const seams = {
    ...f.seams,
    makeTempDir: () => Promise.reject("raw failure"),
  };
  const result = await runCoverageCarryOverCheck(
    input(DELETE_TEST_AND_INSERT_HEADER),
    seams,
  );
  assertEquals(result, { kind: "error", reason: "raw failure" });
});

Deno.test("runCoverageCarryOverCheck - a worktree remove that throws falls back to removing the directory and pruning", async () => {
  const f = fake({
    base: DENO_BASE,
    head: HEAD_WITH_OTHER_TEST,
    baseLcov: BASE_LCOV,
    headLcov: `SF:${REPO}/lib/m.ts\nDA:3,1\nDA:4,1\nDA:6,0\nend_of_record\n`,
    respond: (cmd, args) => {
      if (cmd === "git" && args[0] === "worktree" && args[1] === "remove") {
        throw new Error("spawn failed");
      }
      return undefined;
    },
  });
  const result = await runCoverageCarryOverCheck(
    input(DELETE_TEST_AND_INSERT_HEADER),
    f.seams,
  );
  assertEquals(result.kind, "completed");
  assertEquals(
    f.calls.some((c) => isCall(c, "git", "worktree", "prune")),
    true,
  );
  assertEquals(f.removed.includes(TMP), true);
});

Deno.test("runCoverageCarryOverCheck - a worktree remove that times out falls back to removing the directory and pruning", async () => {
  const f = fake({
    base: DENO_BASE,
    head: HEAD_WITH_OTHER_TEST,
    baseLcov: BASE_LCOV,
    headLcov: `SF:${REPO}/lib/m.ts\nDA:3,1\nDA:4,1\nDA:6,0\nend_of_record\n`,
    respond: (cmd, args) =>
      cmd === "git" && args[0] === "worktree" && args[1] === "remove"
        ? { code: 0, stdout: "", stderr: "", timedOut: true }
        : undefined,
  });
  const result = await runCoverageCarryOverCheck(
    input(DELETE_TEST_AND_INSERT_HEADER),
    f.seams,
  );
  assertEquals(result.kind, "completed");
  assertEquals(
    f.calls.some((c) => isCall(c, "git", "worktree", "prune")),
    true,
  );
  assertEquals(f.removed.includes(TMP), true);
});

// ---------------------------------------------------------------------------
// Integration: a real git repository and the real seams
// ---------------------------------------------------------------------------

const LIB_FILE = `export function pick(flag: boolean): string {
  if (flag) {
    return "one";
  }
  return "two";
}
`;
const ONE_TEST = `import { pick } from "./lib.ts";

Deno.test("one", () => {
  if (pick(true) !== "one") throw new Error("expected one");
});
`;
const TWO_TEST = `import { pick } from "./lib.ts";

Deno.test("two", () => {
  if (pick(false) !== "two") throw new Error("expected two");
});
`;

async function git(cwd: string, args: string[]): Promise<string> {
  const out = await new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
    stdin: "null",
  }).output();
  if (out.code !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${new TextDecoder().decode(out.stderr)}`,
    );
  }
  return new TextDecoder().decode(out.stdout).trim();
}

/**
 * A repository with lib.ts (two branches), a test reaching each branch, and a
 * base commit. HEAD deletes the branch-two test; `extendOneTest` also has the
 * remaining test reach branch two.
 */
async function buildRepo(extendOneTest: boolean): Promise<{
  dir: string;
  base: string;
  diff: string;
}> {
  const dir = await Deno.makeTempDir({ prefix: "vibe-coverage-carryover-" });
  await git(dir, ["init", "-q"]);
  await git(dir, ["config", "user.email", "test@example.invalid"]);
  await git(dir, ["config", "user.name", "Test"]);
  await git(dir, ["config", "commit.gpgsign", "false"]);
  await Deno.writeTextFile(`${dir}/deno.json`, "{}\n");
  await Deno.writeTextFile(`${dir}/lib.ts`, LIB_FILE);
  await Deno.writeTextFile(`${dir}/one_test.ts`, ONE_TEST);
  await Deno.writeTextFile(`${dir}/two_test.ts`, TWO_TEST);
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", "base"]);
  const base = await git(dir, ["rev-parse", "HEAD"]);

  await Deno.remove(`${dir}/two_test.ts`);
  if (extendOneTest) {
    await Deno.writeTextFile(
      `${dir}/one_test.ts`,
      ONE_TEST + "\n" +
        TWO_TEST.replace('import { pick } from "./lib.ts";\n', ""),
    );
  }
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", "head"]);
  const diff = await git(dir, [
    "diff",
    "--unified=0",
    "--no-renames",
    `${base}...HEAD`,
  ]);
  return { dir, base, diff: diff + "\n" };
}

Deno.test("runCoverageCarryOverCheck integration - a branch reached only by the removed test is reported uncovered", async () => {
  const repo = await buildRepo(false);
  try {
    const result = await runCoverageCarryOverCheck(
      {
        repoPath: repo.dir,
        base: repo.base,
        diff: repo.diff,
        budgetSeconds: 120,
      },
      defaultMutationRunnerSeams(),
    );
    assertEquals(result.kind, "completed");
    if (result.kind !== "completed") return;
    assertEquals(result.changedTests, ["two_test.ts"]);
    assertEquals(result.uncovered, [{ file: "lib.ts", line: 5 }]);
  } finally {
    await Deno.remove(repo.dir, { recursive: true });
  }
});

Deno.test("runCoverageCarryOverCheck integration - the remaining test reaching the branch clears it", async () => {
  const repo = await buildRepo(true);
  try {
    const result = await runCoverageCarryOverCheck(
      {
        repoPath: repo.dir,
        base: repo.base,
        diff: repo.diff,
        budgetSeconds: 120,
      },
      defaultMutationRunnerSeams(),
    );
    assertEquals(result.kind, "completed");
    if (result.kind !== "completed") return;
    assertEquals(result.changedTests, ["two_test.ts"]);
    assertEquals(result.uncovered, []);
    assertEquals(result.carried > 0, true);
  } finally {
    await Deno.remove(repo.dir, { recursive: true });
  }
});
