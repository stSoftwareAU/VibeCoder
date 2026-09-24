/**
 * Composition tests for the degraded-run delivery guard running in the LIVE
 * completion phase (Issue #2562).
 *
 * #2543's implementation run fell back to Haiku, delivered one of seven
 * accepted changes, and its PR closed the issue with nothing recording the
 * rest. These tests drive `workOnIssueCompletion` — the path `issue_worker.ts`
 * runs — and assert on what reaches `gh`: whether a follow-up issue is filed,
 * and what the PR body says. Both directions are pinned: a degraded partial run
 * files the residue and says so; the same run healthy, or degraded but
 * complete, raises the PR exactly as before.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { workOnIssueCompletion } from "../lib/phases/completion_phase.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import type { PhaseClaudeResult } from "../lib/phase_run_stats.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type { GitHubClient, Result } from "../types.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";

const SHA = "9a8b7c6d5e4f30291827364554637281900fedcb";
const ISSUE = 518;

const ISSUE_WITH_CRITERIA = `## Problem

Two things are wrong.

## Acceptance criteria

- [ ] The router sends planning to opus.
- [ ] The docs table lists opus for planning.
`;

/** Shaped like #2543: grill-me scope, no acceptance-criteria heading. */
const GRILL_ME_ISSUE = `## Current Understanding

Finish the switch.

### Accepted scope so far

- Route the planning phases to opus.
- Raise the Claude Code pin.
- Bump the release floor to 1.9.0.

### Open questions

None.
`;

/** One criterion met, one missing — judged independently, so every gate passes. */
const SUMMARY_PARTIAL = `## Summary

Did half of it.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — the router sends planning to opus — evidence: \`lib/config_defaults.ts\` — reviewer: met
- **missing** — the docs table lists opus — reviewer: missing — reason: ran out of turns

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — Australian English, TDD, fail-loud error handling
`;

const SUMMARY_COMPLETE = `## Summary

Did all of it.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — the router sends planning to opus — evidence: \`lib/config_defaults.ts\` — reviewer: met
- **met** — the docs table lists opus — evidence: \`docs/MODEL-AND-CACHING.md\` — reviewer: met

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — Australian English, TDD, fail-loud error handling
`;

const DEGRADED: PhaseClaudeResult[] = [{ fallbackModel: "haiku" }];
const HEALTHY: PhaseClaudeResult[] = [];

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

interface Outcome {
  status: string;
  reason?: string;
  issueCreates: string[][];
  prBodies: string[];
}

