/**
 * Issue #3689: the issue worker's final-mile push runs the pre-push gate.
 *
 * Drives `workOnIssueCompletion` with the git seams mocked and counts gate
 * calls and pushes: a blocked gate means no push and no recovery; a passing
 * gate lets the push through; recovery re-gates before the retry push.
 *
 * Australian English throughout (behaviour, organisation).
 */

import { createProductionRunCoreDeps } from "../lib/run_core_production_deps.ts";
import { captureContentSnapshot } from "../lib/content_approval_tracker.ts";
import { resolveContentApprovalStateDir } from "../lib/content_approval_state_dir.ts";
import { envFrom } from "./support/env_lookup.ts";
import type { RunOutcome } from "../lib/run_outcome.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  applyCodingFailureLadder,
  classifyCodingFailure,
  planCodingFailure,
} from "../lib/coding_failure_ladder.ts";
import { callbackOutcomeFromRun } from "../lib/run_callback_context.ts";
import { deriveRunOutcome } from "../lib/run_outcome.ts";
import type { FailureCategory } from "../lib/failure_diagnosis.ts";
import {
  detectFailureCategory,
  isInfrastructureFailure,
  PRE_PUSH_GATE_MARKER,
} from "../lib/failure_diagnosis.ts";
import { PrePushGateInfrastructureError } from "../lib/pre_push_gate.ts";
import { PrePushGateBlockedError } from "../lib/git_push.ts";
import { workOnIssueCompletion } from "../lib/phases/completion_phase.ts";
import type {
  IssueContext,
  PhaseResult,
  PhaseState,
  WorkOnIssueResult,
} from "../lib/issue_worker_types.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type { GitHubClient, Result, WorkerConfig } from "../types.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import {
  createMissingScopeWarner,
  type MissingScopeWarner,
  type WorkflowScopeState,
} from "../lib/workflow_scope.ts";

const SHA = "1f0c2b3a4d5e6f708192a3b4c5d6e7f8091a2b3c";

const SUMMARY = `## Summary
Added the gitleaks workflow. Closes #10.

## Test Plan
- Ran the workflow locally with act.
`;

/** A stale-branch rejection, which routes to push recovery. */
const REFUSAL_STALE = "! [rejected] issue-10 -> issue-10 (fetch first)";

function stubClient(): GitHubClient {
  return {
    getIssue: () => {
      throw new Error("stub");
    },
    getIssueComments: () => Promise.resolve([]),
    addLabel: () => Promise.resolve(),
    removeLabel: () => Promise.resolve(),
    postComment: () => Promise.resolve(undefined),
    editIssue: () => Promise.resolve(),
    assignIssue: () => Promise.resolve(),
    unassignIssue: () => Promise.resolve(),
    closeIssue: () => Promise.resolve(),
  };
}

type GitResult = Result<{ code: number; stdout: string; stderr: string }>;

interface Scenario {
  landedWhen?: "before-recovery" | "during-push" | "before-bookkeeping";
  partialMerged?: boolean;
  unrelatedMerged?: boolean;
  extraLocalWork?: boolean;
  lookupUnavailable?: boolean;
  landedTarget?: string;
  /** Verdict the launcher recorded; "unknown" models "detection never ran". */
  scope: WorkflowScopeState;
  /** Whether `git diff --name-only` can answer. */
  diffAnswers: boolean;
  /** Paths the diff (or the commit list) reports. */
  changedFiles: string[];
  /** Whether the push is refused by GitHub for want of the scope. */
  pushRefused: boolean;
  /**
   * Gate answers, consumed one per call; a string is a block message (a
   * verdict on the branch) and an `Error` is returned as is (a lookup that
   * failed).
   */
  gateAnswers: Array<"pass" | string | Error>;
  /** Whether the PR base resolves to nothing (no local, remote or fetched ref). */
  baseUnresolvable?: boolean;
  /** The host's warn-once latch, shared to model one process (Issue #2689). */
  warner?: MissingScopeWarner;
}

