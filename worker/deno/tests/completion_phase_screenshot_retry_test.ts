/**
 * The screenshot gate's one extra in-run agent turn before it fails the run
 * (Issue #2960).
 *
 * Mirrors `completion_phase_branch_evidence_test.ts`'s style: a temp repo
 * with a PR summary carrying no screenshot reference and a UI file changed, a
 * stubbed git/gh layer, and a stub `runClaudeWithRetry` that either "captures"
 * the missing evidence (appends a file to the mutable changed-files list and
 * writes it to disk) or does nothing, to exercise both branches of the
 * recovery.
 *
 * Australian English throughout.
 */

import { assert, assertEquals } from "@std/assert";
import { workOnIssueCompletion } from "../lib/phases/completion_phase.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type { GitHubClient } from "../types.ts";
import type { RunClaudeOptions } from "../lib/claude_runner.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { WorkerConfig } from "../types.ts";

const SHA = "deadbeef00deadbeef00deadbeef00deadbeef0";

function stubClient(
  posted: string[],
  labelsAdded: string[],
): GitHubClient {
  return {
    getIssue: () => {
      throw new Error("stub");
    },
    getIssueComments: () => Promise.resolve([]),
    addLabel: (_r, _n, label) => {
      labelsAdded.push(label);
      return Promise.resolve();
    },
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

async function makeRepo(issueNumber: number): Promise<string> {
  const root = await Deno.makeTempDir();
  await Deno.mkdir(`${root}/docs/evidence`, { recursive: true });
  await Deno.mkdir(`${root}/docs/archive/pr-summaries`, { recursive: true });
  await Deno.writeTextFile(
    `${root}/docs/archive/pr-summaries/pr-summary-${issueNumber}.md`,
    `## Summary\nA UI change with no screenshot reference.\n`,
  );
  return root;
}

interface Harness {
  repoPath: string;
  ctx: IssueContext;
  state: PhaseState;
  deps: ReturnType<typeof createMockDeps>;
  posted: string[];
  labelsAdded: string[];
  capturedPrCreates: string[][];
  agentCalls: RunClaudeOptions[];
}

type RunClaudeFn = (
  options: RunClaudeOptions,
) => ReturnType<
  ReturnType<typeof createMockDeps>["claude"]["runClaudeWithRetry"]
>;

/** Build a harness whose completion run reaches the screenshot gate. */
function makeHarness(options: {
  issueNumber?: number;
  changedFiles: string[];
  repoPath: string;
  runClaudeWithRetry: RunClaudeFn;
  config?: Partial<WorkerConfig>;
}): Harness {
  const issueNumber = options.issueNumber ?? 2960;
  const posted: string[] = [];
  const labelsAdded: string[] = [];
  const capturedPrCreates: string[][] = [];
  const agentCalls: RunClaudeOptions[] = [];

  const ctx: IssueContext = {
    repo: "stSoftwareAU/VibeCoder",
    issueNumber,
    issueTitle: "UI change needing a screenshot",
    issueBody: "",
    issueLabels: [],
    issueComments: "",
    githubUser: "testbot",
    config: { ...buildDefaultWorkerConfig(), ...options.config },
  };
  const state: PhaseState = {
    branchName: `issue-${issueNumber}`,
    baseBranch: "main",
    defaultBranch: "main",
    repoPath: options.repoPath,
    clarityStatus: "not_assessed",
    claudeOutput: "",
    executeStartTime: 0,
    baselineQualityPassed: true,
    baselineQualityOutput: "",
    sessionResumeState: { sessionId: "resume-session-2960", phaseCount: 1 },
  };

  const deps = createMockDeps({
    github: {
      createClient: () => stubClient(posted, labelsAdded),
      runGhCommand: (args: string[]) => {
        if (args[0] === "pr" && args[1] === "create") {
          capturedPrCreates.push(args);
        }
        return Promise.resolve(
          "https://github.com/stSoftwareAU/VibeCoder/pull/1",
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
              stdout: options.changedFiles.join("\n") + "\n",
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
    claude: {
      runClaudeWithRetry: (runOptions: RunClaudeOptions) => {
        agentCalls.push(runOptions);
        return options.runClaudeWithRetry(runOptions);
      },
    },
  });

  return {
    repoPath: options.repoPath,
    ctx,
    state,
    deps,
    posted,
    labelsAdded,
    capturedPrCreates,
    agentCalls,
  };
}

async function cleanup(h: Harness): Promise<void> {
  await Deno.remove(h.repoPath, { recursive: true }).catch(() => {});
}

Deno.test("completion - screenshot gate: extra turn captures the evidence and the run proceeds (Issue #2960)", async () => {
  const issueNumber = 2960;
  const repoPath = await makeRepo(issueNumber);
  const changedFiles = ["web/index.html"];

  const h = makeHarness({
    issueNumber,
    changedFiles,
    repoPath,
    runClaudeWithRetry: async () => {
      // Simulate the agent capturing and committing the screenshot.
      changedFiles.push("docs/evidence/after.png");
      await Deno.writeTextFile(`${repoPath}/docs/evidence/after.png`, "png");
      return {
        ok: true,
        value: { exitCode: 0, output: "captured", timedOut: false },
      };
    },
  });

  const result = await workOnIssueCompletion(h.ctx, h.state, h.deps);
  await cleanup(h);

  assertEquals(result.status, "continue", JSON.stringify(result));
  assertEquals(h.agentCalls.length, 1);
  assertEquals(h.capturedPrCreates.length, 1, "PR should be created");
  assert(
    !h.labelsAdded.includes("needs-screenshot"),
    "needs-screenshot must not be added",
  );
  assert(
    !h.posted.some((p) => p.includes("Screenshot Evidence Required")),
    "gate must not fail",
  );

  const call = h.agentCalls[0]!;
  assertStringIncludesPrompt(call.prompt, "Screenshot Evidence Required");
  assertEquals(call.mcpConfig, true);
  assertEquals(call.sessionResumeState, h.state.sessionResumeState);
  assertEquals(call.timeoutSeconds, 600);
});

function assertStringIncludesPrompt(prompt: string, needle: string): void {
  assert(
    prompt.includes(needle),
    `expected prompt to include "${needle}": ${prompt}`,
  );
}

Deno.test("completion - screenshot gate: configured timeout is honoured (Issue #2960)", async () => {
  const issueNumber = 2961;
  const repoPath = await makeRepo(issueNumber);
  const changedFiles = ["web/index.html"];

  const h = makeHarness({
    issueNumber,
    changedFiles,
    repoPath,
    config: { screenshotRetryTimeoutSeconds: 120 },
    runClaudeWithRetry: async () => {
      changedFiles.push("docs/evidence/after.png");
      await Deno.writeTextFile(`${repoPath}/docs/evidence/after.png`, "png");
      return {
        ok: true,
        value: { exitCode: 0, output: "captured", timedOut: false },
      };
    },
  });

  await workOnIssueCompletion(h.ctx, h.state, h.deps);
  await cleanup(h);

  assertEquals(h.agentCalls.length, 1);
  assertEquals(h.agentCalls[0]!.timeoutSeconds, 120);
});

Deno.test("completion - screenshot gate: extra turn does nothing, run fails as before (Issue #2960)", async () => {
  const issueNumber = 2962;
  const repoPath = await makeRepo(issueNumber);
  const changedFiles = ["web/index.html"];

  const h = makeHarness({
    issueNumber,
    changedFiles,
    repoPath,
    runClaudeWithRetry: () =>
      Promise.resolve({
        ok: true,
        value: { exitCode: 0, output: "did nothing", timedOut: false },
      }),
  });

  const result = await workOnIssueCompletion(h.ctx, h.state, h.deps);
  await cleanup(h);

  assertEquals(h.agentCalls.length, 1);
  assertEquals(h.labelsAdded.filter((l) => l === "needs-screenshot").length, 1);
  assertEquals(
    h.posted.filter((p) => p.includes("Screenshot Evidence Required")).length,
    1,
  );
  assertEquals(result.status, "failure");
  assertEquals(
    (result as { reason: string }).reason,
    "Screenshot evidence missing for UI-related change",
  );
  assertEquals(h.capturedPrCreates.length, 0);
});

Deno.test("completion - screenshot gate: extra turn throws, run fails as before (Issue #2960)", async () => {
  const issueNumber = 2963;
  const repoPath = await makeRepo(issueNumber);
  const changedFiles = ["web/index.html"];
  let diffCalls = 0;

  const h = makeHarness({
    issueNumber,
    changedFiles,
    repoPath,
    runClaudeWithRetry: () => {
      throw new Error("agent crashed");
    },
  });
  // Track diff calls to assert no re-run of completion happens.
  const originalRunGit = h.deps.git.runGitCommand;
  h.deps.git.runGitCommand = ((args: string[]) => {
    if (args[0] === "diff" && args.includes("--name-only")) diffCalls++;
    return originalRunGit(args);
  }) as typeof originalRunGit;

  const result = await workOnIssueCompletion(h.ctx, h.state, h.deps);
  await cleanup(h);

  assertEquals(h.agentCalls.length, 1);
  assertEquals(result.status, "failure");
  assertEquals(h.labelsAdded.filter((l) => l === "needs-screenshot").length, 1);
  assertEquals(
    h.posted.filter((p) => p.includes("Screenshot Evidence Required")).length,
    1,
  );
  // One diff call for the original attempt only — no re-run of completion.
  assertEquals(diffCalls, 1);
});

Deno.test("completion - screenshot gate: extra turn errors (ok:false), run fails as before (Issue #2960)", async () => {
  const issueNumber = 2964;
  const repoPath = await makeRepo(issueNumber);
  const changedFiles = ["web/index.html"];

  const h = makeHarness({
    issueNumber,
    changedFiles,
    repoPath,
    runClaudeWithRetry: () =>
      Promise.resolve({ ok: false, error: new Error("spawn failed") }),
  });

  const result = await workOnIssueCompletion(h.ctx, h.state, h.deps);
  await cleanup(h);

  assertEquals(h.agentCalls.length, 1);
  assertEquals(result.status, "failure");
  assertEquals(h.labelsAdded.filter((l) => l === "needs-screenshot").length, 1);
});

Deno.test("completion - screenshot gate: extra turn times out, run fails as before and no re-run (Issue #2960)", async () => {
  const issueNumber = 2965;
  const repoPath = await makeRepo(issueNumber);
  const changedFiles = ["web/index.html"];

  const h = makeHarness({
    issueNumber,
    changedFiles,
    repoPath,
    runClaudeWithRetry: () =>
      Promise.resolve({
        ok: true,
        value: { exitCode: 124, output: "", timedOut: true },
      }),
  });

  const result = await workOnIssueCompletion(h.ctx, h.state, h.deps);
  await cleanup(h);

  assertEquals(h.agentCalls.length, 1);
  assertEquals(result.status, "failure");
  assertEquals(h.capturedPrCreates.length, 0);
  assertEquals(h.labelsAdded.filter((l) => l === "needs-screenshot").length, 1);
});

Deno.test("completion - screenshot gate: not needed for a non-UI change (Issue #2960)", async () => {
  const issueNumber = 2966;
  const repoPath = await makeRepo(issueNumber);
  const changedFiles = ["src/foo.ts"];

  const h = makeHarness({
    issueNumber,
    changedFiles,
    repoPath,
    runClaudeWithRetry: () => {
      throw new Error("must not be called");
    },
  });

  const result = await workOnIssueCompletion(h.ctx, h.state, h.deps);
  await cleanup(h);

  assertEquals(h.agentCalls.length, 0);
  assertEquals(result.status, "continue", JSON.stringify(result));
});

Deno.test("completion - screenshot gate: not needed when evidence is already on the branch (Issue #2960)", async () => {
  const issueNumber = 2967;
  const repoPath = await makeRepo(issueNumber);
  await Deno.writeTextFile(`${repoPath}/docs/evidence/x.png`, "png");
  const changedFiles = ["web/index.html", "docs/evidence/x.png"];

  const h = makeHarness({
    issueNumber,
    changedFiles,
    repoPath,
    runClaudeWithRetry: () => {
      throw new Error("must not be called");
    },
  });

  const result = await workOnIssueCompletion(h.ctx, h.state, h.deps);
  await cleanup(h);

  assertEquals(h.agentCalls.length, 0);
  assertEquals(result.status, "continue", JSON.stringify(result));
});

Deno.test("completion - screenshot gate: not needed when the repo opts out via skip_screenshot_check (Issue #2960)", async () => {
  const issueNumber = 2968;
  const repoPath = await makeRepo(issueNumber);
  const changedFiles = ["web/index.html"];
  const repo = "stSoftwareAU/VibeCoder";

  const h = makeHarness({
    issueNumber,
    changedFiles,
    repoPath,
    config: {
      repoConfig: { [repo]: { skipScreenshotCheck: true } },
    },
    runClaudeWithRetry: () => {
      throw new Error("must not be called");
    },
  });

  const result = await workOnIssueCompletion(h.ctx, h.state, h.deps);
  await cleanup(h);

  assertEquals(h.agentCalls.length, 0);
  assertEquals(result.status, "continue", JSON.stringify(result));
});
