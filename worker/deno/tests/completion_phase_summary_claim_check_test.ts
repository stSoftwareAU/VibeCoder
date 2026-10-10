/**
 * Integration tests for the first-run PR-summary claim check running in the
 * LIVE completion phase (Issue #3257).
 *
 * A first-run PR summary has repeatedly described named code wrongly
 * (VibeCoder#3252, #3132) — a problem the #3143 review-fix drift check
 * cannot reach, because it only runs on a review-fix push, never on the
 * first turn that writes the summary and raises the PR. These tests drive
 * `workOnIssueCompletion` and assert on the observable outcome (whether `gh
 * pr create` ran, whether the in-run recovery fired, what the posted comment
 * says), not on how the check is called.
 *
 * Mirrors `completion_phase_branch_outcomes_test.ts`'s harness.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { workOnIssueCompletion } from "../lib/phases/completion_phase.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { AutoMergeResult } from "../lib/pr_auto_merge.ts";
import type { GitHubClient, Result } from "../types.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import {
  DRIFT_VERDICT_CLOSE,
  DRIFT_VERDICT_OPEN,
} from "../lib/pr_feedback_drift_check.ts";
import {
  CORRECTED_SUMMARY_CLOSE,
  CORRECTED_SUMMARY_OPEN,
} from "../lib/summary_claim_correction.ts";

const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f901122334455";
const REPO = "stSoftwareAU/VibeCoder";
const ISSUE = 3257;
const PR_URL = `https://github.com/${REPO}/pull/4411`;

const ISSUE_BODY = `## Problem

A first-run PR summary has repeatedly described named code wrongly.
`;

const DOCS_SWEEP_LINE =
  "**Docs sweep** — grep: `BrokerBalance`; section: `docs/reporting-api.md#decisions-report`; no hits";

const WRONG_CLAIM_SENTENCE =
  "`phraseAnywhere()` escapes the phrase and joins its words with `\\s+`.";

/** (a)/(b) A summary naming a helper with a wrong description. */
const SUMMARY_WRONG_CLAIM = `## Summary

Changed the broker balance card. Closes #${ISSUE}.

${WRONG_CLAIM_SENTENCE}

## Test Plan

- manually verified
`;

/** (a) The same summary with the wrong sentence removed. */
const SUMMARY_WRONG_CLAIM_FIXED = `## Summary

Changed the broker balance card. Closes #${ISSUE}.

## Test Plan

- manually verified
`;

const WIDGET_TEST_PATH = "worker/deno/tests/widget_test.ts";
const WIDGET_TEST_CONTENT =
  `Deno.test("renders the header", () => {\n  // ...\n});\n`;

/** (c) A Test Plan bullet citing a behaviour no test in the file covers. */
const SUMMARY_TEST_PLAN_CLAIM = `## Summary

Changed the broker balance card. Closes #${ISSUE}.

## Test Plan

- \`${WIDGET_TEST_PATH}\` covers "rejects malformed widget payloads"
`;

/** (c) The same summary, rewritten to quote a behaviour the file covers. */
const SUMMARY_TEST_PLAN_CLAIM_FIXED = `## Summary

Changed the broker balance card. Closes #${ISSUE}.

## Test Plan

- \`${WIDGET_TEST_PATH}\` covers "renders the header"
`;

/** (d)/(e) Clean summary, no claims about named code. */
const SUMMARY_CLEAN = `## Summary

Changed the broker balance card. Closes #${ISSUE}.

## Test Plan

- manually verified
`;

/**
 * (f) A code diff whose summary has a valid Docs sweep line but no Branch
 * outcomes list, AND a wrong claim about named code.
 */
