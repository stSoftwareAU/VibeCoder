/**
 * The main-loop execute phase must grant the Playwright MCP browser only to a
 * run that needs one (Issue #192).
 *
 * This is the fleet path that hands the agent a `cwd`, and a `cwd` alone used
 * to wire the browser — outbound HTTP through a full browser context — into
 * every issue the worker touched, including backend issues with no UI. The
 * grant now rides an explicit need signal: the `needs-screenshot` label, or a
 * repo configured with `requiresScreenshots`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { workOnIssueExecuteClaude } from "../lib/phases/execute_phase.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import type { RepoConfig, WorkerConfig } from "../types.ts";

/** Run the execute phase once and report the `mcpConfig` the runner saw. */
async function capturedMcpConfig(
  issueLabels: string[],
  repoConfig?: Record<string, RepoConfig>,
): Promise<boolean | undefined> {
  const config: WorkerConfig = buildDefaultWorkerConfig();
  if (repoConfig) config.repoConfig = repoConfig;
  const ctx: IssueContext = {
    repo: "org/repo",
    issueNumber: 192,
    issueTitle: "Work me",
    issueBody: "Do the thing.",
    issueLabels,
    issueComments: "",
    githubUser: "testbot",
    config,
  };
  const state: PhaseState = {
    branchName: "issue-192-work-me",
    baseBranch: "main",
    defaultBranch: "main",
    repoPath: "/tmp/test-repo",
    clarityStatus: "assessed_clear",
    claudeOutput: "",
    executeStartTime: Date.now(),
    baselineQualityPassed: true,
    baselineQualityOutput: "",
  };
  const seen: Array<Record<string, unknown>> = [];
  const deps = createMockDeps({
    claude: {
      runClaudeWithRetry: ((options: Record<string, unknown>) => {
        seen.push(options);
        return Promise.resolve({
          ok: true,
          value: { output: "done", exitCode: 0, timedOut: false },
        });
      }) as never,
    },
    pr: {
      findExistingPrForIssue: (() =>
        Promise.resolve({ ok: true, value: null })) as never,
    },
  });

  await workOnIssueExecuteClaude(ctx, state, deps);

  assertEquals(seen.length >= 1, true, "the runner must be invoked");
  return seen[0]!.mcpConfig as boolean | undefined;
}

Deno.test("execute_phase - a backend issue is run with no browser MCP server (Issue #192)", async () => {
  assertEquals(
    await capturedMcpConfig(["enhancement", "work-on"]),
    false,
    "a cwd alone must not grant browser/network capability",
  );
});

Deno.test("execute_phase - a needs-screenshot issue is granted the browser (Issue #192)", async () => {
  assertEquals(
    await capturedMcpConfig(["enhancement", "needs-screenshot"]),
    true,
  );
});

Deno.test("execute_phase - a repo configured with requiresScreenshots is granted the browser (Issue #192)", async () => {
  assertEquals(
    await capturedMcpConfig(["enhancement"], {
      "org/repo": { requiresScreenshots: true } as unknown as RepoConfig,
    }),
    true,
  );
});