async function runCompletion(opts: {
  issueBody: string;
  summary: string | null;
  claudeRunStats: PhaseClaudeResult[];
  failIssueCreate?: boolean;
}): Promise<Outcome> {
  const repoPath = await Deno.makeTempDir();
  if (opts.summary !== null) {
    await Deno.mkdir(`${repoPath}/docs/archive/pr-summaries`, {
      recursive: true,
    });
    await Deno.writeTextFile(
      `${repoPath}/docs/archive/pr-summaries/pr-summary-${ISSUE}.md`,
      opts.summary,
    );
  }

  const issueCreates: string[][] = [];
  const prBodies: string[] = [];

  const ctx: IssueContext = {
    repo: "stSoftwareAU/VibeCoder",
    issueNumber: ISSUE,
    issueTitle: "Finish the switch",
    issueBody: opts.issueBody,
    issueLabels: ["enhancement", "work-on"],
    issueComments: "",
    githubUser: "testbot",
    config: buildDefaultWorkerConfig(),
  };
  const state: PhaseState = {
    branchName: `issue-${ISSUE}-switch`,
    baseBranch: "main",
    defaultBranch: "main",
    repoPath,
    clarityStatus: "not_assessed",
    claudeOutput: "",
    executeStartTime: 0,
    baselineQualityPassed: true,
    baselineQualityOutput: "",
    claudeRunStats: opts.claudeRunStats,
  };

  const deps = createMockDeps({
    github: {
      createClient: () => stubClient(),
      ensureLabelExists: () =>
        Promise.resolve({ ok: true as const, value: undefined }),
      runGhCommand: (args: string[]) => {
        if (args[0] === "issue" && args[1] === "list") {
          return Promise.resolve("[]");
        }
        if (args[0] === "issue" && args[1] === "create") {
          issueCreates.push(args);
          return opts.failIssueCreate
            ? Promise.reject(new Error("HTTP 502"))
            : Promise.resolve(
              "https://github.com/stSoftwareAU/VibeCoder/issues/900\n",
            );
        }
        if (args[0] === "pr" && args[1] === "create") {
          prBodies.push(args[args.indexOf("--body") + 1] ?? "");
        }
        return Promise.resolve(
          "https://github.com/stSoftwareAU/VibeCoder/pull/100",
        );
      },
    },
    git: {
      runGitCommand: (
        cmdArgs: string[],
      ): Promise<Result<{ code: number; stdout: string; stderr: string }>> => {
        const ok = (stdout: string) =>
          Promise.resolve({
            ok: true as const,
            value: { code: 0, stdout, stderr: "" },
          });
        if (cmdArgs[0] === "rev-parse") return ok(`${SHA}\n`);
        if (cmdArgs[0] === "diff" && cmdArgs[1] === "--name-only") {
          return ok("worker/deno/lib/config_defaults.ts");
        }
        return ok("");
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

  return {
    status: result.status,
    reason: result.status === "failure" ? result.reason : undefined,
    issueCreates,
    prBodies,
  };
}

Deno.test("completion - a degraded run delivering one of two criteria files the residue and says so in the PR", async () => {
  const outcome = await runCompletion({
    issueBody: ISSUE_WITH_CRITERIA,
    summary: SUMMARY_PARTIAL,
    claudeRunStats: DEGRADED,
  });

  assertEquals(outcome.status, "continue");
  assertEquals(outcome.issueCreates.length, 1, "one follow-up is filed");
  const create = outcome.issueCreates[0]!;
  const body = create[create.indexOf("--body") + 1]!;
  assertStringIncludes(body, "The docs table lists opus for planning.");
  assertStringIncludes(body, `#${ISSUE}`);

  assertEquals(outcome.prBodies.length, 1);
  const pr = outcome.prBodies[0]!;
  assertStringIncludes(pr, "Degraded run — partial delivery");
  assertStringIncludes(pr, "#900");
  assertStringIncludes(pr, "The docs table lists opus for planning.");
});

Deno.test("completion - the same run, healthy and complete, raises the PR with no follow-up", async () => {
  const outcome = await runCompletion({
    issueBody: ISSUE_WITH_CRITERIA,
    summary: SUMMARY_COMPLETE,
    claudeRunStats: HEALTHY,
  });

  assertEquals(outcome.status, "continue");
  assertEquals(outcome.issueCreates.length, 0);
  assertEquals(outcome.prBodies.length, 1);
  assert(!outcome.prBodies[0]!.includes("Degraded run"));
});

Deno.test("completion - a healthy run is unaffected even when its summary reports a gap", async () => {
  const outcome = await runCompletion({
    issueBody: ISSUE_WITH_CRITERIA,
    summary: SUMMARY_PARTIAL,
    claudeRunStats: HEALTHY,
  });

  assertEquals(outcome.status, "continue");
  assertEquals(outcome.issueCreates.length, 0);
  assert(!outcome.prBodies[0]!.includes("Degraded run"));
});

Deno.test("completion - a degraded run that met every criterion raises the PR with no follow-up", async () => {
  const outcome = await runCompletion({
    issueBody: ISSUE_WITH_CRITERIA,
    summary: SUMMARY_COMPLETE,
    claudeRunStats: DEGRADED,
  });

  assertEquals(outcome.status, "continue");
  assertEquals(outcome.issueCreates.length, 0);
  assert(!outcome.prBodies[0]!.includes("Degraded run"));
});

Deno.test("completion - #2543 reproduction: a degraded run with no summary on a grill-me issue files every scope item", async () => {
  const outcome = await runCompletion({
    issueBody: GRILL_ME_ISSUE,
    summary: null,
    claudeRunStats: DEGRADED,
  });

  assertEquals(outcome.status, "continue");
  assertEquals(outcome.issueCreates.length, 1);
  const create = outcome.issueCreates[0]!;
  const body = create[create.indexOf("--body") + 1]!;
  assertStringIncludes(body, "Route the planning phases to opus.");
  assertStringIncludes(body, "Raise the Claude Code pin.");
  assertStringIncludes(body, "Bump the release floor to 1.9.0.");
  assertStringIncludes(outcome.prBodies[0]!, "#900");
});

Deno.test("completion - a degraded run whose follow-up cannot be filed raises no PR", async () => {
  const outcome = await runCompletion({
    issueBody: ISSUE_WITH_CRITERIA,
    summary: SUMMARY_PARTIAL,
    claudeRunStats: DEGRADED,
    failIssueCreate: true,
  });

  assertEquals(outcome.status, "failure");
  assertStringIncludes(outcome.reason ?? "", "follow-up");
  assertEquals(outcome.prBodies.length, 0, "gh pr create must not run");
});