const SUMMARY_FOLD = `## Summary

Changed the broker balance card. Closes #${ISSUE}.

${DOCS_SWEEP_LINE}

${WRONG_CLAIM_SENTENCE}

## Test Plan

- manually verified
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

/** Build a drift-verdict reply block naming `findings`. */
function verdictReply(
  findings: Array<{ file: string; sentence: string; reason: string }>,
): string {
  return `${DRIFT_VERDICT_OPEN}\n${
    JSON.stringify({ findings })
  }\n${DRIFT_VERDICT_CLOSE}`;
}

interface QuestionCall {
  prompt: string;
  disallowedTools: readonly string[] | undefined;
}

interface ClaudeCall {
  prompt: string;
  disallowedTools: readonly string[] | undefined;
}

interface Scenario {
  /** Summary on the branch when the completion phase starts. */
  summary: string;
  /** Summary the recovery invocation writes; omitted, it changes nothing. */
  retryWrites?: string;
  /**
   * Per-`runClaudeWithRetry`-call scripted behaviour, one entry per call
   * (repeats the last entry once exhausted). When absent, falls back to the
   * single `retryWrites` behaviour for every call. `writes` sets the summary
   * file's content after the call; `output` is the reply text (used by the
   * correction turn's `CORRECTED_SUMMARY_OPEN`/`CLOSE` markers).
   */
  claudeTurns?: Array<{ writes?: string; output?: string }>;
  /** The branch's changed files, as `git diff --name-only` reports them. */
  changedFiles: string;
  /** Tracked files `ls-files` reports. */
  trackedFiles?: string[];
  /** Files readable in the temp repoPath, path -> content. */
  repoFiles?: Record<string, string>;
  /**
   * Scripted replies to `runSummaryClaimQuestion`, one per call (repeats the
   * last entry once exhausted). Each entry is either a verdict reply string
   * or `"ERROR"` to simulate a launch failure.
   */
  questionReplies?: string[];
  /** Issue labels. Defaults to a non-bug enhancement. */
  issueLabels?: string[];
  /** When true, an open PR already exists for this run's branch. */
  existingPr?: boolean;
}

interface Outcome {
  status: string;
  reason?: string;
  outcomeKind?: string;
  claudeCalls: number;
  claudeCallDetails: ClaudeCall[];
  prCreateCalls: number;
  finalisePrCalls: number;
  questionCalls: QuestionCall[];
  comments: string[];
  /** The summary file's content when the run ended, before cleanup. */
  finalSummary: string | undefined;
}

/** Drive the live completion phase over a (possibly) blocked claim check. */
async function runCompletion(scenario: Scenario): Promise<Outcome> {
  const repoPath = await Deno.makeTempDir();
  const workDir = await Deno.makeTempDir();
  const summaryPath =
    `${repoPath}/docs/archive/pr-summaries/pr-summary-${ISSUE}.md`;
  await Deno.mkdir(`${repoPath}/docs/archive/pr-summaries`, {
    recursive: true,
  });
  await Deno.writeTextFile(summaryPath, scenario.summary);

  for (const [relPath, content] of Object.entries(scenario.repoFiles ?? {})) {
    const abs = `${repoPath}/${relPath}`;
    await Deno.mkdir(abs.slice(0, abs.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(abs, content);
  }

  const comments: string[] = [];
  let prCreateCalls = 0;
  let finalisePrCalls = 0;
  let claudeCallIndex = 0;
  const claudeCallDetails: ClaudeCall[] = [];
  let questionCallIndex = 0;
  const questionCalls: QuestionCall[] = [];

  const config = buildDefaultWorkerConfig();
  config.workDir = workDir;

  const ctx: IssueContext = {
    repo: REPO,
    issueNumber: ISSUE,
    issueTitle: "Check the summary claim check",
    issueBody: ISSUE_BODY,
    issueLabels: scenario.issueLabels ?? ["enhancement", "work-on"],
    issueComments: "",
    githubUser: "testbot",
    config,
  };
  const state: PhaseState = {
    branchName: `issue-${ISSUE}-summary-claim-check`,
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
        const ok = (stdout: string, code = 0) =>
          Promise.resolve({
            ok: true as const,
            value: { code, stdout, stderr: "" },
          });
        if (cmdArgs[0] === "rev-parse") return ok(`${SHA}\n`);
        if (cmdArgs[0] === "ls-files") {
          return ok((scenario.trackedFiles ?? []).join("\n"));
        }
        if (cmdArgs[0] === "diff" && cmdArgs[1] === "--name-only") {
          if (cmdArgs.includes("--diff-filter=ACMR")) return ok("");
          return ok(scenario.changedFiles);
        }
        if (cmdArgs[0] === "--literal-pathspecs" && cmdArgs[1] === "ls-tree") {
          return ok("");
        }
        return ok("");
      },
    },
    claude: {
      runClaudeWithRetry: (
        options: { prompt: string; disallowedTools?: readonly string[] },
      ) => {
        claudeCallDetails.push({
          prompt: options.prompt,
          disallowedTools: options.disallowedTools,
        });
        const turn = scenario.claudeTurns?.[
          Math.min(claudeCallIndex, (scenario.claudeTurns?.length ?? 1) - 1)
        ];
        claudeCallIndex++;
        if (turn !== undefined) {
          if (turn.writes !== undefined) {
            Deno.writeTextFileSync(summaryPath, turn.writes);
          }
          return Promise.resolve({
            ok: true as const,
            value: {
              exitCode: 0,
              output: turn.output ?? "done",
              timedOut: false,
            },
          });
        }
        if (scenario.retryWrites !== undefined) {
          Deno.writeTextFileSync(summaryPath, scenario.retryWrites);
        }
        return Promise.resolve({
          ok: true as const,
          value: { exitCode: 0, output: "done", timedOut: false },
        });
      },
      runSummaryClaimQuestion: (
        options: { prompt: string; disallowedTools?: readonly string[] },
      ) => {
        questionCalls.push({
          prompt: options.prompt,
          disallowedTools: options.disallowedTools,
        });
        const replies = scenario.questionReplies ?? ["EMPTY"];
        const reply = replies[Math.min(questionCallIndex, replies.length - 1)]!;
        questionCallIndex++;
        if (reply === "ERROR") {
          return Promise.resolve({
            ok: false as const,
            error: new Error("question could not be launched"),
          });
        }
        return Promise.resolve({
          ok: true as const,
          value: {
            exitCode: 0,
            output: reply === "EMPTY" ? verdictReply([]) : reply,
            timedOut: false,
          },
        });
      },
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
        scenario.existingPr
          ? Promise.resolve({ ok: true as const, value: PR_URL })
          : Promise.resolve({ ok: false, error: new Error("none") }),
      findExistingPrForBranch: () =>
        scenario.existingPr
          ? Promise.resolve({ ok: true as const, value: PR_URL })
          : Promise.resolve({ ok: false as const, error: new Error("none") }),
      recoverExistingPr: () =>
        Promise.resolve({ ok: true, value: "recovered" }),
      finalisePr: () => {
        finalisePrCalls++;
        return Promise.resolve({
          ok: true,
          value: { result: AutoMergeResult.Enabled, message: "armed" },
        });
      },
    },
  });

  let result;
  let finalSummary: string | undefined;
  try {
    result = await workOnIssueCompletion(ctx, state, deps);
    try {
      finalSummary = await Deno.readTextFile(summaryPath);
    } catch {
      finalSummary = undefined;
    }
  } finally {
    await Deno.remove(repoPath, { recursive: true });
    await Deno.remove(workDir, { recursive: true });
  }

  return {
    status: result.status,
    reason: result.status === "failure" || result.status === "early_exit"
      ? result.reason
      : undefined,
    outcomeKind: result.status === "early_exit"
      ? result.outcome?.kind
      : undefined,
    claudeCalls: claudeCallDetails.length,
    claudeCallDetails,
    prCreateCalls,
    finalisePrCalls,
    questionCalls,
    comments,
    finalSummary,
  };
}

// (a)
Deno.test(
  "completion - a wrong claim about named code blocks; the recovery removes it and the PR is raised",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_WRONG_CLAIM,
      retryWrites: SUMMARY_WRONG_CLAIM_FIXED,
      changedFiles: "docs/notes.md",
      questionReplies: [
        verdictReply([
          {
            file: `docs/archive/pr-summaries/pr-summary-${ISSUE}.md`,
            sentence: WRONG_CLAIM_SENTENCE,
            reason: "the head's phraseAnywhere builds no regex",
          },
        ]),
        verdictReply([]),
      ],
    });

    assertEquals(outcome.status, "continue");
    assertEquals(outcome.prCreateCalls, 1);
    assertEquals(outcome.claudeCalls, 1, "exactly one recovery invocation");
    assertEquals(outcome.comments.length, 1);
    assertStringIncludes(outcome.comments[0]!, "describes named code wrongly");
    assertStringIncludes(outcome.comments[0]!, WRONG_CLAIM_SENTENCE);
  },
);

// (b)
Deno.test(
  "completion - a wrong claim the recovery does not fix fails the run after one recovery turn",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_WRONG_CLAIM,
      // No retryWrites: the recovery changes nothing, the question keeps
      // finding it on the second attempt too.
      changedFiles: "docs/notes.md",
      questionReplies: [
        verdictReply([
          {
            file: `docs/archive/pr-summaries/pr-summary-${ISSUE}.md`,
            sentence: WRONG_CLAIM_SENTENCE,
            reason: "the head's phraseAnywhere builds no regex",
          },
        ]),
      ],
    });

    assertEquals(outcome.status, "failure");
    assertEquals(outcome.prCreateCalls, 0);
    // Issue #3324: the second attempt's block is claim-only (every other
    // gate passed), so it now gets the one summary-only correction turn
    // before the run fails — one recovery turn plus one correction turn.
    assertEquals(
      outcome.claudeCalls,
      2,
      "one recovery turn plus one correction turn",
    );
  },
);

// (c)
Deno.test(
  "completion - a Test Plan bullet citing a behaviour no test covers blocks; the recovery quotes a covered behaviour and the PR is raised",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_TEST_PLAN_CLAIM,
      retryWrites: SUMMARY_TEST_PLAN_CLAIM_FIXED,
      changedFiles: "docs/notes.md",
      trackedFiles: [WIDGET_TEST_PATH],
      repoFiles: { [WIDGET_TEST_PATH]: WIDGET_TEST_CONTENT },
    });

    assertEquals(outcome.status, "continue");
    assertEquals(outcome.prCreateCalls, 1);
    assertEquals(outcome.claudeCalls, 1, "exactly one recovery invocation");
    assertEquals(outcome.comments.length, 1);
    assertStringIncludes(outcome.comments[0]!, WIDGET_TEST_PATH);
    assertStringIncludes(
      outcome.comments[0]!,
      "rejects malformed widget payloads",
    );
  },
);

// (d)
Deno.test(
  "completion - a clean summary raises the PR; the question runs once, read-only, naming the base and the summary path",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_CLEAN,
      changedFiles: "docs/notes.md",
    });

    assertEquals(outcome.status, "continue");
    assertEquals(outcome.prCreateCalls, 1);
    assertEquals(outcome.claudeCalls, 0);
    assertEquals(outcome.questionCalls.length, 1);
    const call = outcome.questionCalls[0]!;
    assertStringIncludes(call.prompt, "...HEAD");
    assertStringIncludes(
      call.prompt,
      `docs/archive/pr-summaries/pr-summary-${ISSUE}.md`,
    );
    assert(call.disallowedTools?.includes("Edit"));
    assert(call.disallowedTools?.includes("Write"));
  },
);

// (e)
Deno.test(
  "completion - the question failing to launch does not block the PR",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_CLEAN,
      changedFiles: "docs/notes.md",
      questionReplies: ["ERROR"],
    });

    assertEquals(outcome.status, "continue");
    assertEquals(outcome.prCreateCalls, 1);
    assertEquals(outcome.claudeCalls, 0);
  },
);

// (f)
Deno.test(
  "completion - a code diff with no Branch outcomes list AND a wrong claim folds into one comment, one recovery turn",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_FOLD,
      changedFiles: "crates/report/src/decisions.rs",
      questionReplies: [
        verdictReply([
          {
            file: `docs/archive/pr-summaries/pr-summary-${ISSUE}.md`,
            sentence: WRONG_CLAIM_SENTENCE,
            reason: "the head's phraseAnywhere builds no regex",
          },
        ]),
      ],
    });

    assertEquals(outcome.status, "failure");
    assertEquals(outcome.prCreateCalls, 0);
    assertEquals(outcome.comments.length, 1);
    assertStringIncludes(outcome.comments[0]!, "Branch outcomes");
    assertStringIncludes(outcome.comments[0]!, "describes named code wrongly");
    assertEquals(outcome.claudeCalls, 1, "exactly one recovery invocation");

    // Issue #3324: the folded branch-outcomes + claim-check comment reaches
    // the recovery prompt as two separate numbered REQUIRED ITEMs.
    const recoveryPrompt = outcome.claudeCallDetails[0]!.prompt;
    assertStringIncludes(recoveryPrompt, "REQUIRED ITEM 1 of 2");
    assertStringIncludes(recoveryPrompt, "REQUIRED ITEM 2 of 2");
    const item2HeaderIndex = recoveryPrompt.indexOf("REQUIRED ITEM 2 of 2");
    const claimTextIndex = recoveryPrompt.indexOf(
      "describes named code wrongly",
      item2HeaderIndex,
    );
    assertEquals(claimTextIndex > item2HeaderIndex, true);
    const claimSentenceIndex = recoveryPrompt.indexOf(
      WRONG_CLAIM_SENTENCE,
      item2HeaderIndex,
    );
    assertEquals(claimSentenceIndex > item2HeaderIndex, true);
  },
);

// ---------------------------------------------------------------------------
// Summary-only claim correction turn (Issue #3324): a sentence the claim
// check only flags on the re-run, after the recovery turn was already
// spent.
// ---------------------------------------------------------------------------

const SENTENCE_B =
  "`anotherHelper()` strips whitespace before comparing values.";

/** (h) A summary carrying two wrong claims, A and B. */
const SUMMARY_TWO_WRONG_CLAIMS = `## Summary

