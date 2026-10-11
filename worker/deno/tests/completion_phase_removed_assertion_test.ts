/**
 * Integration tests for the removed-test-assertion gate running in the LIVE
 * completion phase (Issue #3131).
 *
 * The fleet's PR-summary contract already told the agent (#3061) to list
 * every assertion a diff removes from an *existing* test, together with the
 * issue requirement that makes the old assertion untrue, in the PR
 * summary's `## Test Plan` — but that rule was prose only; nothing in the
 * worker checked it. These tests drive `workOnIssueCompletion` and assert
 * on the observable outcome (whether `gh pr create` was invoked, whether
 * the in-run recovery fired, what the posted comment says), not on how the
 * gate is called.
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
import { MAX_DIFF_CHARS } from "../lib/removed_assertion_gate.ts";

const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f901122334456";
const REPO = "stSoftwareAU/VibeCoder";
const ISSUE = 3131;
const PR_URL = `https://github.com/${REPO}/pull/4211`;

const ISSUE_BODY = `## Problem

Removed test assertions are not accounted for in the PR summary.
`;

const ISSUE_BODY_WITH_CRITERIA = `## Problem

Removed test assertions are not accounted for in the PR summary.

## Acceptance Criteria

- [ ] Removed assertions are named in the Test Plan.
- [ ] A test drives the gate both ways.
`;

/** The issue's own verification fixture: a realistic `git diff --unified=0` removing an assertion. */
const SCORE_DIFF = [
  "diff --git a/crates/api/tests/decisions.rs b/crates/api/tests/decisions.rs",
  "index abc123..def456 100644",
  "--- a/crates/api/tests/decisions.rs",
  "+++ b/crates/api/tests/decisions.rs",
  "@@ -40,1 +40,0 @@ fn scores_are_rated() {",
  '-    assert_eq!(record.score.to_string(), "-0.5");',
  "",
].join("\n");

/** A test-file diff that adds a line but removes nothing. */
const NOOP_TEST_DIFF = [
  "diff --git a/worker/deno/tests/foo_test.ts b/worker/deno/tests/foo_test.ts",
  "index 111..222 100644",
  "--- a/worker/deno/tests/foo_test.ts",
  "+++ b/worker/deno/tests/foo_test.ts",
  "@@ -10,0 +11,1 @@",
  '+  console.log("noop");',
  "",
].join("\n");

/** A summary with a `## Test Plan` that does not name the removed assertion. */
const SUMMARY_WITHOUT_ASSERTION = `## Summary

Changed scoring to a rating. Closes #${ISSUE}.

## Test Plan

- \`crates/api/tests/decisions.rs\` still passes.
`;

/** The same summary once the gate's comment has been answered. */
const SUMMARY_WITH_ASSERTION = `## Summary

Changed scoring to a rating. Closes #${ISSUE}.

## Test Plan

- Removed from \`crates/api/tests/decisions.rs\`: \`assert_eq!(record.score.to_string(), "-0.5")\` — #2253 changes the score to a rating, so the old value is untrue
`;

/** A summary with no `## Test Plan` heading at all. */
const SUMMARY_WITHOUT_HEADING = `## Summary

Tidied a log line. Closes #${ISSUE}.
`;

