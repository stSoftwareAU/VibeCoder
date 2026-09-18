/**
 * A UI file changed only by a version stamp does not make the change a UI
 * change (Issue #2300).
 *
 * GRQ-health#211: a backend change to run.sh carried update_version.sh's
 * cache-busting bump in index.html, sw.js and dashboard.js — the
 * repository's own quality check demands it — and the screenshot gate failed
 * a 44-minute run for a screenshot of nothing. The completion phase now reads
 * each changed UI file's own patch and sets a bump-only file aside.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { workOnIssueCompletion } from "../lib/phases/completion_phase.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type { GitHubClient } from "../types.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";

const SHA = "96a7fa00c0ffee00c0ffee00c0ffee00c0ffee00";

/** The patch the failed run carried, verbatim. */
const INDEX_HTML_BUMP = `diff --git a/docs/index.html b/docs/index.html
--- a/docs/index.html
+++ b/docs/index.html
@@ -40 +40 @@
-    <link href="./styles.css?v=1.1.28" rel="stylesheet">
+    <link href="./styles.css?v=1.1.30" rel="stylesheet">
@@ -146 +146 @@
-    <script src="./dashboard.js?v=1.1.28"></script>
+    <script src="./dashboard.js?v=1.1.30"></script>
`;

/** The same file with a real edit beside the bump. */
const INDEX_HTML_RESTYLED = `diff --git a/docs/index.html b/docs/index.html
--- a/docs/index.html
+++ b/docs/index.html
@@ -40 +40 @@
-    <link href="./styles.css?v=1.1.28" rel="stylesheet">
+    <link href="./styles.css?v=1.1.30" rel="stylesheet">
@@ -60 +60 @@
-    <h1>GRQ Health</h1>
+    <h1 class="display-4">GRQ Health</h1>
`;

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
  await Deno.mkdir(`${root}/docs/archive/pr-summaries`, { recursive: true });
  await Deno.writeTextFile(
    `${root}/docs/archive/pr-summaries/pr-summary-211.md`,
    "## Summary\n\nOnly a bounded log tail is published; the html pages are cache-busted. Closes #211.\n\n## Evidence\n\nBackend/CLI change — there is no new web interface to screenshot.\n",
  );
  return root;
}

/** Drive completion with a git stub that serves the given index.html patch. */
async function run(indexHtmlPatch: string) {
  const repoPath = await makeRepo();
  const posted: string[] = [];
  const patchedFiles: string[] = [];
  let prCreated = false;
  const ctx: IssueContext = {
    repo: "stSoftwareAU/GRQ-health",
    issueNumber: 211,
    issueTitle: "Repository is 897 MB for a 32 MB tree",
    issueBody: "",
    issueLabels: ["work-on"],
    issueComments: "",
    githubUser: "testbot",
    config: buildDefaultWorkerConfig(),
  };
  const state: PhaseState = {
    branchName: "issue-211-repository-is-897-mb",
    baseBranch: "Develop",
    defaultBranch: "Develop",
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
        if (args[0] === "pr" && args[1] === "create") prCreated = true;
        return Promise.resolve(
          "https://github.com/stSoftwareAU/GRQ-health/pull/900",
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
        if (cmdArgs[0] === "diff" && cmdArgs[1] === "--name-only") {
          return Promise.resolve({
            ok: true,
            value: {
              code: 0,
              stdout:
                "run.sh\nhelpers/compact-history.sh\ndocs/index.html\ndocs/sw.js\ndocs/archive/pr-summaries/pr-summary-211.md\n",
              stderr: "",
            },
          });
        }
        if (cmdArgs[0] === "diff" && cmdArgs.includes("--")) {
          const file = cmdArgs[cmdArgs.length - 1]!;
          patchedFiles.push(file);
          return Promise.resolve({
            ok: true,
            value: {
              code: 0,
              stdout: file === "docs/index.html" ? indexHtmlPatch : "",
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
  return { result, posted, patchedFiles, prCreated };
}

Deno.test("completion - a version bump in index.html is not a UI change, so a backend change is not gated on screenshots (Issue #2300)", async () => {
  const { result, posted, patchedFiles, prCreated } = await run(
    INDEX_HTML_BUMP,
  );
  assertEquals(
    patchedFiles,
    ["docs/index.html"],
    "only the UI-extension files have their patch read",
  );
  assertEquals(result.status, "continue", JSON.stringify(result));
  assert(
    !posted.some((p) => p.includes("Screenshot Evidence Required")),
    "a cache-busting bump must not be gated on screenshots",
  );
  assert(prCreated, "the PR is created");
});

Deno.test("completion - a real edit beside the bump is still a UI change and is gated (Issue #2300)", async () => {
  const { result, posted, prCreated } = await run(INDEX_HTML_RESTYLED);
  assertEquals(result.status, "failure", JSON.stringify(result));
  assert(
    posted.some((p) => p.includes("Screenshot Evidence Required")),
    "a restyled page without evidence is gated as before",
  );
  assert(!prCreated, "no PR is created");
});
