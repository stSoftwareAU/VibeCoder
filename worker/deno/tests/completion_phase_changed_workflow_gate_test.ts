/**
 * Integration tests for the changed-workflow file-check gate running in the
 * LIVE completion phase (Issue #1859).
 *
 * These drive `workOnIssueCompletion` — the path `issue_worker.ts` actually
 * runs — and assert on the observable outcome: whether `gh pr create` was
 * invoked, and what the run reported when it was not.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { workOnIssueCompletion } from "../lib/phases/completion_phase.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type { GitHubClient, Result } from "../types.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";

const SHA = "1122334455667788990011223344556677889900";

const SUMMARY = `## Summary

Added a unit-test workflow. Closes #1859.

## Test Plan

- CI runs the new workflow on every PR
`;

/** A workflow that passes every file-scoped check. */
const CLEAN_WORKFLOW = `name: Unit Tests

on:
  pull_request:
    branches: [main, milestone/*]

permissions:
  contents: read

jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: read
    steps:
      - name: Checkout
        uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
        with:
          persist-credentials: false
      - name: Run tests
        run: |
          set -euo pipefail
          deno test --allow-none
          echo done
`;

/** The same workflow with the checkout pinned to a hijackable tag. */
const TAG_PINNED_WORKFLOW = CLEAN_WORKFLOW.replace(
  "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2",
  "actions/checkout@v4",
);

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
  prCreateCalls: number;
  comments: string[];
}

/**
 * Run the completion phase over a clone whose branch changed `files`.
 *
 * @param files - Repo-relative path → contents, written into the clone and
 *   reported by the stubbed `git diff`
 * @param changed - What the branch diff reports; defaults to every written
 *   file, so an entry omitted here is an untouched pre-existing file
 */
async function runCompletion(
  files: Record<string, string>,
  changed?: string[],
): Promise<Outcome> {
  const repoPath = await Deno.makeTempDir();
  await Deno.mkdir(`${repoPath}/docs/archive/pr-summaries`, {
    recursive: true,
  });
  await Deno.writeTextFile(
    `${repoPath}/docs/archive/pr-summaries/pr-summary-1859.md`,
    SUMMARY,
  );
  for (const [rel, content] of Object.entries(files)) {
    const dir = rel.slice(0, rel.lastIndexOf("/"));
    await Deno.mkdir(`${repoPath}/${dir}`, { recursive: true });
    await Deno.writeTextFile(`${repoPath}/${rel}`, content);
  }

  const comments: string[] = [];
  let prCreateCalls = 0;

  const ctx: IssueContext = {
    repo: "stSoftwareAU/VibeCoder",
    issueNumber: 1859,
    issueTitle: "Add a unit-test workflow",
    issueBody: "## Summary\n\nAdd a workflow that runs the unit tests.\n",
    issueLabels: ["enhancement", "work-on"],
    issueComments: "",
    githubUser: "testbot",
    config: buildDefaultWorkerConfig(),
  };
  const state: PhaseState = {
    branchName: "issue-1859-workflow",
    baseBranch: "main",
    defaultBranch: "main",
    repoPath,
    clarityStatus: "not_assessed",
    claudeOutput: "",
    executeStartTime: 0,
    baselineQualityPassed: true,
    baselineQualityOutput: "",
  };

  const diffOutput = (changed ?? Object.keys(files)).join("\n");

  const deps = createMockDeps({
    github: {
      createClient: () => stubClient(comments),
      runGhCommand: (args: string[]) => {
        if (args[0] === "pr" && args[1] === "create") prCreateCalls++;
        return Promise.resolve(
          "https://github.com/stSoftwareAU/VibeCoder/pull/101",
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
          return ok(diffOutput);
        }
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
  "completion - a changed workflow carrying a finding raises no PR",
  async () => {
    const outcome = await runCompletion({
      ".github/workflows/ci.yml": TAG_PINNED_WORKFLOW,
    });

    assertEquals(outcome.status, "failure");
    assertEquals(outcome.prCreateCalls, 0, "gh pr create must not run");
    assertStringIncludes(outcome.reason ?? "", "BP-SHA-PIN-actions-checkout");
    assertStringIncludes(outcome.reason ?? "", ".github/workflows/ci.yml:18");
    assertEquals(outcome.comments.length, 1, "the issue is told why");
    assertStringIncludes(outcome.comments[0]!, "BP-SHA-PIN-actions-checkout");
  },
);

Deno.test(
  "completion - a changed workflow with no finding raises the PR",
  async () => {
    const outcome = await runCompletion({
      ".github/workflows/ci.yml": CLEAN_WORKFLOW,
    });

    assertEquals(outcome.status, "continue");
    assertEquals(outcome.prCreateCalls, 1);
    assertEquals(outcome.comments.length, 0);
  },
);

Deno.test(
  "completion - a run that changes no workflow file is unaffected",
  async () => {
    const outcome = await runCompletion({
      "worker/deno/lib/date_parser.ts": "export const a = 1;\n",
    });

    assertEquals(outcome.status, "continue");
    assertEquals(outcome.prCreateCalls, 1);
  },
);

Deno.test(
  "completion - a pre-existing offending workflow does not block an unrelated PR",
  async () => {
    const outcome = await runCompletion(
      {
        ".github/workflows/ci.yml": TAG_PINNED_WORKFLOW,
        "worker/deno/lib/date_parser.ts": "export const a = 1;\n",
      },
      ["worker/deno/lib/date_parser.ts"],
    );

    assertEquals(outcome.status, "continue");
    assertEquals(outcome.prCreateCalls, 1);
  },
);

Deno.test(
  "completion - an unreadable changed workflow file fails loud",
  async () => {
    const outcome = await runCompletion({}, [".github/workflows/gone.yml"]);

    assertEquals(outcome.status, "failure");
    assertEquals(outcome.prCreateCalls, 0);
    assertStringIncludes(outcome.reason ?? "", "could not read");
    assertStringIncludes(outcome.reason ?? "", ".github/workflows/gone.yml");
  },
);
