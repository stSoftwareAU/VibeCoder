/**
 * The unit-test time budget (Issue #2642).
 *
 * A unit test should finish in milliseconds. A slow one costs wall-clock and
 * tokens on every agent run that runs it, and nothing caught a new one: the
 * planning suites spent one to three seconds a test spawning a real `claude`
 * behind fully mocked dependencies, unnoticed. So every unit pass writes a
 * JUnit report, and this module reads the per-test times back:
 *
 * - every test over {@link UNIT_TEST_BUDGET_MS} is reported as a WARNING line
 *   naming the test and its time;
 * - a file whose tests **all** exceed the budget fails the gate, unless it is
 *   an integration suite or on {@link SLOW_UNIT_TEST_KEEP_FILES} with a
 *   reason. One slow case in an otherwise fast file is a warning; a file that
 *   is slow throughout is a unit suite that is really something else.
 *
 * ```mermaid
 * flowchart LR
 *   P[deno test pass] -->|--junit-path| X[JUnit XML]
 *   X --> T[per-test times]
 *   T -->|test over 1s| W[WARNING line]
 *   T -->|every test in the file over 1s, not exempt| F[gate FAILS]
 * ```
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import {
  IN_GATE_SCRIPT_SUITES,
  INTEGRATION_TEST_FILES,
} from "./integration_test_manifest.ts";

/** The per-test budget: a unit test over this is reported. */
export const UNIT_TEST_BUDGET_MS = 1000;

/**
 * Files kept in the unit gate although every test in them is slow, and why.
 *
 * A named exception with a reason, exactly like `IN_GATE_SCRIPT_SUITES` —
 * whose entries are included here by reference, because a script suite the
 * gate runs on purpose is slow on purpose. Adding a file here is a decision
 * that its cost is the point of the test; say what that cost buys.
 */
export const SLOW_UNIT_TEST_KEEP_FILES: ReadonlyMap<string, string> = new Map([
  ...IN_GATE_SCRIPT_SUITES,
]);

/** One test's measured time. */
export interface TestTiming {
  /** The test file, as the manifests spell it (`tests/foo_test.ts`). */
  file: string;
  /** The test's own name. */
  name: string;
  /** Wall time in milliseconds. */
  ms: number;
}

/** Undo the five XML entities `deno test` escapes in a JUnit attribute. */
function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** One attribute's decoded value from a tag's attribute text. */
function attribute(attrs: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs);
  return match ? decodeXml(match[1]!) : undefined;
}

/** `./tests/foo_test.ts` → `tests/foo_test.ts`, the manifests' spelling. */
export function normaliseTestPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(
    /^worker\/deno\//,
    "",
  );
}

/**
 * Per-test times from a `deno test --junit-path` report.
 *
 * Throws on a report that is not a JUnit document, so an unreadable report
 * fails loud rather than reading as "no test was slow".
 */
export function parseJunitTestTimes(xml: string): TestTiming[] {
  if (!/<testsuites[\s>]/.test(xml)) {
    throw new Error("not a JUnit report: no <testsuites> element");
  }
  const timings: TestTiming[] = [];
  for (const match of xml.matchAll(/<testcase\s([^>]*)>/g)) {
    const attrs = match[1]!;
    const name = attribute(attrs, "name");
    const file = attribute(attrs, "classname");
    const seconds = Number(attribute(attrs, "time"));
    if (name === undefined || file === undefined || !Number.isFinite(seconds)) {
      throw new Error(`unreadable JUnit testcase: <testcase ${attrs}>`);
    }
    timings.push({
      file: normaliseTestPath(file),
      name,
      ms: Math.round(seconds * 1000),
    });
  }
  return timings;
}

/** `1.23s` — the precision a budget of one second needs. */
function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s`;
}

/** Options for {@link unitTestTimeBudget}. */
export interface TimeBudgetOptions {
  budgetMs?: number;
  /** Injected so a test can vary them. */
  integrationFiles?: readonly string[];
  keepFiles?: ReadonlyMap<string, string>;
}

/** What the budget found over one or more passes. */
export interface TimeBudgetReport {
  /** One WARNING line per test over the budget, slowest first. */
  warnings: string[];
  /** Files whose every test is over the budget and that are not exempt. */
  failedFiles: string[];
  /** One line per failed file, saying what to do about it. */
  failures: string[];
}

/** Hold a set of per-test times to the unit-test budget. */
export function unitTestTimeBudget(
  timings: readonly TestTiming[],
  options: TimeBudgetOptions = {},
): TimeBudgetReport {
  const budgetMs = options.budgetMs ?? UNIT_TEST_BUDGET_MS;
  const exempt = new Set([
    ...(options.integrationFiles ?? INTEGRATION_TEST_FILES),
    ...(options.keepFiles ?? SLOW_UNIT_TEST_KEEP_FILES).keys(),
  ]);
  const budget = seconds(budgetMs);

  const slow = timings.filter((t) => t.ms > budgetMs)
    .sort((a, b) => b.ms - a.ms);
  const warnings = slow.map((t) =>
    `WARNING: slow unit test (${seconds(t.ms)} > ${budget}): ` +
    `${t.file} — ${t.name}`
  );

  const byFile = new Map<string, TestTiming[]>();
  for (const t of timings) {
    byFile.set(t.file, [...(byFile.get(t.file) ?? []), t]);
  }
  const failedFiles = [...byFile]
    .filter(([file, tests]) =>
      !exempt.has(file) && tests.every((t) => t.ms > budgetMs)
    )
    .map(([file]) => file)
    .sort();
  const failures = failedFiles.map((file) => {
    const tests = byFile.get(file)!;
    const total = tests.reduce((sum, t) => sum + t.ms, 0);
    return `FAIL: every test in ${file} (${tests.length}, ${seconds(total)}) ` +
      `is over the ${budget} unit-test budget — find what the mocks miss and ` +
      `make it fast, or list the file in INTEGRATION_TEST_FILES or ` +
      `SLOW_UNIT_TEST_KEEP_FILES with a reason (Issue #2642)`;
  });
  return { warnings, failedFiles, failures };
}

/**
 * The per-test times one green pass reported.
 *
 * Throws when the report is missing or unreadable: a pass that exited 0
 * without its report has not proved it was fast, and must not read as if it
 * had.
 */
export async function readPassTimings(
  junitPath: string,
  readText: (path: string) => Promise<string> = Deno.readTextFile,
): Promise<TestTiming[]> {
  let xml: string;
  try {
    xml = await readText(junitPath);
  } catch (error) {
    throw new Error(
      `the unit pass wrote no JUnit report at ${junitPath}: ` +
        (error instanceof Error ? error.message : String(error)),
    );
  }
  return parseJunitTestTimes(xml);
}