Changed the broker balance card. Closes #${ISSUE}.

${WRONG_CLAIM_SENTENCE}

${SENTENCE_B}

## Test Plan

- manually verified
`;

/** (h) After the recovery turn removes A but leaves B untouched. */
const SUMMARY_AFTER_RECOVERY_LEAVES_B = `## Summary

Changed the broker balance card. Closes #${ISSUE}.

${SENTENCE_B}

## Test Plan

- manually verified
`;

/** (h) After the correction turn removes B too. */
const SUMMARY_AFTER_CORRECTION = `## Summary

Changed the broker balance card. Closes #${ISSUE}.

## Test Plan

- manually verified
`;

const SUMMARY_PATH_3257 = `docs/archive/pr-summaries/pr-summary-${ISSUE}.md`;

function findingFor(sentence: string, reason: string) {
  return { file: SUMMARY_PATH_3257, sentence, reason };
}

// (h)
Deno.test(
  "completion - a claim found only on the re-run is corrected by the one summary-only correction turn",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_TWO_WRONG_CLAIMS,
      changedFiles: "docs/notes.md",
      claudeTurns: [
        { writes: SUMMARY_AFTER_RECOVERY_LEAVES_B },
        {
          output:
            `${CORRECTED_SUMMARY_OPEN}\n${SUMMARY_AFTER_CORRECTION}${CORRECTED_SUMMARY_CLOSE}`,
        },
      ],
      questionReplies: [
        verdictReply([
          findingFor(
            WRONG_CLAIM_SENTENCE,
            "the head's phraseAnywhere builds no regex",
          ),
        ]),
        verdictReply([
          findingFor(SENTENCE_B, "the head's anotherHelper does not compare"),
        ]),
        verdictReply([]),
      ],
    });

    assertEquals(outcome.status, "continue");
    assertEquals(outcome.prCreateCalls, 1);
    assertEquals(
      outcome.claudeCalls,
      2,
      "one recovery turn, one correction turn",
    );
    const correctionCall = outcome.claudeCallDetails[1]!;
    assert(correctionCall.disallowedTools?.includes("Bash"));
    assert(correctionCall.disallowedTools?.includes("Edit"));
    assert(correctionCall.disallowedTools?.includes("Write"));
    assertEquals(
      (outcome.finalSummary ?? "").includes(SENTENCE_B),
      false,
      "the corrected summary no longer carries sentence B",
    );
  },
);

// (i)
Deno.test(
  "completion - the correction turn finalises an existing PR normally when the claim clears",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_TWO_WRONG_CLAIMS,
      changedFiles: "docs/notes.md",
      existingPr: true,
      claudeTurns: [
        { writes: SUMMARY_AFTER_RECOVERY_LEAVES_B },
        {
          output:
            `${CORRECTED_SUMMARY_OPEN}\n${SUMMARY_AFTER_CORRECTION}${CORRECTED_SUMMARY_CLOSE}`,
        },
      ],
      questionReplies: [
        verdictReply([
          findingFor(
            WRONG_CLAIM_SENTENCE,
            "the head's phraseAnywhere builds no regex",
          ),
        ]),
        verdictReply([
          findingFor(SENTENCE_B, "the head's anotherHelper does not compare"),
        ]),
        verdictReply([]),
      ],
    });

    assertEquals(outcome.status !== "early_exit", true);
    assertEquals(outcome.reason, undefined);
    assertEquals(
      outcome.finalisePrCalls > 0,
      true,
      "the existing PR was finalised",
    );
  },
);

// (j) Negative test for carry-forward: the correction turn fails to remove
// the sentence (or replies with no markers at all) and the re-run's own
// model pass misses it too — the carried-forward finding still blocks.
Deno.test(
  "completion - a correction that leaves the sentence still blocks via the carried-forward finding (no PR)",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_TWO_WRONG_CLAIMS,
      changedFiles: "docs/notes.md",
      claudeTurns: [
        { writes: SUMMARY_AFTER_RECOVERY_LEAVES_B },
        // No CORRECTED_SUMMARY_OPEN/CLOSE markers — the correction leaves
        // the file untouched, so sentence B is still on the branch.
        { output: "I looked, but nothing needed fixing." },
      ],
      questionReplies: [
        verdictReply([
          findingFor(
            WRONG_CLAIM_SENTENCE,
            "the head's phraseAnywhere builds no regex",
          ),
        ]),
        verdictReply([
          findingFor(SENTENCE_B, "the head's anotherHelper does not compare"),
        ]),
        // The re-run's own model pass misses sentence B entirely; only the
        // carried-forward finding should still catch it.
        verdictReply([]),
      ],
    });

    assertEquals(outcome.status, "failure");
    assertEquals(outcome.prCreateCalls, 0);
    assertEquals(outcome.claudeCalls, 2);
  },
);

Deno.test(
  "completion - a correction that leaves the sentence blocks an existing PR as summary_incomplete via carry-forward",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_TWO_WRONG_CLAIMS,
      changedFiles: "docs/notes.md",
      existingPr: true,
      claudeTurns: [
        { writes: SUMMARY_AFTER_RECOVERY_LEAVES_B },
        { output: "I looked, but nothing needed fixing." },
      ],
      questionReplies: [
        verdictReply([
          findingFor(
            WRONG_CLAIM_SENTENCE,
            "the head's phraseAnywhere builds no regex",
          ),
        ]),
        verdictReply([
          findingFor(SENTENCE_B, "the head's anotherHelper does not compare"),
        ]),
        verdictReply([]),
      ],
    });

    assertEquals(outcome.status, "early_exit");
    assertEquals(outcome.outcomeKind, "summary_incomplete");
  },
);

// (k) The correction turn runs at most once per run: a new sentence C
// flagged on the attempt right after the correction does not get a second
// correction turn.
Deno.test(
  "completion - the correction turn runs at most once per run",
  async () => {
    const SENTENCE_C = "`thirdHelper()` rounds to two decimal places.";
    // The correction turn fixes B but, in rewriting that line, introduces a
    // brand-new wrong claim C — a new, never-before-seen block.
    const SUMMARY_AFTER_CORRECTION_WITH_C = `## Summary

