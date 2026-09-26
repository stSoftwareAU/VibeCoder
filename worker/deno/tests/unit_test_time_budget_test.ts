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

Deno.test("time budget - integration suites and the keep-list warn but never fail", () => {
  const timings: TestTiming[] = [
    { file: "tests/integration_test.ts", name: "spawns", ms: 9000 },
    { file: "tests/kept_test.ts", name: "watchdog", ms: 6000 },
  ];
  const report = unitTestTimeBudget(timings, {
    integrationFiles: ["tests/integration_test.ts"],
    keepFiles: new Map([["tests/kept_test.ts", "times a real watchdog"]]),
  });

  assertEquals(report.failedFiles, []);
  assertEquals(report.warnings.length, 2);
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
    failedFiles: [],
    failures: [],
  });
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

Deno.test("parseJunitTestTimes - reads the report deno test really writes", async () => {
  const dir = await Deno.makeTempDir({ prefix: "issue2642-junit-" });
  try {
    await Deno.writeTextFile(
      `${dir}/fast_test.ts`,
      'Deno.test("a fast one", () => {});\n',
    );
    const out = await new Deno.Command(Deno.execPath(), {
      args: [
        "test",
        "--no-check",
        "--no-config",
        "--reporter=dot",
        `--junit-path=${dir}/report.xml`,
        `${dir}/fast_test.ts`,
      ],
      cwd: dir,
      stdout: "null",
      stderr: "piped",
    }).output();
    assertEquals(out.code, 0, new TextDecoder().decode(out.stderr));

    const timings = await readPassTimings(`${dir}/report.xml`);
    assertEquals(timings.map((t) => t.name), ["a fast one"]);
    assertEquals(timings[0]!.file, "fast_test.ts");
    assertEquals(unitTestTimeBudget(timings, NO_EXEMPTIONS).warnings, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
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

Deno.test("normaliseTestPath - spells a path the way the manifests do", () => {
  assertEquals(normaliseTestPath("./tests/a_test.ts"), "tests/a_test.ts");
  assertEquals(
    normaliseTestPath("worker/deno/tests/a_test.ts"),
    "tests/a_test.ts",
  );
  assertEquals(normaliseTestPath("tests\\a_test.ts"), "tests/a_test.ts");
  assertEquals(normaliseTestPath("tests/a_test.ts"), "tests/a_test.ts");
});
