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
 *   naming the test and its time — except in an exempt file, slow by
 *   decision, which gets one plain line counting its slow tests;
 * - a file whose tests **all** exceed the budget fails the gate, unless it is
 *   an integration suite or on {@link SLOW_UNIT_TEST_KEEP_FILES} with a
 *   reason. One slow case in an otherwise fast file is a warning; a file that
 *   is slow throughout is a unit suite that is really something else.
 *
 * Issue #2669: the agent's own run puts the git guard shim first on `PATH`,
 * and every message-carrying `git` call a test makes then pays ~200 ms of
 * Deno start-up for the guard. Measured on the 38 files once baselined, the
 * same tests ran in 2 s without the shim and 39 s with it. There the failure
 * is not enforced — each would-be failure is printed as a NOT ENFORCED line
 * instead — because the time is the guard's, not the test's; CI and the
 * worker's own gate run without the shim and enforce it.
 *
 * ```mermaid
 * flowchart LR
 *   P[deno test pass] -->|--junit-path| X[JUnit XML]
 *   X --> T[per-test times]
 *   T -->|test over 1s| W[WARNING line]
 *   T -->|every test in the file over 1s, not exempt| S{git guard shim on PATH?}
 *   S -->|no| F[gate FAILS]
 *   S -->|yes| N[NOT ENFORCED line]
 * ```
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import {
  IN_GATE_SCRIPT_SUITES,
  INTEGRATION_TEST_FILES,
} from "./integration_test_manifest.ts";
import { SUBPROCESS_TIMING_TEST_FILES } from "./parallel_unsafe_test_manifest.ts";
import { GIT_GUARD_SHIM_MARKER } from "./git_guard_shim.ts";

/** The per-test budget: a unit test over this is reported. */
export const UNIT_TEST_BUDGET_MS = 1000;

/**
 * Files kept in the unit gate although every test in them is slow, and why.
 *
 * A named exception with a reason, exactly like `IN_GATE_SCRIPT_SUITES` and
 * `SUBPROCESS_TIMING_TEST_FILES` — whose entries are included here by
 * reference, because a script suite the gate runs on purpose, and a suite
 * that races a real subprocess on purpose, are slow on purpose. Adding a file
 * here is a decision that its cost is the point of the test; say what that
 * cost buys.
 */
export const SLOW_UNIT_TEST_KEEP_FILES: ReadonlyMap<string, string> = new Map([
  ...IN_GATE_SCRIPT_SUITES,
  ...SUBPROCESS_TIMING_TEST_FILES,
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
  for (const match of attrs.matchAll(/(?:^|\s)([\w:.-]+)="([^"]*)"/g)) {
    if (match[1] === name) return decodeXml(match[2]!);
  }
  return undefined;
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
  /**
   * The git guard shim is the `git` on `PATH` (Issue #2669): report a file
   * that would fail as NOT ENFORCED instead — see {@link gitGuardShimOnPath}.
   */
  gitGuardShim?: boolean;
}

/** What the budget found over one or more passes. */
export interface TimeBudgetReport {
  /**
   * One WARNING line per test over the budget in a non-exempt file, slowest
   * first.
   */
  warnings: string[];
  /** One plain line per exempt file with tests over the budget. */
  exemptNotes: string[];
  /** Files whose every test is over the budget and that are not exempt. */
  failedFiles: string[];
  /** One line per failed file, saying what to do about it. */
  failures: string[];
  /**
   * One NOT ENFORCED line per file that would have failed, when the git guard
   * shim is on `PATH` (Issue #2669).
   */
  unenforced: string[];
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

