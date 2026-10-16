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

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { workOnIssueCompletion } from "../lib/phases/completion_phase.ts";
import {
  readSecurityFixGateBlock,
  recordSecurityFixGateBlock,
  resolveSecurityGateStateDir,
} from "../lib/security_fix_gate_feedback.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type { GitHubClient, Result, WorkerConfig } from "../types.ts";
import {
  DEFAULT_DISCRIMINATION_BUDGET_SECONDS,
  type DiscriminationRunInput,
  type SecurityFixDiscrimination,
} from "../lib/security_fix_discrimination.ts";
import type { SecurityGateRunVerdict } from "../lib/security_fix_gate_retry.ts";
import type {
  SecurityFixGateAnswers,
  SecurityFixVerification,
} from "../lib/security_fix_verdict.ts";
import type { SecurityFixVerifierInput } from "../lib/security_fix_verifier.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";

/** The cited test, declared in TEST_DIFF and named by COMPLIANT_SUMMARY. */
const CITED_TEST = {
  file: "worker/deno/tests/injection_test.ts",
  name: "rejects_injection",
};

/** A red-to-green record: the cited test fails on the base and passes after. */
const RED_GREEN: SecurityFixDiscrimination = {
  kind: "checked",
  test: CITED_TEST,
  preFix: "fail",
  postFix: "pass",
};

/** Where every scripted gate cites: a line of the fix at the head. */
const FIX_CITATION = "worker/deno/lib/sanitise.ts:1";

const FIXED_GATES: SecurityFixGateAnswers = {
  sink_mitigated: {
    status: "pass",
    citation: FIX_CITATION,
    rationale: "the sink only sees allowlisted input",
  },
  reachability: {
    status: "pass",
    citation: FIX_CITATION,
    rationale: "the trigger passes the allowlist first",
  },
  class_eliminated: {
    status: "pass",
    citation: FIX_CITATION,
    rationale: "every injection payload is refused, not one literal",
  },
  sweep_complete: {
    status: "pass",
    citation: FIX_CITATION,
    rationale: "no other query builds SQL from input",
  },
};

/** The independent verifier's FIXED verdict (Issue #3657). */
const FIXED: SecurityFixVerification = {
  kind: "checked",
  verdict: "FIXED",
  gates: FIXED_GATES,
};

/** The sink still concatenates input, so the trigger stays open (Issue #3657). */
const NOT_FIXED: SecurityFixVerification = {
  kind: "checked",
  verdict: "NOT_FIXED",
  gates: {
    ...FIXED_GATES,
    sink_mitigated: {
      status: "fail",
      citation: FIX_CITATION,
      rationale: "the sink still concatenates the input",
    },
  },
};

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

**Docs sweep** — grep: \`sanitise\`; section: \`docs/SECURITY.md#input-sanitisation\`; no hits; siblings: none — no existing set gained a member

**Branch outcomes:** none added
`;

