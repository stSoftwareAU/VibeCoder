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
 * complete, raises the PR exactly as before only when it reports no gap.
 * Issue #3506: a healthy run whose summary closes out a criterion as `partial`
 * or `missing` files one follow-up too, and its PR body says so.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildDegradedFollowUpIssue,
  degradedFollowUpFindingId,
  FOLLOW_UP_CHAIN_STOP_MARKER,
  FOLLOW_UP_CHAIN_STOP_SECTION_HEADING,
  REPORTED_GAP_SECTION_HEADING,
} from "../lib/degraded_delivery.ts";
import { workOnIssueCompletion } from "../lib/phases/completion_phase.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import type { PhaseClaudeResult } from "../lib/phase_run_stats.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type { GitHubClient, Result } from "../types.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { deriveRunOutcome, type RunOutcome } from "../lib/run_outcome.ts";

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

**Docs sweep** — grep: \`opus\`; section: \`docs/MODEL-AND-CACHING.md#planning\`; no hits; siblings: none — no existing set gained a member

**Branch outcomes:** none added
`;

/**
 * Same as `SUMMARY_PARTIAL` but with no `Docs sweep` line, so the docs-sweep
 * gate (Issue #3073) itself blocks — used to check gate ordering against the
 * degraded-delivery guard on a branch that already has an open PR (Issue
 * #3085 review).
 */
const SUMMARY_PARTIAL_NO_DOCS_SWEEP = `## Summary

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

**Docs sweep** — grep: \`opus\`; section: \`docs/MODEL-AND-CACHING.md#planning\`; no hits; siblings: none — no existing set gained a member

**Branch outcomes:** none added
`;

/** Issue #2695 (a): no `## Acceptance Criteria`, no accepted scope. */
const ISSUE_WITHOUT_SCOPE = `## Problem

The parser mishandles a leap year.
`;

/** Issue #2695 (c): the first criterion `partial`, the second `met`. */
const SUMMARY_PARTIAL_AND_MET = `## Summary

Did a little.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **partial** — the router sends planning to opus — evidence: \`lib/config_defaults.ts\` — reviewer: partial — reason: execution only
- **met** — the docs table lists opus — evidence: \`docs/MODEL-AND-CACHING.md\` — reviewer: met

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — Australian English, TDD, fail-loud error handling

**Docs sweep** — grep: \`opus\`; section: \`docs/MODEL-AND-CACHING.md#planning\`; no hits; siblings: none — no existing set gained a member

**Branch outcomes:** none added
`;

/**
 * Same as `SUMMARY_PARTIAL` but with no `## Standards Review` section, so the
 * independent two-axis review gate (Issue #663) itself blocks — used to check
 * that an existing-PR branch still runs the degraded-delivery guard ahead of
 * that gate's own `reportSummaryRuleBlock` call (Issue #3092).
 */
const SUMMARY_PARTIAL_NO_STANDARDS_REVIEW = `## Summary

Did half of it.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — the router sends planning to opus — evidence: \`lib/config_defaults.ts\` — reviewer: met
- **missing** — the docs table lists opus — reviewer: missing — reason: ran out of turns

**Docs sweep** — grep: \`opus\`; section: \`docs/MODEL-AND-CACHING.md#planning\`; no hits; siblings: none — no existing set gained a member

**Branch outcomes:** none added
`;

/**
 * Same as `SUMMARY_PARTIAL` but the `missing` entry carries no `reason:`, so
 * the acceptance-criteria closure gate (Issue #518) itself blocks — `##
 * Standards Review` is intact, so only the closure gate fails. Used to check
 * the same guard ordering against the closure gate (Issue #3092).
 */
const SUMMARY_PARTIAL_NO_CLOSURE_REASON = `## Summary

Did half of it.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **met** — the router sends planning to opus — evidence: \`lib/config_defaults.ts\` — reviewer: met
- **missing** — the docs table lists opus — reviewer: missing

## Standards Review

<!-- vibe-standards-review inputs="diff+CODING-STANDARDS.md" -->

- **clean** — Australian English, TDD, fail-loud error handling

**Docs sweep** — grep: \`opus\`; section: \`docs/MODEL-AND-CACHING.md#planning\`; no hits; siblings: none — no existing set gained a member

**Branch outcomes:** none added
`;

/** A minimal summary carrying only the Docs sweep line (Issue #3073). */
const SUMMARY_MINIMAL_WITH_DOCS_SWEEP =
  `## Summary\n\nFinished the switch. Closes #${ISSUE}.\n\n**Docs sweep** — grep: \`opus\`; section: \`docs/MODEL-AND-CACHING.md#planning\`; no hits; siblings: none — no existing set gained a member\n\n**Branch outcomes:** none added\n`;

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
  /** Every `gh issue close` the run issued (PR #3676 review). */
  issueCloses: string[][];
  /** Every `gh issue edit` and `gh issue comment` the run issued. */
  issueEdits: string[][];
  issueComments: string[][];
  prBodies: string[];
  recoverCalls: number;
  prCreateCalls: number;
  /** Set when the run recorded an existing PR on its state (Issue #2044). */
  prUrl?: string;
  prNumber?: number;
  outcome: RunOutcome;
  /** Every `logger.warn` call the run made, with its context. */
  warnings: { message: string; context: unknown }[];
}

