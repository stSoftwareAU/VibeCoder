/**
 * Integration tests for the PR-summary docs-sweep gate running in the LIVE
 * completion phase (Issue #3073).
 *
 * A PR summary carrying no `Docs sweep` line — or one naming no manual
 * `section:` — used to sail through PR creation unchecked. These tests drive
 * `workOnIssueCompletion` and assert on the observable outcome (whether
 * `gh pr create` was invoked, whether the in-run recovery fired), not on how
 * the gate is called.
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
  type DeferredPrRecord,
  listDeferredPrs,
} from "../lib/deferred_pr_store.ts";

const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f901122334455";
const REPO = "stSoftwareAU/VibeCoder";
const ISSUE = 3073;
const PR_URL = `https://github.com/${REPO}/pull/4210`;

/** GitHub's secondary (content-creation) rate-limit refusal of `gh pr create`. */
const SECONDARY_LIMIT_ERROR =
  "gh command failed (exit 1): HTTP 403: You have exceeded a secondary rate " +
  "limit and have been temporarily blocked from content creation. Please " +
  "retry your request again later.";

const ISSUE_BODY = `## Problem

Nothing checks the PR summary's Docs sweep line.
`;

/** A summary with no Docs sweep line at all. */
const SUMMARY_WITHOUT_LINE = `## Summary

Changed the broker balance card. Closes #${ISSUE}.

## Test Plan

- \`worker/deno/tests/completion_phase_docs_sweep_test.ts\`
`;

/** The same summary once the gate's comment has been answered. */
const SUMMARY_WITH_LINE = `## Summary

Changed the broker balance card. Closes #${ISSUE}.

**Docs sweep** — grep: \`BrokerBalance\`; section: \`docs/reporting-api.md#decisions-report\`; no hits; siblings: none — no existing set gained a member

**Branch outcomes:** none added

## Test Plan

- \`worker/deno/tests/completion_phase_docs_sweep_test.ts\`
`;

/** One comment posted, with the issue/PR number it was posted to (Issue #3237). */
interface CommentPost {
  number: number;
  body: string;
}

