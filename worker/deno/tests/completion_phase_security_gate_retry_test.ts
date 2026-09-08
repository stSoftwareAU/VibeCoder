/**
 * In-run recovery from a security-fix gate block (Issue #1575).
 *
 * A block used to end the run: three of #1385's four attempts were false blocks
 * on a correct branch, roughly USD 10.50 and 28 minutes for nothing. These
 * tests drive the LIVE completion phase and assert on the observable outcome —
 * how many agent invocations the block caused, whether `gh pr create` ran, what
 * the issue was told, and what the verdict store now holds.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { workOnIssueCompletion } from "../lib/phases/completion_phase.ts";
import {
  readSecurityFixGateBlock,
  recordSecurityFixGateBlock,
  resolveSecurityGateStateDir,
} from "../lib/security_fix_gate_feedback.ts";
import {
  matchedTestDeclarations,
  MAX_REPORTED_TEST_DECLARATIONS,
} from "../lib/security_fix_gate.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type { GitHubClient, Result } from "../types.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";

const SHA = "1f0c2b3a4d5e6f708192a3b4c5d6e7f8091a2b3c";
const REPO = "stSoftwareAU/VibeCoder";
const ISSUE = 3939;

/** A PR summary with no verification evidence at all — the gate blocks it. */
const BARE_SUMMARY = `## Summary

Fixed the injection flaw. Closes #${ISSUE}.
`;

/** The evidence-complete summary an agent writes once told what is missing. */
const COMPLIANT_SUMMARY = `## Summary

Fixed the injection flaw. Closes #${ISSUE}.

## Test Plan

- Added \`worker/deno/tests/injection_test.ts::rejects_injection\`, a regression
  test that reproduces the flaw: it fails against the unfixed code and passes
  after the fix.
- The original attack input is now rejected by the allowlist, so the original
  trigger is closed with no trivial bypass.
`;

/**
 * The branch diff — a wrapped `Deno.test(` declaration, exactly the shape that
 * produced #1385's false blocks.
 */
const TEST_DIFF =
  `diff --git a/worker/deno/tests/injection_test.ts b/worker/deno/tests/injection_test.ts
--- a/worker/deno/tests/injection_test.ts
+++ b/worker/deno/tests/injection_test.ts
@@ -0,0 +1,5 @@
+Deno.test(
+  "rejects_injection",
+  () => {
+    assertEquals(sanitise("'; DROP TABLE"), "");
+  },
+);
`;

interface Recorded {
  comments: string[];
  labels: string[];
}

function stubClient(recorded: Recorded): GitHubClient {
  return {
    getIssue: () => {
      throw new Error("stub");
    },
    getIssueComments: () => Promise.resolve([]),
    addLabel: (_repo: string, _issue: number, label: string) => {
      recorded.labels.push(label);
      return Promise.resolve();
    },
    removeLabel: () => Promise.resolve(),
    postComment: (_repo: string, _issue: number, body: string) => {
      recorded.comments.push(body);
      return Promise.resolve(undefined);
    },
    editIssue: () => Promise.resolve(),
    assignIssue: () => Promise.resolve(),
    unassignIssue: () => Promise.resolve(),
    closeIssue: () => Promise.resolve(),
  };
}

function summaryPath(repoPath: string): string {
  return `${repoPath}/docs/archive/pr-summaries/pr-summary-${ISSUE}.md`;
}

interface Scenario {
  /** Summary on the branch when the completion phase starts. */
  summary: string;
  /** Summary the retry invocation writes; omitted, the agent changes nothing. */
  retryWrites?: string;
  /** Work directory backing the verdict store. */
  workDir: string;
  /** Make the retry invocation itself fail (a rate limit, a spawn failure). */
  retryInvocationFails?: boolean;
}

interface Outcome {
  status: string;
  reason?: string;
  claudeCalls: number;
  claudePrompts: string[];
  qualityGateRuns: number;
  prCreateCalls: number;
  comments: string[];
  labels: string[];
}

