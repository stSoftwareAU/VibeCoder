/** Finish releases preserve recovery work without charging an issue failure. */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { planCodingFailure } from "../lib/coding_failure_ladder.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type {
  IssueContext,
  PhaseResult,
  PhaseState,
} from "../lib/issue_worker_types.ts";
import { workOnIssueQualityGate } from "../lib/phases/quality_gate_remediation_phase.ts";
import { recoverFromSecurityGateBlock } from "../lib/security_fix_gate_retry.ts";
import { recoverFromSummaryRuleBlock } from "../lib/summary_rule_gate_retry.ts";
import { recoverFromScreenshotGateBlock } from "../lib/screenshot_gate_retry.ts";
import {
  readSecurityFixGateBlock,
  resolveSecurityGateStateDir,
} from "../lib/security_fix_gate_feedback.ts";
import type { GitHubClient } from "../types.ts";

for (
  const recovery of [
    "quality",
    "quality-with-bump",
    "security",
    "summary",
    "screenshot",
  ]
) {
  Deno.test(`${recovery} recovery - finish deadline preserves WIP and skips further gates`, async () => {
    const root = await Deno.makeTempDir();
    try {
      const config = buildDefaultWorkerConfig();
      config.workDir = `${root}/work`;
      config.infraRetryBackoffMs = 0;
      const ctx: IssueContext = {
        repo: "acme/widgets",
        issueNumber: 4245,
        issueTitle: "Finish deadline",
        issueBody: "",
        issueLabels: [],
        issueComments: "",
        githubUser: "testbot",
        config,
      };
      const state: PhaseState = {
        branchName: "issue-4245",
        baseBranch: "main",
        defaultBranch: "main",
        repoPath: root,
        clarityStatus: "not_assessed",
        claudeOutput: "implementation complete",
        executeStartTime: Date.now() - 600_000,
        baselineQualityPassed: true,
        baselineQualityOutput: "",
        baselineFailedChecks: [],
        securityGateBlocks: [{
          missing: ["test-file-changed"],
          declarations: [],
          discrimination: null,
        }],
        summaryRuleBlocks: [{
          reason: "summary incomplete",
          comment: "Complete the evidence.",
        }],
        screenshotGateBlock: { failureMessage: "Capture screenshot evidence." },
        ...(recovery === "quality-with-bump"
          ? {
            bumpInfo: {
              status: "applied" as const,
              files: ["deno.lock"],
              output: "bumped",
            },
          }
          : {}),
      };
      let agentCalls = 0;
      let qualityRuns = 0;
      let pushes = 0;
      let completionRuns = 0;
      let failureCalls = 0;
      const comments: string[] = [];
      const deps = createMockDeps({
        claude: {
          runClaudeWithRetry: () => {
            agentCalls++;
            return Promise.resolve({
              ok: true as const,
              value: {
                exitCode: 124,
                output: "partial recovery",
                timedOut: true,
                timeoutReason: "hard-timeout" as const,
                finishDeadline: true,
              },
            });
          },
        },
        quality: {
          collectDiffableGateFindings: () => Promise.resolve([]),
          runQualityGate: () => {
            qualityRuns++;
            return Promise.resolve({
              ok: true as const,
              value: {
                checks: [{ name: "deno test", status: "FAILED" as const }],
                summary: { text: "failed", passed: false },
                passed: false,
                output: "deno test failed",
              },
            });
          },
        },
        git: {
          runGitCommand: (args) => {
            if (args[0] === "revert") {
              throw new Error("a scheduled release must not audit a bump");
            }
            const stdout = args[0] === "status"
              ? " M fix.ts\n"
              : args[0] === "rev-parse"
              ? `${state.branchName}\n`
              : "";
            return Promise.resolve({
              ok: true as const,
              value: { code: 0, stdout, stderr: "" },
            });
          },
          commitAndPushPending: (branch) => {
            assertEquals(branch, state.branchName);
            pushes++;
            return Promise.resolve({
              ok: true as const,
              value: {
                committedNewChanges: true,
                commitsPushed: 1,
                finalUnpushedCount: 0,
                finalUnpushedSource: "remote-head" as const,
              },
            });
          },
        },
        github: {
          handleIssueFailure: () => {
            failureCalls++;
            throw new Error("the finish deadline must not charge failed-once");
          },
          createClient: () =>
            ({
              postComment: (_repo: string, _issue: number, body: string) => {
                comments.push(body);
                return Promise.resolve(undefined);
              },
            }) as unknown as GitHubClient,
        },
      });
      const rerun = (): Promise<PhaseResult> => {
        completionRuns++;
        return Promise.resolve({
          status: "failure",
          category: "quality_check",
          reason: "still blocked",
        });
      };
      const result = recovery.startsWith("quality")
        ? await workOnIssueQualityGate(ctx, state, deps)
        : recovery === "security"
        ? await recoverFromSecurityGateBlock(ctx, state, deps, rerun)
        : recovery === "summary"
        ? await recoverFromSummaryRuleBlock(ctx, state, deps, {
          status: "failure",
          category: "summary_incomplete",
          reason: "summary incomplete",
        }, rerun)
        : await recoverFromScreenshotGateBlock(ctx, state, deps, rerun);
      assert(result.status === "failure");
      assertEquals(result.category, "scheduled_release");
      assertStringIncludes(result.reason, "finish deadline");
      assertEquals(agentCalls, 1);
      assertEquals(qualityRuns, recovery.startsWith("quality") ? 1 : 0);
      assertEquals(completionRuns, 0);
      assertEquals(failureCalls, 0);
      assertEquals(comments, []);
      assertEquals(pushes, 1);
      assertEquals(state.preservedWip?.branch, state.branchName);
      assertEquals(state.failureLadderApplied, undefined);
      assertEquals(
        planCodingFailure({
          success: false,
          expectedSkip: false,
          category: result.category,
          reason: result.reason,
        }).applyLadder,
        false,
      );
      if (recovery === "security") {
        const stored = await readSecurityFixGateBlock(
          resolveSecurityGateStateDir(config.workDir),
          ctx.repo,
          ctx.issueNumber,
        );
        assertEquals(stored?.blockCount, 0);
      }
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
}