Changed the broker balance card. Closes #${ISSUE}.

${SENTENCE_C}

## Test Plan

- manually verified
`;
    const outcome = await runCompletion({
      summary: SUMMARY_TWO_WRONG_CLAIMS,
      changedFiles: "docs/notes.md",
      claudeTurns: [
        { writes: SUMMARY_AFTER_RECOVERY_LEAVES_B },
        {
          output:
            `${CORRECTED_SUMMARY_OPEN}\n${SUMMARY_AFTER_CORRECTION_WITH_C}${CORRECTED_SUMMARY_CLOSE}`,
        },
      ],
      questionReplies: [
        verdictReply([
          findingFor(
            WRONG_CLAIM_SENTENCE,
            "the head's phraseAnywhere builds no regex",
          ),
        ]),
        verdictReply([
          findingFor(SENTENCE_B, "the head's anotherHelper does not compare"),
        ]),
        // Attempt 3, after the correction turn: a brand-new sentence C.
        verdictReply([
          findingFor(SENTENCE_C, "the head's thirdHelper does not round"),
        ]),
      ],
    });

    assertEquals(outcome.status, "failure");
    assertEquals(outcome.prCreateCalls, 0);
    assertEquals(
      outcome.claudeCalls,
      2,
      "no third (correction) turn — the correction runs at most once per run",
    );
  },
);

// (g)
Deno.test(
  "completion - no summary file at all never calls the summary claim question",
  async () => {
    const repoPath = await Deno.makeTempDir();
    const workDir = await Deno.makeTempDir();
    // No docs/archive/pr-summaries file written at all.

    const comments: string[] = [];
    let prCreateCalls = 0;
    const questionCalls: QuestionCall[] = [];

    const config = buildDefaultWorkerConfig();
    config.workDir = workDir;

    const ctx: IssueContext = {
      repo: REPO,
      issueNumber: ISSUE,
      issueTitle: "Check the summary claim check",
      issueBody: ISSUE_BODY,
      issueLabels: ["enhancement", "work-on"],
      issueComments: "",
      githubUser: "testbot",
      config,
    };
    const state: PhaseState = {
      branchName: `issue-${ISSUE}-summary-claim-check-no-summary`,
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
          if (args[0] === "pr" && args[1] === "view") {
            return Promise.resolve(JSON.stringify({ state: "OPEN" }));
          }
          return Promise.resolve(PR_URL);
        },
      },
      git: {
        runGitCommand: (
          cmdArgs: string[],
        ): Promise<
          Result<{ code: number; stdout: string; stderr: string }>
        > => {
          const ok = (stdout: string, code = 0) =>
            Promise.resolve({
              ok: true as const,
              value: { code, stdout, stderr: "" },
            });
          if (cmdArgs[0] === "rev-parse") return ok(`${SHA}\n`);
          if (cmdArgs[0] === "ls-files") return ok("");
          if (cmdArgs[0] === "diff" && cmdArgs[1] === "--name-only") {
            if (cmdArgs.includes("--diff-filter=ACMR")) return ok("");
            return ok("docs/notes.md");
          }
          return ok("");
        },
      },
      claude: {
        runSummaryClaimQuestion: (
          options: { prompt: string },
        ) => {
          questionCalls.push({ prompt: options.prompt, disallowedTools: [] });
          return Promise.resolve({
            ok: true as const,
            value: { exitCode: 0, output: verdictReply([]), timedOut: false },
          });
        },
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
        recoverExistingPr: () =>
          Promise.resolve({ ok: true, value: "recovered" }),
        finalisePr: () =>
          Promise.resolve({
            ok: true,
            value: { result: AutoMergeResult.Enabled, message: "armed" },
          }),
      },
    });

    let result;
    try {
      result = await workOnIssueCompletion(ctx, state, deps);
    } finally {
      await Deno.remove(repoPath, { recursive: true });
      await Deno.remove(workDir, { recursive: true });
    }

    assertEquals(result.status, "continue");
    assertEquals(prCreateCalls, 1);
    assertEquals(questionCalls.length, 0, "no summary file — no question");
  },
);
