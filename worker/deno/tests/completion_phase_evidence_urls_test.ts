/**
 * Tests that `workOnIssueCompletion` rewrites relative evidence image paths in
 * the PR body to commit-pinned raw GitHub URLs (Issue #2985).
 *
 * GitHub does not resolve relative image paths in PR descriptions, so the
 * production completion phase must convert `![alt](docs/evidence/foo.png)`
 * references to `https://github.com/<repo>/raw/<sha>/docs/evidence/foo.png`
 * before creating the PR. Previously this conversion only lived in the
 * never-called legacy `pr_completion_phase.ts` path, so every evidence image
 * shipped as a broken link.
 *
 * Australian English used throughout (behaviour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { workOnIssueCompletion } from "../lib/phases/completion_phase.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type { GitHubClient } from "../types.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";

const SHA = "9ad209d9b3f438e12562c046c06dfc6f9ad2d4d0";

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
  await Deno.mkdir(`${root}/docs/evidence`, { recursive: true });
  await Deno.mkdir(`${root}/docs/archive/pr-summaries`, { recursive: true });
  await Deno.writeTextFile(`${root}/docs/evidence/issue-2985-fix.png`, "img");
  await Deno.writeTextFile(
    `${root}/docs/archive/pr-summaries/pr-summary-2985.md`,
    `## Summary
Fixed it. Closes #2985.

## Evidence
![Fix](docs/evidence/issue-2985-fix.png)
![External](https://example.com/x.png)
`,
  );
  return root;
}

Deno.test(
  "completion - converts relative evidence images to raw URLs in the PR body",
  async () => {
    const repoPath = await makeRepo();
    const capturedBodies: string[] = [];

    const ctx: IssueContext = {
      repo: "stSoftwareAU/private-repo-10",
      issueNumber: 2985,
      issueTitle: "Evidence image links in PR are broken",
      issueBody: "",
      issueLabels: [],
      issueComments: "",
      githubUser: "testbot",
      config: buildDefaultWorkerConfig(),
    };
    const state: PhaseState = {
      branchName: "issue-2985-fix",
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
            const bodyIdx = args.indexOf("--body");
            if (bodyIdx >= 0) capturedBodies.push(args[bodyIdx + 1]!);
          }
          return Promise.resolve(
            "https://github.com/stSoftwareAU/private-repo-10/pull/99",
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
          // diff --name-only and anything else: empty output.
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

    assertEquals(result.status, "continue");
    assertEquals(capturedBodies.length, 1, "PR must be created once");
    const body = capturedBodies[0]!;

    // The in-repo relative path is rewritten to a commit-pinned raw URL.
    assertStringIncludes(
      body,
      `https://github.com/stSoftwareAU/private-repo-10/raw/${SHA}/docs/evidence/issue-2985-fix.png`,
    );
    // No relative evidence path survives in the body.
    assertEquals(body.includes("(docs/evidence/"), false);
    // External images are untouched.
    assertStringIncludes(body, "https://example.com/x.png");
  },
);