function stubClient(
  comments: string[],
  posts: CommentPost[] = [],
  options: { postCommentThrows?: boolean } = {},
): GitHubClient {
  return {
    getIssue: () => {
      throw new Error("stub");
    },
    getIssueComments: () => Promise.resolve([]),
    addLabel: () => Promise.resolve(),
    removeLabel: () => Promise.resolve(),
    postComment: (_repo: string, issue: number, body: string) => {
      if (options.postCommentThrows) {
        return Promise.reject(new Error("stub: postComment failed"));
      }
      comments.push(body);
      posts.push({ number: issue, body });
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
  /** Whether the run's branch already carries an open PR. */
  prExistsForBranch?: boolean;
  /**
   * When true, the `git diff --name-only <base>...HEAD` call that resolves
   * `changedFiles` for the docs-sweep gate fails (non-zero exit) — the gate
   * must fail closed rather than read the unreadable diff as docs-free
   * (Issue #3073 / #3085 review).
   */
  diffFails?: boolean;
  /**
   * What `git grep` over the head's docs answers for the Docs sweep line's
   * terms (Issue #3172), in `git grep -n -z HEAD` shape. Omitted, no hit.
   */
  grepOutput?: string;
  /**
   * What `git grep` over source files outside `docs/` answers — the
   * comment-line pass (Issue #3219). Omitted, no hit.
   */
  sourceGrepOutput?: string;
  /** Exit code `git grep` returns; defaults to 0 with output, 1 without. */
  grepCode?: number;
  /** Ordered event log shared across the mocked deps, for assertion. */
  events?: string[];
  /**
   * When true, the stub client's `postComment` rejects — exercising the
   * advisory docs-sweep comment's own failure path (Issue #3237). Omitted,
   * `postComment` succeeds as normal.
   */
  postCommentThrows?: boolean;
  /**
   * When true, `gh pr create` is refused by GitHub's secondary
   * (content-creation) rate limit with no time left in the run, so the PR is
   * parked for the next cycle's drain (Issue #1951).
   */
  prCreateRefusedBySecondaryLimit?: boolean;
}

interface Outcome {
  status: string;
  reason?: string;
  claudeCalls: number;
  claudePrompts: string[];
  prCreateCalls: number;
  comments: string[];
  /** Every comment posted, with the issue/PR number it targeted (Issue #3237). */
  commentPosts: CommentPost[];
  events: string[];
  /** `logger.warn` messages recorded while driving this run (Issue #3237). */
  warnLogs: string[];
  /** PRs parked for the next cycle's drain when creation was deferred. */
  deferred: DeferredPrRecord[];
}

/** Drive the live completion phase over a (possibly) blocked docs-sweep gate. */
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
  const commentPosts: CommentPost[] = [];
  let prCreateCalls = 0;
  let claudeCalls = 0;
  const claudePrompts: string[] = [];
  const events = scenario.events ?? [];
  const warnLogs: string[] = [];

  const config = buildDefaultWorkerConfig();
  config.workDir = workDir;
  config.infraRetryBackoffMs = 1;

  const ctx: IssueContext = {
    repo: REPO,
    issueNumber: ISSUE,
    issueTitle: "Check the Docs sweep line",
    issueBody: ISSUE_BODY,
    issueLabels: ["enhancement", "work-on"],
    issueComments: "",
    githubUser: "testbot",
    config,
    // No time left to wait out a secondary limit: the run defers at once.
    ...(scenario.prCreateRefusedBySecondaryLimit
      ? { handlerDeadlineEpochMs: Date.now() }
      : {}),
  };
  const state: PhaseState = {
    branchName: `issue-${ISSUE}-docs-sweep`,
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
        warnLogs.push(message);
      },
    },
    github: {
      createClient: () =>
        stubClient(comments, commentPosts, {
          postCommentThrows: scenario.postCommentThrows,
        }),
      runGhCommand: (args: string[]) => {
        if (args[0] === "pr" && args[1] === "create") {
          prCreateCalls++;
          events.push("pr-create");
          if (scenario.prCreateRefusedBySecondaryLimit) {
            return Promise.reject(new Error(SECONDARY_LIMIT_ERROR));
          }
        }
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
        if (cmdArgs[0] === "grep") {
          const stdout = cmdArgs.includes(":(exclude)docs")
            ? scenario.sourceGrepOutput ?? ""
            : scenario.grepOutput ?? "";
          return Promise.resolve({
            ok: true as const,
            value: {
              code: scenario.grepCode ?? (stdout === "" ? 1 : 0),
              stdout,
              stderr: "",
            },
          });
        }
        // The 3-arg form (`diff --name-only <base>...HEAD`) is the call that
        // feeds the docs-sweep gate's `changedFiles`; the 4-arg form (with
        // `--diff-filter=ACMR`) feeds the unrelated changed-workflow gate and
        // must keep succeeding so a failing diff only exercises the gate
        // under test.
        if (
          cmdArgs[0] === "diff" && cmdArgs[1] === "--name-only" &&
          cmdArgs.length === 3
        ) {
          if (scenario.diffFails) {
            return Promise.resolve({
              ok: true as const,
              value: { code: 128, stdout: "", stderr: "fatal: bad revision" },
            });
          }
          return ok(scenario.changedFiles);
        }
        if (cmdArgs[0] === "diff" && cmdArgs[1] === "--name-only") {
          return ok(scenario.changedFiles);
        }
        // The branch-outcomes gate (Issue #3147) confirms each named test
        // exists at the head via `ls-tree`; a file the branch changed is
        // there, so answer with the requested paths among `changedFiles`.
        if (cmdArgs.includes("ls-tree")) {
          const atHead = new Set(scenario.changedFiles.split("\n"));
          const requested = cmdArgs.slice(cmdArgs.indexOf("--") + 1);
          return ok(requested.filter((p) => atHead.has(p)).join("\n"));
        }
        return ok("");
      },
    },
    claude: {
      runClaudeWithRetry: (options: { prompt: string }) => {
        claudeCalls++;
        claudePrompts.push(options.prompt);
        events.push("claude");
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
        Promise.resolve(
          scenario.prExistsForBranch
            ? { ok: true as const, value: PR_URL }
            : { ok: false as const, error: new Error("none") },
        ),
      recoverExistingPr: () => {
        events.push("recover");
        return Promise.resolve({ ok: true, value: "recovered" });
      },
      finalisePr: () => {
        events.push("finalise");
        return Promise.resolve({
          ok: true,
          value: { result: AutoMergeResult.Enabled, message: "armed" },
        });
      },
    },
  });

  let result;
  let deferred: DeferredPrRecord[] = [];
  try {
    result = await workOnIssueCompletion(ctx, state, deps);
    deferred = await listDeferredPrs(workDir);
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
    claudePrompts,
    prCreateCalls,
    comments,
    commentPosts,
    events,
    warnLogs,
    deferred,
  };
}

