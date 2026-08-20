/**
 * The completion phase opens the PR over REST when `gh pr create` meets an
 * exhausted primary GraphQL quota (Issue #42).
 *
 * Observed live: 26 minutes of agent time, a green quality gate and a pushed
 * branch produced no PR at all, because `gh pr create` is GraphQL-backed and
 * the primary quota was gone. The REST `pulls` endpoint rides the separate
 * core quota (≈4 000 calls still available at the time), so the work lands.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { workOnIssueCompletion } from "../lib/phases/completion_phase.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type { GitHubClient } from "../types.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";

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

interface CompletionRun {
  status: string;
  reason?: string;
  ghCalls: string[][];
  infos: string[];
  warnings: string[];
}

/** Run the completion phase with a scripted `gh`. */
async function runCompletion(
  ghHandler: (args: string[]) => string,
): Promise<CompletionRun> {
  const repoPath = await Deno.makeTempDir();
  await Deno.mkdir(`${repoPath}/docs/archive/pr-summaries`, {
    recursive: true,
  });
  await Deno.writeTextFile(
    `${repoPath}/docs/archive/pr-summaries/pr-summary-16.md`,
    "## Summary\n\nFence milestone branch/title. Closes #16.\n",
  );

  const config = buildDefaultWorkerConfig();
  // Keep the bounded infra retry (Issue #1550) from adding its 15s backoff
  // to this suite — the retry itself is still exercised.
  config.infraRetryBackoffMs = 1;
  const ctx: IssueContext = {
    repo: "stSoftwareAU/VibeCoder",
    issueNumber: 16,
    issueTitle: "Milestone branch/title spliced into prompt instructions",
    issueBody: "",
    issueLabels: ["work-on"],
    issueComments: "",
    githubUser: "stservice",
    config,
  };
  const state: PhaseState = {
    branchName: "issue-16-milestone-branch-title",
    baseBranch: "main",
    defaultBranch: "main",
    repoPath,
    clarityStatus: "not_assessed",
    claudeOutput: "",
    executeStartTime: 0,
    baselineQualityPassed: true,
    baselineQualityOutput: "",
  };

  const ghCalls: string[][] = [];
  const infos: string[] = [];
  const warnings: string[] = [];
  const deps = createMockDeps({
    logger: {
      info: (m: string) => infos.push(m),
      warn: (m: string) => warnings.push(m),
      error: () => undefined,
      debug: () => undefined,
    } as never,
    github: {
      createClient: () => stubClient(),
      runGhCommand: (args: string[]) => {
        ghCalls.push(args);
        try {
          return Promise.resolve(ghHandler(args));
        } catch (err) {
          return Promise.reject(err);
        }
      },
    },
    git: {
      reconcileHeadToBranch: () =>
        Promise.resolve({
          ok: true as const,
          value: {
            action: "already-on-branch" as const,
            fromRef: "issue-16-milestone-branch-title",
          },
        }),
      pushUnpushedCommits: () => Promise.resolve({ ok: true as const, value: 2 }),
      runGitCommand: (args: string[]) =>
        Promise.resolve({
          ok: true as const,
          value: {
            code: 0,
            stdout: args[0] === "rev-list" ? "2\n" : "",
            stderr: "",
          },
        }),
    },
    pr: {
      // Both pre-checks are GraphQL-backed, so they are dead while the
      // quota is exhausted — exactly the state this fallback must survive.
      findExistingPrForIssue: () =>
        Promise.resolve({
          ok: false,
          error: new Error("GraphQL: API rate limit already exceeded"),
        }),
      findExistingPrForBranch: () =>
        Promise.resolve({
          ok: false,
          error: new Error("GraphQL: API rate limit already exceeded"),
        }),
    },
  });

  const result = await workOnIssueCompletion(ctx, state, deps);
  await Deno.remove(repoPath, { recursive: true });
  return {
    status: result.status,
    ...(result.status === "failure" ? { reason: result.reason } : {}),
    ghCalls,
    infos,
    warnings,
  };
}