/** Drive the live completion phase over a blocked security fix. */
async function runCompletion(scenario: Scenario): Promise<Outcome> {
  const repoPath = await Deno.makeTempDir();
  await Deno.mkdir(`${repoPath}/docs/archive/pr-summaries`, {
    recursive: true,
  });
  await Deno.writeTextFile(summaryPath(repoPath), scenario.summary);

  const recorded: Recorded = { comments: [], labels: [] };
  let prCreateCalls = 0;
  let claudeCalls = 0;
  let qualityGateRuns = 0;
  const claudePrompts: string[] = [];

  const config = buildDefaultWorkerConfig();
  config.workDir = scenario.workDir;

  const ctx: IssueContext = {
    repo: REPO,
    issueNumber: ISSUE,
    issueTitle: "Security fix",
    issueBody: "",
    issueLabels: ["security", "work-on"],
    issueComments: "",
    githubUser: "testbot",
    config,
  };
  const state: PhaseState = {
    branchName: `issue-${ISSUE}-gate`,
    baseBranch: "main",
    defaultBranch: "main",
    repoPath,
    clarityStatus: "not_assessed",
    claudeOutput: "",
    executeStartTime: 0,
    baselineQualityPassed: true,
    baselineQualityOutput: "",
  };

  const deps = createMockDeps({
    github: {
      createClient: () => stubClient(recorded),
      runGhCommand: (args: string[]) => {
        if (args[0] === "pr" && args[1] === "create") prCreateCalls++;
        return Promise.resolve(`https://github.com/${REPO}/pull/99`);
      },
    },
    git: {
      runGitCommand: (
        cmdArgs: string[],
      ): Promise<Result<{ code: number; stdout: string; stderr: string }>> => {
        const ok = (stdout: string) =>
          Promise.resolve({
            ok: true as const,
            value: { code: 0, stdout, stderr: "" },
          });
        if (cmdArgs[0] === "rev-parse") return ok(`${SHA}\n`);
        if (cmdArgs[0] === "diff" && cmdArgs[1] === "--name-only") {
          return ok(
            [
              "worker/deno/lib/sanitise.ts",
              "worker/deno/tests/injection_test.ts",
            ]
              .join("\n"),
          );
        }
        if (cmdArgs[0] === "diff") return ok(TEST_DIFF);
        return ok("");
      },
    },
    claude: {
      runClaudeWithRetry: (options: { prompt: string }) => {
        claudeCalls++;
        claudePrompts.push(options.prompt);
        if (scenario.retryInvocationFails) {
          return Promise.resolve({
            ok: false as const,
            error: new Error("rate limited"),
          });
        }
        if (scenario.retryWrites !== undefined) {
          Deno.writeTextFileSync(summaryPath(repoPath), scenario.retryWrites);
        }
        return Promise.resolve({
          ok: true as const,
          value: { exitCode: 0, output: "done", timedOut: false },
        });
      },
    },
    quality: {
      runQualityGate: () => {
        qualityGateRuns++;
        return Promise.resolve({
          ok: true as const,
          value: {
            checks: [],
            summary: { text: "All checks passed", passed: true },
            passed: true,
            output: "",
          },
        });
      },
    },
    pr: {
      findExistingPrForIssue: () =>
        Promise.resolve({ ok: false, error: new Error("none") }),
      findExistingPrForBranch: () =>
        Promise.resolve({ ok: false, error: new Error("none") }),
    },
  });

  const result = await workOnIssueCompletion(ctx, state, deps);
  await Deno.remove(repoPath, { recursive: true });

  return {
    status: result.status,
    reason: result.status === "failure" ? result.reason : undefined,
    claudeCalls,
    claudePrompts,
    qualityGateRuns,
    prCreateCalls,
    comments: recorded.comments,
    labels: recorded.labels,
  };
}