interface Outcome {
  outcome?: RunOutcome;
  attempts: number;
  prCreates: number;
  preservedWork?: string;
  status: string;
  category?: unknown;
  reason?: string;
  pushes: number;
  recoveries: number;
  gateCalls: number;
  /** The `baseRef` each gate call received (5th argument). */
  gateBaseRefs: Array<string | undefined>;
  warnings: string[];
}

async function runCompletion(scenario: Scenario): Promise<Outcome> {
  const repoPath = await Deno.makeTempDir();
  await Deno.mkdir(`${repoPath}/docs/archive/pr-summaries`, {
    recursive: true,
  });
  await Deno.writeTextFile(
    `${repoPath}/docs/archive/pr-summaries/pr-summary-10.md`,
    SUMMARY,
  );
  let pushes = 0;
  let attempts = 0;
  let phaseReturned = false;
  let prCreates = 0;
  let merged = scenario.landedWhen === "before-recovery";
  if (scenario.extraLocalWork) {
    await Deno.writeTextFile(
      `${repoPath}/unshipped.ts`,
      "preserve this distinct work",
    );
  }
  let recoveries = 0;
  let gateCalls = 0;
  const gateBaseRefs: Array<string | undefined> = [];
  const warnings: string[] = [];
  const config: WorkerConfig = buildDefaultWorkerConfig();
  // The in-run infrastructure retry must not sleep its real backoff.
  config.infraRetryBackoffMs = 1;
  config.workDir = `${repoPath}/work`;
  config.allowedAuthors = ["testbot"];
  const ctx: IssueContext = {
    repo: "stSoftwareAU/GRQ-VibeCoder",
    issueNumber: 10,
    issueTitle: "Add Gitleaks Secrets Detection workflow",
    issueBody: "",
    issueLabels: ["work-on"],
    issueComments: "",
    githubUser: "testbot",
    config,
  };
  const state: PhaseState = {
    branchName: "issue-10-add-gitleaks-secrets-detection-workflow",
    defaultBranch: "main",
    repoPath,
  } as PhaseState;
  if (scenario.landedTarget) state.milestoneBranch = scenario.landedTarget;
  const deps = createMockDeps({
    logger: { warn: (message: string) => warnings.push(message) },
    github: {
      createClient: () => stubClient(),
      handleIssueFailure: () => {
        attempts++;
        return Promise.resolve({
          ok: true,
          value: {
            markedAsFailed: false,
            markedAsFailedOnce: true,
            failureCategory: "quality_check",
            isInfrastructure: false,
          },
        });
      },
      runGhCommand: (args: string[]) => {
        if (args[0] === "issue" && args[1] === "view") {
          if (
            phaseReturned && scenario.landedWhen === "before-bookkeeping" &&
            args.at(-1) === "labels"
          ) merged = true;
          return Promise.resolve(
            JSON.stringify({
              number: ctx.issueNumber,
              title: ctx.issueTitle,
              body: ctx.issueBody,
              author: { login: "testbot" },
              labels: [{ name: "work-on" }],
              comments: [],
              state: "OPEN",
            }),
          );
        }
        if (args[0] === "pr" && args[1] === "list" && args.includes("merged")) {
          if (scenario.lookupUnavailable) {
            return Promise.reject(new Error("GitHub unavailable"));
          }
          return Promise.resolve(JSON.stringify(
            merged
              ? [{
                number: 99,
                url: `https://github.com/${ctx.repo}/pull/99`,
                state: "MERGED",
                title: "Fixture (#10)",
                mergedAt: "2026-10-18T01:44:24Z",
                headRefName: scenario.unrelatedMerged
                  ? "issue-10-unrelated"
                  : state.branchName,
                headRefOid: SHA,
                headRepository: { name: ctx.repo.split("/")[1] },
                headRepositoryOwner: { login: ctx.repo.split("/")[0] },
                baseRefName: state.milestoneBranch ?? "main",
                mergeCommit: { oid: "2".repeat(40) },
                body: scenario.partialMerged
                  ? "Part of #10.\n\n## Acceptance Criteria\n- **partial** — required scope remains — evidence: partial fixture — reason: unfinished"
                  : SUMMARY,
              }]
              : [],
          ));
        }
        if (args[0] === "api" && args[1]?.includes("/compare/")) {
          return Promise.resolve("behind");
        }
        if (args[0] === "pr" && args[1] === "create") prCreates++;
        return Promise.resolve(
          "https://github.com/stSoftwareAU/GRQ-VibeCoder/pull/99",
        );
      },
    },
    git: {
      runGitCommand: (cmdArgs: string[]): Promise<GitResult> => {
        const ok = (stdout: string): Promise<GitResult> =>
          Promise.resolve({
            ok: true as const,
            value: { code: 0, stdout, stderr: "" },
          });
        if (scenario.baseUnresolvable) {
          if (cmdArgs[0] === "fetch") {
            return Promise.resolve({
              ok: true as const,
              value: { code: 1, stdout: "", stderr: "fatal: no such ref" },
            });
          }
          if (cmdArgs[0] === "rev-parse" && cmdArgs.includes("--verify")) {
            return Promise.resolve({
              ok: true as const,
              value: { code: 1, stdout: "", stderr: "" },
            });
          }
        }
        if (cmdArgs[0] === "status" && scenario.extraLocalWork) {
          return ok("?? unshipped.ts");
        }
        if (cmdArgs[0] === "rev-parse") return ok(`${SHA}\n`);
        if (cmdArgs[0] === "diff" && cmdArgs[1] === "--name-only") {
          if (!scenario.diffAnswers) {
            return Promise.resolve({
              ok: false as const,
              error: new Error("fatal: bad revision 'origin/main...HEAD'"),
            });
          }
          return ok(scenario.changedFiles.join("\n"));
        }
        if (cmdArgs[0] === "log" && cmdArgs.includes("--name-only")) {
          return ok(scenario.changedFiles.join("\n"));
        }
        if (cmdArgs[0] === "rev-list") return ok("1\n");
        return ok("");
      },
      gateUnpushedCommits: (_branch, _opts, _spec, _ran, baseRef) => {
        gateBaseRefs.push(baseRef);
        const answer = scenario.gateAnswers[gateCalls++] ?? "pass";
        return Promise.resolve(
          answer === "pass" ? { ok: true as const, value: undefined } : {
            ok: false as const,
            error: answer instanceof Error
              ? new PrePushGateInfrastructureError(answer.message, {
                cause: answer,
              })
              : new PrePushGateBlockedError(answer),
          },
        );
      },
      pushUnpushedCommits: () => {
        pushes++;
        if (scenario.landedWhen === "during-push") merged = true;
        return scenario.pushRefused && pushes === 1
          ? Promise.resolve({
            ok: false as const,
            error: new Error(REFUSAL_STALE),
          })
          : Promise.resolve({ ok: true as const, value: 1 });
      },
      recoverFromPushRejection: () => {
        recoveries++;
        return Promise.resolve({
          ok: true as const,
          value: "Push succeeded after rebase recovery",
        });
      },
    },
    pr: {
      findExistingPrForIssue: () =>
        Promise.resolve({ ok: false, error: new Error("none") }),
      findExistingPrForBranch: () =>
        Promise.resolve({ ok: false, error: new Error("none") }),
    },
    infrastructure: {
      workflowScopeState: () => scenario.scope,
      warnMissingWorkflowScope: scenario.warner ?? createMissingScopeWarner(),
    },
  });
  try {
    let result: PhaseResult = {
      status: "failure",
      category: "unknown",
      reason: "phase did not run",
    };
    const runPhase = async (): Promise<WorkOnIssueResult> => {
      result = await workOnIssueCompletion(ctx, state, deps);
      phaseReturned = true;
      return {
        category: result.status === "continue"
          ? "unknown" as const
          : result.category,
        ...(result.status === "continue" ||
            result.status === "early_exit" && !result.expectedSkip
          ? { success: true as const }
          : { success: false as const }),
        expectedSkip: result.status === "early_exit" &&
          result.expectedSkip === true,
        phase: "completion",
        reason: result.status === "continue"
          ? "normal completion"
          : result.reason,
        timings: {},
        ...(result.status === "early_exit" && result.outcome
          ? { outcome: result.outcome }
          : {}),
        branchContext: {
          branchName: state.branchName,
          repoPath,
          defaultBranch: state.defaultBranch,
          milestoneBranch: state.milestoneBranch,
          reapproved: false,
        },
      };
    };
    let terminal: WorkOnIssueResult;
    if (scenario.landedWhen) {
      const snapshot = await captureContentSnapshot(
        resolveContentApprovalStateDir(config.workDir),
        ctx.repo,
        ctx.issueNumber,
        ctx.issueTitle,
        ctx.issueBody,
        "testbot",
      );
      assert(snapshot.ok);
      const production = await createProductionRunCoreDeps({
        repoDir: repoPath,
        workDir: config.workDir,
        githubUser: ctx.githubUser,
        config,
        logger: deps.logger,
        workerDeps: deps,
        workOnIssue: runPhase,
        env: envFrom({ HOME: repoPath }),
      });
      try {
        const processed = await production.deps.processIssue({
          repo: ctx.repo,
          issueNumber: ctx.issueNumber,
          issueTitle: ctx.issueTitle,
          milestoneTitle: "",
        });
        assert(processed.ok);
        terminal = {
          category: "unknown",
          success: processed.value.success,
          expectedSkip: processed.value.skipped,
          outcome: processed.value.outcome,
          phase: "completion",
          reason: "processed completion",
          timings: {},
        };
      } finally {
        production.cleanup();
      }
    } else {
      terminal = await runPhase();
    }
    return {
      category: "category" in result ? result.category : undefined,
      outcome: terminal.outcome,
      attempts,
      prCreates,
      ...(scenario.extraLocalWork
        ? { preservedWork: await Deno.readTextFile(`${repoPath}/unshipped.ts`) }
        : {}),
      status: terminal.expectedSkip && terminal.outcome?.kind === "claim_stale"
        ? "early_exit"
        : result.status,
      reason: result.status === "failure" ? result.reason : undefined,
      pushes,
      recoveries,
      gateCalls,
      gateBaseRefs,
      warnings,
    };
  } finally {
    await Deno.remove(repoPath, { recursive: true });
  }
}

