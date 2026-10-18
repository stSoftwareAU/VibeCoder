/**
 * Issue #3689: the issue worker's final-mile push runs the pre-push gate.
 *
 * Drives `workOnIssueCompletion` with the git seams mocked and counts gate
 * calls and pushes: a blocked gate means no push and no recovery; a passing
 * gate lets the push through; recovery re-gates before the retry push.
 *
 * Australian English throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { classifyCodingFailure } from "../lib/coding_failure_ladder.ts";
import {
  detectFailureCategory,
  isInfrastructureFailure,
  PRE_PUSH_GATE_MARKER,
} from "../lib/failure_diagnosis.ts";
import { PrePushGateBlockedError } from "../lib/git_push.ts";
import { workOnIssueCompletion } from "../lib/phases/completion_phase.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
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
  status: string;
  reason?: string;
  pushes: number;
  recoveries: number;
  gateCalls: number;
  /** The `baseRef` each gate call received (5th argument). */
  gateBaseRefs: Array<string | undefined>;
  warnings: string[];
  /** INFO lines the completion phase logged (Issue #3770). */
  infos: string[];
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
  let recoveries = 0;
  let gateCalls = 0;
  const gateBaseRefs: Array<string | undefined> = [];
  const warnings: string[] = [];
  const infos: string[] = [];
  const config: WorkerConfig = buildDefaultWorkerConfig();
  // The in-run infrastructure retry must not sleep its real backoff.
  config.infraRetryBackoffMs = 1;
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
  const deps = createMockDeps({
    logger: {
      info: (message: string) => infos.push(message),
      warn: (message: string) => warnings.push(message),
    },
    github: {
      createClient: () => stubClient(),
      runGhCommand: () =>
        Promise.resolve(
          "https://github.com/stSoftwareAU/GRQ-VibeCoder/pull/99",
        ),
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
        if (answer === "pass") {
          return Promise.resolve({
            ok: true as const,
            value: { kind: "passed" as const, checksRun: GATE_CHECKS },
          });
        }
        if (answer === "noop") {
          return Promise.resolve({
            ok: true as const,
            value: { kind: "noop" as const },
          });
        }
        return Promise.resolve({
          ok: false as const,
          error: answer instanceof Error
            ? answer
            : new PrePushGateBlockedError(answer),
        });
      },
      pushUnpushedCommits: () => {
        pushes++;
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
    const result = await workOnIssueCompletion(ctx, state, deps);
    return {
      status: result.status,
      reason: result.status === "failure" ? result.reason : undefined,
      pushes,
      recoveries,
      gateCalls,
      gateBaseRefs,
      warnings,
      infos,
    };
  } finally {
    await Deno.remove(repoPath, { recursive: true });
  }
}

/** The checks the pass stub reports, to assert the pass line names them. */
const GATE_CHECKS = ["deno fmt", "markdownlint"];

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
    "completion - a passing pre-push gate logs the checks it ran (Issue #3770)",
  permissions: { read: true, write: true },
  async fn() {
    const o = await runCompletion({
      ...base,
      pushRefused: false,
      gateAnswers: ["pass"],
    });
    assert(
      o.infos.includes(
        `Pre-push gate passed checks=[${GATE_CHECKS.join(", ")}]`,
      ),
      `expected a pass line naming the checks, got: ${JSON.stringify(o.infos)}`,
    );
  },
});

Deno.test({
  name:
    "completion - a no-op pre-push gate logs nothing ahead, never as a pass (Issue #3770)",
  permissions: { read: true, write: true },
  async fn() {
    const o = await runCompletion({
      ...base,
      pushRefused: false,
      gateAnswers: ["noop"],
    });
    assert(
      o.infos.some((line) =>
        line.startsWith("Pre-push gate: nothing ahead of ")
      ),
      `expected a nothing-ahead line, got: ${JSON.stringify(o.infos)}`,
    );
    assert(
      !o.infos.some((line) => line.startsWith("Pre-push gate passed")),
      `a no-op must not log as a pass, got: ${JSON.stringify(o.infos)}`,
    );
  },
});