Deno.test(
  "completion - code-changing diff without the line recovers once in-run and then raises the PR",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_WITHOUT_LINE,
      retryWrites: SUMMARY_WITH_LINE,
      changedFiles: "crates/report/src/decisions.rs",
    });

    assertEquals(outcome.status, "continue");
    assertEquals(outcome.claudeCalls, 1, "exactly one recovery invocation");
    assertEquals(outcome.prCreateCalls, 1, "the recovered run raises its PR");
  },
);

Deno.test(
  "completion - the recovery not adding the line fails with no PR raised",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_WITHOUT_LINE,
      changedFiles: "crates/report/src/decisions.rs",
    });

    assertEquals(outcome.status, "failure");
    assertEquals(outcome.prCreateCalls, 0, "gh pr create must not run");
    assertStringIncludes(outcome.reason ?? "", "Docs sweep");
    assertEquals(outcome.comments.length, 1);
    assertStringIncludes(outcome.comments[0]!, "section:");
  },
);

Deno.test(
  "completion - a summary with a valid line raises the PR with no comment",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_WITH_LINE,
      changedFiles: "crates/report/src/decisions.rs",
    });

    assertEquals(outcome.status, "continue");
    assertEquals(outcome.prCreateCalls, 1);
    assertEquals(outcome.claudeCalls, 0, "no recovery invocation needed");
    assertEquals(outcome.comments.length, 0);
  },
);

Deno.test(
  "completion - a docs/test-only diff with no line raises the PR",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_WITHOUT_LINE,
      changedFiles: "docs/guide.md\nworker/deno/tests/foo_test.ts",
    });

    assertEquals(outcome.status, "continue");
    assertEquals(outcome.prCreateCalls, 1);
    assertEquals(outcome.claudeCalls, 0);
    assertEquals(outcome.comments.length, 0);
  },
);

/**
 * The 9 changed files from VibeCoder#3159 (PR #3159), joined as
 * `git diff --name-only` would report them.
 */
const CHANGED_FILES_3159 = [
  "DESIGN-PRINCIPLES.md",
  "docs/archive/pr-summaries/pr-summary-3146.md",
  "docs/workflows/issue-processing.md",
  "prompts/coding_guidelines/prompt.md",
  "prompts/issue/prompt.md",
  "worker/deno/lib/analysis_only_handoff.ts",
  "worker/deno/lib/phases/declared_handoff.ts",
  "worker/deno/lib/phases/handle_no_changes_phase.ts",
  "worker/deno/tests/handle_no_changes_blocked_deferral_test.ts",
].join("\n");

/**
 * An excerpt of `docs/archive/pr-summaries/pr-summary-3146.md` — the Summary
 * and the real Docs sweep bullet, verbatim (a full stop, not a `section:`
 * field) — reproducing VibeCoder#3159, where this exact shape shipped with no
 * in-run recovery because the agent had already raised its own PR.
 */
const SUMMARY_3159_WITHOUT_SECTION = `## Summary

A no-changes run that files its own follow-up and then ends with
\`## Blocked:\` / \`Depends on <that follow-up>\` no longer defers. It now hands
off straight to the analysis-only hand-off, which adds \`needs-human\` —
unconditionally, even when the same output also names a file to change, so a
self-filed match can never fall through to the described-code-change retry or
the short-output failure (both return a \`failure\` with no \`needs-human\`, and
the *next* run would see the follow-up's \`createdAt\` fall outside the
run-scoped self-filed window and defer onto it instead — Issue #3146 review
of PR #3159). Closes #${ISSUE}.

- [x] Red-first regression test
- [x] Fix in \`handOffDeclaredOutcome\`
- [x] Docs and prompt sweep
- [x] \`./quality.sh\` green

## Evidence

- **Docs sweep.** Grepped for "filed during" / "this run filed" / "After a
  commit, a". Updated:
  - \`DESIGN-PRINCIPLES.md\`
  - \`prompts/issue/prompt.md\` (the "Blocked" bullet; the later passage is
    scoped to committed work and stays accurate)
  - \`prompts/coding_guidelines/prompt.md\`

  \`CODING-STANDARDS.md\` holds no copy of this rule. The related rules checked
  were the #3088 committed-run deferral rules and the escape-hatch rule; they
  now agree.

## Test Plan

- \`worker/deno/tests/completion_phase_docs_sweep_test.ts\`
`;