const BLOCK = "[PRE_PUSH_BLOCKED] docs/USAGE.md:117 MD018";
const base = {
  scope: "granted" as WorkflowScopeState,
  diffAnswers: true,
  changedFiles: ["docs/USAGE.md"],
};

Deno.test({
  name:
    "completion - a blocking pre-push gate fails closed: no push, no recovery (Issue #3689)",
  permissions: { read: true, write: true },
  async fn() {
    const o = await runCompletion({
      ...base,
      pushRefused: false,
      gateAnswers: [BLOCK],
    });
    assertEquals(o.status, "failure");
    assertEquals(o.gateCalls, 1);
    assertEquals(o.pushes, 0, "a blocked gate must never reach the push");
    assertEquals(o.recoveries, 0);
    assert((o.reason ?? "").startsWith(PRE_PUSH_GATE_MARKER));
    assertStringIncludes(o.reason ?? "", BLOCK);
  },
});

Deno.test({
  name:
    "completion - the gate covers the whole branch against the PR base, first and retry (PR #3716 review)",
  permissions: { read: true, write: true },
  async fn() {
    const o = await runCompletion({
      ...base,
      pushRefused: true,
      gateAnswers: ["pass", "pass"],
    });
    assertEquals(o.gateCalls, 2);
    // WIP checkpoints push the agent's commits ungated, so "unpushed" alone
    // would miss them: both calls must name the base the PR will compare to.
    assertEquals(o.gateBaseRefs, ["origin/main", "origin/main"]);
  },
});

