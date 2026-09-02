/**
 * The timeout kill must explain itself (Issue #768, part of #764).
 *
 * A run killed at its deadline used to leave nothing durable saying whether
 * the progress extension was consulted, how many grants it made, or which
 * signal it judged stalled — diagnosing #732's kill needed a dig through
 * `claude_runner.ts`. The telemetry existed; the operator-facing artefacts
 * stopped short of it.
 *
 * These tests pin the two artefacts a human actually reads:
 *
 * - the watchdog kill log at `fireHardTimeout`, and
 * - the timeout release comment (`getFailureDiagnosis*` →
 *   `renderRunOutcomeClause`),
 *
 * each naming the base timeout, the deadline armed at kill time, the elapsed
 * seconds, the extensions granted, and why the last check was refused. Zero
 * grants is its own finding and must read differently from a run that was
 * extended and still ran out. With the feature off every message keeps its
 * pre-existing wording, byte for byte.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { runClaudeWithTimeout } from "../lib/claude_runner.ts";
import type { TreeProgressState } from "../lib/progress_extension.ts";
import {
  buildExtensionTelemetry,
  type ExtensionTelemetry,
  formatTimeoutExtensionSummary,
} from "../lib/timeout_extension_telemetry.ts";
import {
  getFailureDiagnosis,
  getFailureDiagnosisOneliner,
} from "../lib/failure_diagnosis.ts";
import { buildDiagnosticContext } from "../lib/execute_claude_phase.ts";
import { deriveRunOutcome } from "../lib/run_outcome.ts";
import { renderRunOutcomeClause } from "../lib/heartbeat_storage.ts";
import { workOnIssueExecuteClaude } from "../lib/phases/execute_phase.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import type { Logger } from "../types.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A 3600 s budget extended four times, then refused on a stalled tree. */
function extendedRun(): ExtensionTelemetry {
  return buildExtensionTelemetry({
    baseTimeoutSeconds: 3600,
    startMs: 1_000_000,
    deadlineMs: 1_000_000 + 5_640_000,
    nowMs: 1_000_000 + 5_645_000,
    granted: 4,
    refusalReason: "working tree unchanged despite tool activity 31s ago",
  });
}

/** The #732 shape: the very first check refused, so nothing was granted. */
function refusedRun(): ExtensionTelemetry {
  return buildExtensionTelemetry({
    baseTimeoutSeconds: 3600,
    startMs: 0,
    deadlineMs: 3_600_000,
    nowMs: 3_601_000,
    granted: 0,
    refusalReason: "no tool activity recorded in the last 900s",
  });
}

/** Every figure the issue requires an artefact to name. */
function assertNamesTheFigures(
  text: string,
  expected: { base: number; armed: number; elapsed: number },
): void {
  assertStringIncludes(text, `${expected.base}s`);
  assertStringIncludes(text, `${expected.armed}s`);
  assertStringIncludes(text, `${expected.elapsed}s`);
}

// ---------------------------------------------------------------------------
// The shared sentence
// ---------------------------------------------------------------------------

Deno.test("formatTimeoutExtensionSummary - names every figure of an extended run (Issue #768)", () => {
  const summary = formatTimeoutExtensionSummary(extendedRun());
  assertNamesTheFigures(summary, { base: 3600, armed: 5640, elapsed: 5645 });
  assertStringIncludes(summary, "base timeout 3600s");
  assertStringIncludes(summary, "deadline armed at kill 5640s");
  assertStringIncludes(summary, "elapsed 5645s");
  assertStringIncludes(summary, "4 extensions granted");
  assertStringIncludes(
    summary,
    "last check refused because working tree unchanged despite tool activity 31s ago",
  );
});

Deno.test("formatTimeoutExtensionSummary - zero grants is its own finding (Issue #768)", () => {
  const summary = formatTimeoutExtensionSummary(refusedRun());
  assertStringIncludes(summary, "no extensions granted");
  assertStringIncludes(
    summary,
    "last check refused because no tool activity recorded in the last 900s",
  );
  assert(
    !summary.includes("extensions granted ("),
    `a refused run must not read as if it were extended: ${summary}`,
  );
  // Distinguishable from the extended run, which is the whole point.
  assert(
    summary !== formatTimeoutExtensionSummary(extendedRun()),
    "the zero-grant and extended sentences must differ",
  );
});

Deno.test("formatTimeoutExtensionSummary - a run never refused says so rather than falling silent (Issue #768)", () => {
  const summary = formatTimeoutExtensionSummary(
    buildExtensionTelemetry({
      baseTimeoutSeconds: 3600,
      startMs: 0,
      deadlineMs: 3_600_000,
      nowMs: 1_800_000,
      granted: 0,
    }),
  );
  assertStringIncludes(summary, "no extensions granted");
  assertStringIncludes(summary, "no extension check was refused");
});

// ---------------------------------------------------------------------------
// The release comment
// ---------------------------------------------------------------------------

