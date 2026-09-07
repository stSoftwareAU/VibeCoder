/**
 * Issue #1475: the completion phase refuses to push a branch that changes
 * `.github/workflows/` when the token lacks the `workflow` scope, and says
 * so with the fix — before any push, so no recovery ladder runs and the
 * failure is classified as the host's credential, not the issue.
 *
 * Drives `workOnIssueCompletion`, the path `issue_worker.ts` actually runs,
 * with the scope verdict injected through `deps.infrastructure` — the seam
 * production fills from the launcher's preflight — so no test mutates the
 * process environment (Issue #880).
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

const SHA = "1f0c2b3a4d5e6f708192a3b4c5d6e7f8091a2b3c";

const SUMMARY = `## Summary
Added the gitleaks workflow. Closes #10.

## Test Plan
- Ran the workflow locally with act.
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

interface Outcome {
  status: string;
  reason?: string;
  pushes: number;
  prCreateCalls: number;
}

async function runCompletion(
  changedFiles: string[],
  scope: "true" | "false" | undefined,
): Promise<Outcome> {
  const repoPath = await Deno.makeTempDir();
  await Deno.mkdir(`${repoPath}/docs/archive/pr-summaries`, {
    recursive: true,
  });
  await Deno.writeTextFile(
    `${repoPath}/docs/archive/pr-summaries/pr-summary-10.md`,
    SUMMARY,
  );
  const comments: string[] = [];
  let prCreateCalls = 0;
  let pushes = 0;
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
    github: {
      createClient: () => stubClient(comments),
      runGhCommand: (args: string[]) => {
        if (args[0] === "pr" && args[1] === "create") prCreateCalls++;
        return Promise.resolve(
          "https://github.com/stSoftwareAU/GRQ-VibeCoder/pull/99",
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
          return ok(changedFiles.join("\n"));
        }
        if (cmdArgs[0] === "rev-list") return ok("1\n");
        return ok("");
      },
      pushUnpushedCommits: () => {
        pushes++;
        return Promise.resolve({ ok: true as const, value: 1 });
      },
    },
    pr: {
      findExistingPrForIssue: () =>
        Promise.resolve({ ok: false, error: new Error("none") }),
      findExistingPrForBranch: () =>
        Promise.resolve({ ok: false, error: new Error("none") }),
    },
    // `undefined` models a launcher that recorded no verdict: fail open.
    infrastructure: { tokenHasWorkflowScope: () => scope !== "false" },
  });
  try {
    const result = await workOnIssueCompletion(ctx, state, deps);
    return {
      status: result.status,
      reason: result.status === "failure" ? result.reason : undefined,
      pushes,
      prCreateCalls,
    };
  } finally {
    await Deno.remove(repoPath, { recursive: true });
  }
}

Deno.test({
  name:
    "completion - without the workflow scope, a workflow change fails before any push, naming the fix (Issue #1475)",
  permissions: { read: true, write: true },
  async fn() {
    const outcome = await runCompletion(
      [".github/workflows/gitleaks.yml", "README.md"],
      "false",
    );
    assertEquals(outcome.status, "failure");
    assertEquals(outcome.pushes, 0, "no push must be attempted");
    assertEquals(outcome.prCreateCalls, 0);
    assertStringIncludes(
      outcome.reason ?? "",
      ".github/workflows/gitleaks.yml",
    );
    assertStringIncludes(outcome.reason ?? "", "gh auth refresh -s workflow");
    assertEquals(
      detectFailureCategory(outcome.reason ?? ""),
      "token_scope",
      "the host's credential is blamed, not the issue",
    );
  },
});

Deno.test({
  name:
    "completion - without the scope, a change that touches no workflow is pushed as normal (Issue #1475)",
  permissions: { read: true, write: true },
  async fn() {
    const outcome = await runCompletion(
      ["README.md", ".github/CODEOWNERS"],
      "false",
    );
    assertEquals(
      outcome.status !== "failure" ||
        !(outcome.reason ?? "").includes("workflow"),
      true,
      outcome.reason,
    );
    assertEquals(outcome.pushes, 1, "the push proceeds");
  },
});

Deno.test({
  name:
    "completion - with the scope, or with no preflight verdict, a workflow change is pushed (Issue #1475)",
  permissions: { read: true, write: true },
  async fn() {
    for (const scope of ["true", undefined] as const) {
      const outcome = await runCompletion([".github/workflows/ci.yml"], scope);
      assertEquals(
        outcome.pushes,
        1,
        `scope=${String(scope)}: the push proceeds`,
      );
    }
  },
});