Deno.test({
  name:
    "completion - an unresolvable PR base degrades the gate to the unpushed-only check (PR #3716 review)",
  permissions: { read: true, write: true },
  async fn() {
    const o = await runCompletion({
      ...base,
      baseUnresolvable: true,
      pushRefused: false,
      gateAnswers: ["pass"],
    });
    // Later phases may push again on this mock; every gate call must run
    // without a base and none may be skipped or throw.
    assert(o.gateBaseRefs.length >= 1, "the gate still runs");
    assert(o.gateBaseRefs.every((ref) => ref === undefined));
    assert(!(o.reason ?? "").includes("PRE_PUSH_BLOCKED"));
  },
});

Deno.test({
  name:
    "completion - a passing pre-push gate lets the push through (Issue #3689)",
  permissions: { read: true, write: true },
  async fn() {
    const o = await runCompletion({
      ...base,
      pushRefused: false,
      gateAnswers: ["pass"],
    });
    assertEquals(o.gateCalls, 1);
    assertEquals(o.pushes, 1);
    // Later phases may still fail on this mock; the gate must not be why.
    assert(!(o.reason ?? "").includes("PRE_PUSH_BLOCKED"));
  },
});

Deno.test({
  name:
    "completion - recovery commits are re-gated before the retry push (Issue #3689)",
  permissions: { read: true, write: true },
  async fn() {
    const o = await runCompletion({
      ...base,
      pushRefused: true,
      gateAnswers: ["pass", BLOCK],
    });
    assertEquals(o.status, "failure");
    assertEquals(o.recoveries, 1);
    assertEquals(o.gateCalls, 2);
    assertEquals(o.pushes, 1, "the retry push must be blocked by the gate");
    assert((o.reason ?? "").startsWith(PRE_PUSH_GATE_MARKER));
    assertStringIncludes(o.reason ?? "", BLOCK);
  },
});