Deno.test("getFailureDiagnosis - the timeout diagnosis carries the extension telemetry (Issue #768)", () => {
  const diagnosis = getFailureDiagnosis(
    "timeout",
    "assessed_clear",
    "",
    extendedRun(),
  );
  assertStringIncludes(diagnosis, "ran out of time");
  assertNamesTheFigures(diagnosis, { base: 3600, armed: 5640, elapsed: 5645 });
  assertStringIncludes(diagnosis, "4 extensions granted");
  assertStringIncludes(diagnosis, "working tree unchanged");
});

Deno.test("getFailureDiagnosis - a kill after zero grants reports the refusal (Issue #768)", () => {
  const diagnosis = getFailureDiagnosis(
    "timeout",
    "not_assessed",
    "",
    refusedRun(),
  );
  assertStringIncludes(diagnosis, "no extensions granted");
  assertStringIncludes(diagnosis, "no tool activity recorded in the last 900s");
});

Deno.test("getFailureDiagnosis - the extension telemetry also arrives via the diagnostic context (Issue #768)", () => {
  const context = buildDiagnosticContext({
    clarityStatus: "assessed_clear",
    elapsedSeconds: 5645,
    claudeNoOutputTimeout: 600,
    claudeTimeout: 3600,
    extensions: extendedRun(),
  });
  const diagnosis = getFailureDiagnosis("timeout", "assessed_clear", context);
  assertStringIncludes(diagnosis, "deadline armed at kill 5640s");
  assertStringIncludes(diagnosis, "4 extensions granted");
  assertStringIncludes(diagnosis, "working tree unchanged");
});

Deno.test("getFailureDiagnosis - the extension off keeps the pre-existing wording (Issue #768)", () => {
  assertEquals(
    getFailureDiagnosis("timeout"),
    `- Claude ran out of time before completing the task
- The task may need to be broken into smaller pieces
- Consider simplifying the issue scope or splitting it into sub-issues`,
  );
});

Deno.test("getFailureDiagnosisOneliner - the timeout one-liner carries the telemetry (Issue #768)", () => {
  const extended = getFailureDiagnosisOneliner(
    "timeout",
    "not_assessed",
    "",
    extendedRun(),
  );
  assertStringIncludes(extended, "Likely cause: Claude ran out of time.");
  assertNamesTheFigures(extended, { base: 3600, armed: 5640, elapsed: 5645 });
  assertStringIncludes(extended, "4 extensions granted");

  const refused = getFailureDiagnosisOneliner(
    "timeout",
    "not_assessed",
    "",
    refusedRun(),
  );
  assertStringIncludes(refused, "no extensions granted");
  assertStringIncludes(refused, "no tool activity recorded");
});

Deno.test("getFailureDiagnosisOneliner - the extension off keeps the pre-existing wording (Issue #768)", () => {
  assertEquals(
    getFailureDiagnosisOneliner("timeout"),
    "Likely cause: Claude ran out of time.",
  );
});

Deno.test("renderRunOutcomeClause - the timeout release comment names the grants and the refusal (Issue #768)", () => {
  const outcome = deriveRunOutcome({
    success: false,
    phase: "execute",
    reason: "Claude timed out with its work preserved on the branch",
    elapsedSeconds: 5645,
    extensions: extendedRun(),
  });
  assert(outcome.kind === "no_pr");
  assertEquals(outcome.category, "timeout");

  const clause = renderRunOutcomeClause(outcome);
  assertStringIncludes(clause, "no PR raised — `timeout`");
  assertNamesTheFigures(clause, { base: 3600, armed: 5640, elapsed: 5645 });
  assertStringIncludes(clause, "4 extensions granted");
  assertStringIncludes(clause, "working tree unchanged");
});

Deno.test("renderRunOutcomeClause - a zero-grant kill is not mistaken for an ineligible run (Issue #768)", () => {
  const outcome = deriveRunOutcome({
    success: false,
    phase: "execute",
    reason: "Claude timed out without creating changes",
    elapsedSeconds: 3601,
    extensions: refusedRun(),
  });
  const clause = renderRunOutcomeClause(outcome);
  assertStringIncludes(clause, "no extensions granted");
  assertStringIncludes(clause, "last check refused because");
  assertStringIncludes(clause, "no tool activity recorded");
});

Deno.test("renderRunOutcomeClause - with the extension off the clause is unchanged (Issue #768)", () => {
  const outcome = deriveRunOutcome({
    success: false,
    phase: "execute",
    reason: "Claude timed out without creating changes",
    elapsedSeconds: 3601,
  });
  const clause = renderRunOutcomeClause(outcome);
  assertStringIncludes(clause, "Likely cause: Claude ran out of time.");
  assert(
    !clause.includes("Progress extension"),
    `a run without telemetry must say nothing about extensions: ${clause}`,
  );
});

// ---------------------------------------------------------------------------
// The execute phase carries the telemetry to the release site
// ---------------------------------------------------------------------------

