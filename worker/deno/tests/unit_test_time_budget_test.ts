/**
 * The unit-test time budget (Issue #2642).
 *
 * The budget reads each pass's JUnit report back: a test over one second is
 * reported as a WARNING, and a file whose tests are all over it fails the
 * gate unless it is exempt. Both directions are pinned — a slow stub test is
 * reported, a fast one is not — and the report the parser reads is the one
 * `deno test --junit-path` really writes.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  budgetProvedPass,
  gitGuardShimOnPath,
  normaliseTestPath,
  parseJunitTestTimes,
  passesTimeBudget,
  readPassTimings,
  SLOW_UNIT_TEST_KEEP_FILES,
  type TestTiming,
  UNIT_TEST_BUDGET_MS,
  unitTestTimeBudget,
} from "../lib/unit_test_time_budget.ts";
import { IN_GATE_SCRIPT_SUITES } from "../lib/integration_test_manifest.ts";
import { SUBPROCESS_TIMING_TEST_FILES } from "../lib/parallel_unsafe_test_manifest.ts";
import { renderGitShimScript } from "../lib/git_guard_shim.ts";

/** A JUnit report in the shape `deno test --junit-path` writes. */
function junit(cases: { file: string; name: string; seconds: number }[]) {
  const body = cases.map((c) =>
    `<testcase name="${c.name}" classname="./${c.file}" ` +
    `time="${c.seconds.toFixed(3)}" line="1" col="6">\n</testcase>`
  ).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<testsuites name="deno test" tests="${cases.length}">\n` +
    `<testsuite name="x">\n${body}\n</testsuite>\n</testsuites>\n`;
}

/** No exemptions, so a test decides exactly what is exempt. */
const NO_EXEMPTIONS = { integrationFiles: [], keepFiles: new Map() };

Deno.test("time budget - a slow stub test is reported with its name and time", () => {
  const report = unitTestTimeBudget([
    { file: "tests/slow_test.ts", name: "a stub that sleeps", ms: 1234 },
    { file: "tests/slow_test.ts", name: "a fast neighbour", ms: 3 },
  ], NO_EXEMPTIONS);

  assertEquals(report.warnings, [
    "WARNING: slow unit test (1.23s > 1.00s): tests/slow_test.ts — " +
    "a stub that sleeps",
  ]);
  // One slow case in a fast file is a warning, never a failure.
  assertEquals(report.failedFiles, []);
});

Deno.test("time budget - a fast test is not reported", () => {
  const report = unitTestTimeBudget([
    { file: "tests/fast_test.ts", name: "quick", ms: 12 },
    // At the budget is within it: only a test *over* one second is slow.
    {
      file: "tests/fast_test.ts",
      name: "right at it",
      ms: UNIT_TEST_BUDGET_MS,
    },
  ], NO_EXEMPTIONS);

  assertEquals(report.warnings, []);
  assertEquals(report.failures, []);
});

Deno.test("time budget - a file whose every test is slow fails, slowest warnings first", () => {
  const report = unitTestTimeBudget([
    { file: "tests/b_test.ts", name: "one", ms: 1500 },
    { file: "tests/b_test.ts", name: "two", ms: 2500 },
    { file: "tests/a_test.ts", name: "fine", ms: 5 },
  ], NO_EXEMPTIONS);

  assertEquals(report.failedFiles, ["tests/b_test.ts"]);
  assertEquals(report.failures.length, 1);
  assert(report.failures[0]!.startsWith("FAIL: every test in tests/b_test.ts"));
  assert(report.failures[0]!.includes("(2, 4.00s)"));
  assert(report.warnings[0]!.includes("two"), "slowest first");
  assertEquals(report.warnings.length, 2);
});

Deno.test("time budget - integration suites and the keep-list never fail and get one note, not a WARNING each", () => {
  const timings: TestTiming[] = [
    { file: "tests/integration_test.ts", name: "spawns", ms: 9000 },
    { file: "tests/kept_test.ts", name: "watchdog", ms: 6000 },
    { file: "tests/kept_test.ts", name: "reaps", ms: 5000 },
  ];
  const report = unitTestTimeBudget(timings, {
    integrationFiles: ["tests/integration_test.ts"],
    keepFiles: new Map([["tests/kept_test.ts", "times a real watchdog"]]),
  });

  assertEquals(report.failedFiles, []);
  assertEquals(report.warnings, []);
  assertEquals(report.exemptNotes, [
    "slow by decision: tests/integration_test.ts — 1 test(s) over 1.00s",
    "slow by decision: tests/kept_test.ts — 2 test(s) over 1.00s",
  ]);
});

Deno.test("time budget - the subprocess-timing suites are on the keep-list", () => {
  for (const file of SUBPROCESS_TIMING_TEST_FILES.keys()) {
    assert(SLOW_UNIT_TEST_KEEP_FILES.has(file), file);
  }
});

Deno.test("time budget - every keep-list entry is a reasoned decision, not a baseline (Issue #2669)", () => {
  // The #2642 baseline kept 38 files on one generic reason; #2669 burnt it
  // down. Only an entry that says what its cost buys may remain.
  const keptFiles = new Set([
    ...IN_GATE_SCRIPT_SUITES.keys(),
    ...SUBPROCESS_TIMING_TEST_FILES.keys(),
  ]);
  for (const [file, reason] of SLOW_UNIT_TEST_KEEP_FILES) {
    assert(reason.trim().length > 0, `${file} is kept with no reason`);
    assert(!/over or near the budget/.test(reason), `${file}: ${reason}`);
    assert(keptFiles.has(file), `${file} is kept outside the two manifests`);
  }
});

Deno.test("time budget - the run.ps1 launcher suite is on the default keep-list", () => {
  // Kept in the gate by decision (Issue #1598), so kept past the budget too.
  for (const file of IN_GATE_SCRIPT_SUITES.keys()) {
    assert(SLOW_UNIT_TEST_KEEP_FILES.has(file), file);
  }
  const report = unitTestTimeBudget([
    { file: "tests/run_ps1_launcher_test.ts", name: "reaps", ms: 6000 },
  ]);
  assertEquals(report.failedFiles, []);
});

Deno.test("time budget - no timings, no findings", () => {
  assertEquals(unitTestTimeBudget([]), {
    warnings: [],
    exemptNotes: [],
    failedFiles: [],
    failures: [],
    unenforced: [],
  });
});

Deno.test("time budget - under the git guard shim a slow file is reported, not failed (Issue #2669)", () => {
  const report = unitTestTimeBudget([
    { file: "tests/git_heavy_test.ts", name: "commits", ms: 1400 },
    { file: "tests/git_heavy_test.ts", name: "pushes", ms: 1100 },
  ], { ...NO_EXEMPTIONS, gitGuardShim: true });

  assertEquals(report.failedFiles, []);
  assertEquals(report.failures, []);
  // Loud, not silent: each would-be failure is named, with why it is waived.
  assertEquals(report.unenforced.length, 1);
  assert(
    report.unenforced[0]!.startsWith(
      "NOT ENFORCED: every test in tests/git_heavy_test.ts",
    ),
  );
  assert(report.unenforced[0]!.includes("git guard shim"));
  // The per-test WARNING lines still name every slow test.
  assertEquals(report.warnings.length, 2);
});

Deno.test("time budget - without the git guard shim a slow file still fails (Issue #2669)", () => {
  const report = unitTestTimeBudget([
    { file: "tests/git_heavy_test.ts", name: "commits", ms: 1400 },
  ], { ...NO_EXEMPTIONS, gitGuardShim: false });
  assertEquals(report.failedFiles, ["tests/git_heavy_test.ts"]);
  assertEquals(report.unenforced, []);
});

Deno.test("budgetProvedPass - only an enforced, clean budget lets a pass be cached (Issue #2669)", () => {
  const slow = [{ file: "tests/git_heavy_test.ts", name: "a", ms: 1500 }];
  const fast = [{ file: "tests/git_heavy_test.ts", name: "a", ms: 20 }];
  const opts = { ...NO_EXEMPTIONS };
  assert(budgetProvedPass(unitTestTimeBudget(fast, opts)));
  assert(
    budgetProvedPass(unitTestTimeBudget(fast, { ...opts, gitGuardShim: true })),
  );
  // Waived under the shim: green, but not proved, so not cached.
  assert(
    !budgetProvedPass(
      unitTestTimeBudget(slow, { ...opts, gitGuardShim: true }),
    ),
  );
  assert(!budgetProvedPass(unitTestTimeBudget(slow, opts)));
});

/** A temp `PATH` directory holding one file named `git`. */
async function pathWithGit(body: string, mode = 0o755): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "issue2669-" });
  await Deno.writeTextFile(`${dir}/git`, body);
  await Deno.chmod(`${dir}/git`, mode);
  return dir;
}

/** The rendered shim, as the worker writes it. */
const SHIM_SCRIPT = renderGitShimScript({
  denoPath: "/usr/bin/deno",
  guardModulePath: "/opt/guard/git_guard_cli.ts",
  realGitPath: "/usr/bin/git",
  verdictDir: "/tmp/verdict",
  denoDir: "/tmp/deno-dir",
});

Deno.test("gitGuardShimOnPath - finds the real rendered shim first on PATH (Issue #2669)", async () => {
  const shim = await pathWithGit(SHIM_SCRIPT);
  const plain = await pathWithGit('#!/bin/sh\nexec /usr/bin/git "$@"\n');
  try {
    assert(await gitGuardShimOnPath(`${shim}:${plain}`));
    // Only the git that would run counts: a shim behind another git is not.
    assert(!await gitGuardShimOnPath(`${plain}:${shim}`));
  } finally {
    await Deno.remove(shim, { recursive: true });
    await Deno.remove(plain, { recursive: true });
  }
});

Deno.test("gitGuardShimOnPath - no PATH, an empty PATH or no git on it is no shim", async () => {
  const empty = await Deno.makeTempDir({ prefix: "issue2669-" });
  try {
    assert(!await gitGuardShimOnPath(undefined));
    assert(!await gitGuardShimOnPath(""));
    assert(!await gitGuardShimOnPath(`::${empty}:/nonexistent/issue2669`));
  } finally {
    await Deno.remove(empty, { recursive: true });
  }
});

Deno.test("gitGuardShimOnPath - skips a git that the shell would not run", async () => {
  // A non-executable file or a directory named git is not what the shell
  // runs, so the executable shim behind it decides.
  const inert = await pathWithGit(SHIM_SCRIPT, 0o644);
  const dirGit = await Deno.makeTempDir({ prefix: "issue2669-" });
  await Deno.mkdir(`${dirGit}/git`);
  const shim = await pathWithGit(SHIM_SCRIPT);
  const plain = await pathWithGit('#!/bin/sh\nexec /usr/bin/git "$@"\n');
  try {
    assert(!await gitGuardShimOnPath(`${inert}:${dirGit}:${plain}`));
    assert(await gitGuardShimOnPath(`${inert}:${dirGit}:${shim}`));
  } finally {
    for (const dir of [inert, dirGit, shim, plain]) {
      await Deno.remove(dir, { recursive: true });
    }
  }
});

/** Whether a mode-0311 file is still readable here (root reads anything). */
async function unreadableFilesAreReadable(): Promise<boolean> {
  const dir = await pathWithGit(SHIM_SCRIPT, 0o311);
  try {
    return await Deno.readFile(`${dir}/git`).then(() => true, () => false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test({
  name:
    "gitGuardShimOnPath - an unreadable git throws rather than reading as no shim",
  // Reported as ignored, not passed, where permissions cannot be denied.
  ignore: await unreadableFilesAreReadable(),
  fn: async () => {
    // Executable but not readable: the check cannot tell, so it fails loud.
    const locked = await pathWithGit(SHIM_SCRIPT, 0o311);
    try {
      await assertRejects(
        () => gitGuardShimOnPath(locked),
        Deno.errors.PermissionDenied,
      );
    } finally {
      await Deno.remove(locked, { recursive: true });
    }
  },
});

Deno.test("parseJunitTestTimes - reads names, files and times, entities decoded", () => {
  const xml = junit([
    {
      file: "tests/a_test.ts",
      name: "it&apos;s &lt;fast&gt; &amp; fine",
      seconds: 0.012,
    },
    { file: "tests/b_test.ts", name: "slow", seconds: 1.5 },
  ]);
  assertEquals(parseJunitTestTimes(xml), [
    { file: "tests/a_test.ts", name: "it's <fast> & fine", ms: 12 },
    { file: "tests/b_test.ts", name: "slow", ms: 1500 },
  ]);
});

Deno.test("parseJunitTestTimes - fails loud on a report that is not JUnit", () => {
  assertThrows(() => parseJunitTestTimes(""), Error, "not a JUnit report");
  assertThrows(
    () => parseJunitTestTimes('<testsuites><testcase name="x">'),
    Error,
    "unreadable JUnit testcase",
  );
});

/**
 * A report `deno test --junit-path` wrote (Deno 2.9), verbatim — kept as a
 * fixture so the parser is held to the real shape without spawning `deno`.
 */
const REAL_DENO_REPORT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="deno test" tests="2" failures="0" errors="0" time="0.021">
    <testsuite name="./tests/stream_compaction_seam_2642_test.ts" tests="2" disabled="0" errors="0" failures="0">
        <testcase name="#2642 - the setup phase compacts a resumed stream through deps.claude" classname="./tests/stream_compaction_seam_2642_test.ts" time="0.006" line="140" col="6">
        </testcase>
        <testcase name="#2642 - the mock deps&apos; compaction answers no window and runs nothing" classname="./tests/stream_compaction_seam_2642_test.ts" time="0.000" line="191" col="6">
        </testcase>
    </testsuite>
</testsuites>
`;

Deno.test("parseJunitTestTimes - reads the report deno test really writes", async () => {
  const timings = await readPassTimings(
    "report.xml",
    () => Promise.resolve(REAL_DENO_REPORT),
  );
  assertEquals(timings, [
    {
      file: "tests/stream_compaction_seam_2642_test.ts",
      name:
        "#2642 - the setup phase compacts a resumed stream through deps.claude",
      ms: 6,
    },
    {
      file: "tests/stream_compaction_seam_2642_test.ts",
      name:
        "#2642 - the mock deps' compaction answers no window and runs nothing",
      ms: 0,
    },
  ]);
  assertEquals(unitTestTimeBudget(timings, NO_EXEMPTIONS).warnings, []);
});

Deno.test("readPassTimings - a missing report fails loud rather than reading as fast", async () => {
  await assertRejects(
    () => readPassTimings("/nonexistent/issue2642/report.xml"),
    Error,
    "wrote no JUnit report",
  );
});

Deno.test("passesTimeBudget - holds every pass's report to one budget", async () => {
  const reports: Record<string, string> = {
    "/p.xml": junit([{ file: "tests/p_test.ts", name: "p", seconds: 1.1 }]),
    "/s.xml": junit([{ file: "tests/s_test.ts", name: "s", seconds: 0.01 }]),
  };
  const report = await passesTimeBudget(["/p.xml", "/s.xml"], {
    ...NO_EXEMPTIONS,
    readText: (path) => Promise.resolve(reports[path]!),
  });
  assertEquals(report.failedFiles, ["tests/p_test.ts"]);
  assertEquals(report.warnings.length, 1);
});

Deno.test("passesTimeBudget - waives a slow file when the git guard shim is on PATH", async () => {
  const report = await passesTimeBudget(["/p.xml"], {
    ...NO_EXEMPTIONS,
    gitGuardShim: true,
    readText: () =>
      Promise.resolve(
        junit([{ file: "tests/p_test.ts", name: "p", seconds: 1.1 }]),
      ),
  });
  assertEquals(report.failedFiles, []);
  assertEquals(report.unenforced.length, 1);
});

Deno.test("normaliseTestPath - spells a path the way the manifests do", () => {
  assertEquals(normaliseTestPath("./tests/a_test.ts"), "tests/a_test.ts");
  assertEquals(
    normaliseTestPath("worker/deno/tests/a_test.ts"),
    "tests/a_test.ts",
  );
  assertEquals(normaliseTestPath("tests\\a_test.ts"), "tests/a_test.ts");
  assertEquals(normaliseTestPath("tests/a_test.ts"), "tests/a_test.ts");
});