Deno.test({
  name:
    "completion - a blocked gate whose quoted output says rate limit, timed out and SIGKILL still earns a ladder attempt (PR #3716 review)",
  permissions: { read: true, write: true },
  async fn() {
    const o = await runCompletion({
      ...base,
      pushRefused: false,
      gateAnswers: [
        "[PRE_PUSH_BLOCKED] -    // back off when the exchange rate limit is hit\n" +
        "the check timed out and was killed by SIGKILL",
      ],
    });
    assertEquals(o.status, "failure");
    const decision = classifyCodingFailure(o.reason);
    assertEquals(decision.category, "pre_push_gate");
    assertEquals(decision.disposition, "ladder");
  },
});

Deno.test({
  name:
    "completion - a gate block with ~100 KB of output keeps the marker, names the check and stays under the comment cap (PR #3716 review)",
  permissions: { read: true, write: true },
  async fn() {
    const command = "deno fmt --check --permit-no-files src/big.ts";
    const huge = `[PRE_PUSH_BLOCKED] Pre-flight gate BLOCK (Issue #3577): ` +
      `command \`${command}\` failed with exit code 1.\n\n` +
      "-    let unformatted = 1;\n".repeat(5000) +
      "Unpushed commits on issue-10 were not pushed.";
    assert(huge.length > 100_000);
    const o = await runCompletion({
      ...base,
      pushRefused: false,
      gateAnswers: [huge],
    });
    assertEquals(o.status, "failure");
    const reason = o.reason ?? "";
    assert(reason.startsWith(PRE_PUSH_GATE_MARKER));
    assertStringIncludes(reason, command);
    assertStringIncludes(
      reason,
      "Unpushed commits on issue-10 were not pushed.",
    );
    // Far under GitHub's 65,536-character comment limit.
    assert(reason.length < 8000, `reason was ${reason.length} characters`);
  },
});

Deno.test({
  name:
    "completion - a gate block redacts a secret in its output before the cut (PR #3716 review)",
  permissions: { read: true, write: true },
  async fn() {
    const token = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
    const o = await runCompletion({
      ...base,
      pushRefused: false,
      gateAnswers: [
        `[PRE_PUSH_BLOCKED] command \`./pre-flight.sh\` failed\n` +
        `GITHUB_TOKEN=${token}\n`,
      ],
    });
    assert(!(o.reason ?? "").includes(token));
  },
});