function makeState(): PhaseState {
  return {
    branchName: "issue-768-telemetry",
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

/** Drive the execute phase with a runner result and return the state it left. */
async function runTimedOutPhase(
  extensions?: ExtensionTelemetry,
): Promise<{ state: PhaseState; reason: string }> {
  const deps = createMockDeps({
    claude: {
      runClaudeWithRetry: (() =>
        Promise.resolve({
          ok: true,
          value: {
            output: "Still reading the codebase",
            exitCode: 124,
            rawExitCode: 143,
            timedOut: true,
            timeoutReason: "hard-timeout",
            ...(extensions ? { extensions } : {}),
          },
        })) as never,
    },
    pr: {
      findExistingPrForIssue: (() =>
        Promise.resolve({ ok: true, value: null })) as never,
    },
  });
  const config = buildDefaultWorkerConfig();
  const ctx: IssueContext = {
    repo: "org/repo",
    issueNumber: 768,
    issueTitle: "A run killed at its deadline",
    issueBody: "Do the thing.",
    issueLabels: [],
    issueComments: "",
    githubUser: "testbot",
    config,
  };
  const state = makeState();
  const result = await workOnIssueExecuteClaude(ctx, state, deps) as {
    status: string;
    reason?: string;
  };
  assertEquals(result.status, "failure");
  return { state, reason: result.reason ?? "" };
}

Deno.test("execute_phase - a timed-out run hands its extension telemetry to the release comment (Issue #768)", async () => {
  const { state, reason } = await runTimedOutPhase(extendedRun());
  assertEquals(state.extensionTelemetry?.granted, 4);

  // The same derivation workOnIssue performs at the release site.
  const clause = renderRunOutcomeClause(deriveRunOutcome({
    success: false,
    phase: "execute",
    reason,
    elapsedSeconds: 5645,
    ...(state.extensionTelemetry
      ? { extensions: state.extensionTelemetry }
      : {}),
  }));
  assertStringIncludes(clause, "4 extensions granted");
  assertStringIncludes(clause, "working tree unchanged");
});

Deno.test("execute_phase - with the extension off no telemetry is recorded (Issue #768)", async () => {
  const { state } = await runTimedOutPhase();
  assertEquals(state.extensionTelemetry, undefined);
});

// ---------------------------------------------------------------------------
// The watchdog kill log
// ---------------------------------------------------------------------------

/** One stream-json line carrying a tool call, so the activity signal moves. */
const TOOL_LINE =
  `{"type":"assistant","message":{"content":[{"type":"tool_use",` +
  `"name":"Edit","input":{"file_path":"worker/deno/lib/x.ts"}}]}}`;

/** Install a stub `claude` on PATH; see the #4298 suite for the rationale. */
async function installStub(
  body: string,
): Promise<{ restore: () => Promise<void> }> {
  const dir = await Deno.makeTempDir({ prefix: "timeout_report_768_" });
  const stubPath = `${dir}/claude`;
  await Deno.writeTextFile(stubPath, `#!/usr/bin/env bash\n${body}`);
  await Deno.chmod(stubPath, 0o755);
  const originalPath = Deno.env.get("PATH") ?? "";
  Deno.env.set("PATH", `${dir}:${originalPath}`);
  return {
    restore: async () => {
      Deno.env.set("PATH", originalPath);
      await Deno.remove(dir, { recursive: true }).catch(() => undefined);
    },
  };
}

/** A stub that emits a tool call every `gapSeconds` for `count` iterations. */
function chattyStub(count: number, gapSeconds: string): string {
  return `for i in $(seq 1 ${count}); do\n` +
    `  printf '%s\\n' '${TOOL_LINE}'\n` +
    `  sleep ${gapSeconds}\n` +
    `done\n` +
    `printf '%s\\n' '{"type":"result","result":"done"}'\n`;
}

/** Collect log lines so the kill message can be asserted on. */
function recordingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const logger = {
    info: (m: string) => lines.push(m),
    warn: (m: string) => lines.push(m),
    error: (m: string) => lines.push(m),
  } as unknown as Logger;
  return { logger, lines };
}

Deno.test({
  name:
    "runClaudeWithTimeout - a kill after zero grants logs the armed deadline and the refusal (Issue #768)",
  fn: async () => {
    // The first check refuses, so nothing is granted and the deadline never
    // moves — the #732 shape, which must still be readable off the log.
    const stub = await installStub(chattyStub(120, "0.1"));
    const { logger, lines } = recordingLogger();
    const probe = (): Promise<TreeProgressState> =>
      Promise.resolve("unchanged");
    try {
      const result = await runClaudeWithTimeout({
        prompt: "test",
        timeoutSeconds: 1,
        killAfterSeconds: 1,
        logger,
        progressExtension: {
          policy: { enabled: true, grantSeconds: 1, activityStallSeconds: 60 },
          treeProbe: probe,
        },
      });
      assert(result.ok, "the runner must return a result");
      if (!result.ok) return;
      assertEquals(result.value.extensions?.granted, 0);

      const kill = lines.find((l) => l.startsWith("Claude timed out after"));
      assert(kill, `a kill line must be logged, got: ${JSON.stringify(lines)}`);
      assertStringIncludes(kill, "base budget 1s");
      assertStringIncludes(kill, "no extension granted");
      assertStringIncludes(kill, "deadline unchanged at 1s");
      assertStringIncludes(kill, "last extension refused:");
      assertStringIncludes(kill, "working tree unchanged");
    } finally {
      await stub.restore();
    }
  },
});
