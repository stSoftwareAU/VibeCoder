/**
 * Integration tests for the security-fix patch-verification gate running in
 * the LIVE completion phase (Issue #3939).
 *
 * The gate (Issue #3540, hardened by #3652) had exactly one caller, in the
 * legacy `pr_completion_phase.ts` module that the bash→Deno migration orphaned,
 * so it never executed in production: every `security`-labelled PR reached
 * `gh pr create` unchecked. These tests drive `workOnIssueCompletion` — the
 * path `issue_worker.ts` actually runs — and assert on the observable outcome
 * (whether `gh pr create` was invoked), not on how the gate is called.
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
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type { GitHubClient, Result, WorkerConfig } from "../types.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";

const SHA = "1f0c2b3a4d5e6f708192a3b4c5d6e7f8091a2b3c";

/** A PR summary that satisfies the gate's prose half and cites a real test. */
const COMPLIANT_SUMMARY = `## Summary

Fixed the injection flaw. Closes #3939.

## Test Plan

- Added \`worker/deno/tests/injection_test.ts::rejects_injection\`, a regression
  test that reproduces the flaw: it fails against the unfixed code and passes
  after the fix.
- The original attack input is now rejected by the allowlist, so the original
  trigger is closed with no trivial bypass.
`;

/** The same summary with every scrap of verification evidence removed. */
const BARE_SUMMARY = `## Summary

Fixed the injection flaw. Closes #3939.
`;

/** Diff body for a test file that genuinely adds the cited test. */
const TEST_DIFF =
  `diff --git a/worker/deno/tests/injection_test.ts b/worker/deno/tests/injection_test.ts
--- a/worker/deno/tests/injection_test.ts
+++ b/worker/deno/tests/injection_test.ts
@@ -0,0 +1,3 @@
+Deno.test("rejects_injection", () => {
+  assertEquals(sanitise("'; DROP TABLE"), "");
+});
`;

function stubClient(comments: string[]): GitHubClient {
  return {
    getIssue: () => {
      throw new Error("stub");
    },
    getIssueComments: () => Promise.resolve([]),
    addLabel: () => Promise.resolve(),
    removeLabel: () => Promise.resolve(),
    postComment: (_repo: string, _issue: number, body: string) => {
      comments.push(body);
      return Promise.resolve(undefined);
    },
    editIssue: () => Promise.resolve(),
    assignIssue: () => Promise.resolve(),
    unassignIssue: () => Promise.resolve(),
    closeIssue: () => Promise.resolve(),
  };
}

async function makeRepo(summary: string): Promise<string> {
  const root = await Deno.makeTempDir();
  await Deno.mkdir(`${root}/docs/archive/pr-summaries`, { recursive: true });
  await Deno.writeTextFile(
    `${root}/docs/archive/pr-summaries/pr-summary-3939.md`,
    summary,
  );
  return root;
}

interface Scenario {
  /** Files the branch diff reports as changed. */
  changedFiles: string[];
  /** PR summary written to the repo. */
  summary: string;
  /** Issue labels for the run. */
  labels: string[];
  /** Optional worker-config mutation (e.g. the skip repo config). */
  configure?: (config: WorkerConfig) => void;
}

interface Outcome {
  status: string;
  reason?: string;
  prCreateCalls: number;
  comments: string[];
}

/** Run the live completion phase against a scenario and report what happened. */
async function runCompletion(scenario: Scenario): Promise<Outcome> {
  const repoPath = await makeRepo(scenario.summary);
  const comments: string[] = [];
  let prCreateCalls = 0;

  const config = buildDefaultWorkerConfig();
  scenario.configure?.(config);

  const ctx: IssueContext = {
    repo: "stSoftwareAU/VibeCoder",
    issueNumber: 3939,
    issueTitle: "Security-fix gate never runs",
    issueBody: "",
    issueLabels: scenario.labels,
    issueComments: "",
    githubUser: "testbot",
    config,
  };
  const state: PhaseState = {
    branchName: "issue-3939-gate",
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
      createClient: () => stubClient(comments),
      runGhCommand: (args: string[]) => {
        if (args[0] === "pr" && args[1] === "create") prCreateCalls++;
        return Promise.resolve(
          "https://github.com/stSoftwareAU/VibeCoder/pull/99",
        );
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
          // The gate tries `origin/main...HEAD` first; a worker clone that has
          // no origin ref falls back to the local range, so only answer the
          // local one to exercise that fallback.
          if (cmdArgs[2]?.startsWith("origin/")) {
            return Promise.resolve({
              ok: true as const,
              value: { code: 128, stdout: "", stderr: "bad revision" },
            });
          }
          return ok(scenario.changedFiles.join("\n"));
        }
        if (cmdArgs[0] === "diff") return ok(TEST_DIFF);
        return ok("");
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
    prCreateCalls,
    comments,
  };
}