Deno.test({
  name:
    "completion - a gate that cannot reach the remote is not blamed on the branch: no marker, infrastructure (PR #3716 review)",
  permissions: { read: true, write: true },
  async fn() {
    const o = await runCompletion({
      ...base,
      pushRefused: false,
      // The in-run infrastructure retry may ask again: keep answering with
      // the same outage so a retry cannot slip through and push.
      gateAnswers: Array.from(
        { length: 5 },
        () =>
          new Error(
            "fatal: unable to access 'https://github.com/o/r.git/': " +
              "Could not resolve host: github.com",
          ),
      ),
    });
    assertEquals(o.status, "failure");
    const reason = o.reason ?? "";
    assert(!reason.startsWith(PRE_PUSH_GATE_MARKER));
    assertEquals(o.pushes, 0, "an unreadable branch state must not push");
    assert(o.gateCalls > 1, "an infrastructure failure is retried in-run");
    assertStringIncludes(reason, "Could not resolve host");
    const category = detectFailureCategory(reason);
    assertEquals(category, "push_failure");
    assert(isInfrastructureFailure(category));
    assertEquals(classifyCodingFailure(reason).category, "push_failure");
  },
});

for (
  const [label, git] of [
    [
      "a git call the worker's timeout cut off",
      "TIMEOUT: git rev-list --count --no-merges origin/main..HEAD timed out " +
      "after 30s (Issue #619)",
    ],
    [
      "an ls-remote that timed out on the network",
      "fatal: unable to access 'https://github.com/o/r.git/': " +
      "Failed to connect to github.com port 443: Connection timed out",
    ],
  ] as const
) {
  Deno.test({
    name:
      `completion - ${label} is a push failure, not a timeout, and is retried in-run (PR #3716 review)`,
    permissions: { read: true, write: true },
    async fn() {
      const o = await runCompletion({
        ...base,
        pushRefused: false,
        gateAnswers: Array.from({ length: 5 }, () => new Error(git)),
      });
      assertEquals(o.status, "failure");
      const reason = o.reason ?? "";
      assertStringIncludes(reason, git);
      assertEquals(o.pushes, 0, "an unreadable branch state must not push");
      assert(o.gateCalls > 1, "an infrastructure failure is retried in-run");
      const category = detectFailureCategory(reason);
      assertEquals(category, "push_failure");
      assert(isInfrastructureFailure(category));
      assertEquals(classifyCodingFailure(reason).category, "push_failure");
    },
  });
}

Deno.test({
  name:
    "completion - a gate lookup failure with ~100 KB of output is capped too (PR #3716 review)",
  permissions: { read: true, write: true },
  async fn() {
    const huge = "fatal: Could not resolve host: github.com\n" +
      "remote: noise\n".repeat(10_000) + "end of the git output";
    assert(huge.length > 100_000);
    const o = await runCompletion({
      ...base,
      pushRefused: false,
      gateAnswers: Array.from({ length: 5 }, () => new Error(huge)),
    });
    const reason = o.reason ?? "";
    assertStringIncludes(reason, "Could not resolve host");
    assertStringIncludes(reason, "end of the git output");
    assert(reason.length < 8000, `reason was ${reason.length} characters`);
  },
});

