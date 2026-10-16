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
        dir.includes("cov-base") ? (opts.baseLcov ?? "") : (opts.headLcov ?? ""),
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
    f.calls.some((c) =>
      isCall(c, "git", "worktree", "remove", "--force", WT)
    ),
    true,
  );
  assertEquals(f.removed.includes(TMP), true);
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
    isCall(c, "deno", "test") && c.args.some((a) => a.startsWith("--coverage=") && a.includes("cov-base"))
  );
  assertEquals(baseRun?.timeoutMs, 1000);
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
  const baseRun = f.calls.find((c) => isCall(c, "deno", "test") && c.cwd === WT);
  assertEquals(baseRun?.args, [
    "test",
    "--no-check",
    "-A",
    `--coverage=${TMP}/cov-base-0`,
    "tests/m_test.ts",
  ]);
  const headRun = f.calls.find((c) => isCall(c, "deno", "test") && c.cwd === REPO);
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
    headLcov: [`SF:${REPO}/lib/m.ts`, "DA:3,1", "DA:4,1", "DA:6,2", "end_of_record", ""]
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
    headLcov: [`SF:${REPO}/lib/m.ts`, "DA:3,1", "DA:4,1", "DA:6,0", "end_of_record", ""]
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

Deno.test("runCoverageCarryOverCheck - an unexpected throw becomes an error result", async () => {
  const f = fake({ base: DENO_BASE, makeTempDirThrows: "disk full" });
  const result = await runCoverageCarryOverCheck(
    input(DELETE_TEST_AND_INSERT_HEADER),
    f.seams,
  );
  assertEquals(result, { kind: "error", reason: "disk full" });
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
      ONE_TEST + "\n" + TWO_TEST.replace('import { pick } from "./lib.ts";\n', ""),
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
