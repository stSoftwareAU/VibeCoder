/**
 * Integration tests for wiring resolveImagePaths() into the PR-creation
 * pipeline (Issue #2230).
 *
 * The resolver (Issue #2229) is a pure transform; the completion phase is the
 * integration point. These tests exercise the full pipeline through
 * processScreenshotEvidence() so the GitHub raw URL ends up correct, and
 * verify that the soft gate never fails PR creation on a warning.
 *
 * Issue #3939: retargeted from the orphaned `pr_completion_phase.ts` module
 * (deleted with that issue) to `workOnIssueCompletion`, the path the worker
 * actually runs.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { resolveImagePaths } from "../lib/image_path_resolver.ts";
import { processScreenshotEvidence } from "../lib/pr_evidence.ts";
import { workOnIssueCompletion } from "../lib/phases/completion_phase.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type { GitHubClient } from "../types.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";

// =============================================================================
// Pipeline: resolveImagePaths -> processScreenshotEvidence
// =============================================================================

Deno.test("integration - rewritten path feeds processScreenshotEvidence to a GitHub raw URL", async () => {
  const repoDir = await Deno.makeTempDir();
  try {
    // Only docs/screenshots/foo.png exists on disk; the body points at the
    // wrong docs/evidence/foo.png directory.
    await Deno.mkdir(`${repoDir}/docs/screenshots`, { recursive: true });
    await Deno.writeTextFile(`${repoDir}/docs/screenshots/foo.png`, "fake-png");

    const body = "## Evidence\n![Shot](docs/evidence/foo.png)\n";

    // Step 2b: resolver rewrites the broken path.
    const resolved = await resolveImagePaths(body, repoDir);
    assertEquals(resolved.rewrites, [
      { from: "docs/evidence/foo.png", to: "docs/screenshots/foo.png" },
    ]);
    assertEquals(resolved.warnings, []);
    assertStringIncludes(resolved.body, "docs/screenshots/foo.png");

    // Step 3: evidence processing now sees the rewritten path and converts it.
    const evidence = await processScreenshotEvidence(resolved.body, {
      repoPath: repoDir,
      githubRepo: "org/repo",
      screenshotDir: "docs/screenshots",
      gitCommandFn: async (_args: string[]) => "deadbeef\n",
    });

    assertEquals(evidence.screenshotsConverted, 1);
    assertStringIncludes(
      evidence.content,
      "https://github.com/org/repo/raw/deadbeef/docs/screenshots/foo.png",
    );
    // The broken docs/evidence path must no longer be present.
    assertEquals(evidence.content.includes("docs/evidence/foo.png"), false);
  } finally {
    await Deno.remove(repoDir, { recursive: true });
  }
});

Deno.test("integration - clean path is a resolver no-op (no rewrites, no warnings)", async () => {
  const repoDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${repoDir}/docs/evidence`, { recursive: true });
    await Deno.writeTextFile(`${repoDir}/docs/evidence/foo.png`, "fake-png");

    const body = "## Evidence\n![Shot](docs/evidence/foo.png)\n";
    const resolved = await resolveImagePaths(body, repoDir);

    assertEquals(resolved.rewrites, []);
    assertEquals(resolved.warnings, []);
    assertEquals(resolved.body, body);
  } finally {
    await Deno.remove(repoDir, { recursive: true });
  }
});

// =============================================================================
// Soft gate: PR creation does not fail on a resolver warning
// =============================================================================

/** Minimal GitHub client stub — the soft gate must not touch the issue. */
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

Deno.test("integration - PR creation does not fail when resolver emits a warning", async () => {
  const workDir = await Deno.makeTempDir();
  try {
    // PR summary references an image that exists nowhere on disk -> warning,
    // and the broken path must be left untouched in the body.
    await Deno.mkdir(`${workDir}/docs/archive/pr-summaries`, {
      recursive: true,
    });
    await Deno.writeTextFile(
      `${workDir}/docs/archive/pr-summaries/pr-summary-2230.md`,
      "## Summary\nCloses #2230\n\n## Evidence\n![Missing](docs/evidence/missing.png)\n",
    );

    const ctx: IssueContext = {
      repo: "org/test-repo",
      issueNumber: 2230,
      issueTitle: "Wire resolver",
      issueBody: "",
      issueLabels: ["enhancement", "work-on"],
      issueComments: "",
      githubUser: "test-worker",
      config: buildDefaultWorkerConfig(),
    };
    const state: PhaseState = {
      branchName: "issue-2230-wire-resolver",
      baseBranch: "main",
      defaultBranch: "main",
      repoPath: workDir,
      clarityStatus: "assessed_clear",
      claudeOutput: "",
      executeStartTime: 0,
      baselineQualityPassed: true,
      baselineQualityOutput: "",
    };

    let prCreated = false;
    const deps = createMockDeps({
      github: {
        createClient: () => stubClient(),
        runGhCommand: (args: string[]) => {
          if (args[0] === "pr" && args[1] === "create") prCreated = true;
          return Promise.resolve("https://github.com/org/repo/pull/99\n");
        },
      },
      git: {
        runGitCommand: (cmdArgs: string[]) =>
          Promise.resolve({
            ok: true as const,
            value: {
              code: 0,
              stdout: cmdArgs[0] === "rev-parse" ? "abc123def\n" : "",
              stderr: "",
            },
          }),
      },
      pr: {
        findExistingPrForIssue: () =>
          Promise.resolve({ ok: false, error: new Error("none") }),
        findExistingPrForBranch: () =>
          Promise.resolve({ ok: false, error: new Error("none") }),
      },
    });

    const result = await workOnIssueCompletion(ctx, state, deps);

    assertEquals(result.status, "continue");
    assertEquals(prCreated, true);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});