/** The same summary with every scrap of verification evidence removed. */
const BARE_SUMMARY = `## Summary

Fixed the injection flaw. Closes #3939.

**Docs sweep** — grep: \`sanitise\`; section: \`docs/SECURITY.md#input-sanitisation\`; no hits; siblings: none — no existing set gained a member

## Test Plan

- Manual check that the fix compiles.
**Branch outcomes:** none added
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
  /**
   * Stub for the red-to-green runner (Issue #3659). Omitted means the runner
   * is not wired, which the gate must block on rather than pass unchecked.
   */
  discrimination?: SecurityFixDiscrimination;
  /** Make the stub throw this message instead of returning. */
  discriminationThrows?: string;
  /** Make `rev-parse` and `fetch` fail so the base ref cannot be resolved. */
  baseRefUnresolvable?: boolean;
  /** The issue body the run is given (the security finding). */
  issueBody?: string;
  /**
   * Stub for the independent security-fix verifier (Issue #3657). Omitted
   * means the verifier is not wired, which the gate must block on.
   */
  verification?: SecurityFixVerification;
  /** Make the verifier stub throw this message instead of returning. */
  verifierThrows?: string;
  /** Make every `diff --name-only` fail so no branch diff is collected. */
  diffUnavailable?: boolean;
}

interface Outcome {
  status: string;
  reason?: string;
  prCreateCalls: number;
  comments: string[];
  /** Every input the discrimination runner was called with. */
  discriminationInputs: DiscriminationRunInput[];
  /** The repo path the run used. */
  repoPath: string;
  /** The verdicts the gate recorded on run state. */
  securityGateBlocks: SecurityGateRunVerdict[];
  /** Every input the independent verifier was called with (Issue #3657). */
  verifierInputs: SecurityFixVerifierInput[];
  /** Every info and warn line the run logged, with its context. */
  logs: LoggedLine[];
}

/** One info or warn line the run logged. */
interface LoggedLine {
  level: "info" | "warn";
  message: string;
  context?: Record<string, unknown>;
}

/** Run the live completion phase against a scenario and report what happened. */
async function runCompletion(scenario: Scenario): Promise<Outcome> {
  const repoPath = await makeRepo(scenario.summary);
  const comments: string[] = [];
  let prCreateCalls = 0;
  const discriminationInputs: DiscriminationRunInput[] = [];
  const verifierInputs: SecurityFixVerifierInput[] = [];
  const logs: LoggedLine[] = [];

  const config = buildDefaultWorkerConfig();
  scenario.configure?.(config);

  const ctx: IssueContext = {
    repo: "stSoftwareAU/VibeCoder",
    issueNumber: 3939,
    issueTitle: "Security-fix gate never runs",
    issueBody: scenario.issueBody ?? "",
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

  const stub = scenario.discrimination;
  const throws = scenario.discriminationThrows;
  const deps = createMockDeps({
    logger: {
      info: (message, context) =>
        logs.push({ level: "info", message, context }),
      warn: (message, context) =>
        logs.push({ level: "warn", message, context }),
    },
    quality: stub || throws
      ? {
        runSecurityFixDiscrimination: (input: DiscriminationRunInput) => {
          discriminationInputs.push(input);
          if (throws) return Promise.reject(new Error(throws));
          return Promise.resolve(stub!);
        },
      }
      : {},
    claude: scenario.verification || scenario.verifierThrows
      ? {
        runSecurityFixVerifier: (input: SecurityFixVerifierInput) => {
          verifierInputs.push(input);
          if (scenario.verifierThrows) {
            return Promise.reject(new Error(scenario.verifierThrows));
          }
          return Promise.resolve({ verification: scenario.verification! });
        },
      }
      : {},
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
        const fails = () =>
          Promise.resolve({
            ok: true as const,
            value: { code: 128, stdout: "", stderr: "bad revision" },
          });
        if (
          scenario.baseRefUnresolvable &&
          (cmdArgs[0] === "rev-parse" || cmdArgs[0] === "fetch")
        ) return fails();
        if (cmdArgs[0] === "rev-parse") return ok(`${SHA}\n`);
        if (cmdArgs[0] === "diff" && cmdArgs[1] === "--name-only") {
          if (scenario.diffUnavailable) return fails();
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
    discriminationInputs,
    repoPath,
    securityGateBlocks: state.securityGateBlocks ?? [],
    verifierInputs,
    logs,
  };
}

/** The lines the completion phase logged about the security-fix verifier. */
function verifierLogs(outcome: Outcome): LoggedLine[] {
  return outcome.logs.filter((line) =>
    line.message.startsWith("Security-fix verifier")
  );
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
      verification: FIXED,
      labels: ["security", "work-on"],
      summary: COMPLIANT_SUMMARY,
      discrimination: RED_GREEN,
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
        "trigger-closed-not-checked",
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
        verification: FIXED,
        labels: ["security", "work-on"],
        summary: COMPLIANT_SUMMARY,
        discrimination: RED_GREEN,
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

// --- Executed red-to-green discrimination (Issue #3659) ---------------------

const SECURITY_FILES = [
  "worker/deno/lib/sanitise.ts",
  "worker/deno/tests/injection_test.ts",
];

Deno.test(
  "completion - red-to-green discrimination raises the PR and runs only the cited test over production files (Issue #3659)",
  async () => {
    const outcome = await runCompletion({
      verification: FIXED,
      labels: ["security"],
      summary: COMPLIANT_SUMMARY,
      changedFiles: SECURITY_FILES,
      discrimination: RED_GREEN,
    });

    assertEquals(outcome.status, "continue");
    assertEquals(outcome.prCreateCalls, 1);
    assertEquals(outcome.discriminationInputs.length, 1);
    const input = outcome.discriminationInputs[0]!;
    assertEquals(input.productionFiles, ["worker/deno/lib/sanitise.ts"]);
    assertEquals(input.tests, [CITED_TEST]);
    assertEquals(input.baseRef, "origin/main");
    assertEquals(input.repoPath, outcome.repoPath);
    assertEquals(input.budgetSeconds, DEFAULT_DISCRIMINATION_BUDGET_SECONDS);
  },
);

Deno.test(
  "completion - a declared quality credential reaches the discrimination runner (Issue #3659)",
  async () => {
    const outcome = await runCompletion({
      verification: FIXED,
      labels: ["security"],
      summary: COMPLIANT_SUMMARY,
      changedFiles: SECURITY_FILES,
      discrimination: RED_GREEN,
      configure: (config) => {
        config.repoConfig = {
          "stSoftwareAU/VibeCoder": {
            qualityCredentials: { mint: "printf 'DECLARED_KEY=minted\\n'" },
          },
        };
      },
    });

    assertEquals(outcome.status, "continue");
    assertEquals(outcome.discriminationInputs.length, 1);
    assertEquals(outcome.discriminationInputs[0]!.credentialEnv, {
      DECLARED_KEY: "minted",
    });
  },
);

Deno.test(
  "completion - unresolvable quality credentials block without running the cited test (Issue #3659)",
  async () => {
    const outcome = await runCompletion({
      labels: ["security"],
      summary: COMPLIANT_SUMMARY,
      changedFiles: SECURITY_FILES,
      discrimination: RED_GREEN,
      configure: (config) => {
        config.repoConfig = {
          "stSoftwareAU/VibeCoder": { qualityCredentials: { mint: "exit 7" } },
        };
      },
    });

    assertEquals(outcome.status, "failure");
    assertEquals(outcome.prCreateCalls, 0);
    assertEquals(outcome.discriminationInputs.length, 0);
    assertStringIncludes(
      outcome.reason ?? "",
      "quality_credentials could not be resolved",
    );
  },
);

Deno.test(
  "completion - an unresolvable base ref blocks without running the cited test (Issue #3659)",
  async () => {
    const outcome = await runCompletion({
      labels: ["security"],
      summary: COMPLIANT_SUMMARY,
      changedFiles: SECURITY_FILES,
      discrimination: RED_GREEN,
      baseRefUnresolvable: true,
    });

    assertEquals(outcome.status, "failure");
    assertEquals(outcome.prCreateCalls, 0);
    assertEquals(outcome.discriminationInputs.length, 0);
    assertStringIncludes(outcome.reason ?? "", "the base ref is unresolvable");
  },
);

// Each operand of the run condition keeps the runner from executing a test the
// gate does not need a record for.

Deno.test(
  "completion - the runner is not called when the gate is inactive (Issue #3659)",
  async () => {
    const outcome = await runCompletion({
      labels: ["work-on"],
      summary: COMPLIANT_SUMMARY,
      changedFiles: SECURITY_FILES,
      discrimination: RED_GREEN,
    });

    assertEquals(outcome.status, "continue");
    assertEquals(outcome.prCreateCalls, 1);
    assertEquals(outcome.discriminationInputs.length, 0);
  },
);

Deno.test(
  "completion - the runner is not called when no branch diff is collected (Issue #3659)",
  async () => {
    const outcome = await runCompletion({
      labels: ["security"],
      summary: COMPLIANT_SUMMARY,
      changedFiles: SECURITY_FILES,
      discrimination: RED_GREEN,
      diffUnavailable: true,
    });

    assertEquals(outcome.status, "failure");
    assertEquals(outcome.prCreateCalls, 0);
    assertEquals(outcome.discriminationInputs.length, 0);
  },
);

Deno.test(
  "completion - the runner is not called when no test file changed (Issue #3659)",
  async () => {
    const outcome = await runCompletion({
      labels: ["security"],
      summary: COMPLIANT_SUMMARY,
      changedFiles: ["worker/deno/lib/sanitise.ts"],
      discrimination: RED_GREEN,
    });

    assertEquals(outcome.status, "failure");
    assertEquals(outcome.prCreateCalls, 0);
    assertEquals(outcome.discriminationInputs.length, 0);
    assertStringIncludes(outcome.reason ?? "", "TEST FILE");
  },
);

Deno.test(
  "completion - the runner is not called when the cited test is not declared in the diff (Issue #3659)",
  async () => {
    const outcome = await runCompletion({
      labels: ["security"],
      summary: COMPLIANT_SUMMARY.replace("rejects_injection", "rejects_other"),
      changedFiles: SECURITY_FILES,
      discrimination: RED_GREEN,
    });

    assertEquals(outcome.status, "failure");
    assertEquals(outcome.prCreateCalls, 0);
    assertEquals(outcome.discriminationInputs.length, 0);
    assertStringIncludes(outcome.reason ?? "", "TEST IDENTIFIER");
  },
);

Deno.test(
  "completion - green-to-green blocks the PR and names the recorded runs (Issue #3659)",
  async () => {
    const outcome = await runCompletion({
      labels: ["security"],
      summary: COMPLIANT_SUMMARY,
      changedFiles: SECURITY_FILES,
      discrimination: {
        kind: "checked",
        test: CITED_TEST,
        preFix: "pass",
        postFix: "pass",
      },
    });

    assertEquals(outcome.status, "failure");
    assertEquals(outcome.prCreateCalls, 0);
    assertStringIncludes(outcome.reason ?? "", "did not go red then green");
    assertStringIncludes(outcome.reason ?? "", "base production files: pass");
    assertEquals(
      outcome.securityGateBlocks[0]?.discrimination?.kind,
      "checked",
    );
  },
);

Deno.test(
  "completion - red-to-red blocks the PR (Issue #3659)",
  async () => {
    const outcome = await runCompletion({
      labels: ["security"],
      summary: COMPLIANT_SUMMARY,
      changedFiles: SECURITY_FILES,
      discrimination: {
        kind: "checked",
        test: CITED_TEST,
        preFix: "fail",
        postFix: "fail",
      },
    });

    assertEquals(outcome.status, "failure");
    assertEquals(outcome.prCreateCalls, 0);
    assertStringIncludes(outcome.reason ?? "", "did not go red then green");
  },
);

Deno.test(
  "completion - a not_checked record blocks the PR with its reason rendered (Issue #3659)",
  async () => {
    const outcome = await runCompletion({
      labels: ["security"],
      summary: COMPLIANT_SUMMARY,
      changedFiles: SECURITY_FILES,
      discrimination: {
        kind: "not_checked",
        reason: "the sandbox ran out of budget",
      },
    });

    assertEquals(outcome.status, "failure");
    assertEquals(outcome.prCreateCalls, 0);
    assertStringIncludes(outcome.reason ?? "", "the sandbox ran out of budget");
  },
);

Deno.test(
  "completion - an unwired runner blocks rather than passing unchecked (Issue #3659)",
  async () => {
    const outcome = await runCompletion({
      labels: ["security"],
      summary: COMPLIANT_SUMMARY,
      changedFiles: SECURITY_FILES,
    });

    assertEquals(outcome.status, "failure");
    assertEquals(outcome.prCreateCalls, 0);
    assertStringIncludes(outcome.reason ?? "", "not wired");
  },
);

Deno.test(
  "completion - a throwing runner blocks and reports the failure (Issue #3659)",
  async () => {
    const outcome = await runCompletion({
      labels: ["security"],
      summary: COMPLIANT_SUMMARY,
      changedFiles: SECURITY_FILES,
      discriminationThrows: "boom",
    });

    assertEquals(outcome.status, "failure");
    assertEquals(outcome.prCreateCalls, 0);
    assertStringIncludes(
      outcome.reason ?? "",
      "discrimination runner failed: boom",
    );
  },
);

// --- Independent security-fix verifier (Issue #3657) ------------------------

const VERIFIER_LABELS = ["security", "work-on"];

Deno.test(
  "completion - a NOT_FIXED verdict blocks with trigger-closed and shows the verdict (Issue #3657)",
  async () => {
    const outcome = await runCompletion({
      labels: VERIFIER_LABELS,
      summary: COMPLIANT_SUMMARY,
      changedFiles: SECURITY_FILES,
      discrimination: RED_GREEN,
      verification: NOT_FIXED,
    });

    assertEquals(outcome.status, "failure");
    assertEquals(outcome.prCreateCalls, 0, "gh pr create must not run");
    assertEquals(outcome.securityGateBlocks[0]?.missing, ["trigger-closed"]);
    assertStringIncludes(
      outcome.reason ?? "",
      "Independent verifier verdict:",
    );
  },
);

Deno.test(
  "completion - an unwired verifier blocks with trigger-closed-not-checked (Issue #3657)",
  async () => {
    const outcome = await runCompletion({
      labels: VERIFIER_LABELS,
      summary: COMPLIANT_SUMMARY,
      changedFiles: SECURITY_FILES,
      discrimination: RED_GREEN,
    });

    assertEquals(outcome.status, "failure");
    assertEquals(outcome.prCreateCalls, 0);
    assertEquals(outcome.securityGateBlocks[0]?.missing, [
      "trigger-closed-not-checked",
    ]);
    assertStringIncludes(
      outcome.reason ?? "",
      "not checked: the security-fix verifier is not wired",
    );
  },
);

Deno.test(
  "completion - a throwing verifier blocks with trigger-closed-not-checked (Issue #3657)",
  async () => {
    const outcome = await runCompletion({
      labels: VERIFIER_LABELS,
      summary: COMPLIANT_SUMMARY,
      changedFiles: SECURITY_FILES,
      discrimination: RED_GREEN,
      verifierThrows: "boom",
    });

    assertEquals(outcome.status, "failure");
    assertEquals(outcome.prCreateCalls, 0);
    assertEquals(outcome.securityGateBlocks[0]?.missing, [
      "trigger-closed-not-checked",
    ]);
    assertStringIncludes(
      outcome.reason ?? "",
      "security-fix verifier failed: boom",
    );
  },
);

Deno.test(
  "completion - the verifier gets the finding, the title and the repo path, and no PR summary field (Issue #3657)",
  async () => {
    const outcome = await runCompletion({
      labels: VERIFIER_LABELS,
      summary: COMPLIANT_SUMMARY,
      changedFiles: SECURITY_FILES,
      discrimination: RED_GREEN,
      issueBody: "Input is concatenated into the SQL query.",
      verification: FIXED,
    });

    assertEquals(outcome.verifierInputs.length, 1);
    const input = outcome.verifierInputs[0]!;
    assertEquals(
      input.findingBody,
      "Input is concatenated into the SQL query.",
    );
    assertEquals(input.issueTitle, "Security-fix gate never runs");
    assertEquals(input.repo, "stSoftwareAU/VibeCoder");
    assertEquals(input.issueNumber, 3939);
    assertEquals(input.repoPath, outcome.repoPath);
    assertEquals(input.baseRef, "origin/main");
    // The fixer's own account never reaches the verifier.
    assertEquals(Object.keys(input).sort(), [
      "baseRef",
      "findingBody",
      "issueNumber",
      "issueTitle",
      "killAfterSeconds",
      "logger",
      "maxRetries",
      "model",
      "repo",
      "repoPath",
      "timeoutSeconds",
    ]);
  },
);

Deno.test(
  "completion - a FIXED verdict with all other evidence lets the gate pass (Issue #3657)",
  async () => {
    const outcome = await runCompletion({
      labels: VERIFIER_LABELS,
      summary: COMPLIANT_SUMMARY,
      changedFiles: SECURITY_FILES,
      discrimination: RED_GREEN,
      verification: FIXED,
    });

    assertEquals(outcome.status, "continue");
    assertEquals(outcome.prCreateCalls, 1, "gh pr create must run");
    assertEquals(outcome.verifierInputs.length, 1);
    assertEquals(outcome.securityGateBlocks.length, 0);
  },
);

Deno.test(
  "completion - the recorded gate block carries the verifier's verification (Issue #3657)",
  async () => {
    const outcome = await runCompletion({
      labels: VERIFIER_LABELS,
      summary: COMPLIANT_SUMMARY,
      changedFiles: SECURITY_FILES,
      discrimination: RED_GREEN,
      verification: NOT_FIXED,
    });

    // The in-run recovery re-runs the gate once, so each block is checked.
    assert(outcome.securityGateBlocks.length > 0);
    for (const block of outcome.securityGateBlocks) {
      assertEquals(block.verification, NOT_FIXED);
    }
  },
);

Deno.test(
  "completion - an unresolvable base ref keeps the verifier from running and blocks trigger-closed-not-checked (Issue #3657)",
  async () => {
    const outcome = await runCompletion({
      labels: VERIFIER_LABELS,
      summary: COMPLIANT_SUMMARY,
      changedFiles: SECURITY_FILES,
      discrimination: RED_GREEN,
      verification: FIXED,
      baseRefUnresolvable: true,
    });

    assertEquals(
      outcome.verifierInputs.length,
      0,
      "the verifier must not be called without a comparable base",
    );
    assertEquals(outcome.status, "failure");
    assertEquals(outcome.prCreateCalls, 0);
    // The discrimination check is not checked for the same reason, so the
    // list carries it too; the trigger's own marker is what this test pins.
    const missing = outcome.securityGateBlocks[0]?.missing ?? [];
    assert(
      missing.includes("trigger-closed-not-checked"),
      `missing: ${missing.join(", ")}`,
    );
    assertStringIncludes(
      outcome.reason ?? "",
      "the base ref is unresolvable",
    );
  },
);

Deno.test(
  "completion - a checked verdict is logged as run with its verdict (Issue #3657)",
  async () => {
    const outcome = await runCompletion({
      labels: VERIFIER_LABELS,
      summary: COMPLIANT_SUMMARY,
      changedFiles: SECURITY_FILES,
      discrimination: RED_GREEN,
      verification: FIXED,
    });

    assertEquals(verifierLogs(outcome), [
      {
        level: "info",
        message: "Security-fix verifier ran",
        context: { verdict: "FIXED" },
      },
    ]);
  },
);

Deno.test(
  "completion - a not checked verification is logged as not run with its reason (Issue #3657)",
  async () => {
    const reason = "git diff failed: bad revision";
    const outcome = await runCompletion({
      labels: VERIFIER_LABELS,
      summary: COMPLIANT_SUMMARY,
      changedFiles: SECURITY_FILES,
      discrimination: RED_GREEN,
      verification: { kind: "not_checked", reason },
    });

    const lines = verifierLogs(outcome);
    // The in-run recovery re-runs the gate, so one line per verifier call.
    assertEquals(lines.length, outcome.verifierInputs.length);
    assert(lines.length > 0);
    for (const line of lines) {
      assertEquals(line, {
        level: "warn",
        message: "Security-fix verifier did not run",
        context: { reason },
      });
    }
  },
);

Deno.test(
  "completion - a verifier kept from running by an unresolvable base ref is logged with the reason (Issue #3657)",
  async () => {
    const outcome = await runCompletion({
      labels: VERIFIER_LABELS,
      summary: COMPLIANT_SUMMARY,
      changedFiles: SECURITY_FILES,
      discrimination: RED_GREEN,
      verification: FIXED,
      baseRefUnresolvable: true,
    });

    const lines = verifierLogs(outcome);
    assert(lines.length > 0);
    for (const line of lines) {
      assertEquals(line.level, "warn");
      assertEquals(line.message, "Security-fix verifier did not run");
      assertStringIncludes(
        String(line.context?.reason),
        "the base ref is unresolvable",
      );
    }
  },
);
