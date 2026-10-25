/**
 * A pull request body over GitHub's 65,536-character limit gets one summarise
 * turn before anything is cut, then the same completion checks, then the
 * shorter body is what `gh pr create` and `gh pr edit --body` publish
 * (Issue #4359).
 *
 * The agent and `gh` are injected. Nothing here calls GitHub.
 *
 * Australian English throughout.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { workOnIssueCompletion } from "../lib/phases/completion_phase.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type { GitHubClient } from "../types.ts";
import type { RunClaudeOptions } from "../lib/claude_runner.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { GITHUB_ISSUE_BODY_MAX_CHARS } from "../lib/idle_task_body_limit.ts";

const ISSUE = 4359;
const FILLER = "LENGTH-FILLER-4359\n";
const SHORT_MARKER = "SHORT-SUMMARY-MARKER-4359";
const SUMMARY_PATH = `docs/archive/pr-summaries/pr-summary-${ISSUE}.md`;
const PR_URL = "https://github.com/stSoftwareAU/VibeCoder/pull/91";

function longSummary(): string {
  // Comfortably over the limit once the worker appends its footer.
  return `## Summary\n\n${FILLER.repeat(4000)}\n\nCloses #${ISSUE}.\n`;
}

function shortSummary(): string {
  return [
    "## Summary",
    "",
    `${SHORT_MARKER}. Closes #${ISSUE}.`,
    "",
    `Full summary: [\`${SUMMARY_PATH}\`](${SUMMARY_PATH})`,
    "",
  ].join("\n");
}

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

interface Harness {
  repoPath: string;
  ctx: IssueContext;
  state: PhaseState;
  deps: ReturnType<typeof createMockDeps>;
  ghCalls: string[][];
  agentCalls: RunClaudeOptions[];
  recoveredBodies: string[];
}

async function makeRepo(): Promise<string> {
  const root = await Deno.makeTempDir();
  await Deno.mkdir(`${root}/docs/archive/pr-summaries`, { recursive: true });
  await Deno.writeTextFile(`${root}/${SUMMARY_PATH}`, longSummary());
  return root;
}

function makeHarness(
  repoPath: string,
  options: {
    runClaudeWithRetry: (
      options: RunClaudeOptions,
    ) => ReturnType<
      ReturnType<typeof createMockDeps>["claude"]["runClaudeWithRetry"]
    >;
    runGhCommand?: (args: string[]) => Promise<string>;
    existingPr?: boolean;
  },
): Harness {
  const ghCalls: string[][] = [];
  const agentCalls: RunClaudeOptions[] = [];
  const recoveredBodies: string[] = [];
  const ctx: IssueContext = {
    repo: "stSoftwareAU/VibeCoder",
    issueNumber: ISSUE,
    issueTitle: "PR body has no length limit",
    issueBody: "",
    issueLabels: [],
    issueComments: "",
    githubUser: "testbot",
    config: buildDefaultWorkerConfig(),
  };
  const state: PhaseState = {
    branchName: `issue-${ISSUE}-pr-body-limit`,
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
        ghCalls.push(args);
        if (options.runGhCommand) return options.runGhCommand(args);
        return Promise.resolve(PR_URL);
      },
    },
    pr: {
      ...(options.existingPr
        ? {
          findExistingPrForBranch: () =>
            Promise.resolve({ ok: true as const, value: PR_URL }),
          recoverExistingPr: (
            _repo: string,
            _issueNumber: number,
            _prUrl: string,
            prBody?: string,
          ) => {
            if (prBody !== undefined) recoveredBodies.push(prBody);
            return Promise.resolve({
              ok: true as const,
              value: "recovered",
            });
          },
        }
        : {}),
    },
    claude: {
      runClaudeWithRetry: (runOptions: RunClaudeOptions) => {
        agentCalls.push(runOptions);
        return options.runClaudeWithRetry(runOptions);
      },
    },
  });
  return { repoPath, ctx, state, deps, ghCalls, agentCalls, recoveredBodies };
}

function createdBody(ghCalls: string[][]): string | undefined {
  const create = ghCalls.find((args) =>
    args[0] === "pr" && args[1] === "create"
  );
  if (!create) return undefined;
  const index = create.indexOf("--body");
  return index >= 0 ? create[index + 1] : undefined;
}

function rewriteShort(repoPath: string): Promise<void> {
  return Deno.writeTextFile(`${repoPath}/${SUMMARY_PATH}`, shortSummary());
}

Deno.test(
  "completion - an over-long summary gets one summarise turn and the PR is raised with the shorter body (Issue #4359)",
  async () => {
    const repoPath = await makeRepo();
    const h = makeHarness(repoPath, {
      runClaudeWithRetry: async (options) => {
        assert(
          !options.prompt.includes(FILLER.trim()),
          "the summarise prompt must not paste the over-long summary",
        );
        assertStringIncludes(options.prompt, SUMMARY_PATH);
        assertStringIncludes(options.prompt, String(GITHUB_ISSUE_BODY_MAX_CHARS));
        assertStringIncludes(options.prompt, "vibe-spec-review");
        assertStringIncludes(options.prompt, "Condense");
        await rewriteShort(repoPath);
        return {
          ok: true,
          value: { exitCode: 0, output: "rewritten", timedOut: false },
        };
      },
    });
    try {
      const result = await workOnIssueCompletion(h.ctx, h.state, h.deps);
      assertEquals(result.status, "continue", JSON.stringify(result));
      assertEquals(h.agentCalls.length, 1, "exactly one summarise turn");
      const body = createdBody(h.ghCalls);
      assert(body !== undefined, "gh pr create must run");
      assert(
        body.length <= GITHUB_ISSUE_BODY_MAX_CHARS,
        `published body is ${body.length} characters`,
      );
      assertStringIncludes(body, SHORT_MARKER);
      assert(
        !body.includes(FILLER.trim()),
        "the published body must be the rewrite, not a cut of the original",
      );
      const createAt = h.ghCalls.findIndex((args) =>
        args[0] === "pr" && args[1] === "create"
      );
      assert(createAt >= 0);
      assertEquals(
        h.ghCalls.slice(0, createAt).some((args) =>
          args[0] === "pr" && args[1] === "create"
        ),
        false,
      );
    } finally {
      await Deno.remove(repoPath, { recursive: true });
    }
  },
);

Deno.test(
  "completion - an existing PR is edited with the rewritten shorter body (Issue #4359)",
  async () => {
    const repoPath = await makeRepo();
    const h = makeHarness(repoPath, {
      existingPr: true,
      runClaudeWithRetry: async () => {
        await rewriteShort(repoPath);
        return {
          ok: true,
          value: { exitCode: 0, output: "rewritten", timedOut: false },
        };
      },
    });
    try {
      const result = await workOnIssueCompletion(h.ctx, h.state, h.deps);
      assertEquals(result.status, "continue", JSON.stringify(result));
      assertEquals(h.agentCalls.length, 1);
      assertEquals(createdBody(h.ghCalls), undefined, "gh pr create must not run");
      assertEquals(h.recoveredBodies.length, 1);
      const body = h.recoveredBodies[0]!;
      assert(body.length <= GITHUB_ISSUE_BODY_MAX_CHARS);
      assertStringIncludes(body, SHORT_MARKER);
      assert(!body.includes(FILLER.trim()));
    } finally {
      await Deno.remove(repoPath, { recursive: true });
    }
  },
);

Deno.test(
  "completion - a failed summarise turn still raises the PR with a shortened body (Issue #4359)",
  async () => {
    const repoPath = await makeRepo();
    const h = makeHarness(repoPath, {
      runClaudeWithRetry: () => {
        throw new Error("agent boom");
      },
    });
    try {
      const result = await workOnIssueCompletion(h.ctx, h.state, h.deps);
      assertEquals(result.status, "continue", JSON.stringify(result));
      assertEquals(h.agentCalls.length, 1, "the failed turn is not retried");
      const body = createdBody(h.ghCalls);
      assert(body !== undefined, "gh pr create must still run");
      assert(body.length <= GITHUB_ISSUE_BODY_MAX_CHARS);
      assertStringIncludes(body, SUMMARY_PATH);
    } finally {
      await Deno.remove(repoPath, { recursive: true });
    }
  },
);

Deno.test(
  "completion - a gh failure that is not the body-length error still fails the run (Issue #4359)",
  async () => {
    const repoPath = await makeRepo();
    const h = makeHarness(repoPath, {
      runClaudeWithRetry: async () => {
        await rewriteShort(repoPath);
        return {
          ok: true,
          value: { exitCode: 0, output: "rewritten", timedOut: false },
        };
      },
      runGhCommand: (args) => {
        if (args[0] === "pr" && args[1] === "create") {
          return Promise.reject(new Error("authentication failed"));
        }
        return Promise.resolve(PR_URL);
      },
    });
    try {
      const result = await workOnIssueCompletion(h.ctx, h.state, h.deps);
      assertEquals(result.status, "failure");
      if (result.status !== "failure") return;
      assertStringIncludes(result.reason, "authentication failed");
      assert(
        !result.reason.includes("Body is too long"),
        "a real gh failure must not be reported as the length error",
      );
    } finally {
      await Deno.remove(repoPath, { recursive: true });
    }
  },
);
