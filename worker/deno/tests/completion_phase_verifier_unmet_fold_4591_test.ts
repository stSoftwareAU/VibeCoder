/**
 * The pre-PR verifier's block carries the unmet-criteria verdict (Issue #4591).
 *
 * The verifier gate is the last summary gate before the unmet-criteria gate.
 * When it blocks, its block now folds the unmet criteria in, so the in-session
 * note and the one pull-request comment name them as well as the verifier's
 * findings. Before the fix, the verifier built its own block and the unmet
 * criteria were dropped from the reviewer note.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { workOnIssueCompletion } from "../lib/phases/completion_phase.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { AutoMergeResult } from "../lib/pr_auto_merge.ts";
import type { GitHubClient, Result } from "../types.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import {
  PRE_PR_VERIFIER_COMMENT_HEADING,
  type PrePrVerifierResult,
  type ReviewFinding,
} from "../lib/pre_pr_verifier.ts";
import { validateAcceptanceClosure } from "../lib/acceptance_criteria_gate.ts";
import { validateIndependentReview } from "../lib/independent_review_gate.ts";
import { validateReproductionStatus } from "../lib/reproduction_status_gate.ts";
import {
  assessUnmetCriteria,
  buildUnmetCriteriaGateComment,
} from "../lib/unmet_criteria_gate.ts";

const SHA = "b2c3d4e5f60718293a4b5c6d7e8f901122334455aa";
const REPO = "stSoftwareAU/VibeCoder";
const ISSUE = 4591;
const PR_URL = `https://github.com/${REPO}/pull/4412`;
const SUMMARY_REL = `docs/archive/pr-summaries/pr-summary-${ISSUE}.md`;

const CRITERION_MET = "The reviewer note names the unmet criteria";
const CRITERION_PARTIAL = "The pull request comment names the unmet criteria";

const ISSUE_BODY = `## Problem

The reviewer note drops the unmet acceptance criteria.

## Acceptance Criteria

- [ ] ${CRITERION_MET}
- [ ] ${CRITERION_PARTIAL}
`;

const FINDING: ReviewFinding = {
  file: "lib/phases/completion_phase.ts",
  line: 3301,
  problem: "the verifier block drops the unmet criteria from the note",
  fix: "fold the late verdicts into the verifier block",
};

// Both criteria met: the only gate that reports is the pre-PR verifier.
const SUMMARY_MET = `## Summary

Folded the unmet criteria into the verifier block. Closes #${ISSUE}.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — ${CRITERION_MET.toLowerCase()} — evidence: \`worker/deno/lib/phases/completion_phase.ts\` — reviewer: met
- **met** — ${CRITERION_PARTIAL.toLowerCase()} — evidence: \`worker/deno/lib/phases/completion_phase.ts\` — reviewer: met

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — Australian English, TDD, fail-loud error handling

**Docs sweep** — grep: \`unmet\`; section: \`docs/EXTENDING.md\`; no hits; siblings: none — no existing set gained a member

**Branch outcomes:** none added

## Test Plan

- the repository tests passed
`;

// One criterion still partial: the unmet-criteria gate reports as well.
const SUMMARY_PARTIAL = `## Summary

Folded the unmet criteria into the verifier block. Closes #${ISSUE}.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — ${CRITERION_MET.toLowerCase()} — evidence: \`worker/deno/lib/phases/completion_phase.ts\` — reviewer: met
- **partial** — ${CRITERION_PARTIAL.toLowerCase()} — evidence: \`worker/deno/lib/phases/completion_phase.ts\` — reviewer: partial — reason: the comment lacks the criteria

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — Australian English, TDD, fail-loud error handling

**Docs sweep** — grep: \`unmet\`; section: \`docs/EXTENDING.md\`; no hits; siblings: none — no existing set gained a member

**Branch outcomes:** none added

## Test Plan

- the repository tests passed
`;

/**
 * The first line of a gate's comment is its stable heading paragraph. The
 * builders produce it from one string with no newline, so the first line is
 * the whole heading.
 */
function headline(comment: string): string {
  return comment.split("\n")[0]!;
}

const VERIFIER_HEADING = PRE_PR_VERIFIER_COMMENT_HEADING;
const UNMET_HEADING = headline(
  buildUnmetCriteriaGateComment(
    assessUnmetCriteria(ISSUE_BODY, SUMMARY_PARTIAL),
  ),
);

function checked(findings: ReviewFinding[]): PrePrVerifierResult {
  return {
    status: "checked",
    review: {
      summary: findings.length ? "one problem" : "nothing found",
      findings,
      testChanges: "none",
      testChangeNotes: [],
      unrelatedIssues: [],
      checklist: [],
      closure: [],
    },
  };
}

function stubClient(
  posted: { number: number; body: string }[],
): GitHubClient {
  return {
    getIssue: () => {
      throw new Error("stub");
    },
    getIssueComments: () => Promise.resolve([]),
    addLabel: () => Promise.resolve(),
    removeLabel: () => Promise.resolve(),
    postComment: (_repo: string, number: number, body: string) => {
      posted.push({ number, body });
      return Promise.resolve(undefined);
    },
    editIssue: () => Promise.resolve(),
    assignIssue: () => Promise.resolve(),
    unassignIssue: () => Promise.resolve(),
    closeIssue: () => Promise.resolve(),
  };
}

/**
 * Runs the completion phase for ISSUE against `summary`, with the pre-PR
 * verifier returning `verifier` on every call and the GitHub, git and Claude
 * stubs the other completion tests use. Returns what the run did and said.
 */