/**
 * The same fixture once the recovery answers the whole block it was handed:
 * a \`section:\` field for the Docs sweep, and the \`Branch outcomes:\` list
 * (Issue #3147) the same retry notice asks for, since this diff changes code.
 * Answering only the Docs sweep would leave the branch-outcomes gate blocked
 * and end the run \`summary_incomplete\` after the one recovery turn.
 */
const SUMMARY_3159_WITH_SECTION = SUMMARY_3159_WITHOUT_SECTION.replace(
  '- **Docs sweep.** Grepped for "filed during" / "this run filed" / ' +
    '"After a\n  commit, a". Updated:',
  "**Docs sweep** — grep: `filed during` / `this run filed` / " +
    "`After a commit, a`; section: `DESIGN-PRINCIPLES.md`; siblings: none — no existing set gained a member; updated:",
).replace(
  "## Test Plan",
  "**Branch outcomes:**\n\n" +
    "- self-filed `Depends on` follow-up hands off to needs-human — " +
    "`worker/deno/tests/handle_no_changes_blocked_deferral_test.ts`\n\n" +
    "## Test Plan",
);

Deno.test(
  "completion - a run whose agent already raised its PR (VibeCoder#3159) gets the one recovery turn before that PR is finalised, then raises nothing new",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_3159_WITHOUT_SECTION,
      retryWrites: SUMMARY_3159_WITH_SECTION,
      changedFiles: CHANGED_FILES_3159,
      prExistsForBranch: true,
      events: [],
    });

    assertEquals(outcome.status, "continue");
    const retryPrompts = outcome.claudePrompts.filter((p) =>
      p.includes("RETRY NOTICE")
    );
    assertEquals(retryPrompts.length, 1, "exactly one recovery invocation");
    assertStringIncludes(retryPrompts[0]!, "Docs sweep missing");
    // The same one turn also asks for the Branch outcomes list (Issue #3147),
    // which this code diff lacks — the recovery must answer both to finalise.
    assertStringIncludes(retryPrompts[0]!, "Branch outcomes not recorded");

    // The recovery ran before any finalise/create — no `gh pr create` at all
    // (the existing PR is updated, not recreated), and `recoverExistingPr`
    // only after the claude call.
    assertEquals(outcome.prCreateCalls, 0, "the existing PR is not recreated");
    const claudeIndex = outcome.events.indexOf("claude");
    const recoverIndex = outcome.events.indexOf("recover");
    assertEquals(claudeIndex >= 0, true);
    assertEquals(recoverIndex > claudeIndex, true);
    assertEquals(outcome.events.includes("pr-create"), false);
  },
);

Deno.test(
  "completion - the VibeCoder#3159 fixture with no fix from the recovery ends as summary_incomplete, not a silent finalise",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_3159_WITHOUT_SECTION,
      changedFiles: CHANGED_FILES_3159,
      prExistsForBranch: true,
      events: [],
    });

    assertEquals(outcome.status, "early_exit");
    assertStringIncludes(outcome.reason ?? "", "Docs sweep");
    const retryPrompts = outcome.claudePrompts.filter((p) =>
      p.includes("RETRY NOTICE")
    );
    assertEquals(retryPrompts.length, 1, "recovery still entered exactly once");

    const claudeIndex = outcome.events.indexOf("claude");
    const finaliseIndex = outcome.events.indexOf("finalise");
    assertEquals(claudeIndex >= 0, true);
    assertEquals(finaliseIndex > claudeIndex, true);
  },
);

Deno.test(
  "completion - an unreadable diff fails closed even with no Docs sweep line",
  async () => {
    // `git diff --name-only` fails (non-zero exit), so `changedFiles` is
    // unknown. The gate must treat that as "diff could not be read" — not
    // as a docs-free diff — and still block PR creation (Issue #3085 review).
    const outcome = await runCompletion({
      summary: SUMMARY_WITHOUT_LINE,
      changedFiles: "",
      diffFails: true,
    });

    assertEquals(outcome.status, "failure");
    assertEquals(outcome.prCreateCalls, 0, "gh pr create must not run");
    assertStringIncludes(outcome.reason ?? "", "Docs sweep");
    assertEquals(outcome.comments.length, 1);
    assertStringIncludes(outcome.comments[0]!, "section:");
  },
);

// ---------------------------------------------------------------------------
// Issue #3172: the Docs sweep line's own grep terms are re-run at the head.
// Issue #3237: stale hits are advisory (#3237) — posted once, never blocking.
// ---------------------------------------------------------------------------

