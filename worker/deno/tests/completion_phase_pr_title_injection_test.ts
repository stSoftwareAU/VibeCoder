/**
 * The issue title reaches `gh pr create --title` scrubbed of issue-reference
 * syntax (Issue #1248).
 *
 * The failure this encodes: an issue titled `Add caching [#999]` produced the
 * fleet-authored PR title *"Add caching [#999] (Issue #5)"*, which every
 * title matcher reads as a reference to issue #999 as well. A merged PR
 * blocks permanently (Issue #3151), so filing one such issue stranded #999
 * for good under a skip reason that reads like a passing cooldown.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertFalse } from "@std/assert";
import { workOnIssueCompletion } from "../lib/phases/completion_phase.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type { GitHubClient } from "../types.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import {
  prTitleMatchesIssue,
  prTitleReferencesIssue,
} from "../lib/pr_title_issue_ref.ts";

const SHA = "96a7fa00c0ffee00c0ffee00c0ffee00c0ffee00";

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

async function makeRepo(): Promise<string> {
  const root = await Deno.makeTempDir();
  await Deno.mkdir(`${root}/docs/archive/pr-summaries`, { recursive: true });
  await Deno.writeTextFile(
    `${root}/docs/archive/pr-summaries/pr-summary-5.md`,
    "## Summary\n\nAdd caching. Closes #5.\n",
  );
  return root;
}

Deno.test("completion - an issue-reference in the issue title does not reach the PR title (Issue #1248)", async () => {
  const repoPath = await makeRepo();
  const capturedTitles: string[] = [];
  const ctx: IssueContext = {
    repo: "stSoftwareAU/VibeCoder",
    issueNumber: 5,
    // The attacker-supplied title: any issue author can pick it.
    issueTitle: "Add caching [#999]",
    issueBody: "",
    issueLabels: [],
    issueComments: "",
    githubUser: "testbot",
    config: buildDefaultWorkerConfig(),
  };
  const state: PhaseState = {
    branchName: "issue-5-add-caching",
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
      createClient: () => stubClient(),
      runGhCommand: (args: string[]) => {
        if (args[0] === "pr" && args[1] === "create") {
          const titleIdx = args.indexOf("--title");
          if (titleIdx >= 0) capturedTitles.push(args[titleIdx + 1]!);
        }
        return Promise.resolve(
          "https://github.com/stSoftwareAU/VibeCoder/pull/900",
        );
      },
    },
    git: {
      runGitCommand: (cmdArgs: string[]) => {
        if (cmdArgs[0] === "rev-parse") {
          return Promise.resolve({
            ok: true,
            value: { code: 0, stdout: `${SHA}\n`, stderr: "" },
          });
        }
        if (cmdArgs[0] === "diff" && cmdArgs.includes("--name-only")) {
          return Promise.resolve({
            ok: true,
            value: {
              code: 0,
              stdout: "worker/deno/lib/cache.ts\n",
              stderr: "",
            },
          });
        }
        return Promise.resolve({
          ok: true,
          value: { code: 0, stdout: "", stderr: "" },
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

  assertEquals(result.status, "continue", JSON.stringify(result));
  assertEquals(capturedTitles.length, 1);
  const title = capturedTitles[0]!;
  assertFalse(
    prTitleReferencesIssue(title, 999),
    `PR title "${title}" still strands issue #999`,
  );
  assert(
    prTitleMatchesIssue(title, 5),
    `PR title "${title}" lost its own issue reference`,
  );
});