Deno.test(
  "completion - blocks PR creation for a security issue with no test in the diff",
  async () => {
    const outcome = await runCompletion({
      labels: ["security", "work-on"],
      summary: BARE_SUMMARY,
      changedFiles: ["worker/deno/lib/sanitise.ts"],
    });

    assertEquals(outcome.status, "failure");
    assertEquals(outcome.prCreateCalls, 0, "gh pr create must not run");
    assertStringIncludes(outcome.reason ?? "", "PR creation blocked");
    assertStringIncludes(outcome.reason ?? "", "TEST FILE");
    // The operator-facing remediation reaches the issue, so the retry is
    // productive rather than a silent re-run.
    assertEquals(outcome.comments.length, 1);
    assertStringIncludes(outcome.comments[0]!, "PR creation blocked");
  },
);

Deno.test(
  "completion - blocks when a test changed but the summary cites no matching test",
  async () => {
    const outcome = await runCompletion({
      labels: ["security"],
      summary: BARE_SUMMARY,
      changedFiles: [
        "worker/deno/lib/sanitise.ts",
        "worker/deno/tests/injection_test.ts",
      ],
    });

    assertEquals(outcome.status, "failure");
    assertEquals(outcome.prCreateCalls, 0);
    assertStringIncludes(outcome.reason ?? "", "TEST IDENTIFIER");
  },
);

Deno.test(
  "completion - allows a security PR that carries the full verification evidence",
  async () => {
    const outcome = await runCompletion({
      labels: ["security", "work-on"],
      summary: COMPLIANT_SUMMARY,
      changedFiles: [
        "worker/deno/lib/sanitise.ts",
        "worker/deno/tests/injection_test.ts",
      ],
    });

    assertEquals(outcome.status, "continue");
    assertEquals(outcome.prCreateCalls, 1);
  },
);

Deno.test(
  "completion - non-security issue is untouched by the gate",
  async () => {
    const outcome = await runCompletion({
      labels: ["enhancement", "work-on"],
      summary: BARE_SUMMARY,
      changedFiles: ["worker/deno/lib/sanitise.ts"],
    });

    assertEquals(outcome.status, "continue");
    assertEquals(outcome.prCreateCalls, 1);
  },
);

// --- Gate feedback carried into the next attempt (Issue #4057) -------------

const GATE_REPO = "stSoftwareAU/VibeCoder";

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
  "completion - a gate block records its missing items in run state (Issue #4057)",
  async () => {
    await withWorkDir(async (workDir, stateDir) => {
      const outcome = await runCompletion({
        labels: ["security", "work-on"],
        summary: BARE_SUMMARY,
        changedFiles: [
          "worker/deno/lib/sanitise.ts",
          "worker/deno/tests/injection_test.ts",
        ],
        configure: (config) => {
          config.workDir = workDir;
        },
      });
      assertEquals(outcome.status, "failure");

      // The next attempt reads the verdict from run state, not from the
      // service-account comment its trust filter discards.
      const block = await readSecurityFixGateBlock(stateDir, GATE_REPO, 3939);
      assertEquals(block?.missing, [
        "test-identifier-in-diff",
        "regression-test",
        "trigger-closed",
      ]);
      assertEquals(block?.blockCount, 1);
    });
  },
);

Deno.test(
  "completion - a passing gate clears the recorded verdict (Issue #4057)",
  async () => {
    await withWorkDir(async (workDir, stateDir) => {
      await recordSecurityFixGateBlock(stateDir, GATE_REPO, 3939, [
        "trigger-closed",
      ]);

      const outcome = await runCompletion({
        labels: ["security", "work-on"],
        summary: COMPLIANT_SUMMARY,
        changedFiles: [
          "worker/deno/lib/sanitise.ts",
          "worker/deno/tests/injection_test.ts",
        ],
        configure: (config) => {
          config.workDir = workDir;
        },
      });

      assertEquals(outcome.status, "continue");
      assertEquals(outcome.prCreateCalls, 1);
      assertEquals(
        await readSecurityFixGateBlock(stateDir, GATE_REPO, 3939),
        undefined,
        "a stale verdict must not steer the next unrelated run",
      );
    });
  },
);

Deno.test(
  "completion - an unpersistable verdict still blocks the PR (Issue #4057)",
  async () => {
    // No workDir configured, so the store is the unconfigured sentinel: the
    // record throws, and the gate must still block rather than sail through.
    const outcome = await runCompletion({
      labels: ["security", "work-on"],
      summary: BARE_SUMMARY,
      changedFiles: ["worker/deno/lib/sanitise.ts"],
    });

    assertEquals(outcome.status, "failure");
    assertEquals(outcome.prCreateCalls, 0);
  },
);

Deno.test(
  "completion - skip_security_fix_check repo config opts the repo out",
  async () => {
    const outcome = await runCompletion({
      labels: ["security"],
      summary: BARE_SUMMARY,
      changedFiles: ["worker/deno/lib/sanitise.ts"],
      configure: (config) => {
        config.repoConfig = {
          "stSoftwareAU/VibeCoder": { skipSecurityFixCheck: true },
        };
      },
    });

    assertEquals(outcome.status, "continue");
    assertEquals(outcome.prCreateCalls, 1);
  },
);