/** Run a body against a temporary workDir, cleaning up afterwards. */
async function withWorkDir(
  body: (workDir: string, stateDir: string) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir();
  const workDir = `${root}/work`;
  try {
    await body(workDir, resolveSecurityGateStateDir(workDir));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test(
  "completion - a first gate block re-invokes the agent once and the PR is raised",
  async () => {
    await withWorkDir(async (workDir, stateDir) => {
      const outcome = await runCompletion({
        summary: BARE_SUMMARY,
        retryWrites: COMPLIANT_SUMMARY,
        workDir,
      });

      assertEquals(outcome.status, "continue");
      assertEquals(outcome.claudeCalls, 1, "exactly one re-invocation");
      assertEquals(outcome.qualityGateRuns, 1, "the quality gate re-runs");
      assertEquals(outcome.prCreateCalls, 1, "the recovered run raises its PR");
      assertEquals(
        outcome.comments.length,
        0,
        "a recovered block posts no block comment",
      );
      assertEquals(
        await readSecurityFixGateBlock(stateDir, REPO, ISSUE),
        undefined,
        "a recovered block leaves no verdict behind",
      );
    });
  },
);

Deno.test(
  "completion - the retry prompt replays the verdict the gate recorded",
  async () => {
    await withWorkDir(async (workDir) => {
      const outcome = await runCompletion({
        summary: BARE_SUMMARY,
        retryWrites: COMPLIANT_SUMMARY,
        workDir,
      });

      assertEquals(outcome.claudePrompts.length, 1);
      const prompt = outcome.claudePrompts[0]!;
      assertStringIncludes(prompt, "SECURITY-FIX GATE RETRY NOTICE");
      assertStringIncludes(prompt, "ACTUAL TEST IDENTIFIER");
      // The declarations the gate matched, so a false block is recognisable.
      assertStringIncludes(prompt, `"rejects_injection"`);
    });
  },
);

Deno.test(
  "completion - a second block in the same run ends the run with one comment",
  async () => {
    await withWorkDir(async (workDir, stateDir) => {
      const outcome = await runCompletion({
        summary: BARE_SUMMARY,
        workDir,
      });

      assertEquals(outcome.status, "failure");
      assertEquals(outcome.claudeCalls, 1, "the retry is not repeated");
      assertEquals(outcome.prCreateCalls, 0);
      assertEquals(
        outcome.comments.length,
        1,
        "one comment carries both verdicts",
      );
      assertStringIncludes(outcome.comments[0]!, "PR creation blocked");
      assertStringIncludes(
        outcome.comments[0]!,
        "Earlier verdicts in this run",
      );
      // The in-run block charges no run; only the run-ending one counts.
      const block = await readSecurityFixGateBlock(stateDir, REPO, ISSUE);
      assertEquals(block?.blockCount, 1);
    });
  },
);

Deno.test(
  "completion - the block comment lists the declarations the gate matched",
  async () => {
    await withWorkDir(async (workDir) => {
      const outcome = await runCompletion({
        summary: BARE_SUMMARY,
        workDir,
      });

      const comment = outcome.comments[0]!;
      assertStringIncludes(comment, "The gate matched these test declarations");
      assertStringIncludes(comment, `"rejects_injection"`);
    });
  },
);

Deno.test(
  "completion - the second consecutive blocked run hands the issue to a human",
  async () => {
    await withWorkDir(async (workDir, stateDir) => {
      // One blocked run already on record for this issue.
      await recordSecurityFixGateBlock(stateDir, REPO, ISSUE, [
        "test-identifier-in-diff",
      ]);

      const outcome = await runCompletion({
        summary: BARE_SUMMARY,
        workDir,
      });

      assertEquals(outcome.status, "failure");
      assertEquals(
        (await readSecurityFixGateBlock(stateDir, REPO, ISSUE))?.blockCount,
        2,
      );
      assertEquals(outcome.labels.includes("needs-human"), true);
      const escalation = outcome.comments.find((body) =>
        body.includes("Needs human attention") ||
        body.includes("blocked this issue twice")
      );
      assertStringIncludes(escalation ?? "", "consecutive runs");
      assertStringIncludes(escalation ?? "", "test-identifier-in-diff");
    });
  },
);

Deno.test(
  "matchedTestDeclarations - reports wrapped declarations and caps the list",
  () => {
    // Both the opener and the name `deno fmt` wrapped onto the next line —
    // the shape that produced #1385's false blocks.
    assertEquals(matchedTestDeclarations(TEST_DIFF), [
      "Deno.test(",
      `"rejects_injection",`,
    ]);

    const many = Array.from(
      { length: MAX_REPORTED_TEST_DECLARATIONS + 5 },
      (_, i) => `+Deno.test("case number ${i}", () => {});`,
    ).join("\n");
    assertEquals(
      matchedTestDeclarations(many).length,
      MAX_REPORTED_TEST_DECLARATIONS,
    );
  },
);

Deno.test(
  "completion - a retry that cannot be launched charges no blocked run",
  async () => {
    await withWorkDir(async (workDir, stateDir) => {
      const outcome = await runCompletion({
        summary: BARE_SUMMARY,
        workDir,
        retryInvocationFails: true,
      });

      assertEquals(outcome.status, "failure");
      assertEquals(outcome.prCreateCalls, 0);
      assertStringIncludes(
        outcome.reason ?? "",
        "The in-run gate retry could not be launched",
      );
      // The issue still hears the verdict, but a CLI failure is not a gate
      // verdict, so it must not consume the hand-off budget.
      assertEquals(outcome.comments.length, 1);
      assertEquals(outcome.labels.includes("needs-human"), false);
      assertEquals(
        (await readSecurityFixGateBlock(stateDir, REPO, ISSUE))?.blockCount,
        0,
      );
    });
  },
);
