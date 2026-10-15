/**
 * Unit tests for the in-run security-fix gate recovery builders (Issue #1575).
 *
 * The orchestration is covered end to end by
 * `completion_phase_security_gate_retry_test.ts`; these cover the pure text the
 * agent and the operator actually read, including the error path.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  buildBlockedRunsEscalation,
  buildSecurityFixGateBlockComment,
  buildSecurityFixGateRetryPrompt,
  MAX_CONSECUTIVE_BLOCKED_RUNS,
  recoverFromSecurityGateBlock,
  shouldEscalateBlockedRuns,
} from "../lib/security_fix_gate_retry.ts";
import type { SecurityFixGateBlock } from "../lib/security_fix_gate_feedback.ts";
import { SECURITY_FIX_GATE_MARKER } from "../lib/failure_diagnosis.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { GitHubClient } from "../types.ts";

const BLOCK: SecurityFixGateBlock = {
  repo: "stSoftwareAU/VibeCoder",
  issueNumber: 1385,
  missing: ["test-identifier-in-diff", "trigger-closed"],
  blockedAt: "2026-09-08T00:00:00.000Z",
  blockCount: 0,
  declarations: [
    "Deno.test(",
    '"handle_no_changes_phase - withholds the close",',
  ],
};

Deno.test("gate retry - the prompt replays the verdict and forbids new work", () => {
  const prompt = buildSecurityFixGateRetryPrompt(BLOCK);

  assertStringIncludes(prompt, "stSoftwareAU/VibeCoder#1385");
  assertStringIncludes(prompt, "SECURITY-FIX GATE RETRY NOTICE");
  assertStringIncludes(prompt, "ACTUAL TEST IDENTIFIER");
  // The declarations the gate matched, so a false block is recognisable.
  assertStringIncludes(prompt, "handle_no_changes_phase - withholds the close");
  assertStringIncludes(prompt, "do not start new work");
  assertStringIncludes(
    prompt,
    "docs/archive/pr-summaries/pr-summary-1385.md",
  );
});

Deno.test("gate retry - one verdict renders the ordinary block message", () => {
  const comment = buildSecurityFixGateBlockComment([
    { missing: ["trigger-closed"], declarations: [], discrimination: null },
  ]);

  assertStringIncludes(comment, "PR creation blocked");
  assertStringIncludes(comment, "ORIGINAL TRIGGER");
  assertEquals(comment.includes("Earlier verdicts in this run"), false);
});

Deno.test("gate retry - two verdicts ride in one comment", () => {
  const comment = buildSecurityFixGateBlockComment([
    { missing: ["test-file-changed"], declarations: [], discrimination: null },
    { missing: ["trigger-closed"], declarations: [], discrimination: null },
  ]);

  assertStringIncludes(comment, "ORIGINAL TRIGGER");
  assertStringIncludes(comment, "Earlier verdicts in this run");
  assertStringIncludes(comment, "Attempt 1: test-file-changed");
});

Deno.test("gate retry - a comment with no verdict fails loud", () => {
  assertThrows(
    () => buildSecurityFixGateBlockComment([]),
    Error,
    "at least one verdict",
  );
});

Deno.test("gate retry - the hand-off fires only at the blocked-run cap", () => {
  assertEquals(shouldEscalateBlockedRuns(0), false);
  assertEquals(
    shouldEscalateBlockedRuns(MAX_CONSECUTIVE_BLOCKED_RUNS - 1),
    false,
  );
  assertEquals(shouldEscalateBlockedRuns(MAX_CONSECUTIVE_BLOCKED_RUNS), true);
  assertEquals(
    shouldEscalateBlockedRuns(MAX_CONSECUTIVE_BLOCKED_RUNS + 1),
    true,
  );
});

Deno.test("gate retry - the escalation quotes the verdict and names the gate", () => {
  const escalation = buildBlockedRunsEscalation({ ...BLOCK, blockCount: 2 });

  assertStringIncludes(escalation.reason, "2 consecutive runs");
  assertStringIncludes(escalation.reason, "test-identifier-in-diff");
  assertStringIncludes(escalation.nextStep, "security_fix_gate.ts");
});

/**
 * Drive {@link recoverFromSecurityGateBlock} directly over two recorded
 * verdicts. `launchFails` makes the retry invocation fail; otherwise the
 * re-run completion attempt fails again (a second block).
 */
async function recover(launchFails: boolean) {
  const root = await Deno.makeTempDir();
  try {
    const config = buildDefaultWorkerConfig();
    config.workDir = `${root}/work`;
    const ctx: IssueContext = {
      repo: BLOCK.repo,
      issueNumber: BLOCK.issueNumber,
      issueTitle: "Security fix",
      issueBody: "",
      issueLabels: ["security", "work-on"],
      issueComments: "",
      githubUser: "testbot",
      config,
    };
    const state: PhaseState = {
      branchName: "issue-1385-gate",
      baseBranch: "main",
      defaultBranch: "main",
      repoPath: root,
      clarityStatus: "not_assessed",
      claudeOutput: "",
      executeStartTime: 0,
      baselineQualityPassed: true,
      baselineQualityOutput: "",
      securityGateBlocks: [
        {
          missing: ["test-file-changed"],
          declarations: [],
          discrimination: null,
        },
        { missing: ["trigger-closed"], declarations: [], discrimination: null },
      ],
    };
    const deps = createMockDeps({
      github: {
        createClient: () =>
          ({
            postComment: () => Promise.resolve(undefined),
            addLabel: () => Promise.resolve(),
            removeLabel: () => Promise.resolve(),
            getIssueComments: () => Promise.resolve([]),
          }) as unknown as GitHubClient,
      },
      claude: {
        runClaudeWithRetry: () =>
          Promise.resolve(
            launchFails
              ? { ok: false as const, error: new Error("rate limited") }
              : {
                ok: true as const,
                value: { exitCode: 0, output: "done", timedOut: false },
              },
          ),
      },
      quality: {
        runQualityGate: () =>
          Promise.resolve({
            ok: true as const,
            value: {
              checks: [],
              summary: { text: "All checks passed", passed: true },
              passed: true,
              output: "",
            },
          }),
      },
    });
    return await recoverFromSecurityGateBlock(
      ctx,
      state,
      deps,
      () => Promise.resolve({ status: "failure", reason: "blocked again" }),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test("gate retry - a second block ends the run in failure with the gate marker (Issue #3454)", async () => {
  const result = await recover(false);

  assertEquals(result.status, "failure");
  const reason = result.status === "failure" ? result.reason : "";
  assertEquals(reason.startsWith(`${SECURITY_FIX_GATE_MARKER}: `), true);
  assertStringIncludes(reason, "Attempt 1: test-file-changed");
});

Deno.test("gate retry - a retry that cannot be launched ends the run in failure, unmarked (Issue #3454)", async () => {
  const result = await recover(true);

  assertEquals(result.status, "failure");
  const reason = result.status === "failure" ? result.reason : "";
  assertEquals(reason.startsWith(SECURITY_FIX_GATE_MARKER), false);
  assertStringIncludes(reason, "could not be launched (rate limited)");
});
