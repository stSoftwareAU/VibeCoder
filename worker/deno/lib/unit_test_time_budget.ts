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
import { SUBPROCESS_TIMING_TEST_FILES } from "./parallel_unsafe_test_manifest.ts";

/** The per-test budget: a unit test over this is reported. */
export const UNIT_TEST_BUDGET_MS = 1000;

/**
 * The files already over the budget when it was introduced (Issue #2642).
 *
 * A ratchet, not an endorsement. The budget exists to catch a *new* slow
 * unit file at PR time; failing every run's gate on the files that were
 * already slow would teach everyone to ignore it. Measured on 2026-09-26
 * over the full parallel pass (24,219 tests, 1,652 files, 7 cores,
 * `DENO_JOBS` unset):
 *
 * - {@link OVER_BUDGET_AT_BASELINE} — every test over one second. Nearly
 *   all build real git repositories in a temp directory and drive `git`
 *   through them; the rest spawn `deno` or walk the whole tree.
 * - {@link NEAR_BUDGET_AT_BASELINE} — the fastest test between 0.4 s and
 *   one second, so parallel load alone could tip the file over and fail an
 *   unrelated change.
 *
 * Remove an entry when its file is made fast; never add one to let a new
 * slow file through — that is what {@link SLOW_UNIT_TEST_KEEP_FILES}'s
 * reasoned entries are for.
 */
export const OVER_BUDGET_AT_BASELINE: readonly string[] = [
  "tests/commit_and_push_pending_test.ts",
  "tests/container_build_probe_paths_test.ts",
  "tests/git_branch_sync_test.ts",
  "tests/git_pull_checkout_error_test.ts",
  "tests/git_pull_conflict_test.ts",
  "tests/git_pull_lane_isolation_test.ts",
  "tests/git_pull_remote_head_test.ts",
  "tests/git_push_preflight_test.ts",
  "tests/git_push_recovery_diagnostics_test.ts",
  "tests/git_push_single_branch_clone_test.ts",
  "tests/git_push_single_branch_test.ts",
  "tests/git_unpushed_test.ts",
  "tests/issue_worker_base_fetch_test.ts",
  "tests/milestone_branch_selfheal_test.ts",
  "tests/milestone_branch_worktree_block_test.ts",
  "tests/milestone_conflict_ladder_test.ts",
  "tests/milestone_gate_repair_test.ts",
  "tests/milestone_presync_git_test.ts",
  "tests/milestone_sync_agent_commit_test.ts",
  "tests/milestone_sync_agent_judgement_test.ts",
  "tests/milestone_sync_already_synced_test.ts",
  "tests/milestone_sync_conflict_resolution_test.ts",
  "tests/milestone_sync_dirty_clone_test.ts",
  "tests/milestone_sync_gate_repair_test.ts",
  "tests/milestone_sync_merge_gate_test.ts",
  "tests/parallel_safety_cap_test.ts",
  "tests/push_moved_head_test.ts",
  "tests/quality_gate_bump_audit_history_test.ts",
];

/** See {@link OVER_BUDGET_AT_BASELINE}. */
export const NEAR_BUDGET_AT_BASELINE: readonly string[] = [
  "tests/agents_md_pointer_anchors_test.ts",
  "tests/audit_journal_concurrency_test.ts",
  "tests/claude_runner_oom_terminal_test.ts",
  "tests/git_issue_branch_resume_test.ts",
  "tests/git_ref_args_integration_test.ts",
  "tests/git_repo_validation_test.ts",
  "tests/hidden_files_safety_integration_test.ts",
  "tests/host_workdir_guard_test.ts",
  "tests/milestone_branch_ensure_test.ts",
  "tests/quality_gate_docs_consistency_test.ts",
];

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
  ...[...OVER_BUDGET_AT_BASELINE, ...NEAR_BUDGET_AT_BASELINE].map((
    file,
  ): [string, string] => [
    file,
    "over or near the budget when it was introduced — see " +
    "OVER_BUDGET_AT_BASELINE (Issue #2642)",
  ]),
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
  return { warnings, exemptNotes, failedFiles, failures };
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