const QUOTA_ERROR =
  "gh command failed (exit 1): GraphQL: API rate limit already exceeded for user ID 23146043.";

Deno.test("completion - an exhausted GraphQL quota falls back to the REST pulls endpoint", async () => {
  const run = await runCompletion((args) => {
    if (args[0] === "pr" && args[1] === "create") throw new Error(QUOTA_ERROR);
    if (args[0] === "api" && args.includes("repos/stSoftwareAU/VibeCoder/pulls")) {
      return "https://github.com/stSoftwareAU/VibeCoder/pull/171\n";
    }
    return "";
  });

  assertEquals(
    run.status,
    "continue",
    `quality-gated work must not be discarded: ${run.reason}`,
  );

  const restCreate = run.ghCalls.find((a) =>
    a[0] === "api" && a.includes("POST") &&
    a.includes("repos/stSoftwareAU/VibeCoder/pulls")
  );
  assert(
    restCreate,
    `expected a REST create, got: ${JSON.stringify(run.ghCalls)}`,
  );
  assert(
    restCreate.includes("head=issue-16-milestone-branch-title"),
    restCreate.join(" "),
  );
  assert(restCreate.includes("base=main"), restCreate.join(" "));
  assert(
    run.infos.some((m) => m.includes("REST fallback")),
    `expected the fallback to be logged, got: ${run.infos.join(" | ")}`,
  );
});

Deno.test("completion - the latch's own skip message also triggers the REST fallback", async () => {
  // Once the process is latched, `gh pr create` never spawns: the chokepoint
  // throws this message instead. It carries the primary-quota phrase, so the
  // fallback must recognise it too.
  const run = await runCompletion((args) => {
    if (args[0] === "pr" && args[1] === "create") {
      throw new Error(
        "gh command skipped: GraphQL primary quota exhausted (API rate limit already exceeded) — reset at 11:35Z",
      );
    }
    if (args[0] === "api") {
      return "https://github.com/stSoftwareAU/VibeCoder/pull/172\n";
    }
    return "";
  });

  assertEquals(run.status, "continue", run.reason);
  assert(
    run.ghCalls.some((a) =>
      a[0] === "api" && a.includes("repos/stSoftwareAU/VibeCoder/pulls")
    ),
    `expected a REST create, got: ${JSON.stringify(run.ghCalls)}`,
  );
});

Deno.test("completion - a non-quota create failure does NOT use the REST fallback", async () => {
  const run = await runCompletion((args) => {
    if (args[0] === "pr" && args[1] === "create") {
      throw new Error("gh command failed (exit 1): No commits between main and branch");
    }
    if (args[0] === "api") {
      return "https://github.com/stSoftwareAU/VibeCoder/pull/173\n";
    }
    return "";
  });

  assertEquals(run.status, "failure");
  assertStringIncludes(run.reason ?? "", "No commits between");
  assertEquals(
    run.ghCalls.some((a) =>
      a[0] === "api" && a.includes("POST") &&
      a.includes("repos/stSoftwareAU/VibeCoder/pulls")
    ),
    false,
    "an ordinary create failure must not be re-attempted over REST",
  );
});

Deno.test("completion - a failed REST fallback keeps the original failure reason", async () => {
  const run = await runCompletion((args) => {
    if (args[0] === "pr" && args[1] === "create") throw new Error(QUOTA_ERROR);
    if (args[0] === "api") {
      throw new Error("HTTP 403: Resource not accessible by integration");
    }
    return "";
  });

  assertEquals(run.status, "failure");
  assertStringIncludes(run.reason ?? "", "PR creation failed");
  assertStringIncludes(run.reason ?? "", "rate limit already exceeded");
  assert(
    run.warnings.some((m) => m.includes("REST PR-create fallback failed")),
    `the REST failure must be surfaced, got: ${run.warnings.join(" | ")}`,
  );
});