/** A hit of the line's own term (`BrokerBalance`) the diff did not change. */
const STALE_HIT =
  "HEAD:docs/reporting-api.md\u0000320\u0000BrokerBalance refuses a stale quote\n";

Deno.test(
  "completion - a stale hit of the Docs sweep's own term is advisory (#3237): no recovery turn, the PR is still raised, one PR comment names the hit",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_WITH_LINE,
      changedFiles: "crates/report/src/decisions.rs",
      grepOutput: STALE_HIT,
    });

    assertEquals(outcome.status, "continue");
    assertEquals(outcome.claudeCalls, 0, "no recovery turn is spent");
    assertEquals(outcome.prCreateCalls, 1, "the PR is still raised");
    const prNumber = Number(PR_URL.split("/").pop());
    const prPosts = outcome.commentPosts.filter((p) => p.number === prNumber);
    assertEquals(prPosts.length, 1, "exactly one comment posted to the PR");
    assertStringIncludes(prPosts[0]!.body, "docs/reporting-api.md:320");
    assertStringIncludes(
      prPosts[0]!.body,
      "BrokerBalance refuses a stale quote",
    );
    assertStringIncludes(prPosts[0]!.body.toLowerCase(), "advisory");
    const issuePosts = outcome.commentPosts.filter((p) => p.number === ISSUE);
    assertEquals(issuePosts.length, 0, "no comment posted to the issue");
  },
);

Deno.test(
  "completion - a stale hit on a recovered existing PR gets the advisory comment posted there (#3237)",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_WITH_LINE,
      changedFiles: "crates/report/src/decisions.rs",
      grepOutput: STALE_HIT,
      prExistsForBranch: true,
    });

    assertEquals(outcome.status, "continue");
    assertEquals(outcome.claudeCalls, 0, "no recovery turn is spent");
    assertEquals(outcome.prCreateCalls, 0, "the existing PR is reused");
    assertEquals(
      outcome.events.includes("recover"),
      true,
      "the existing PR is recovered, not created",
    );
    const prNumber = Number(PR_URL.split("/").pop());
    const prPosts = outcome.commentPosts.filter((p) => p.number === prNumber);
    assertEquals(
      prPosts.length,
      1,
      "exactly one comment posted to the existing PR",
    );
    assertStringIncludes(prPosts[0]!.body, "docs/reporting-api.md:320");
  },
);

Deno.test(
  "completion - a failed advisory comment post does not fail the run (#3237)",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_WITH_LINE,
      changedFiles: "crates/report/src/decisions.rs",
      grepOutput: STALE_HIT,
      postCommentThrows: true,
    });

    assertEquals(outcome.status, "continue");
    assertEquals(outcome.claudeCalls, 0, "no recovery turn is spent");
    assertEquals(outcome.prCreateCalls, 1, "the PR is still raised");
    assertEquals(
      outcome.commentPosts.length,
      0,
      "the failed post leaves no comment recorded",
    );
    const issuePosts = outcome.commentPosts.filter((p) => p.number === ISSUE);
    assertEquals(issuePosts.length, 0, "no comment posted to the issue");
    const warned = outcome.warnLogs.some((m) =>
      m.includes("Docs sweep hits comment failed (non-fatal)")
    );
    assertEquals(warned, true, "the failure is logged as non-fatal");
  },
);

Deno.test(
  "completion - a grep that cannot run is logged as not checked and does not block the PR",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_WITH_LINE,
      changedFiles: "crates/report/src/decisions.rs",
      grepOutput: "",
      grepCode: 128,
    });

    assertEquals(outcome.status, "continue");
    assertEquals(outcome.prCreateCalls, 1);
    assertEquals(outcome.claudeCalls, 0);
  },
);

Deno.test(
  "completion - a docs-only diff never re-runs the terms",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_WITH_LINE,
      changedFiles: "docs/guide.md",
      grepOutput: STALE_HIT,
    });

    assertEquals(outcome.status, "continue");
    assertEquals(outcome.prCreateCalls, 1);
    assertEquals(outcome.claudeCalls, 0);
  },
);

// ---------------------------------------------------------------------------
// Issue #3219: the terms are also re-run over source comment lines.
// ---------------------------------------------------------------------------

/** A doc comment in a source file the diff did not touch (VibeCoder#3215). */
const STALE_SOURCE_COMMENT =
  "HEAD:crates/report/src/balance.rs\u000042\u0000/// BrokerBalance is shared by the two old callers\n";

