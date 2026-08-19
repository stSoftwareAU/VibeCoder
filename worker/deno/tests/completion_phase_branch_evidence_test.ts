/**
 * Screenshots committed on the branch but not referenced in the summary
 * count as evidence and are referenced in the PR body (Issue #4355). This
 * is the exact private-repo-10#831 shape: a WIP-resumed run captured three
 * real screenshots into docs/evidence/ while the first attempt's summary
 * ("No screenshot: the Playwright MCP browser is not available…") stayed in
 * place, and the gate failed the run for the summary text.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { workOnIssueCompletion } from "../lib/phases/completion_phase.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type { GitHubClient } from "../types.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import {
  findBranchEvidenceImages,
  formatBranchEvidenceSection,
  validateScreenshotEvidence,
} from "../lib/screenshot_validation.ts";

const SHA = "96a7fa00c0ffee00c0ffee00c0ffee00c0ffee00";

function stubClient(posted: string[]): GitHubClient {
  return {
    getIssue: () => {
      throw new Error("stub");
    },
    getIssueComments: () => Promise.resolve([]),
    addLabel: () => Promise.resolve(),
    removeLabel: () => Promise.resolve(),
    postComment: (_r, _n, body) => {
      posted.push(body);
      return Promise.resolve(undefined);
    },
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
  for (const f of ["issue-831-mvis-before.png", "issue-831-mvis-after.png"]) {
    await Deno.writeTextFile(`${root}/docs/evidence/${f}`, "png");
  }
  await Deno.writeTextFile(
    `${root}/docs/archive/pr-summaries/pr-summary-831.md`,
    `## Summary
Trust a price-confirmed large split; the chart line stays continuous. Closes #831.
## Evidence
No screenshot: the Playwright MCP browser is not available in this container.
`,
  );
  return root;
}

Deno.test("screenshot_validation - evidence images committed on the branch satisfy the gate when the summary carries no reference (Issue #4355)", () => {
  const changed = [
    "docs/projection.js",
    "docs/evidence/issue-831-mvis-before.png",
    "docs/evidence/issue-831-mvis-after.png",
    "docs/evidence/notes.txt",
    "src/other/evidence/not-here.png",
  ];
  assertEquals(findBranchEvidenceImages(changed), [
    "docs/evidence/issue-831-mvis-before.png",
    "docs/evidence/issue-831-mvis-after.png",
  ]);
  const result = validateScreenshotEvidence({
    prSummaryContent:
      "## Summary\nchart html css visual change, no image reference",
    issueLabels: "needs-screenshot",
    changedFiles: changed,
    repo: "o/r",
    issueNumber: 831,
  });
  assertEquals(result.valid, true);
  assertEquals(result.isUiChange, true);
  assertEquals(result.branchEvidence?.length, 2);
  // Without branch evidence the gate still fails as before.
  const failing = validateScreenshotEvidence({
    prSummaryContent: "## Summary\nchart html css visual change",
    issueLabels: "needs-screenshot",
    changedFiles: ["docs/projection.js"],
    repo: "o/r",
    issueNumber: 831,
  });
  assertEquals(failing.valid, false);
  assertStringIncludes(
    formatBranchEvidenceSection(["docs/evidence/issue-831-mvis-after.png"]),
    "![issue-831-mvis-after](docs/evidence/issue-831-mvis-after.png)",
  );
  assertEquals(formatBranchEvidenceSection([]), "");
});

Deno.test("completion - screenshots on the branch are referenced in the PR body (as raw URLs) and the run passes the gate even though the summary names none (Issue #4355)", async () => {
  const repoPath = await makeRepo();
  const capturedBodies: string[] = [];
  const posted: string[] = [];
  const ctx: IssueContext = {
    repo: "stSoftwareAU/private-repo-10",
    issueNumber: 831,
    issueTitle: "bug: 1-for-15 reverse split unadjusted",
    issueBody: "",
    issueLabels: ["top-priority", "needs-screenshot"],
    issueComments: "",
    githubUser: "testbot",
    config: buildDefaultWorkerConfig(),
  };
  const state: PhaseState = {
    branchName: "issue-831-split",
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
      createClient: () => stubClient(posted),
      runGhCommand: (args: string[]) => {
        if (args[0] === "pr" && args[1] === "create") {
          const bodyIdx = args.indexOf("--body");
          if (bodyIdx >= 0) capturedBodies.push(args[bodyIdx + 1]!);
        }
        return Promise.resolve(
          "https://github.com/stSoftwareAU/private-repo-10/pull/900",
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
              stdout:
                "docs/projection.js\ndocs/evidence/issue-831-mvis-before.png\ndocs/evidence/issue-831-mvis-after.png\n",
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
  assert(
    !posted.some((p) => p.includes("Screenshot Evidence Required")),
    "gate must not fail",
  );
  assertEquals(capturedBodies.length, 1);
  const body = capturedBodies[0]!;
  assertStringIncludes(body, "## Evidence");
  for (const f of ["issue-831-mvis-before.png", "issue-831-mvis-after.png"]) {
    assertStringIncludes(
      body,
      `https://github.com/stSoftwareAU/private-repo-10/raw/${SHA}/docs/evidence/${f}`,
    );
  }
  assertEquals(
    body.includes("(docs/evidence/"),
    false,
    "relative paths converted",
  );
});
