/**
 * The merged-PR pre-check refuses to close an issue whose work is stranded
 * on a branch (Issue #174).
 *
 * The pre-check exists to stop the worker re-claiming an issue whose work
 * already shipped (Issue #1560). It matched *any* merged PR referencing the
 * issue, so on VibeCoder#42 a sibling's merged PR closed the issue again on
 * every claim, while three worker commits sat on a branch with no PR.
 *
 * Tests drive the phase with injected doubles and assert on the gh commands
 * issued and the phase result — never on source text.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { MERGED_PR_VIEW } from "./fixtures/merge_landing_stub.ts";
import {
  MERGED_PR_PRECHECK_EARLY_EXIT_REASON,
  workOnIssueMergedPrPrecheck,
} from "../lib/phases/merged_pr_precheck_phase.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";

const REPO = "stSoftwareAU/VibeCoder";

function makeContext(): IssueContext {
  return {
    repo: REPO,
    issueNumber: 42,
    issueTitle: "Primary GraphQL quota exhaustion is swallowed",
    issueBody: "",
    issueLabels: ["top-priority"],
    issueComments: "",
    githubUser: "vibe-worker",
    config: buildDefaultWorkerConfig(),
  };
}

function makeState(): PhaseState {
  return {
    branchName: "",
    baseBranch: "",
    defaultBranch: "",
    repoPath: "",
    clarityStatus: "not_assessed",
    claudeOutput: "",
    executeStartTime: 0,
    baselineQualityPassed: true,
    baselineQualityOutput: "",
  };
}

interface Scenario {
  /** Bare branch names the matching-refs listing returns. */
  branches: string[];
  /** Branch → PRs (any state) that exist for it. */
  prCounts?: Record<string, number>;
  /** Branch → commits ahead of the default branch. */
  aheadBy?: Record<string, number>;
  /** Make every stranded-branch lookup fail. */
  refsFail?: boolean;
}

async function runPrecheck(scenario: Scenario): Promise<{
  status: string;
  reason?: string;
  closed: number[];
  warnings: string[];
}> {
  const closed: number[] = [];
  const warnings: string[] = [];

  const runGhCommand = (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("matching-refs")) {
      if (scenario.refsFail) return Promise.reject(new Error("gh api failed"));
      return Promise.resolve(
        scenario.branches.map((b) => `refs/heads/${b}`).join("\n"),
      );
    }
    if (key.includes(".default_branch")) return Promise.resolve("Develop\n");
    if (args[0] === "pr" && args[1] === "list") {
      const head = args[args.indexOf("--head") + 1]!;
      const count = scenario.prCounts?.[head] ?? 0;
      return Promise.resolve(
        JSON.stringify(Array.from({ length: count }, (_, i) => ({
          number: i + 1,
        }))),
      );
    }
    if (key.includes("/compare/")) {
      const path = args[1]!;
      // The landing check compares a merge commit; the stranded scan asks
      // for `.ahead_by` on a branch.
      if (args.includes("--jq") && args[args.indexOf("--jq") + 1] === ".ahead_by") {
        const head = path.slice(path.lastIndexOf("...") + 3);
        return Promise.resolve(String(scenario.aheadBy?.[head] ?? 0));
      }
      return Promise.resolve(JSON.stringify({ status: "behind" }));
    }
    if (args[0] === "pr" && args[1] === "view") {
      return Promise.resolve(JSON.stringify(MERGED_PR_VIEW));
    }
    if (args[0] === "issue" && args[1] === "view") {
      return Promise.resolve(JSON.stringify({ state: "OPEN", milestone: null }));
    }
    if (args[0] === "issue" && args[1] === "close") {
      closed.push(parseInt(args[2]!, 10));
      return Promise.resolve("");
    }
    return Promise.resolve("");
  };

  const deps = createMockDeps({
    logger: {
      info: () => undefined,
      warn: (m: string) => warnings.push(m),
      error: (m: string) => warnings.push(m),
      debug: () => undefined,
    } as never,
    github: { runGhCommand },
    pr: {
      findExistingPrForIssue: () =>
        Promise.resolve({
          ok: true as const,
          value: `https://github.com/${REPO}/pull/173`,
        }),
    },
  });

  const result = await workOnIssueMergedPrPrecheck(
    makeContext(),
    makeState(),
    deps,
  );
  return {
    status: result.status,
    ...(result.status === "early_exit" ? { reason: result.reason } : {}),
    closed,
    warnings,
  };
}

Deno.test("merged-pr-precheck #174 - does not close when an issue branch is ahead of base with no PR", async () => {
  const run = await runPrecheck({
    branches: ["issue-42-primary-graphql-quota"],
    aheadBy: { "issue-42-primary-graphql-quota": 3 },
  });

  assertEquals(run.status, "continue");
  assertEquals(run.closed, [], "stranded work must not be closed away");
  assert(
    run.warnings.some((w) =>
      w.includes("issue-42-primary-graphql-quota") && w.includes("174")
    ),
    `expected a warning naming the stranded branch: ${run.warnings}`,
  );
});

Deno.test("merged-pr-precheck #174 - still closes when nothing is stranded", async () => {
  const run = await runPrecheck({
    branches: ["issue-42-already-shipped"],
    prCounts: { "issue-42-already-shipped": 1 },
  });

  assertEquals(run.status, "early_exit");
  assertEquals(run.reason, MERGED_PR_PRECHECK_EARLY_EXIT_REASON);
  assertEquals(run.closed, [42]);
});

Deno.test("merged-pr-precheck #174 - no issue branches at all still closes as before", async () => {
  const run = await runPrecheck({ branches: [] });

  assertEquals(run.status, "early_exit");
  assertEquals(run.closed, [42]);
});

Deno.test("merged-pr-precheck #174 - a guard that cannot run says so and does not block the close", async () => {
  const run = await runPrecheck({ branches: [], refsFail: true });

  assertEquals(run.status, "early_exit");
  assertEquals(run.closed, [42]);
  assert(
    run.warnings.some((w) => w.includes("Stranded-branch")),
    `an unrunnable guard must be audible: ${run.warnings}`,
  );
});
