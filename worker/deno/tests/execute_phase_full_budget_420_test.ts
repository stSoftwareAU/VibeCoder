/**
 * An issue claim keeps its full execute budget (Issue #420, parent #397).
 *
 * These tests were the #4297 regime tests: a claim taken late in the cycle
 * used to reach the runner with a truncated timeout and **no** extension
 * option. That truncation killed demonstrably-progressing runs mid-task
 * (GRQ#4398), so the cycle deadline now stops *new* claims only — a claim
 * already in flight gets `claudeTimeout` in full and may extend whenever the
 * operator enabled extensions.
 *
 * They still assert on the wiring rather than a pure function: what the runner
 * is actually handed, plus the run-start deadline the shutdown drain reads.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { workOnIssueExecuteClaude } from "../lib/phases/execute_phase.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import { runInSlotContext } from "../lib/slot_context.ts";
import type { RunDeadlineState } from "../lib/run_deadline.ts";
import type { WorkerConfig } from "../types.ts";

/** Config with the progress-extension feature switched on. */
function extensionConfig(): WorkerConfig {
  return {
    ...buildDefaultWorkerConfig(),
    progressExtensionEnabled: true,
    progressExtensionGrantSeconds: 900,
    progressExtensionStallSeconds: 300,
    progressExtensionCheckSeconds: 300,
  };
}

function issueState(): PhaseState {
  return {
    branchName: "issue-7-budget",
    baseBranch: "main",
    defaultBranch: "main",
    repoPath: "/tmp/test-repo",
    clarityStatus: "assessed_clear",
    claudeOutput: "",
    executeStartTime: Date.now(),
    baselineQualityPassed: true,
    baselineQualityOutput: "",
  };
}

/**
 * Run the execute phase inside a slot and report what the runner was handed,
 * what was logged, and every deadline published to the slot.
 */
async function runPhase(
  config: WorkerConfig,
  cycleDeadlineEpochMs?: number,
): Promise<{
  runnerOptions: Record<string, unknown>;
  lines: string[];
  deadlines: RunDeadlineState[];
}> {
  const ctx: IssueContext = {
    repo: "org/repo",
    issueNumber: 7,
    issueTitle: "Budget",
    issueBody: "Do the thing.",
    issueLabels: [],
    issueComments: "",
    githubUser: "testbot",
    config,
    ...(cycleDeadlineEpochMs !== undefined ? { cycleDeadlineEpochMs } : {}),
  };
  const seen: Array<Record<string, unknown>> = [];
  const lines: string[] = [];
  const deps = createMockDeps({
    logger: { info: (m: string) => lines.push(m) },
    claude: {
      runClaudeWithRetry: ((options: Record<string, unknown>) => {
        seen.push(options);
        return Promise.resolve({
          ok: true,
          value: { output: "done", exitCode: 0, timedOut: false },
        });
      }) as never,
    },
    pr: {
      findExistingPrForIssue: (() =>
        Promise.resolve({ ok: true, value: null })) as never,
    },
  });

  const deadlines: RunDeadlineState[] = [];
  await runInSlotContext(
    {
      slotId: "s1",
      repo: "org/repo",
      issueNumber: 7,
      onRunDeadline: (state) => deadlines.push(state),
    },
    () => workOnIssueExecuteClaude(ctx, issueState(), deps),
  );

  assert(seen.length >= 1, "the runner must be invoked");
  return { runnerOptions: seen[0]!, lines, deadlines };
}

Deno.test("execute_phase - a claim taken with 16 minutes of cycle runway still gets the full configured budget (Issue #420)", async () => {
  const config = extensionConfig();
  // The GRQ#4398 shape: 16 minutes of cycle left against a one-hour budget.
  // The old truncation handed the runner ~990s; the claim now keeps its hour.
  const { runnerOptions } = await runPhase(config, Date.now() + 960_000);

  assertEquals(
    runnerOptions.timeoutSeconds,
    config.claudeTimeout,
    "a claim taken before the deadline must keep its whole execute budget",
  );
});

Deno.test("execute_phase - a claim taken late in the cycle is still offered progress extensions (Issue #420)", async () => {
  const config = extensionConfig();
  const { runnerOptions } = await runPhase(config, Date.now() + 960_000);

  assert(
    runnerOptions.progressExtension !== undefined,
    "with the truncation regime gone, the config flag is the only gate left",
  );
});

Deno.test("execute_phase - extensions stay off when the operator did not enable them (Issue #420)", async () => {
  const config = buildDefaultWorkerConfig();
  assertEquals(
    config.progressExtensionEnabled,
    false,
    "this test asserts the disabled default, so it must be disabled",
  );
  const { runnerOptions } = await runPhase(config, Date.now() + 960_000);

  assertEquals(runnerOptions.progressExtension, undefined);
  assertEquals(runnerOptions.timeoutSeconds, config.claudeTimeout);
});

Deno.test("execute_phase - the run-start log names the budget and whether extensions are on (Issue #420)", async () => {
  const withExtensions = await runPhase(
    extensionConfig(),
    Date.now() + 960_000,
  );
  const enabledLine = withExtensions.lines.find((l) =>
    l.includes("Execute budget")
  );
  assert(
    enabledLine !== undefined,
    `no budget line logged: ${withExtensions.lines.join("\n")}`,
  );
  assert(
    enabledLine.includes("3600s"),
    `the budget an operator reads must be the full one: ${enabledLine}`,
  );
  assert(
    enabledLine.includes("progress extensions on"),
    `the line must say extensions are on: ${enabledLine}`,
  );
  // The retired #4297 regime must not be reported any more — a permanently
  // "extension-eligible" sentence is noise an operator would learn to skip.
  assertEquals(
    withExtensions.lines.some((l) => l.includes("Execute timeout regime")),
    false,
  );

  const withoutExtensions = await runPhase(
    buildDefaultWorkerConfig(),
    Date.now() + 960_000,
  );
  const disabledLine = withoutExtensions.lines.find((l) =>
    l.includes("Execute budget")
  );
  assert(disabledLine !== undefined, "no budget line logged");
  assert(
    disabledLine.includes("progress extensions off"),
    `the line must say extensions are off: ${disabledLine}`,
  );
});

Deno.test("execute_phase - the run publishes its full-budget deadline to the slot, deadline or not (Issue #420)", async () => {
  const config = extensionConfig();

  const before = Date.now();
  const noDeadline = await runPhase(config);
  assertEquals(noDeadline.deadlines.length, 1);
  assertEquals(noDeadline.deadlines[0]!.extensionsGranted, 0);
  assert(
    noDeadline.deadlines[0]!.deadlineMs >= before + config.claudeTimeout * 1000,
    "the reported deadline must be the run's whole budget",
  );

  const lateBefore = Date.now();
  const late = await runPhase(config, Date.now() + 960_000);
  assertEquals(late.deadlines.length, 1);
  assert(
    late.deadlines[0]!.deadlineMs >= lateBefore + config.claudeTimeout * 1000,
    "a claim taken late reports the same whole budget, not a shortened one",
  );
});