async function runCompletion(
  summary: string,
  verifier: PrePrVerifierResult,
) {
  const repoPath = await Deno.makeTempDir();
  const workDir = await Deno.makeTempDir();
  await Deno.mkdir(`${repoPath}/docs/archive/pr-summaries`, {
    recursive: true,
  });
  await Deno.writeTextFile(`${repoPath}/${SUMMARY_REL}`, summary);

  const posted: { number: number; body: string }[] = [];
  const prompts: string[] = [];
  let prCreateCalls = 0;

  const config = buildDefaultWorkerConfig();
  config.workDir = workDir;
  const ctx: IssueContext = {
    repo: REPO,
    issueNumber: ISSUE,
    issueTitle: "Verifier block carries the unmet criteria",
    issueBody: ISSUE_BODY,
    issueLabels: ["work-on"],
    issueComments: "",
    githubUser: "testbot",
    config,
  };
  const state: PhaseState = {
    branchName: `issue-${ISSUE}-verifier-unmet-fold`,
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
      createClient: () => stubClient(posted),
      runGhCommand: (args: string[]) => {
        if (args[0] === "pr" && args[1] === "create") prCreateCalls++;
        if (args[0] === "pr" && args[1] === "view") {
          return Promise.resolve(JSON.stringify({ state: "OPEN" }));
        }
        return Promise.resolve(PR_URL);
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
        if (cmdArgs[0] === "rev-list" && cmdArgs[1] === "--count") {
          return ok("1\n");
        }
        if (cmdArgs[0] === "diff" && cmdArgs.includes("--name-only")) {
          return ok("worker/deno/lib/phases/completion_phase.ts\n");
        }
        return ok("");
      },
    },
    claude: {
      runClaudeWithRetry: (options: { prompt: string }) => {
        prompts.push(options.prompt);
        return Promise.resolve({
          ok: true as const,
          value: { exitCode: 0, output: "noted", timedOut: false },
        });
      },
      runPrePrVerifier: () => Promise.resolve(verifier),
    },
    quality: {
      runQualityGate: () =>
        Promise.resolve({
          ok: true as const,
          value: {
            checks: [],
            summary: { text: "All checks passed", passed: true },
            passed: true,
            output: "",
          },
        }),
    },
    pr: {
      findExistingPrForIssue: () =>
        Promise.resolve({ ok: false, error: new Error("none") }),
      findExistingPrForBranch: () =>
        Promise.resolve({ ok: false as const, error: new Error("none") }),
      updatePrLabels: () => Promise.resolve({ ok: true, value: undefined }),
      finalisePr: () =>
        Promise.resolve({
          ok: true,
          value: { result: AutoMergeResult.Enabled, message: "armed" },
        }),
    },
  });

  let result: Awaited<ReturnType<typeof workOnIssueCompletion>>;
  try {
    result = await workOnIssueCompletion(ctx, state, deps);
  } finally {
    await Deno.remove(repoPath, { recursive: true });
    await Deno.remove(workDir, { recursive: true });
  }
  return {
    result,
    prCreateCalls,
    prompts,
    onPr: posted.filter((comment) => comment.number === 4412),
  };
}

Deno.test(
  "completion - the verifier block folds in the unmet criteria, once each in the note and the PR comment (Issue #4591)",
  async () => {
    // The fixture must trigger only the verifier gate and the unmet-criteria
    // gate, so the test is about the fold and not some other gate.
    const closure = validateAcceptanceClosure({
      issueBody: ISSUE_BODY,
      prSummaryContent: SUMMARY_PARTIAL,
    });
    assertEquals(closure.valid, true);
    const review = validateIndependentReview({
      issueBody: ISSUE_BODY,
      prSummaryContent: SUMMARY_PARTIAL,
    });
    assertEquals(review.valid, true);
    const reproduction = validateReproductionStatus({
      issueLabels: "work-on",
      prSummaryContent: SUMMARY_PARTIAL,
    });
    assertEquals(reproduction.applicable, false);
    const unmet = assessUnmetCriteria(ISSUE_BODY, SUMMARY_PARTIAL);
    assertEquals(unmet.length, 1);

    const run = await runCompletion(SUMMARY_PARTIAL, checked([FINDING]));

    assertEquals(run.result.status, "continue");
    assertEquals(run.prCreateCalls, 1);
    // prompts[0] is the in-session note. Later prompts, if any, are the
    // closure verdict recovery's questions (Issue #2242), which do not carry it.
    const prompt = run.prompts[0]!;
    assertStringIncludes(prompt, VERIFIER_HEADING);
    assertStringIncludes(prompt, UNMET_HEADING);
    assertStringIncludes(prompt, CRITERION_PARTIAL);

    assertEquals(run.onPr.length, 1);
    const body = run.onPr[0]!.body;
    assertStringIncludes(body, VERIFIER_HEADING);
    assertStringIncludes(body, UNMET_HEADING);
    assertStringIncludes(body, CRITERION_PARTIAL);

    for (const text of [prompt, body]) {
      assertEquals(text.split(VERIFIER_HEADING).length - 1, 1);
      assertEquals(text.split(UNMET_HEADING).length - 1, 1);
    }
  },
);

Deno.test(
  "completion - with every criterion met, the PR comment names the verifier finding and not the unmet criteria (Issue #4591)",
  async () => {
    assertEquals(
      assessUnmetCriteria(ISSUE_BODY, SUMMARY_MET).length,
      0,
    );

    const run = await runCompletion(SUMMARY_MET, checked([FINDING]));

    assertEquals(run.result.status, "continue");
    assertEquals(run.prCreateCalls, 1);
    assertEquals(run.prompts[0]!.includes(UNMET_HEADING), false);

    assertEquals(run.onPr.length, 1);
    const body = run.onPr[0]!.body;
    assertStringIncludes(body, VERIFIER_HEADING);
    assertStringIncludes(body, FINDING.problem);
    assertEquals(body.includes(UNMET_HEADING), false);
  },
);