const EXISTING_PR_URL = "https://github.com/stSoftwareAU/VibeCoder/pull/777";

async function runCompletion(opts: {
  issueBody: string;
  summary: string | null;
  claudeRunStats: PhaseClaudeResult[];
  failIssueCreate?: boolean;
  /** Issue #3085 review: the branch already has an open PR before this run. */
  prExistsForBranch?: boolean;
  /** Issue #3121: override the URL `findExistingPrForBranch` reports. */
  prUrl?: string;
  /** PR #3676 review: what `gh issue view` reports for the parent issue. */
  parentState?: "OPEN" | "CLOSED";
  /** PR #3676 review: the parent's milestone, which routes its base branch. */
  milestoneTitle?: string;
  /** PR #3676 review: an open follow-up for the parent that a run would reuse. */
  existingFollowUp?: number;
  /** PR #3676 review: make `gh issue close` reject. */
  failIssueClose?: boolean;
  /** PR #3676 review: make `gh issue edit` reject. */
  failIssueEdit?: boolean;
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
  const issueCloses: string[][] = [];
  const issueEdits: string[][] = [];
  const issueComments: string[][] = [];
  const prBodies: string[] = [];
  let recoverCalls = 0;
  let prCreateCalls = 0;
  const warnings: { message: string; context: unknown }[] = [];

  const ctx: IssueContext = {
    repo: "stSoftwareAU/VibeCoder",
    issueNumber: ISSUE,
    issueTitle: "Finish the switch",
    issueBody: opts.issueBody,
    issueLabels: ["enhancement", "work-on"],
    issueComments: "",
    githubUser: "testbot",
    config: buildDefaultWorkerConfig(),
    ...(opts.milestoneTitle ? { milestoneTitle: opts.milestoneTitle } : {}),
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
    logger: {
      warn: (message: string, context?: unknown) =>
        warnings.push({ message, context }),
    },
    github: {
      createClient: () => stubClient(),
      ensureLabelExists: () =>
        Promise.resolve({ ok: true as const, value: undefined }),
      runGhCommand: (args: string[]) => {
        if (args[0] === "issue" && args[1] === "list") {
          return Promise.resolve(
            opts.existingFollowUp
              ? JSON.stringify([{
                number: opts.existingFollowUp,
                body: `<!-- finding-id: ${
                  degradedFollowUpFindingId(ISSUE)
                } -->`,
                author: { login: "testbot" },
              }])
              : "[]",
          );
        }
        if (args[0] === "issue" && args[1] === "view" && opts.parentState) {
          return Promise.resolve(JSON.stringify({ state: opts.parentState }));
        }
        if (args[0] === "issue" && args[1] === "close") {
          issueCloses.push(args);
          return opts.failIssueClose
            ? Promise.reject(new Error("HTTP 403 close"))
            : Promise.resolve("");
        }
        if (args[0] === "issue" && args[1] === "edit") {
          issueEdits.push(args);
          return opts.failIssueEdit
            ? Promise.reject(new Error("HTTP 403 edit"))
            : Promise.resolve("");
        }
        if (args[0] === "issue" && args[1] === "comment") {
          issueComments.push(args);
          return Promise.resolve("");
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
          prCreateCalls++;
          prBodies.push(args[args.indexOf("--body") + 1] ?? "");
        }
        if (args[0] === "pr" && args[1] === "view") {
          return Promise.resolve(JSON.stringify({ state: "OPEN" }));
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
        Promise.resolve(
          opts.prExistsForBranch
            ? { ok: true as const, value: opts.prUrl ?? EXISTING_PR_URL }
            : { ok: false as const, error: new Error("none") },
        ),
      // Captures the body the recovery path writes back to the existing PR
      // (Issue #3085 review) — `gh pr create` is never called on that path,
      // so `prBodies` above would otherwise stay empty.
      recoverExistingPr: (
        _repo: string,
        _issueNumber: number,
        _prUrl: string,
        body?: string,
      ) => {
        recoverCalls++;
        prBodies.push(body ?? "");
        return Promise.resolve({ ok: true as const, value: "recovered" });
      },
    },
  });

  const result = await workOnIssueCompletion(ctx, state, deps);
  await Deno.remove(repoPath, { recursive: true });

  const reason = result.status === "failure" || result.status === "early_exit"
    ? result.reason
    : undefined;

  return {
    status: result.status,
    reason,
    issueCreates,
    issueCloses,
    issueEdits,
    issueComments,
    prBodies,
    recoverCalls,
    prCreateCalls,
    prUrl: state.prUrl,
    prNumber: state.prNumber,
    warnings,
    // Issue #3121: the composition `workOnIssue` performs — the failed
    // result, plus whatever PR fields the phase recorded on its state.
    outcome: deriveRunOutcome({
      success: false,
      phase: "completion",
      reason: reason ?? "",
      prUrl: state.prUrl,
      prNumber: state.prNumber,
      elapsedSeconds: 42,
    }),
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

Deno.test("completion - a healthy run whose summary reports a missing criterion files one follow-up and says so in the PR (Issue #3506)", async () => {
  const outcome = await runCompletion({
    issueBody: ISSUE_WITH_CRITERIA,
    summary: SUMMARY_PARTIAL,
    claudeRunStats: HEALTHY,
  });

  assertEquals(outcome.status, "continue");
  assertEquals(outcome.issueCreates.length, 1);
  assert(!outcome.prBodies[0]!.includes("Degraded run"));
  const create = outcome.issueCreates[0]!;
  const labelAt = create.indexOf("--label");
  assertEquals(create[labelAt + 1], "idle-task");
  const body = create[create.indexOf("--body") + 1]!;
  assertStringIncludes(body, "The docs table lists opus for planning.");
  assertStringIncludes(body, `#${ISSUE}`);
  assert(!body.includes("**degraded**"));
  const pr = outcome.prBodies[0]!;
  assertStringIncludes(pr, REPORTED_GAP_SECTION_HEADING);
  assertStringIncludes(pr, "#900");
  assertStringIncludes(pr, "The docs table lists opus for planning.");
});

Deno.test("completion - a healthy run on an issue stating no criteria files one idle-task follow-up for its partial entry (PR #3676 review)", async () => {
  const outcome = await runCompletion({
    issueBody: ISSUE_WITHOUT_SCOPE,
    summary: SUMMARY_PARTIAL_AND_MET,
    claudeRunStats: HEALTHY,
  });

  assertEquals(outcome.status, "continue", outcome.reason);
  assertEquals(outcome.issueCreates.length, 1);
  const create = outcome.issueCreates[0]!;
  assertEquals(create[create.indexOf("--label") + 1], "idle-task");
  const body = create[create.indexOf("--body") + 1]!;
  assertStringIncludes(
    body,
    "**partial** — the router sends planning to opus",
  );
  assertStringIncludes(body, "the docs table lists opus");
  assert(!body.includes("**degraded**"));
  const pr = outcome.prBodies[0]!;
  assertStringIncludes(pr, REPORTED_GAP_SECTION_HEADING);
  assertStringIncludes(pr, "the router sends planning to opus");
  assertStringIncludes(pr, "#900");
  assert(!pr.includes("Degraded run"));
});

Deno.test("completion - a degraded run on an issue stating no criteria still files one idle-task follow-up for its partial entry (PR #3676 review)", async () => {
  const outcome = await runCompletion({
    issueBody: ISSUE_WITHOUT_SCOPE,
    summary: SUMMARY_PARTIAL_AND_MET,
    claudeRunStats: DEGRADED,
  });

  assertEquals(outcome.status, "continue", outcome.reason);
  assertEquals(outcome.issueCreates.length, 1);
  const create = outcome.issueCreates[0]!;
  assertEquals(create[create.indexOf("--label") + 1], "idle-task");
  const body = create[create.indexOf("--body") + 1]!;
  assertStringIncludes(body, "**partial** — the router sends planning to opus");
  const pr = outcome.prBodies[0]!;
  assertStringIncludes(pr, "Degraded run — partial delivery");
  assertStringIncludes(pr, "the router sends planning to opus");
  assertStringIncludes(pr, "#900");
  assert(
    !pr.includes("No follow-up was filed"),
    "the PR must not say no follow-up was filed",
  );
});

Deno.test("completion - a healthy run whose summary closes out one criterion as partial files exactly one idle-task follow-up (Issue #3506)", async () => {
  const outcome = await runCompletion({
    issueBody: ISSUE_WITH_CRITERIA,
    summary: SUMMARY_PARTIAL_AND_MET,
    claudeRunStats: HEALTHY,
  });

  assertEquals(outcome.status, "continue");
  assertEquals(outcome.issueCreates.length, 1);
  const create = outcome.issueCreates[0]!;
  assertEquals(create[create.indexOf("--label") + 1], "idle-task");
  const body = create[create.indexOf("--body") + 1]!;
  assertStringIncludes(
    body,
    "**partial** — The router sends planning to opus.",
  );
  const pr = outcome.prBodies[0]!;
  assertStringIncludes(pr, REPORTED_GAP_SECTION_HEADING);
  assertStringIncludes(pr, "#900");
  const section = pr.slice(0, pr.indexOf("## Summary"));
  assertStringIncludes(section, "The router sends planning to opus.");
  assert(
    !section.includes("The docs table lists opus for planning."),
    "met items are not listed in the section",
  );
});

/** Issue body of a partial-delivery follow-up the worker filed for #517. */
const FOLLOW_UP_ISSUE_BODY = buildDegradedFollowUpIssue({
  parentNumber: 517,
  parentTitle: "Finish the switch",
  verdict: {
    degraded: false,
    delivered: ["The docs table lists opus for planning."],
    shortfalls: [{
      criterion: "The router sends planning to opus.",
      status: "partial",
    }],
  },
  runId: "run-1",
}).body;

Deno.test("completion - a healthy run on a partial-delivery follow-up files no nested follow-up and hands it to a human (PR #3676 review)", async () => {
  const outcome = await runCompletion({
    issueBody: FOLLOW_UP_ISSUE_BODY,
    summary: SUMMARY_PARTIAL_AND_MET.replace(
      "Did a little.",
      `Did a little. Closes #${ISSUE}.`,
    ),
    claudeRunStats: HEALTHY,
  });

  assertEquals(outcome.status, "continue");
  assertEquals(outcome.issueCreates, [], "no nested idle-task follow-up");
  assertEquals(outcome.issueEdits.filter((e) => e.includes("--add-label")), [[
    "issue",
    "edit",
    String(ISSUE),
    "--repo",
    "stSoftwareAU/VibeCoder",
    "--add-label",
    "needs-human",
  ]]);
  assertEquals(outcome.issueComments.length, 1);
  const comment = outcome.issueComments[0]!;
  assertStringIncludes(
    comment[comment.indexOf("--body") + 1]!,
    "**partial** — The router sends planning to opus.",
  );
  const pr = outcome.prBodies[0]!;
  assert(pr.startsWith(FOLLOW_UP_CHAIN_STOP_SECTION_HEADING));
  assertStringIncludes(pr, FOLLOW_UP_CHAIN_STOP_MARKER);
  assert(!pr.includes(REPORTED_GAP_SECTION_HEADING));
  assert(!pr.includes(`Closes #${ISSUE}`), "the PR does not close it");
  assertStringIncludes(pr, `Part of #${ISSUE}`);
});

Deno.test("completion - a follow-up that cannot be handed to a human raises no PR (PR #3676 review)", async () => {
  const outcome = await runCompletion({
    issueBody: FOLLOW_UP_ISSUE_BODY,
    summary: SUMMARY_PARTIAL,
    claudeRunStats: HEALTHY,
    failIssueEdit: true,
  });

  assertEquals(outcome.status, "failure");
  assertEquals(outcome.prCreateCalls, 0, "gh pr create must not run");
  assertEquals(outcome.issueCreates, []);
  assertEquals(outcome.issueComments, [], "no comment without the label");
  assertStringIncludes(outcome.reason ?? "", "HTTP 403 edit");
});

Deno.test("completion - a degraded run on a partial-delivery follow-up still files its follow-up (PR #3676 review)", async () => {
  const outcome = await runCompletion({
    issueBody: FOLLOW_UP_ISSUE_BODY,
    summary: SUMMARY_PARTIAL,
    claudeRunStats: DEGRADED,
  });

  assertEquals(outcome.status, "continue");
  assertEquals(outcome.issueCreates.length, 1);
  assertEquals(outcome.issueEdits.filter((e) => e.includes("--add-label")), []);
});

Deno.test("completion - the follow-up log names whether the run was degraded, its reason and its shortfall count (Issue #3506)", async () => {
  const healthy = await runCompletion({
    issueBody: ISSUE_WITH_CRITERIA,
    summary: SUMMARY_PARTIAL_AND_MET,
    claudeRunStats: HEALTHY,
  });
  assertEquals(
    healthy.warnings.filter((w) =>
      w.message ===
        "Run delivered partial scope — residue recorded in a follow-up"
    ),
    [{
      message: "Run delivered partial scope — residue recorded in a follow-up",
      context: {
        degraded: false,
        reason: undefined,
        shortfalls: 1,
        followUp: 900,
        reused: false,
      },
    }],
  );

  const degraded = await runCompletion({
    issueBody: ISSUE_WITH_CRITERIA,
    summary: SUMMARY_PARTIAL,
    claudeRunStats: DEGRADED,
  });
  const logged = degraded.warnings.find((w) =>
    w.message ===
      "Run delivered partial scope — residue recorded in a follow-up"
  )?.context as Record<string, unknown> | undefined;
  assertEquals(logged?.degraded, true);
  assertStringIncludes(String(logged?.reason), "haiku");
});

Deno.test("completion - a healthy run whose gap follow-up cannot be filed raises no PR (Issue #3506)", async () => {
  const outcome = await runCompletion({
    issueBody: ISSUE_WITH_CRITERIA,
    summary: SUMMARY_PARTIAL,
    claudeRunStats: HEALTHY,
    failIssueCreate: true,
  });

  assertEquals(outcome.status, "failure");
  assertEquals(outcome.prCreateCalls, 0, "gh pr create must not run");
  assertStringIncludes(outcome.reason ?? "", "partial or missing");
  assert(!(outcome.reason ?? "").includes("Degraded run"));
  assertStringIncludes(outcome.reason ?? "", "HTTP 502");
});

Deno.test("completion - a healthy run's follow-up is closed when the parent closes mid-run and no PR is raised (PR #3676 review)", async () => {
  const outcome = await runCompletion({
    issueBody: ISSUE_WITH_CRITERIA,
    summary: SUMMARY_PARTIAL,
    claudeRunStats: HEALTHY,
    parentState: "CLOSED",
  });

  assertEquals(outcome.status, "early_exit");
  assertEquals(outcome.prCreateCalls, 0, "no PR is raised for a stale claim");
  assertEquals(outcome.issueCreates.length, 1, "the follow-up was filed");
  assertEquals(outcome.issueCloses.length, 1, "and is retracted");
  const close = outcome.issueCloses[0]!;
  assertEquals(close[2], "900", "the follow-up is closed, not the parent");
  assertEquals(close[close.indexOf("--reason") + 1], "not planned");
  assertStringIncludes(
    close[close.indexOf("--comment") + 1]!,
    "issue_closed",
  );
});

Deno.test("completion - a degraded run's follow-up is closed when the parent closes mid-run (PR #3676 review)", async () => {
  const outcome = await runCompletion({
    issueBody: ISSUE_WITH_CRITERIA,
    summary: SUMMARY_PARTIAL,
    claudeRunStats: DEGRADED,
    parentState: "CLOSED",
  });

  assertEquals(outcome.status, "early_exit");
  assertEquals(outcome.issueCreates.length, 1);
  assertEquals(outcome.issueCloses.length, 1);
});

Deno.test("completion - a follow-up that cannot be closed warns and the stale-claim abort stands (PR #3676 review)", async () => {
  const outcome = await runCompletion({
    issueBody: ISSUE_WITH_CRITERIA,
    summary: SUMMARY_PARTIAL,
    claudeRunStats: HEALTHY,
    parentState: "CLOSED",
    failIssueClose: true,
  });

  assertEquals(outcome.status, "early_exit");
  assertEquals(outcome.issueCloses.length, 1);
  const warned = outcome.warnings.find((w) =>
    w.message.includes("Could not close the stale-claim follow-up")
  );
  assert(warned, "a failed close is warned about");
  assertStringIncludes(warned.message, "HTTP 403 close");
});

Deno.test("completion - a reused follow-up is never closed when the claim goes stale (PR #3676 review)", async () => {
  const outcome = await runCompletion({
    issueBody: ISSUE_WITH_CRITERIA,
    summary: SUMMARY_PARTIAL,
    claudeRunStats: HEALTHY,
    parentState: "CLOSED",
    existingFollowUp: 70,
  });

  assertEquals(outcome.status, "early_exit");
  assertEquals(outcome.issueCreates.length, 0, "the open one is reused");
  assertEquals(outcome.issueCloses.length, 0, "a reused one predates the run");
});

Deno.test("completion - a stale claim with no gap files and closes no follow-up (PR #3676 review)", async () => {
  const outcome = await runCompletion({
    issueBody: ISSUE_WITH_CRITERIA,
    summary: SUMMARY_COMPLETE,
    claudeRunStats: HEALTHY,
    parentState: "CLOSED",
  });

  assertEquals(outcome.status, "early_exit");
  assertEquals(outcome.issueCreates.length, 0);
  assertEquals(outcome.issueCloses.length, 0);
});

Deno.test("completion - an open parent keeps its new follow-up and closes nothing (PR #3676 review)", async () => {
  const outcome = await runCompletion({
    issueBody: ISSUE_WITH_CRITERIA,
    summary: SUMMARY_PARTIAL,
    claudeRunStats: HEALTHY,
    parentState: "OPEN",
  });

  assertEquals(outcome.status, "continue");
  assertEquals(outcome.prCreateCalls, 1);
  assertEquals(outcome.issueCloses.length, 0);
});

Deno.test("completion - a milestone child's follow-up is filed into the parent's milestone (PR #3676 review)", async () => {
  const outcome = await runCompletion({
    issueBody: ISSUE_WITH_CRITERIA,
    summary: SUMMARY_PARTIAL_AND_MET,
    claudeRunStats: HEALTHY,
    milestoneTitle: "Q4 Launch",
  });

  assertEquals(outcome.status, "continue");
  assertEquals(outcome.issueCreates.length, 1);
  const create = outcome.issueCreates[0]!;
  assertEquals(create[create.indexOf("--milestone") + 1], "Q4 Launch");
  assertEquals(create[create.indexOf("--label") + 1], "idle-task");
});

Deno.test("completion - a follow-up for a parent with no milestone carries no --milestone (PR #3676 review)", async () => {
  const outcome = await runCompletion({
    issueBody: ISSUE_WITH_CRITERIA,
    summary: SUMMARY_PARTIAL_AND_MET,
    claudeRunStats: HEALTHY,
  });

  assertEquals(outcome.issueCreates.length, 1);
  assert(!outcome.issueCreates[0]!.includes("--milestone"));
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

Deno.test("completion - #2543 reproduction (b): a degraded run with a minimal summary on a grill-me issue files no follow-up but says so in the PR (Issue #2695)", async () => {
  const outcome = await runCompletion({
    issueBody: GRILL_ME_ISSUE,
    summary: SUMMARY_MINIMAL_WITH_DOCS_SWEEP,
    claudeRunStats: DEGRADED,
  });
  const healthy = await runCompletion({
    issueBody: GRILL_ME_ISSUE,
    summary: SUMMARY_MINIMAL_WITH_DOCS_SWEEP,
    claudeRunStats: HEALTHY,
  });

  assertEquals(outcome.status, "continue");
  assertEquals(outcome.issueCreates.length, 0, "every item is unassessed");
  assertEquals(outcome.prBodies.length, 1);
  const pr = outcome.prBodies[0]!;
  assert(pr.startsWith("## ⚠️ Degraded run"));
  assertStringIncludes(pr, "`haiku`");
  assertStringIncludes(
    pr,
    "no acceptance criterion was assessed `partial` or `missing`",
  );
  assertStringIncludes(pr, "Raise the Claude Code pin.");
  assert(!pr.includes("#900"), "no follow-up is referenced");
  // Past the note, the PR is exactly the one a healthy run raises.
  assert(pr.endsWith(healthy.prBodies[0]!));
  assertStringIncludes(pr, `#${ISSUE}`);
});

Deno.test("completion - (a) a degraded run on an issue stating no criteria files no follow-up but says so in the PR (Issue #2695)", async () => {
  const outcome = await runCompletion({
    issueBody: ISSUE_WITHOUT_SCOPE,
    summary: SUMMARY_MINIMAL_WITH_DOCS_SWEEP,
    claudeRunStats: DEGRADED,
  });
  const healthy = await runCompletion({
    issueBody: ISSUE_WITHOUT_SCOPE,
    summary: SUMMARY_MINIMAL_WITH_DOCS_SWEEP,
    claudeRunStats: HEALTHY,
  });

  assertEquals(outcome.status, "continue");
  assertEquals(outcome.issueCreates.length, 0);
  assertEquals(outcome.prBodies.length, 1);
  const pr = outcome.prBodies[0]!;
  assert(pr.startsWith("## ⚠️ Degraded run"));
  assertStringIncludes(pr, "`haiku`");
  assertStringIncludes(pr, "the issue states no acceptance criteria");
  assert(!pr.includes("#900"), "no follow-up is referenced");
  assert(pr.endsWith(healthy.prBodies[0]!));
});

Deno.test("completion - (c) a degraded run with one partial criterion files the follow-up as before (Issue #2695)", async () => {
  const outcome = await runCompletion({
    issueBody: ISSUE_WITH_CRITERIA,
    summary: SUMMARY_PARTIAL_AND_MET,
    claudeRunStats: DEGRADED,
  });

  assertEquals(outcome.status, "continue", outcome.reason);
  assertEquals(outcome.issueCreates.length, 1);
  const pr = outcome.prBodies[0]!;
  assertStringIncludes(pr, "Degraded run — partial delivery");
  assertStringIncludes(pr, "#900");
  assertStringIncludes(pr, "**partial** — The router sends planning to opus.");
  assert(!pr.includes("The docs table lists opus"), "met items are not listed");
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
  assertStringIncludes(outcome.reason ?? "", "Degraded run (");
  assertEquals(outcome.prBodies.length, 0, "gh pr create must not run");
});

Deno.test("completion - a degraded run that passes every summary gate still names an existing PR when the follow-up cannot be filed (Issue #3092)", async () => {
  // All four summary gates pass (SUMMARY_PARTIAL), so this is completionBody's
  // own guard call, not reportSummaryRuleBlock. The agent already opened a PR
  // during execute. Filing the follow-up fails. The PR stays unfinalised, and
  // the outcome must still name it.
  const outcome = await runCompletion({
    issueBody: ISSUE_WITH_CRITERIA,
    summary: SUMMARY_PARTIAL,
    claudeRunStats: DEGRADED,
    prExistsForBranch: true,
    failIssueCreate: true,
  });

  assertEquals(outcome.status, "failure");
  assertStringIncludes(outcome.reason ?? "", "follow-up");
  assertEquals(
    outcome.prBodies.length,
    0,
    "the existing PR must not be recovered when the follow-up cannot be filed",
  );
  assertEquals(outcome.prUrl, EXISTING_PR_URL);
  assertEquals(outcome.prNumber, 777);
  const derived = deriveRunOutcome({
    success: false,
    phase: "completion",
    reason: outcome.reason ?? "",
    prUrl: outcome.prUrl,
    prNumber: outcome.prNumber,
  });
  assertEquals(derived.kind, "pr");
  if (derived.kind === "pr") {
    assertEquals(derived.prNumber, 777);
    assert(derived.blocked, "a live PR is recorded as blocked, not no_pr");
  }
});

Deno.test("completion - a degraded run whose follow-up cannot be filed names the branch's open PR (Issue #3121)", async () => {
  const outcome = await runCompletion({
    issueBody: ISSUE_WITH_CRITERIA,
    summary: SUMMARY_PARTIAL,
    claudeRunStats: DEGRADED,
    failIssueCreate: true,
    prExistsForBranch: true,
  });

  assertEquals(outcome.status, "failure");
  assertEquals(outcome.outcome.kind, "pr");
  assert(outcome.outcome.kind === "pr", "narrowing");
  assertEquals(outcome.outcome.prNumber, 777);
  assertEquals(outcome.outcome.prUrl, EXISTING_PR_URL);
  assertEquals(outcome.outcome.blocked?.phase, "completion");
  assertStringIncludes(
    outcome.outcome.blocked?.reason ?? "",
    "follow-up",
  );
  assertEquals(outcome.recoverCalls, 0, "the PR must not be recovered");
  assertEquals(outcome.prBodies.length, 0, "no PR body is ever written");
  assertEquals(outcome.prCreateCalls, 0, "gh pr create must not run");
});

Deno.test("completion - a degraded run whose follow-up cannot be filed on a branch with no PR raises no PR (Issue #3121)", async () => {
  const outcome = await runCompletion({
    issueBody: ISSUE_WITH_CRITERIA,
    summary: SUMMARY_PARTIAL,
    claudeRunStats: DEGRADED,
    failIssueCreate: true,
    prExistsForBranch: false,
  });

  assertEquals(outcome.status, "failure");
  assertEquals(outcome.outcome.kind, "no_pr");
  assertEquals(outcome.recoverCalls, 0);
});

Deno.test("completion - a degraded run whose follow-up cannot be filed names no PR for an unnumberable PR URL (Issue #3121)", async () => {
  const outcome = await runCompletion({
    issueBody: ISSUE_WITH_CRITERIA,
    summary: SUMMARY_PARTIAL,
    claudeRunStats: DEGRADED,
    failIssueCreate: true,
    prExistsForBranch: true,
    prUrl: "https://github.com/stSoftwareAU/VibeCoder/pull/not-a-number",
  });

  assertEquals(outcome.status, "failure");
  assertEquals(outcome.outcome.kind, "no_pr");
});

Deno.test("completion - a docs-sweep block on an existing-PR branch still runs the degraded-delivery guard first (Issue #3085 review)", async () => {
  // The docs-sweep gate (Issue #3073) blocks this summary — it carries no
  // `Docs sweep` line. Previously that gate ran *before* the degraded-run
  // delivery guard, so on a branch that already had an open PR, the gate's
  // own `reportSummaryRuleBlock` call recovered (and finalised) that PR
  // before the guard ever filed the follow-up or prefixed the PR body — the
  // exact #2543 loss the guard exists to stop.
  const outcome = await runCompletion({
    issueBody: ISSUE_WITH_CRITERIA,
    summary: SUMMARY_PARTIAL_NO_DOCS_SWEEP,
    claudeRunStats: DEGRADED,
    prExistsForBranch: true,
  });

  assertEquals(outcome.status, "early_exit", outcome.reason);
  assertEquals(
    outcome.issueCreates.length,
    1,
    "the degraded-run follow-up is still filed even though the docs-sweep " +
      "gate blocks this summary",
  );
  assertEquals(
    outcome.prBodies.length,
    1,
    "the recovery path wrote the PR body back exactly once",
  );
  assertStringIncludes(outcome.prBodies[0]!, "Degraded run — partial delivery");
});

Deno.test("completion - an independent-review block on an existing-PR branch still runs the degraded-delivery guard first (Issue #3092)", async () => {
  // The independent two-axis review gate (Issue #663) blocks this summary —
  // it carries no `## Standards Review` section. The guard must still file
  // the follow-up and prefix the PR body before `reportSummaryRuleBlock`
  // recovers and finalises the existing PR.
  const outcome = await runCompletion({
    issueBody: ISSUE_WITH_CRITERIA,
    summary: SUMMARY_PARTIAL_NO_STANDARDS_REVIEW,
    claudeRunStats: DEGRADED,
    prExistsForBranch: true,
  });

  assertEquals(outcome.status, "early_exit", outcome.reason);
  assertEquals(
    outcome.issueCreates.length,
    1,
    "the degraded-run follow-up is still filed even though the independent " +
      "review gate blocks this summary",
  );
  assertEquals(
    outcome.prBodies.length,
    1,
    "the recovery path wrote the PR body back exactly once",
  );
  assertStringIncludes(outcome.prBodies[0]!, "Degraded run — partial delivery");
  assertStringIncludes(outcome.prBodies[0]!, "#900");
});

Deno.test("completion - a closure-gate block on an existing-PR branch still runs the degraded-delivery guard first (Issue #3092)", async () => {
  // The acceptance-criteria closure gate (Issue #518) blocks this summary —
  // its `missing` entry carries no `reason:`. `parseClosureEntries` (which
  // `assessDegradedDelivery` uses) reads the entry's status regardless of
  // whether the gate itself considers the entry well-formed, so this still
  // yields a `missing` shortfall for the degraded assessment.
  const outcome = await runCompletion({
    issueBody: ISSUE_WITH_CRITERIA,
    summary: SUMMARY_PARTIAL_NO_CLOSURE_REASON,
    claudeRunStats: DEGRADED,
    prExistsForBranch: true,
  });

  assertEquals(outcome.status, "early_exit", outcome.reason);
  assertEquals(
    outcome.issueCreates.length,
    1,
    "the degraded-run follow-up is still filed even though the closure " +
      "gate blocks this summary",
  );
  assertEquals(
    outcome.prBodies.length,
    1,
    "the recovery path wrote the PR body back exactly once",
  );
  assertStringIncludes(outcome.prBodies[0]!, "Degraded run — partial delivery");
  assertStringIncludes(outcome.prBodies[0]!, "#900");
});

Deno.test("completion - a healthy run blocked by the independent-review gate on an existing-PR branch carries no Degraded run section", async () => {
  const outcome = await runCompletion({
    issueBody: ISSUE_WITH_CRITERIA,
    summary: SUMMARY_PARTIAL_NO_STANDARDS_REVIEW,
    claudeRunStats: HEALTHY,
    prExistsForBranch: true,
  });

  assertEquals(outcome.status, "early_exit", outcome.reason);
  assertEquals(
    outcome.issueCreates.length,
    1,
    "a healthy run's own missing entry files the follow-up before the gate's recovery",
  );
  assertEquals(outcome.prBodies.length, 1);
  assert(!outcome.prBodies[0]!.includes("Degraded run"));
  assertStringIncludes(outcome.prBodies[0]!, REPORTED_GAP_SECTION_HEADING);
});

Deno.test("completion - a degraded run blocked by the independent-review gate whose follow-up cannot be filed fails the run without finalising the PR", async () => {
  const outcome = await runCompletion({
    issueBody: ISSUE_WITH_CRITERIA,
    summary: SUMMARY_PARTIAL_NO_STANDARDS_REVIEW,
    claudeRunStats: DEGRADED,
    prExistsForBranch: true,
    failIssueCreate: true,
  });

  assertEquals(outcome.status, "failure");
  assertStringIncludes(outcome.reason ?? "", "follow-up");
  assertEquals(
    outcome.prBodies.length,
    0,
    "the PR must not be recovered/finalised when the follow-up cannot be filed",
  );
  assertEquals(outcome.prUrl, EXISTING_PR_URL);
  assertEquals(outcome.prNumber, 777);
  const derived = deriveRunOutcome({
    success: false,
    phase: "completion",
    reason: outcome.reason ?? "",
    prUrl: outcome.prUrl,
    prNumber: outcome.prNumber,
  });
  assertEquals(derived.kind, "pr");
  if (derived.kind === "pr") {
    assertEquals(derived.prNumber, 777);
    assert(derived.blocked, "a live PR is recorded as blocked, not no_pr");
  }
});

Deno.test("completion - a degraded run blocked by the independent-review gate whose follow-up cannot be filed names no PR for an unnumberable PR URL (Issue #3136)", async () => {
  const outcome = await runCompletion({
    issueBody: ISSUE_WITH_CRITERIA,
    summary: SUMMARY_PARTIAL_NO_STANDARDS_REVIEW,
    claudeRunStats: DEGRADED,
    prExistsForBranch: true,
    failIssueCreate: true,
    prUrl: "https://github.com/stSoftwareAU/VibeCoder/pull/not-a-number",
  });

  assertEquals(outcome.status, "failure");
  assertStringIncludes(outcome.reason ?? "", "follow-up");
  assertEquals(outcome.outcome.kind, "no_pr");
  assertEquals(outcome.prUrl, undefined);
  assertEquals(outcome.prNumber, undefined);
  assertEquals(outcome.prBodies.length, 0);
  assertEquals(outcome.recoverCalls, 0);
});

Deno.test("completion - a degraded run blocked by the independent-review gate on a branch with no PR files no follow-up", async () => {
  const outcome = await runCompletion({
    issueBody: ISSUE_WITH_CRITERIA,
    summary: SUMMARY_PARTIAL_NO_STANDARDS_REVIEW,
    claudeRunStats: DEGRADED,
    prExistsForBranch: false,
  });

  assertEquals(outcome.status, "failure", outcome.reason);
  assertEquals(
    outcome.issueCreates.length,
    0,
    "the degraded-run guard must never run for a PR that does not yet exist",
  );
  assertEquals(outcome.prBodies.length, 0, "gh pr create must not run");
});

Deno.test("completion - a docs-sweep block on a branch with no PR files no follow-up, even after the one in-run recovery retry (Issue #3085 review)", async () => {
  // No PR exists yet on this branch, so the degraded-run guard's follow-up
  // would promise a PR ("that run's PR still completes #N on merge") that
  // this gate can still end the run without ever raising. The short-circuit
  // must keep the guard from running at all here — on both the first block
  // and the one in-run recovery retry, since the default mock Claude
  // invocation changes nothing on the branch.
  const outcome = await runCompletion({
    issueBody: ISSUE_WITH_CRITERIA,
    summary: SUMMARY_PARTIAL_NO_DOCS_SWEEP,
    claudeRunStats: DEGRADED,
    prExistsForBranch: false,
  });

  assertEquals(outcome.status, "failure", outcome.reason);
  assertStringIncludes(outcome.reason ?? "", "Docs sweep");
  assertEquals(
    outcome.issueCreates.length,
    0,
    "the degraded-run guard must never file a follow-up for a PR that is " +
      "never raised",
  );
  assertEquals(outcome.prBodies.length, 0, "gh pr create must not run");
});

Deno.test("completion - pending CI and review do not file follow-ups or escalate a follow-up issue (Issue #3961)", async () => {
  const summary = `## Summary

Closes #${ISSUE}.

## Acceptance Criteria

<!-- vibe-spec-review inputs="diff+issue-body" -->

- **partial** — required CI — evidence: PR checks pending — reviewer: partial — reason: CI not yet verified
- **missing** — clean code review — reviewer: missing — reason: awaiting code review

` + SUMMARY_COMPLETE.slice(SUMMARY_COMPLETE.indexOf("## Standards Review"));
  for (const claudeRunStats of [HEALTHY, DEGRADED]) {
    for (
      const issueBody of [
        "Fix the parser.",
        "## Acceptance Criteria\n\n- required CI\n- clean code review\n",
        "Fix the parser.\n\n<!-- finding-id: degraded-follow-up-517 -->",
      ]
    ) {
      const outcome = await runCompletion({
        issueBody,
        summary,
        claudeRunStats,
      });
      assertEquals(outcome.status, "continue");
      assertEquals(outcome.prCreateCalls, 1);
      assertEquals(outcome.issueCreates, []);
      assertEquals(
        outcome.issueEdits.filter((args) => args.includes("needs-human")),
        [],
      );
      assertEquals(outcome.issueComments, []);
      assertStringIncludes(outcome.prBodies[0]!, "CI not yet verified");
      assert(!outcome.prBodies[0]!.includes(FOLLOW_UP_CHAIN_STOP_MARKER));
    }
  }
});