Deno.test({
  name:
    "completion preserves declared network and gate verdict causes through retry, failure bookkeeping and outcome (Issue #3738)",
  permissions: { read: true, write: true },
  async fn() {
    for (
      const [answer, category, disposition] of [
        [
          new Error(
            "Could not resolve host; quoted check: rate limit timeout ENOSPC TypeError: boom",
          ),
          "push_failure",
          "transient",
        ],
        [
          "[PRE_PUSH_BLOCKED] actual test failure; quoted output: rate limit timeout",
          "pre_push_gate",
          "ladder",
        ],
      ] as const
    ) {
      const o = await runCompletion({
        ...base,
        pushRefused: false,
        gateAnswers: Array.from({ length: 5 }, () => answer),
      });
      assertEquals(o.status, "failure");
      assertEquals(
        o.category,
        category,
        "the phase must declare its cause instead of depending on reason wording",
      );
      assertEquals(
        o.gateCalls > 1,
        category === "push_failure",
        "only the network failure is retried in-run",
      );
      // A transport wrapper can reword/quote the result. Its declared cause
      // still drives decisions and telemetry rather than the quotation.
      const reason = "outer wrapper: " + o.reason;
      const run = {
        success: false,
        expectedSkip: false,
        phase: "completion",
        reason,
        category: o.category as FailureCategory,
      };
      const plan = planCodingFailure(run);
      assertEquals(plan.decision?.category, category);
      assertEquals(plan.decision?.disposition, disposition);
      let failureWrites = 0;
      const options = {
        repo: "o/r",
        issueNumber: 10,
        githubUser: "testbot",
        failureReason: reason,
        category: run.category,
      };
      const applied = await applyCodingFailureLadder(options, {
        handleIssueFailure: (record) => {
          failureWrites++;
          assertEquals(
            "category" in record ? record.category : undefined,
            category,
          );
          return Promise.resolve({
            ok: true,
            value: {
              markedAsFailed: false,
              markedAsFailedOnce: true,
              failureCategory: category,
              isInfrastructure: false,
            },
          });
        },
      });
      assertEquals(applied.decision.category, category);
      assertEquals(failureWrites, category === "push_failure" ? 0 : 1);
      const outcome = deriveRunOutcome(run);
      assertEquals(outcome.kind, "no_pr");
      assertEquals(outcome.kind === "no_pr" && outcome.category, category);
      const emitted = callbackOutcomeFromRun({
        repo: "o/r",
        issueNumber: 10,
        result: "failure",
        startedAtEpochMs: 0,
        finishedAtEpochMs: 1,
        outcome,
      });
      assertEquals(emitted?.category, category);
      assertEquals(
        emitted?.failureClass,
        category === "push_failure" ? "unknown" : "agent-outcome",
      );
      assertEquals(o.pushes, 0);
    }
  },
});

Deno.test("completion reconciles merges before recovery and final failure bookkeeping without spending an attempt (Issue #3977)", async () => {
  for (
    const landedWhen of [
      "before-recovery",
      "during-push",
      "before-bookkeeping",
    ] as const
  ) {
    const o = await runCompletion({
      ...base,
      landedWhen,
      pushRefused: landedWhen === "during-push",
      gateAnswers: landedWhen === "before-bookkeeping" ? [BLOCK] : ["pass"],
    });
    assertEquals(o.status, "early_exit", landedWhen);
    assertEquals(o.attempts, 0, landedWhen);
    assertEquals(o.recoveries, 0, landedWhen);
    assertEquals(o.pushes, landedWhen === "during-push" ? 1 : 0, landedWhen);
    assertEquals(o.prCreates, 0, landedWhen);
    assert(o.outcome?.kind === "claim_stale");
    assertEquals(o.outcome.reason, "work_already_merged");
    assertEquals(o.outcome.baseBranch, "main");
    assertEquals(o.outcome.defaultBranch, "main");
  }
});

Deno.test("completion keeps partial, unrelated and unavailable merges and distinct local work on the failure path (Issue #3977)", async () => {
  for (
    const extra of [{ partialMerged: true }, { unrelatedMerged: true }, {
      lookupUnavailable: true,
    }, { extraLocalWork: true }]
  ) {
    const o = await runCompletion({
      ...base,
      landedWhen: "before-bookkeeping",
      pushRefused: false,
      gateAnswers: [BLOCK],
      ...extra,
    });
    assertEquals(o.status, "failure", JSON.stringify(extra));
    assertEquals(o.attempts, 1, JSON.stringify(extra));
    assertEquals(o.outcome?.kind === "claim_stale", false);
    if (extra.extraLocalWork) {
      assertEquals(o.preservedWork, "preserve this distinct work");
    }
  }
});

Deno.test("completion retains the milestone target and repeated completion produces no failure mutations (Issue #3977)", async () => {
  const scenario = {
    ...base,
    landedWhen: "before-recovery" as const,
    landedTarget: "milestone/implementation",
    pushRefused: false,
    gateAnswers: ["pass" as const],
  };
  const outcomes = await Promise.all([
    runCompletion(scenario),
    runCompletion(scenario),
  ]);
  for (const o of outcomes) {
    assertEquals(o.attempts, 0);
    assertEquals(o.recoveries, 0);
    assertEquals(o.pushes, 0);
    assertEquals(o.prCreates, 0);
    assert(o.outcome?.kind === "claim_stale");
    assertEquals(o.outcome.baseBranch, "milestone/implementation");
    assertEquals(o.outcome.defaultBranch, "main");
  }
});
