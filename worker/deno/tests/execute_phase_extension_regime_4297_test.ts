/**
 * The execute phase applies the deadline / progress-extension rule
 * (Issue #4297, part of #4290).
 *
 * The rule itself is a pure function (`resolveExtensionRegime`), but the
 * regression that matters is the wiring: a claim taken late in the cycle must
 * reach the runner with **no** extension option, or #4254 is undone and one
 * busy-looking run stretches the cycle again. These tests assert on what the
 * runner is actually handed, plus the run-start deadline the shutdown drain
 * reads.
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
    branchName: "issue-7-regime",
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
    issueTitle: "Regime",
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

Deno.test("execute_phase - a deadline-bound claim reaches the runner with no progress extension, and the regime is logged (Issue #4297)", async () => {
  const config = extensionConfig();
  // Ten minutes of cycle left against a one-hour budget: #4254 binds.
  const { runnerOptions, lines } = await runPhase(
    config,
    Date.now() + 600_000,
  );

  assertEquals(
    runnerOptions.progressExtension,
    undefined,
    "a deadline-bound run must not be offered extensions — #4254 would be undone",
  );
  const timeout = runnerOptions.timeoutSeconds as number;
  assert(
    timeout < config.claudeTimeout,
    `the timeout must still be bound by the deadline, got ${timeout}s`,
  );
  const regimeLine = lines.find((l) => l.includes("Execute timeout regime"));
  assert(
    regimeLine !== undefined,
    `no regime line logged: ${lines.join("\n")}`,
  );
  assert(
    regimeLine.includes("deadline-bound"),
    `the regime must be named: ${regimeLine}`,
  );
});

Deno.test("execute_phase - an extension-eligible claim reaches the runner with the extension option (Issue #4297)", async () => {
  const config = extensionConfig();
  // No cycle deadline at all — the configured budget binds.
  const { runnerOptions, lines } = await runPhase(config);

  assert(
    runnerOptions.progressExtension !== undefined,
    "an extension-eligible run must carry the option",
  );
  assertEquals(runnerOptions.timeoutSeconds, config.claudeTimeout);
  const regimeLine = lines.find((l) => l.includes("Execute timeout regime"));
  assert(regimeLine !== undefined, "no regime line logged");
  assert(
    regimeLine.includes("extension-eligible"),
    `the regime must be named: ${regimeLine}`,
  );
});

Deno.test("execute_phase - the run publishes its starting deadline to the slot, in both regimes (Issue #4297)", async () => {
  const config = extensionConfig();
  const before = Date.now();
  const eligible = await runPhase(config);
  assertEquals(eligible.deadlines.length, 1);
  assertEquals(eligible.deadlines[0]!.extensionsGranted, 0);
  assert(
    eligible.deadlines[0]!.deadlineMs >= before + config.claudeTimeout * 1000,
    "the reported deadline must be the run's whole budget",
  );

  const bound = await runPhase(config, Date.now() + 600_000);
  assertEquals(bound.deadlines.length, 1);
  assert(
    bound.deadlines[0]!.deadlineMs < Date.now() + config.claudeTimeout * 1000,
    "a deadline-bound run must report its shortened deadline",
  );
});
