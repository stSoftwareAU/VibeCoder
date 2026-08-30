/**
 * Integration tests for the bug-fix reproduction-status gate running in the
 * LIVE completion phase (Issue #521).
 *
 * A `bug`-labelled PR that claims a regression test used to read identically
 * whether the test was watched to fail before the fix or written afterwards.
 * These tests drive `workOnIssueCompletion` — the path `issue_worker.ts`
 * actually runs — and assert on the observable outcome (whether `gh pr create`
 * was invoked), not on how the gate is called.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { workOnIssueCompletion } from "../lib/phases/completion_phase.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type { GitHubClient, Result } from "../types.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";

const SHA = "1122334455667788990011223344556677889900";

const ISSUE_BODY = `## Problem

\`parseDate("2024-02-29")\` throws on a leap day.
`;

/** A summary that claims a regression test but records no reproduction. */
const SUMMARY_WITHOUT_BLOCK = `## Summary

Fixed the leap-year branch. Closes #521.

## Test Plan

- Added \`worker/deno/tests/date_parser_test.ts::parses a leap day\`
`;

/** The same summary with an honest not-run reproduction. */
const SUMMARY_NOT_RUN = `## Summary

Fixed the leap-year branch. Closes #521.

## Reproduction

- **symptom** — \`parseDate("2024-02-29")\` threw \`RangeError\` on a leap day
- **status** — \`not-run\` — reason: the failing input only arrives from the production scheduler, which is unreachable from this container
- **regression test** — \`worker/deno/tests/date_parser_test.ts::parses a leap day\`

## Test Plan

- Added \`worker/deno/tests/date_parser_test.ts::parses a leap day\`
`;

/** The same summary with a fully verified reproduction. */
const SUMMARY_VERIFIED = `## Summary

Fixed the leap-year branch. Closes #521.

## Reproduction

- **symptom** — \`parseDate("2024-02-29")\` threw \`RangeError\` on a leap day
- **status** — \`verified\` — the regression test was observed failing against the unfixed code and passing after the fix
- **regression test** — \`worker/deno/tests/date_parser_test.ts::parses a leap day\`

## Test Plan

- Added \`worker/deno/tests/date_parser_test.ts::parses a leap day\`
`;

function stubClient(comments: string[]): GitHubClient {
  return {
    getIssue: () => {
      throw new Error("stub");
    },
    getIssueComments: () => Promise.resolve([]),
    addLabel: () => Promise.resolve(),
    removeLabel: () => Promise.resolve(),
    postComment: (_repo: string, _issue: number, body: string) => {
      comments.push(body);
      return Promise.resolve(undefined);
    },
    editIssue: () => Promise.resolve(),
    assignIssue: () => Promise.resolve(),
    unassignIssue: () => Promise.resolve(),
    closeIssue: () => Promise.resolve(),
  };
}

interface Outcome {
  status: string;
  reason?: string;
  prCreateCalls: number;
  comments: string[];
}

async function runCompletion(
  labels: string[],
  summary: string,
): Promise<Outcome> {
  const repoPath = await Deno.makeTempDir();
  await Deno.mkdir(`${repoPath}/docs/archive/pr-summaries`, {
    recursive: true,
  });
  await Deno.writeTextFile(
    `${repoPath}/docs/archive/pr-summaries/pr-summary-521.md`,
    summary,
  );

  const comments: string[] = [];
  let prCreateCalls = 0;

  const ctx: IssueContext = {
    repo: "stSoftwareAU/VibeCoder",
    issueNumber: 521,
    issueTitle: "Leap day throws",
    issueBody: ISSUE_BODY,
    issueLabels: labels,
    issueComments: "",
    githubUser: "testbot",
    config: buildDefaultWorkerConfig(),
  };
  const state: PhaseState = {
    branchName: "issue-521-repro",
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
      createClient: () => stubClient(comments),
      runGhCommand: (args: string[]) => {
        if (args[0] === "pr" && args[1] === "create") prCreateCalls++;
        return Promise.resolve(
          "https://github.com/stSoftwareAU/VibeCoder/pull/101",
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
          return ok("worker/deno/lib/date_parser.ts");
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
    prCreateCalls,
    comments,
  };
}

Deno.test(
  "completion - a bug-labelled summary with no reproduction block is blocked",
  async () => {
    const outcome = await runCompletion(
      ["bug", "work-on"],
      SUMMARY_WITHOUT_BLOCK,
    );

    assertEquals(outcome.status, "failure");
    assertEquals(outcome.prCreateCalls, 0, "gh pr create must not run");
    assertStringIncludes(outcome.reason ?? "", "Reproduction status");
    assertEquals(outcome.comments.length, 1);
    assertStringIncludes(outcome.comments[0]!, "## Reproduction");
  },
);

Deno.test(
  "completion - an honest not-run reproduction raises the PR",
  async () => {
    const outcome = await runCompletion(["bug", "work-on"], SUMMARY_NOT_RUN);

    assertEquals(outcome.status, "continue");
    assertEquals(outcome.prCreateCalls, 1);
    assertEquals(outcome.comments.length, 0);
  },
);

Deno.test(
  "completion - a verified reproduction raises the PR",
  async () => {
    const outcome = await runCompletion(["bug", "work-on"], SUMMARY_VERIFIED);

    assertEquals(outcome.status, "continue");
    assertEquals(outcome.prCreateCalls, 1);
  },
);

Deno.test(
  "completion - a non-bug issue with no reproduction block is unaffected",
  async () => {
    const outcome = await runCompletion(
      ["enhancement", "work-on"],
      SUMMARY_WITHOUT_BLOCK,
    );

    assertEquals(outcome.status, "continue");
    assertEquals(outcome.prCreateCalls, 1);
  },
);