Deno.test(
  "completion - a stale doc comment in an untouched source file is advisory like a manual hit (#3237, Issue #3219)",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_WITH_LINE,
      changedFiles: "crates/report/src/decisions.rs",
      sourceGrepOutput: STALE_SOURCE_COMMENT,
    });

    assertEquals(outcome.status, "continue");
    assertEquals(outcome.claudeCalls, 0, "no recovery turn is spent");
    assertEquals(outcome.prCreateCalls, 1, "the PR is still raised");
    const prNumber = Number(PR_URL.split("/").pop());
    const prPosts = outcome.commentPosts.filter((p) => p.number === prNumber);
    assertEquals(prPosts.length, 1, "exactly one comment posted to the PR");
    assertStringIncludes(
      prPosts[0]!.body,
      "crates/report/src/balance.rs:42",
    );
    assertStringIncludes(
      prPosts[0]!.body,
      "BrokerBalance is shared by the two old callers",
    );
    const issuePosts = outcome.commentPosts.filter((p) => p.number === ISSUE);
    assertEquals(issuePosts.length, 0, "no comment posted to the issue");
  },
);

Deno.test(
  "completion - a source hit on a code line, not a comment, does not block (Issue #3219)",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_WITH_LINE,
      changedFiles: "crates/report/src/decisions.rs",
      sourceGrepOutput:
        "HEAD:crates/report/src/balance.rs\u000043\u0000pub struct BrokerBalance {\n",
    });

    assertEquals(outcome.status, "continue");
    assertEquals(outcome.prCreateCalls, 1);
    assertEquals(outcome.claudeCalls, 0);
  },
);

// ---------------------------------------------------------------------------
// Review of PR #3251: a later summary-rule block on a run whose branch already
// has a PR finalises that PR through `reportSummaryRuleBlock`, and the
// advisory comment must reach the PR on that path too.
// ---------------------------------------------------------------------------

/**
 * A summary with a valid Docs sweep line but no `Branch outcomes:` list, on a
 * code-changing diff — the branch-outcomes gate (Issue #3147) blocks it, the
 * recovery turn leaves it unchanged, and the second verdict goes through
 * `reportSummaryRuleBlock`.
 */
const SUMMARY_WITH_LINE_NO_OUTCOMES = SUMMARY_WITH_LINE.replace(
  "**Branch outcomes:** none added\n",
  "",
);

Deno.test(
  "completion - a stale hit on an existing PR blocked twice by another summary gate is still posted to the PR (#3237)",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_WITH_LINE_NO_OUTCOMES,
      changedFiles: "crates/report/src/decisions.rs",
      grepOutput: STALE_HIT,
      prExistsForBranch: true,
    });

    assertEquals(
      outcome.claudeCalls,
      1,
      "the other gate spends its one recovery turn",
    );
    assertEquals(outcome.prCreateCalls, 0, "the existing PR is reused");
    assertEquals(
      outcome.events.includes("recover"),
      true,
      "the existing PR is recovered, not created",
    );
    const prNumber = Number(PR_URL.split("/").pop());
    const prPosts = outcome.commentPosts.filter((p) => p.number === prNumber);
    assertEquals(
      prPosts.length,
      1,
      "exactly one advisory comment reaches the existing PR",
    );
    assertStringIncludes(prPosts[0]!.body, "docs/reporting-api.md:320");
    assertStringIncludes(prPosts[0]!.body.toLowerCase(), "advisory");
  },
);

// ---------------------------------------------------------------------------
// Issue #3237 review: a PR whose creation is deferred by GitHub's secondary
// rate limit keeps the advisory, so the next cycle's drain can post it.
// ---------------------------------------------------------------------------

Deno.test(
  "completion - a stale hit on a PR deferred by the secondary limit is parked with the PR, not lost (Issue #3237)",
  async () => {
    const outcome = await runCompletion({
      summary: SUMMARY_WITH_LINE,
      changedFiles: "crates/report/src/decisions.rs",
      grepOutput: STALE_HIT,
      prCreateRefusedBySecondaryLimit: true,
    });

    assertEquals(outcome.status, "early_exit", outcome.reason);
    assertEquals(outcome.deferred.length, 1, "the PR is parked for the drain");
    assertStringIncludes(
      outcome.deferred[0]!.advisoryComment ?? "",
      "docs/reporting-api.md:320",
    );
  },
);
