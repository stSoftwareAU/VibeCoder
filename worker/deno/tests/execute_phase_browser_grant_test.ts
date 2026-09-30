/**
 * The main-loop execute phase grants the Playwright MCP browser to every run
 * unless the repository sets `skip_screenshot_check` (Issue #2925).
 *
 * Issue #192 wired it only on an explicit need signal — the `needs-screenshot`
 * label or `requiresScreenshots` — but the screenshot gate decides "UI change"
 * afterwards, from the diff. A run that touched UI files with no label had no
 * tool to take the screenshot the gate then demanded, and failed
 * (GRQ-AutoTrader#1772, #1788 and four more). Seconds of browser start-up are
 * cheaper than a failed run and a retry.
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

Deno.test("execute_phase - an issue with no screenshot label is still granted the browser (Issue #2925)", async () => {
  assertEquals(
    await capturedMcpConfig(["enhancement", "work-on"]),
    true,
    "the gate judges UI changes from the diff, so the tool must be there up front",
  );
});

Deno.test("execute_phase - skip_screenshot_check withholds the browser, even with the label (Issue #2925)", async () => {
  assertEquals(
    await capturedMcpConfig(["enhancement", "needs-screenshot"], {
      "org/repo": { skipScreenshotCheck: true } as unknown as RepoConfig,
    }),
    false,
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
