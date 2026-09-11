/**
 * Issue #1952: a push GitHub refuses for want of the `workflow` scope fails
 * once, immediately, and is recorded as the host's credential.
 *
 * Drives `workOnIssueCompletion` — the path `issue_worker.ts` runs — with the
 * git seams mocked, so the assertions are behavioural: how many pushes were
 * attempted, whether the rebase ladder ran, and what the failure reason
 * classifies as.
 *
 * Australian English throughout (behaviour, organisation).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { workOnIssueCompletion } from "../lib/phases/completion_phase.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type { GitHubClient, Result, WorkerConfig } from "../types.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { detectFailureCategory } from "../lib/failure_diagnosis.ts";
import type { WorkflowScopeState } from "../lib/workflow_scope.ts";

const SHA = "1f0c2b3a4d5e6f708192a3b4c5d6e7f8091a2b3c";

const SUMMARY = `## Summary
Added the gitleaks workflow. Closes #10.

## Test Plan
- Ran the workflow locally with act.
`;

/** GitHub's refusal, as it reaches the worker through git's stderr. */
const REFUSAL =
  "! [remote rejected] issue-10 -> issue-10 (refusing to allow an OAuth App " +
  "to create or update workflow `.github/workflows/gitleaks.yml` without " +
  "`workflow` scope)";

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
}

interface Outcome {
  status: string;
  reason?: string;
  pushes: number;
  recoveries: number;
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
      pushUnpushedCommits: () => {
        pushes++;
        return scenario.pushRefused
          ? Promise.resolve({ ok: false as const, error: new Error(REFUSAL) })
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
    infrastructure: { workflowScopeState: () => scenario.scope },
  });
  try {
    const result = await workOnIssueCompletion(ctx, state, deps);
    return {
      status: result.status,
      reason: result.status === "failure" ? result.reason : undefined,
      pushes,
      recoveries,
      warnings,
    };
  } finally {
    await Deno.remove(repoPath, { recursive: true });
  }
}

Deno.test({
  name:
    "completion - GitHub's workflow-scope refusal fails once, with no rebase recovery (Issue #1952)",
  permissions: { read: true, write: true },
  async fn() {
    const outcome = await runCompletion({
      // The launcher recorded no verdict, so the pre-push check cannot stop
      // this: the refusal arrives at the push itself.
      scope: "unknown",
      diffAnswers: true,
      changedFiles: [".github/workflows/gitleaks.yml"],
      pushRefused: true,
    });
    assertEquals(outcome.status, "failure");
    assertEquals(outcome.pushes, 1, "exactly one push attempt");
    assertEquals(outcome.recoveries, 0, "no rebase recovery may run");
    assertStringIncludes(outcome.reason ?? "", "lacks the 'workflow' scope");
    assertStringIncludes(outcome.reason ?? "", "gh auth refresh -s workflow");
    assertEquals(
      detectFailureCategory(outcome.reason ?? ""),
      "token_scope",
      "the record must carry token_scope, not push_failure",
    );
  },
});

Deno.test({
  name:
    "completion - an unreadable diff falls back to the commit list, so the scope check still fires (Issue #1952)",
  permissions: { read: true, write: true },
  async fn() {
    const outcome = await runCompletion({
      scope: "absent",
      diffAnswers: false,
      changedFiles: [".github/workflows/gitleaks.yml", "README.md"],
      pushRefused: false,
    });
    assertEquals(outcome.status, "failure");
    assertEquals(outcome.pushes, 0, "no push may be attempted");
    assertStringIncludes(
      outcome.reason ?? "",
      ".github/workflows/gitleaks.yml",
    );
    assertEquals(detectFailureCategory(outcome.reason ?? ""), "token_scope");
    assertEquals(
      outcome.warnings.some((w) => w.includes("commit list")),
      true,
      "the fallback must be logged, not silent",
    );
  },
});

Deno.test({
  name:
    "completion - an unknown scope verdict is logged, and the push still proceeds (Issue #1952)",
  permissions: { read: true, write: true },
  async fn() {
    const outcome = await runCompletion({
      scope: "unknown",
      diffAnswers: true,
      changedFiles: [".github/workflows/gitleaks.yml"],
      pushRefused: false,
    });
    assertEquals(outcome.pushes, 1, "fail open, as before");
    assertEquals(
      outcome.warnings.some((w) =>
        w.includes("workflow") && w.includes("no token-scope verdict")
      ),
      true,
      "a check that cannot answer must say so",
    );
  },
});
