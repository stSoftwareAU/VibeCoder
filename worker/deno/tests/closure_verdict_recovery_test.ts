/**
 * The render step of the summary-rule recovery (Issue #2242).
 *
 * `completion_phase_closure_render_test.ts` drives the whole phase; this drives
 * `renderClosureBlocksFromVerdict` directly, so the paths that ask nothing —
 * an issue with no criteria, a summary the agent wrote correctly — and the
 * paths that cannot ask at all are each covered by their own case.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { renderClosureBlocksFromVerdict } from "../lib/closure_verdict_recovery.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import {
  CLOSURE_VERDICT_CLOSE,
  CLOSURE_VERDICT_OPEN,
} from "../lib/closure_verdict.ts";

const REPO = "stSoftwareAU/VibeCoder";
const ISSUE = 2242;

const CRITERIA = ["the block is rendered", "the block passes both gates"];

const ISSUE_WITH_CRITERIA = `## Problem

Prose instead of the block.

## Acceptance Criteria

${CRITERIA.map((c) => `- [ ] ${c}`).join("\n")}
`;

const PROSE_SUMMARY = `## Summary

Did the work. Closes #${ISSUE}.
`;

const GOOD_SUMMARY = `## Summary

Did the work. Closes #${ISSUE}.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — the block is rendered — evidence: \`lib/closure_verdict.ts\` — reviewer: met
- **met** — the block passes both gates — evidence: \`tests/closure_verdict_test.ts\` — reviewer: met

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — Australian English, TDD
`;

function verdictReply(covered: number): string {
  return [
    CLOSURE_VERDICT_OPEN,
    JSON.stringify({
      criteria: CRITERIA.slice(0, covered).map((criterion) => ({
        criterion,
        status: "met",
        evidence: "worker/deno/tests/closure_verdict_test.ts",
      })),
      standards: [{ status: "clean", finding: "Australian English, TDD" }],
    }),
    CLOSURE_VERDICT_CLOSE,
  ].join("\n");
}

interface Case {
  issueBody: string;
  /** Summary written to the canonical path; omitted, no summary file exists. */
  summary?: string;
  /** The reply every verdict question gets. */
  reply?: string;
  /** Make every model invocation fail to launch. */
  invocationFails?: boolean;
}

async function render(testCase: Case) {
  const repoPath = await Deno.makeTempDir();
  const summaryPath =
    `${repoPath}/docs/archive/pr-summaries/pr-summary-${ISSUE}.md`;
  if (testCase.summary !== undefined) {
    await Deno.mkdir(`${repoPath}/docs/archive/pr-summaries`, {
      recursive: true,
    });
    await Deno.writeTextFile(summaryPath, testCase.summary);
  }

  const config = buildDefaultWorkerConfig();
  const ctx: IssueContext = {
    repo: REPO,
    issueNumber: ISSUE,
    issueTitle: "Render the closure block",
    issueBody: testCase.issueBody,
    issueLabels: ["work-on"],
    issueComments: "",
    githubUser: "testbot",
    config,
  };
  const state: PhaseState = {
    branchName: `issue-${ISSUE}-render`,
    baseBranch: "main",
    defaultBranch: "main",
    repoPath,
    clarityStatus: "not_assessed",
    claudeOutput: "",
    executeStartTime: 0,
    baselineQualityPassed: true,
    baselineQualityOutput: "",
  };

  let calls = 0;
  const deps = createMockDeps({
    claude: {
      runClaudeWithRetry: () => {
        calls++;
        if (testCase.invocationFails) {
          return Promise.resolve({
            ok: false as const,
            error: new Error("rate limited"),
          });
        }
        return Promise.resolve({
          ok: true as const,
          value: {
            exitCode: 0,
            output: testCase.reply ?? "no verdict here",
            timedOut: false,
          },
        });
      },
    },
  });

  try {
    const outcome = await renderClosureBlocksFromVerdict(ctx, state, deps);
    let summary: string | null = null;
    try {
      summary = await Deno.readTextFile(summaryPath);
    } catch {
      summary = null;
    }
    return { outcome, calls, summary };
  } finally {
    await Deno.remove(repoPath, { recursive: true });
  }
}

Deno.test("closure render - an issue stating no criteria asks nothing", async () => {
  const { outcome, calls } = await render({
    issueBody: "## Problem\n\nNo criteria here.\n",
    summary: PROSE_SUMMARY,
  });

  assertEquals(outcome.kind, "not-applicable");
  assertEquals(outcome.valid, true);
  assertEquals(calls, 0, "no model invocation");
});

Deno.test("closure render - a summary that already satisfies both gates asks nothing", async () => {
  const { outcome, calls, summary } = await render({
    issueBody: ISSUE_WITH_CRITERIA,
    summary: GOOD_SUMMARY,
  });

  assertEquals(outcome.kind, "already-valid");
  assertEquals(outcome.valid, true);
  assertEquals(calls, 0, "the agent's own block is still the happy path");
  assertEquals(summary, GOOD_SUMMARY, "the summary is untouched");
});

Deno.test("closure render - a full verdict is rendered into the summary", async () => {
  const { outcome, calls, summary } = await render({
    issueBody: ISSUE_WITH_CRITERIA,
    summary: PROSE_SUMMARY,
    reply: verdictReply(CRITERIA.length),
  });

  assertEquals(outcome.kind, "rendered");
  assertEquals(outcome.valid, true);
  assertEquals(calls, 1, "one question, no re-ask");
  assertStringIncludes(summary ?? "", "## Acceptance Criteria");
  assertStringIncludes(summary ?? "", "Closes #2242");
});

Deno.test("closure render - with no summary file the worker writes the canonical one", async () => {
  const { outcome, summary } = await render({
    issueBody: ISSUE_WITH_CRITERIA,
    reply: verdictReply(CRITERIA.length),
  });

  assertEquals(outcome.kind, "rendered");
  assertEquals(outcome.valid, true);
  // The minimal body the completion phase would otherwise invent, plus blocks.
  assertStringIncludes(summary ?? "", `Closes #${ISSUE}.`);
  assertStringIncludes(summary ?? "", "## Standards Review");
});

Deno.test("closure render - a model invocation that cannot be launched changes nothing", async () => {
  const { outcome, calls, summary } = await render({
    issueBody: ISSUE_WITH_CRITERIA,
    summary: PROSE_SUMMARY,
    invocationFails: true,
  });

  assertEquals(outcome.kind, "unavailable");
  assertEquals(outcome.valid, false);
  assertEquals(calls, 2, "asked twice, then the block stands");
  assertEquals(summary, PROSE_SUMMARY, "nothing was invented");
});

Deno.test("closure render - a short verdict is rendered as it stands and stays invalid", async () => {
  const { outcome, calls, summary } = await render({
    issueBody: ISSUE_WITH_CRITERIA,
    summary: PROSE_SUMMARY,
    reply: verdictReply(1),
  });

  assertEquals(outcome.kind, "rendered");
  assertEquals(outcome.valid, false, "the gate still blocks on the shortfall");
  assertEquals(calls, 2, "asked once more, then rendered");
  assertStringIncludes(summary ?? "", "## Acceptance Criteria");
  assertStringIncludes(outcome.detail, "does not satisfy both gates");
});