  // A WARNING is for a test nobody decided should be slow. An exempt file's
  // slow tests are expected, so they are counted on one plain line per file
  // rather than raised on every green run.
  const slow = timings.filter((t) => t.ms > budgetMs)
    .sort((a, b) => b.ms - a.ms);
  const warnings = slow.filter((t) => !exempt.has(t.file)).map((t) =>
    `WARNING: slow unit test (${seconds(t.ms)} > ${budget}): ` +
    `${t.file} — ${t.name}`
  );
  const exemptCounts = new Map<string, number>();
  for (const t of slow.filter((t) => exempt.has(t.file))) {
    exemptCounts.set(t.file, (exemptCounts.get(t.file) ?? 0) + 1);
  }
  const exemptNotes = [...exemptCounts].sort(([a], [b]) => a.localeCompare(b))
    .map(([file, count]) =>
      `slow by decision: ${file} — ${count} test(s) over ${budget}`
    );

  const byFile = new Map<string, TestTiming[]>();
  for (const t of timings) {
    byFile.set(t.file, [...(byFile.get(t.file) ?? []), t]);
  }
  const slowFiles = [...byFile]
    .filter(([file, tests]) =>
      !exempt.has(file) && tests.every((t) => t.ms > budgetMs)
    )
    .map(([file]) => file)
    .sort();
  const everyTestOver = (file: string): string => {
    const tests = byFile.get(file)!;
    const total = tests.reduce((sum, t) => sum + t.ms, 0);
    return `every test in ${file} (${tests.length}, ${seconds(total)}) ` +
      `is over the ${budget} unit-test budget`;
  };
  if (options.gitGuardShim) {
    const unenforced = slowFiles.map((file) =>
      `NOT ENFORCED: ${everyTestOver(file)} — the git guard shim is on PATH ` +
      `and adds ~200 ms of Deno start-up to every message-carrying git ` +
      `call; CI and the worker's own gate enforce this (Issue #2669)`
    );
    return { warnings, exemptNotes, failedFiles: [], failures: [], unenforced };
  }
  const failures = slowFiles.map((file) =>
    `FAIL: ${everyTestOver(file)} — find what the mocks miss and ` +
    `make it fast, or list the file in INTEGRATION_TEST_FILES or ` +
    `SLOW_UNIT_TEST_KEEP_FILES with a reason (Issue #2642)`
  );
  return {
    warnings,
    exemptNotes,
    failedFiles: slowFiles,
    failures,
    unenforced: [],
  };
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

/** {@link unitTestTimeBudget} over the reports of the green passes given. */
export async function passesTimeBudget(
  junitPaths: readonly string[],
  options: TimeBudgetOptions & {
    readText?: (path: string) => Promise<string>;
  } = {},
): Promise<TimeBudgetReport> {
  const timings: TestTiming[] = [];
  for (const path of junitPaths) {
    timings.push(...await readPassTimings(path, options.readText));
  }
  return unitTestTimeBudget(timings, options);
}

/** Bytes read from a candidate `git` — the shim's header is in its first lines. */
const SHIM_HEAD_BYTES = 512;

/**
 * The first bytes of the regular file at `path`, or `undefined` when there is
 * no such file. Any other error — a permission fault, say — is thrown.
 */
export async function readFileHead(path: string): Promise<string | undefined> {
  let file: Deno.FsFile;
  try {
    file = await Deno.open(path, { read: true });
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
  try {
    if (!(await file.stat()).isFile) return undefined;
    const buffer = new Uint8Array(SHIM_HEAD_BYTES);
    const read = await file.read(buffer);
    return new TextDecoder().decode(buffer.subarray(0, read ?? 0));
  } finally {
    file.close();
  }
}

/**
 * Whether the `git` this process would run is the agent's git guard shim
 * (Issue #2669).
 *
 * The first `git` on `pathVar` — pass `Deno.env.get("PATH")` — decides, as
 * it does for the shell. Reading
 * `PATH` only detects the shim; it never removes it — editing `PATH` to skip
 * the guard is the bypass the shim's own documentation forbids.
 */
export async function gitGuardShimOnPath(
  pathVar: string | undefined,
  readHead: (path: string) => Promise<string | undefined> = readFileHead,
): Promise<boolean> {
  for (const dir of (pathVar ?? "").split(":")) {
    if (dir === "") continue;
    const head = await readHead(`${dir}/git`);
    if (head !== undefined) return head.includes(GIT_GUARD_SHIM_MARKER);
  }
  return false;
}
