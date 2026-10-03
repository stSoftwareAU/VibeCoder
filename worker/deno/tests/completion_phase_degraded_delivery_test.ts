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

**Docs sweep** — grep: \`opus\`; section: \`docs/MODEL-AND-CACHING.md#planning\`; no hits
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

**Docs sweep** — grep: \`opus\`; section: \`docs/MODEL-AND-CACHING.md#planning\`; no hits
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

**Docs sweep** — grep: \`opus\`; section: \`docs/MODEL-AND-CACHING.md#planning\`; no hits
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

**Docs sweep** — grep: \`opus\`; section: \`docs/MODEL-AND-CACHING.md#planning\`; no hits
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

**Docs sweep** — grep: \`opus\`; section: \`docs/MODEL-AND-CACHING.md#planning\`; no hits
`;

/** A minimal summary carrying only the Docs sweep line (Issue #3073). */
const SUMMARY_MINIMAL_WITH_DOCS_SWEEP =
  `## Summary\n\nFinished the switch. Closes #${ISSUE}.\n\n**Docs sweep** — grep: \`opus\`; section: \`docs/MODEL-AND-CACHING.md#planning\`; no hits\n`;

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
  recoverCalls: number;
  prCreateCalls: number;
  /** Set when the run recorded an existing PR on its state (Issue #2044). */
  prUrl?: string;
  prNumber?: number;
  outcome: RunOutcome;
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
  let recoverCalls = 0;
  let prCreateCalls = 0;

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
    prBodies,
    recoverCalls,
    prCreateCalls,
    prUrl: state.prUrl,
    prNumber: state.prNumber,
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
    0,
    "a healthy run files no follow-up",
  );
  assertEquals(outcome.prBodies.length, 1);
  assert(!outcome.prBodies[0]!.includes("Degraded run"));
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
