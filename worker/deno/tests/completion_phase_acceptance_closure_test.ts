/**
 * Integration tests for the acceptance-criteria closure gate running in the
 * LIVE completion phase (Issue #518), and for the independent two-axis review
 * gate that now sits beside it (Issue #663).
 *
 * The planner publishes `## Acceptance Criteria` into every sub-issue and
 * nothing downstream read it back, so a run could raise a PR that never said
 * which criteria it met. These tests drive `workOnIssueCompletion` — the path
 * `issue_worker.ts` actually runs — and assert on the observable outcome
 * (whether `gh pr create` was invoked), not on how the gate is called.
 *
 * Issue #663 changed what a passing summary looks like: the closure block must
 * also record the independent Spec reviewer's provenance and per-entry verdict,
 * and the Standards axis must be reported under its own heading. Only
 * `SUMMARY_WITH_BLOCK` was updated for that — the existing assertions are
 * unchanged, and `SUMMARY_SELF_ASSESSED` keeps the old shape as the negative
 * control for the new gate.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { workOnIssueCompletion } from "../lib/phases/completion_phase.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type { GitHubClient, Result } from "../types.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";

const SHA = "9a8b7c6d5e4f30291827364554637281900fedcb";

const ISSUE_WITH_CRITERIA = `## Problem

The criteria are never read again.

## Acceptance criteria

- [ ] The prompt requires the closure block.
- [ ] A test drives the verifier both ways.
`;

const ISSUE_WITHOUT_CRITERIA = `## Problem

The parser mishandles a leap year.
`;

/** A summary that never closes the criteria out. */
const SUMMARY_WITHOUT_BLOCK = `## Summary

Closed the loop. Closes #518.

## Test Plan

- \`worker/deno/tests/acceptance_criteria_gate_test.ts\`
`;

/** The same summary carrying the closure block, self-assessed (Issue #663). */
const SUMMARY_SELF_ASSESSED = `## Summary

Closed the loop. Closes #518.

## Acceptance Criteria

- **met** — the prompt requires the closure block — evidence: \`prompts/issue/v36.md\`
- **met** — a test drives the verifier both ways — evidence: \`worker/deno/tests/acceptance_criteria_gate_test.ts\`

## Test Plan

- \`worker/deno/tests/acceptance_criteria_gate_test.ts\`
`;

/** The closure block as both gates now require it: judged independently. */
const SUMMARY_WITH_BLOCK = `## Summary

Closed the loop. Closes #518.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — the prompt requires the closure block — evidence: \`prompts/issue/v36.md\` — reviewer: met
- **met** — a test drives the verifier both ways — evidence: \`worker/deno/tests/acceptance_criteria_gate_test.ts\` — reviewer: met

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — Australian English, TDD, fail-loud error handling

## Test Plan

- \`worker/deno/tests/acceptance_criteria_gate_test.ts\`
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
  issueBody: string,
  summary: string,
): Promise<Outcome> {
  const repoPath = await Deno.makeTempDir();
  await Deno.mkdir(`${repoPath}/docs/archive/pr-summaries`, {
    recursive: true,
  });
  await Deno.writeTextFile(
    `${repoPath}/docs/archive/pr-summaries/pr-summary-518.md`,
    summary,
  );

  const comments: string[] = [];
  let prCreateCalls = 0;

  const ctx: IssueContext = {
    repo: "stSoftwareAU/VibeCoder",
    issueNumber: 518,
    issueTitle: "Close the acceptance-criteria loop",
    issueBody,
    issueLabels: ["enhancement", "work-on"],
    issueComments: "",
    githubUser: "testbot",
    config: buildDefaultWorkerConfig(),
  };
  const state: PhaseState = {
    branchName: "issue-518-closure",
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
          return ok("worker/deno/lib/acceptance_criteria_gate.ts");
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
  "completion - a criteria-bearing issue whose summary omits the block is blocked",
  async () => {
    const outcome = await runCompletion(
      ISSUE_WITH_CRITERIA,
      SUMMARY_WITHOUT_BLOCK,
    );

    assertEquals(outcome.status, "failure");
    assertEquals(outcome.prCreateCalls, 0, "gh pr create must not run");
    assertStringIncludes(outcome.reason ?? "", "Acceptance criteria");
    assertEquals(outcome.comments.length, 1);
    assertStringIncludes(outcome.comments[0]!, "Acceptance-criteria closure");
  },
);

Deno.test(
  "completion - the same issue passes once the summary closes the criteria out",
  async () => {
    const outcome = await runCompletion(
      ISSUE_WITH_CRITERIA,
      SUMMARY_WITH_BLOCK,
    );

    assertEquals(outcome.status, "continue");
    assertEquals(outcome.prCreateCalls, 1);
    assertEquals(outcome.comments.length, 0);
  },
);

Deno.test(
  "completion - a self-assessed closure block is blocked by the review gate",
  async () => {
    const outcome = await runCompletion(
      ISSUE_WITH_CRITERIA,
      SUMMARY_SELF_ASSESSED,
    );

    assertEquals(outcome.status, "failure");
    assertEquals(outcome.prCreateCalls, 0, "gh pr create must not run");
    assertStringIncludes(outcome.reason ?? "", "Independent Spec/Standards");
    assertEquals(outcome.comments.length, 1);
    assertStringIncludes(outcome.comments[0]!, "Independent review missing");
    assertStringIncludes(outcome.comments[0]!, "vibe-spec-review");
  },
);

Deno.test(
  "completion - an issue with no acceptance criteria is unaffected",
  async () => {
    const outcome = await runCompletion(
      ISSUE_WITHOUT_CRITERIA,
      SUMMARY_WITHOUT_BLOCK,
    );

    assertEquals(outcome.status, "continue");
    assertEquals(outcome.prCreateCalls, 1);
  },
);
