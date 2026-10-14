/**
 * Issue #3689: the issue worker's final-mile push runs the pre-push gate.
 *
 * Drives `workOnIssueCompletion` with the git seams mocked and counts gate
 * calls and pushes: a blocked gate means no push and no recovery; a passing
 * gate lets the push through; recovery re-gates before the retry push.
 *
 * Australian English throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
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
  /** Gate verdicts, consumed one per call; a string is a block message. */
  gateAnswers: Array<"pass" | string>;
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
  const config: WorkerConfig = buildDefaultWorkerConfig();
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
    logger: { warn: (message: string) => warnings.push(message) },
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
        return Promise.resolve(
          answer === "pass"
            ? { ok: true as const, value: undefined }
            : { ok: false as const, error: new Error(answer) },
        );
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
    assert((o.reason ?? "").startsWith("[PRE_PUSH_BLOCKED]"));
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
    assert((o.reason ?? "").startsWith("[PRE_PUSH_BLOCKED]"));
  },
});