/** A summary with a Test Plan heading but no closure block (Acceptance Criteria) at all. */
const SUMMARY_NO_CLOSURE_NO_ASSERTION = `## Summary

Changed scoring to a rating. Closes #${ISSUE}.

## Test Plan

- \`crates/api/tests/decisions.rs\` still passes.
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

interface Scenario {
  /** Summary on the branch when the completion phase starts. */
  summary: string;
  /** Summary the recovery invocation writes; omitted, it changes nothing. */
  retryWrites?: string;
  /** The branch's changed files, as `git diff --name-only` reports them. */
  changedFiles: string;
  /**
   * `git diff --name-status -z` stdout. Defaults to one `M` record per
   * changed file. Set this when the rename-collapsed name list and the
   * sides list disagree.
   */
  renameStatus?: string;
  /** The test-file-only unified diff (`removedAssertionDiffArgs`'s output). */
  testDiff?: string;
  /** When true, the test-file diff read fails (non-zero exit). */
  testDiffFails?: boolean;
  /** Issue body; defaults to one with no Acceptance Criteria. */
  issueBody?: string;
}

interface Outcome {
  status: string;
  reason?: string;
  claudeCalls: number;
  prCreateCalls: number;
  comments: string[];
  warnings: string[];
  /** argv of the `git diff` call the gate used to read the test-file patch. */
  testDiffArgs?: string[];
}

/** Drive the live completion phase over a (possibly) blocked removed-assertion gate. */
async function runCompletion(scenario: Scenario): Promise<Outcome> {
  const repoPath = await Deno.makeTempDir();
  const workDir = await Deno.makeTempDir();
  const summaryPath =
    `${repoPath}/docs/archive/pr-summaries/pr-summary-${ISSUE}.md`;
  await Deno.mkdir(`${repoPath}/docs/archive/pr-summaries`, {
    recursive: true,
  });
  await Deno.writeTextFile(summaryPath, scenario.summary);

  const comments: string[] = [];
  const warnings: string[] = [];
  let prCreateCalls = 0;
  let claudeCalls = 0;
  let testDiffArgs: string[] | undefined;

  const config = buildDefaultWorkerConfig();
  config.workDir = workDir;

  const ctx: IssueContext = {
    repo: REPO,
    issueNumber: ISSUE,
    issueTitle: "Check removed test assertions",
    issueBody: scenario.issueBody ?? ISSUE_BODY,
    issueLabels: ["enhancement", "work-on"],
    issueComments: "",
    githubUser: "testbot",
    config,
  };
  const state: PhaseState = {
    branchName: `issue-${ISSUE}-removed-assertion`,
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
    logger: {
      warn: (message: string) => {
        warnings.push(message);
      },
    },
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
        const ok = (stdout: string) =>
          Promise.resolve({
            ok: true as const,
            value: { code: 0, stdout, stderr: "" },
          });
        if (cmdArgs[0] === "rev-parse") return ok(`${SHA}\n`);
        if (
          cmdArgs[0] === "diff" && cmdArgs.includes("--diff-filter=AMRD")
        ) {
          testDiffArgs = cmdArgs;
          if (scenario.testDiffFails) {
            return Promise.resolve({
              ok: true as const,
              value: { code: 128, stdout: "", stderr: "fatal: bad revision" },
            });
          }
          return ok(scenario.testDiff ?? "");
        }
        if (
          cmdArgs[0] === "diff" && cmdArgs.includes("--name-status") &&
          cmdArgs.includes("-z")
        ) {
          if (scenario.renameStatus !== undefined) {
            return ok(scenario.renameStatus);
          }
          const paths = scenario.changedFiles.split("\n").filter((path) =>
            path.length > 0
          );
          return ok(
            paths.length > 0
              ? `${paths.map((path) => `M\0${path}`).join("\0")}\0`
              : "",
          );
        }
        if (
          cmdArgs[0] === "diff" && cmdArgs.includes("--name-only") &&
          cmdArgs.includes("-z") && cmdArgs.includes("--no-renames")
        ) {
          const paths = scenario.changedFiles.split("\n").filter((path) =>
            path.length > 0
          );
          return ok(paths.length > 0 ? `${paths.join("\0")}\0` : "");
        }
        if (cmdArgs[0] === "diff" && cmdArgs[1] === "--name-only") {
          return ok(scenario.changedFiles);
        }
        return ok("");
      },
    },
    claude: {
      runClaudeWithRetry: (_options: { prompt: string }) => {
        claudeCalls++;
        if (scenario.retryWrites !== undefined) {
          Deno.writeTextFileSync(summaryPath, scenario.retryWrites);
        }
        return Promise.resolve({
          ok: true as const,
          value: { exitCode: 0, output: "done", timedOut: false },
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

  return {
    status: result.status,
    reason: result.status === "failure" || result.status === "early_exit"
      ? result.reason
      : undefined,
    claudeCalls,
    prCreateCalls,
    comments,
    warnings,
    testDiffArgs,
  };
}

// --- (a) Issue's verification case -----------------------------------------

Deno.test(
  "completion - a removed assertion not named in the Test Plan fails with no PR raised",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_WITHOUT_ASSERTION,
      changedFiles: "crates/api/tests/decisions.rs",
      testDiff: SCORE_DIFF,
    });

    assertEquals(outcome.status, "failure");
    assertEquals(outcome.prCreateCalls, 0, "gh pr create must not run");
    assertStringIncludes(outcome.reason ?? "", "Test Plan");
    assertEquals(outcome.comments.length, 1);
    assertStringIncludes(
      outcome.comments[0]!,
      'assert_eq!(record.score.to_string(), "-0.5");',
    );
    assertStringIncludes(outcome.comments[0]!, "Test Plan");
  },
);

// --- (b) Recovery names the assertion ---------------------------------------

Deno.test(
  "completion - recovery naming the removed assertion recovers once in-run and then raises the PR",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_WITHOUT_ASSERTION,
      retryWrites: SUMMARY_WITH_ASSERTION,
      changedFiles: "crates/api/tests/decisions.rs",
      testDiff: SCORE_DIFF,
    });

    assertEquals(outcome.status, "continue");
    assertEquals(outcome.claudeCalls, 1, "exactly one recovery invocation");
    assertEquals(outcome.prCreateCalls, 1, "the recovered run raises its PR");
  },
);

// --- (c) Summary already names the assertion --------------------------------

Deno.test(
  "completion - a summary already naming the removed assertion raises the PR with no comment",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_WITH_ASSERTION,
      changedFiles: "crates/api/tests/decisions.rs",
      testDiff: SCORE_DIFF,
    });

    assertEquals(outcome.status, "continue");
    assertEquals(outcome.prCreateCalls, 1);
    assertEquals(outcome.claudeCalls, 0, "no recovery invocation needed");
    assertEquals(outcome.comments.length, 0);
  },
);

// --- (d) Test file touched, no removed assertions, no Test Plan heading ----

Deno.test(
  "completion - a test-file diff with no removed assertion still requires the Test Plan heading",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_WITHOUT_HEADING,
      changedFiles: "worker/deno/tests/foo_test.ts",
      testDiff: NOOP_TEST_DIFF,
    });

    assertEquals(outcome.status, "failure");
    assertEquals(outcome.prCreateCalls, 0, "gh pr create must not run");
    assertStringIncludes(outcome.reason ?? "", "Test Plan");
    assertEquals(outcome.comments.length, 1);
  },
);

// --- (e) Test-file patch unreadable: only the heading rule applies ---------

Deno.test(
  "completion - an unreadable test-file diff still raises the PR when the Test Plan heading is present",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_WITHOUT_ASSERTION,
      changedFiles: "crates/api/tests/decisions.rs",
      testDiffFails: true,
    });

    assertEquals(outcome.status, "continue");
    assertEquals(outcome.prCreateCalls, 1);
    assertEquals(outcome.comments.length, 0);
  },
);

// --- (f) Folding with the acceptance-criteria closure gate ------------------

Deno.test(
  "completion - a summary missing both the closure block and the removed-assertion naming gets one comment with both notices",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_NO_CLOSURE_NO_ASSERTION,
      changedFiles: "crates/api/tests/decisions.rs",
      testDiff: SCORE_DIFF,
      issueBody: ISSUE_BODY_WITH_CRITERIA,
    });

    assertEquals(outcome.status, "failure");
    assertEquals(outcome.prCreateCalls, 0);
    assertEquals(outcome.comments.length, 1);
    assertStringIncludes(outcome.comments[0]!, "Acceptance-criteria closure");
    assertStringIncludes(
      outcome.comments[0]!,
      "Removed test assertions not accounted for",
    );
  },
);

// --- (g) Ordering with the docs-sweep gate ----------------------------------

Deno.test(
  "completion - a summary failing both the docs sweep and the removed-assertion gate gets one comment with both notices",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_WITHOUT_HEADING,
      changedFiles: "crates/api/src/lib.rs\ncrates/api/tests/decisions.rs",
      testDiff: SCORE_DIFF,
    });

    assertEquals(outcome.status, "failure");
    assertEquals(outcome.prCreateCalls, 0);
    assertEquals(outcome.comments.length, 1);
    assertStringIncludes(outcome.comments[0]!, "Docs sweep");
    assertStringIncludes(
      outcome.comments[0]!,
      "Removed test assertions not accounted for",
    );
  },
);

// --- (h) Diff scoped to just the changed test files (PR #3148 review) ------

/** SUMMARY_WITH_ASSERTION plus a Docs sweep line and a Branch outcomes line,
 * so a changed non-test source file (`crates/api/src/lib.rs`) does not also
 * trip those gates (Issue #3147). */
const SUMMARY_WITH_ASSERTION_AND_DOCS_SWEEP = SUMMARY_WITH_ASSERTION +
  "\n**Docs sweep** — grep: `score`; section: none — internal scoring " +
  "logic isn't documented; no hits; siblings: none — no existing set gained a member\n" +
  "\n**Branch outcomes:** none added\n";

Deno.test(
  "completion - the removed-assertion diff is scoped to just the changed test files",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_WITH_ASSERTION_AND_DOCS_SWEEP,
      changedFiles: "crates/api/src/lib.rs\ncrates/api/tests/decisions.rs",
      testDiff: SCORE_DIFF,
    });

    assertEquals(outcome.status, "continue");
    const args = outcome.testDiffArgs ?? [];
    const pathspecIndex = args.indexOf("--");
    assert(pathspecIndex !== -1, "pathspec separator must be present");
    assertEquals(args.slice(pathspecIndex + 1), [
      "crates/api/tests/decisions.rs",
    ]);
    assert(
      !args.includes("crates/api/src/lib.rs"),
      "the non-test file must not be part of the pathspec",
    );
  },
);

// --- (i) Rename-collapsed list hides the test file (PR #3148 review) -------

Deno.test(
  "completion - a test file renamed out of the test directory still blocks when an assertion is dropped",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_WITHOUT_HEADING,
      changedFiles: "src/moved.rs",
      renameStatus: "R100\0tests/moved_test.rs\0src/moved.rs\0",
      testDiff: SCORE_DIFF,
    });

    assertEquals(outcome.status, "failure");
    assertEquals(outcome.prCreateCalls, 0, "gh pr create must not run");
    assertStringIncludes(outcome.reason ?? "", "Test Plan");
    const args = outcome.testDiffArgs ?? [];
    const pathspecIndex = args.indexOf("--");
    assert(pathspecIndex !== -1, "pathspec separator must be present");
    assertEquals(args.slice(pathspecIndex + 1), [
      "tests/moved_test.rs",
      "src/moved.rs",
    ]);
  },
);

// --- (j) Patch at the read cap is unreadable, never silently truncated -----
// (PR #3148 review: a large unrelated hunk pushing a test file's own patch
// past MAX_DIFF_CHARS used to pass with testDiffKnown=true and removed:0.)

Deno.test(
  "completion - a test-file diff at the read cap is treated as unreadable rather than silently truncated",
  async () => {
    const hugeDiff = "x".repeat(MAX_DIFF_CHARS) + "\n" + SCORE_DIFF;
    const outcome = await runCompletion({
      summary: SUMMARY_WITHOUT_ASSERTION,
      changedFiles: "crates/api/tests/decisions.rs",
      testDiff: hugeDiff,
    });

    // Treated as unreadable: only the Test Plan heading rule applies, and
    // SUMMARY_WITHOUT_ASSERTION already carries that heading, so the run
    // proceeds rather than silently passing with a false removed:0.
    assertEquals(outcome.status, "continue");
    assertEquals(outcome.prCreateCalls, 1);
    assert(
      outcome.warnings.some((w) => w.includes("read cap")),
      "a warning must be logged when the patch is treated as unreadable",
    );
  },
);

// --- (k) An assertion re-added under a new guard blocks (PR #3148 review) ---
// The patch is read with whole-file context, so a Rust assertion moved into
// a new multi-line `if false { … }` is seen with its guard and is not
// "moved". A Test Plan that does not name it must not raise a PR.

/** Whole-file patch: `assert_eq!` re-added inside a new `if false { }`. */
const GUARDED_READD_DIFF = [
  "diff --git a/crates/api/tests/decisions.rs b/crates/api/tests/decisions.rs",
  "index abc123..def456 100644",
  "--- a/crates/api/tests/decisions.rs",
  "+++ b/crates/api/tests/decisions.rs",
  "@@ -1,5 +1,7 @@",
  " #[test]",
  " fn scores_are_rated() {",
  "     let record = load();",
  '-    assert_eq!(record.score.to_string(), "-0.5");',
  "+    if false {",
  '+        assert_eq!(record.score.to_string(), "-0.5");',
  "+    }",
  " }",
  "",
].join("\n");

Deno.test(
  "completion - an assertion re-added inside a new `if false { }` blocks with no PR raised",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_WITHOUT_ASSERTION,
      changedFiles: "crates/api/tests/decisions.rs",
      testDiff: GUARDED_READD_DIFF,
    });

    assertEquals(outcome.status, "failure");
    assertEquals(outcome.prCreateCalls, 0, "gh pr create must not run");
    assertEquals(outcome.comments.length, 1);
    assertStringIncludes(
      outcome.comments[0]!,
      'assert_eq!(record.score.to_string(), "-0.5");',
    );
    assertStringIncludes(outcome.comments[0]!, "does not count as moved");
  },
);
