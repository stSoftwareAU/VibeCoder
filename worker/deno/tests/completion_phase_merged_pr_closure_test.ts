/**
 * Tests for recoverAndFinaliseExistingPr — merged PR closure (Issue #1559).
 *
 * Verifies the completion phase's recovery path closes the source issue
 * when the existing PR is already merged, and suppresses the redundant
 * "PR created" link comment in that case. Without this behaviour the
 * worker loops re-picking up an issue whose work is already shipped
 * (see parent issue #1557).
 *
 * Three scenarios covered via injected WorkerDeps test doubles:
 *   1. Merged PR + open issue        — gh issue close invoked, linkPrToIssue NOT.
 *   2. Open   PR + open issue        — linkPrToIssue invoked,    gh issue close NOT.
 *   3. Merged PR + already-closed    — neither gh issue close nor linkPrToIssue (idempotent).
 *   4. Held PR (Issue #4075)         — gh pr merge --disable-auto runs, no --auto arming, failure non-fatal.
 *
 * Tests assert on observable behaviour (gh command args, linkPrToIssue
 * call count, phase result status) using injected WorkerDeps doubles —
 * they never inspect source text.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  answerLandingCalls,
  MERGED_PR_VIEW,
  mergedPrViewFor,
} from "./fixtures/merge_landing_stub.ts";
import { recoverAndFinaliseExistingPr } from "../lib/phases/completion_phase.ts";
import {
  createMockDeps,
  mockGitHubClient,
} from "../lib/issue_worker_wiring.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import { STANDING_VIOLATION_LABEL } from "../lib/standing_violation_routing.ts";
import type { WorkerConfig } from "../types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(): WorkerConfig {
  return buildDefaultWorkerConfig();
}

function makeContext(overrides: Partial<IssueContext> = {}): IssueContext {
  return {
    repo: "org/repo",
    issueNumber: 11,
    issueTitle: "Already-merged work",
    issueBody: "",
    issueLabels: [],
    issueComments: "",
    githubUser: "testworker",
    config: makeConfig(),
    ...overrides,
  };
}

function makeState(): PhaseState {
  return {
    branchName: "issue-11-already-merged-work",
    baseBranch: "main",
    defaultBranch: "main",
    repoPath: "/tmp/mock-repo",
    clarityStatus: "not_assessed",
    claudeOutput: "",
    executeStartTime: 0,
    baselineQualityPassed: true,
    baselineQualityOutput: "",
  };
}

/**
 * Build a gh command mock that dispatches on the first two args and records
 * every call. Returns the handler plus the call log for assertions.
 */
function makeGh(handlers: {
  prState: "MERGED" | "OPEN" | "CLOSED";
  issueState: "OPEN" | "CLOSED";
  issueMilestone?: { title: string } | null;
  /** Head of the merged PR — whose PR it is (Issue #174). */
  prHeadRefName?: string;
}): {
  runGhCommand: (args: string[]) => Promise<string>;
  calls: string[][];
} {
  const calls: string[][] = [];
  const runGhCommand = (args: string[]): Promise<string> => {
    // Issue #4396: the close path verifies the merge landed first.
    const landing = answerLandingCalls(args);
    if (landing !== null) return Promise.resolve(landing);
    calls.push([...args]);
    if (args[0] === "pr" && args[1] === "view") {
      return Promise.resolve(
        JSON.stringify(
          handlers.prState === "MERGED"
            ? (handlers.prHeadRefName
              ? mergedPrViewFor(handlers.prHeadRefName)
              : MERGED_PR_VIEW)
            : { state: handlers.prState },
        ),
      );
    }
    if (args[0] === "issue" && args[1] === "view") {
      return Promise.resolve(JSON.stringify({
        state: handlers.issueState,
        milestone: handlers.issueMilestone ?? null,
      }));
    }
    // issue close, issue edit, and anything else succeed silently.
    return Promise.resolve("");
  };
  return { runGhCommand, calls };
}

// ---------------------------------------------------------------------------
// Scenario 1 — merged PR + open issue
// ---------------------------------------------------------------------------

Deno.test(
  "recoverAndFinaliseExistingPr - merged PR + open issue closes the issue and skips linkPrToIssue",
  async () => {
    const ctx = makeContext();
    const state = makeState();

    const gh = makeGh({ prState: "MERGED", issueState: "OPEN" });
    let linkPrCallCount = 0;

    const deps = createMockDeps({
      github: { runGhCommand: gh.runGhCommand },
      pr: {
        linkPrToIssue: () => {
          linkPrCallCount += 1;
          return Promise.resolve({ ok: true, value: undefined });
        },
      },
    });

    const result = await recoverAndFinaliseExistingPr(
      "https://github.com/org/repo/pull/27",
      ctx,
      state,
      "## Summary\n\nCloses #11.\n",
      deps,
      { docsSweepHitsComment: "", holdAutoMerge: false },
    );

    assertEquals(result, { status: "continue" });

    // linkPrToIssue MUST NOT be called when the PR is merged.
    assertEquals(linkPrCallCount, 0);

    // gh issue close MUST be invoked with the correct issue number and repo.
    const closeCall = gh.calls.find(
      (a) => a[0] === "issue" && a[1] === "close",
    );
    assertEquals(closeCall?.[2], "11");
    assertEquals(closeCall?.includes("--repo"), true);
    assertEquals(closeCall?.[closeCall.indexOf("--repo") + 1], "org/repo");

    // The standard close comment is attached.
    assertEquals(closeCall?.includes("--comment"), true);
    const commentIdx = closeCall!.indexOf("--comment");
    assertEquals(
      closeCall![commentIdx + 1],
      "Automatically closed — PR #27 has been merged.",
    );

    // Worker is unassigned after close.
    const editCall = gh.calls.find(
      (a) =>
        a[0] === "issue" && a[1] === "edit" &&
        a.includes("--remove-assignee"),
    );
    assertEquals(editCall?.[2], "11");
    assertEquals(
      editCall?.[editCall.indexOf("--remove-assignee") + 1],
      "testworker",
    );
  },
);

// ---------------------------------------------------------------------------
// Scenario 2 — open PR + open issue
// ---------------------------------------------------------------------------

Deno.test(
  "recoverAndFinaliseExistingPr - open PR + open issue posts link comment and does not close the issue",
  async () => {
    const ctx = makeContext();
    const state = makeState();

    const gh = makeGh({ prState: "OPEN", issueState: "OPEN" });
    let linkPrCallCount = 0;
    let linkPrLastArgs:
      | { repo: string; issueNumber: number; prUrl: string }
      | null = null;

    const deps = createMockDeps({
      github: { runGhCommand: gh.runGhCommand },
      pr: {
        linkPrToIssue: (repo: string, issueNumber: number, prUrl: string) => {
          linkPrCallCount += 1;
          linkPrLastArgs = { repo, issueNumber, prUrl };
          return Promise.resolve({ ok: true, value: undefined });
        },
      },
    });

    const result = await recoverAndFinaliseExistingPr(
      "https://github.com/org/repo/pull/27",
      ctx,
      state,
      "## Summary\n\nCloses #11.\n",
      deps,
      { docsSweepHitsComment: "", holdAutoMerge: false },
    );

    assertEquals(result, { status: "continue" });

    // linkPrToIssue IS called for an open PR, with the expected arguments.
    assertEquals(linkPrCallCount, 1);
    assertEquals(linkPrLastArgs, {
      repo: "org/repo",
      issueNumber: 11,
      prUrl: "https://github.com/org/repo/pull/27",
    });

    // gh issue close MUST NOT be invoked — the PR is not merged.
    assertEquals(
      gh.calls.some((a) => a[0] === "issue" && a[1] === "close"),
      false,
    );
  },
);

// ---------------------------------------------------------------------------
// Scenario 3 — merged PR + already-closed issue (idempotent)
// ---------------------------------------------------------------------------

Deno.test(
  "recoverAndFinaliseExistingPr - merged PR + already-closed issue is idempotent (no close, no link comment)",
  async () => {
    const ctx = makeContext();
    const state = makeState();

    const gh = makeGh({ prState: "MERGED", issueState: "CLOSED" });
    let linkPrCallCount = 0;

    const deps = createMockDeps({
      github: { runGhCommand: gh.runGhCommand },
      pr: {
        linkPrToIssue: () => {
          linkPrCallCount += 1;
          return Promise.resolve({ ok: true, value: undefined });
        },
      },
    });

    const result = await recoverAndFinaliseExistingPr(
      "https://github.com/org/repo/pull/27",
      ctx,
      state,
      "## Summary\n\nCloses #11.\n",
      deps,
      { docsSweepHitsComment: "", holdAutoMerge: false },
    );

    assertEquals(result, { status: "continue" });

    // The PR is merged — the link comment is skipped regardless of issue state.
    assertEquals(linkPrCallCount, 0);

    // The issue is already closed — gh issue close MUST NOT be invoked
    // (ensureIssueClosedIfPrMerged short-circuits when state !== "OPEN").
    assertEquals(
      gh.calls.some((a) => a[0] === "issue" && a[1] === "close"),
      false,
    );
  },
);

// ===========================================================================
// Issue #174 — a merged PR that is not this run's must not close the issue
// ===========================================================================

Deno.test(
  "recoverAndFinaliseExistingPr #174 - a merged PR on someone else's branch leaves the issue open and comments",
  async () => {
    // The VibeCoder#42 shape: the run worked `issue-11-already-merged-work`,
    // and the merged PR the linker returned belongs to a different branch on
    // the same issue. Closing here is what stranded three commits.
    const ctx = makeContext();
    const state = makeState();

    const gh = makeGh({
      prState: "MERGED",
      issueState: "OPEN",
      prHeadRefName: "issue-11-someone-elses-partial-fix",
    });

    const result = await recoverAndFinaliseExistingPr(
      "https://github.com/org/repo/pull/27",
      ctx,
      state,
      "## Summary\n\nCloses #11.\n",
      createMockDeps({ github: { runGhCommand: gh.runGhCommand } }),
      { docsSweepHitsComment: "", holdAutoMerge: false },
    );

    assertEquals(result, { status: "continue" });

    const closeCall = gh.calls.find(
      (a) => a[0] === "issue" && a[1] === "close",
    );
    assertEquals(closeCall, undefined, "the issue must be left open");

    // And the worker says why, naming its branch so a human can find the work.
    const comment = gh.calls.find(
      (a) => a[0] === "issue" && a[1] === "comment",
    );
    assert(comment !== undefined, "a comment must explain the refusal");
    const body = comment![comment!.indexOf("--body") + 1] ?? "";
    assertStringIncludes(body, "issue-11-already-merged-work");
    assertStringIncludes(body, "#27");
  },
);

Deno.test(
  "recoverAndFinaliseExistingPr #174 - a merged PR on this run's own branch still closes the issue",
  async () => {
    // The Issue #1559 case must keep working: when the merged PR is ours,
    // closing is right and the re-pickup loop stays fixed.
    const ctx = makeContext();
    const state = makeState();

    const gh = makeGh({
      prState: "MERGED",
      issueState: "OPEN",
      prHeadRefName: state.branchName,
    });

    await recoverAndFinaliseExistingPr(
      "https://github.com/org/repo/pull/27",
      ctx,
      state,
      "## Summary\n\nCloses #11.\n",
      createMockDeps({ github: { runGhCommand: gh.runGhCommand } }),
      { docsSweepHitsComment: "", holdAutoMerge: false },
    );

    const closeCall = gh.calls.find(
      (a) => a[0] === "issue" && a[1] === "close",
    );
    assertEquals(closeCall?.[2], "11");
  },
);

// ===========================================================================
// Issue #4075 — a held PR must not keep an auto-merge armed by an earlier pass
// ===========================================================================

const HELD_PR_URL = "https://github.com/org/repo/pull/27";
const HELD_PR_BODY = "## Summary\n\nCloses #11.\n";

/** The `gh pr merge` calls recorded by a makeGh double. */
function mergeCalls(calls: string[][]): string[][] {
  return calls.filter((a) => a[0] === "pr" && a[1] === "merge");
}

Deno.test(
  "recoverAndFinaliseExistingPr #4075 - a held open PR is disarmed and never re-armed",
  async () => {
    const gh = makeGh({ prState: "OPEN", issueState: "OPEN" });

    const result = await recoverAndFinaliseExistingPr(
      HELD_PR_URL,
      makeContext(),
      makeState(),
      HELD_PR_BODY,
      createMockDeps({ github: { runGhCommand: gh.runGhCommand } }),
      { docsSweepHitsComment: "", holdAutoMerge: true },
    );

    assertEquals(result, { status: "continue" });

    // The only `gh pr merge` call is the disarm.
    assertEquals(mergeCalls(gh.calls), [
      ["pr", "merge", "27", "--repo", "org/repo", "--disable-auto"],
    ]);
    // No arming call: no `--auto` flag on any merge call.
    assertEquals(
      mergeCalls(gh.calls).some((a) => a.includes("--auto")),
      false,
    );
  },
);

Deno.test(
  "recoverAndFinaliseExistingPr #4075 - a held PR with a verifier hold is disarmed and still commented",
  async () => {
    const gh = makeGh({ prState: "OPEN", issueState: "OPEN" });
    const posted: { prNumber: number; body: string }[] = [];

    const deps = createMockDeps({
      github: {
        runGhCommand: gh.runGhCommand,
        createClient: () => ({
          ...mockGitHubClient(),
          postComment: (_repo: string, prNumber: number, body: string) => {
            posted.push({ prNumber, body });
            return Promise.resolve(undefined);
          },
        }),
      },
    });

    const result = await recoverAndFinaliseExistingPr(
      HELD_PR_URL,
      makeContext(),
      makeState(),
      HELD_PR_BODY,
      deps,
      {
        docsSweepHitsComment: "",
        holdAutoMerge: true,
        verifierHoldComment: "- finding: unresolved",
      },
    );

    assertEquals(result, { status: "continue" });

    // The disarm runs even though the verifier hold comment path also runs.
    assertEquals(mergeCalls(gh.calls), [
      ["pr", "merge", "27", "--repo", "org/repo", "--disable-auto"],
    ]);
    assertEquals(posted.length, 1);
    assertEquals(posted[0]!.prNumber, 27);
    assertStringIncludes(posted[0]!.body, "Auto-merge withheld");
  },
);

Deno.test(
  "recoverAndFinaliseExistingPr #4075 - without a hold, auto-merge is not disarmed",
  async () => {
    const gh = makeGh({ prState: "OPEN", issueState: "OPEN" });

    const result = await recoverAndFinaliseExistingPr(
      HELD_PR_URL,
      makeContext(),
      makeState(),
      HELD_PR_BODY,
      createMockDeps({ github: { runGhCommand: gh.runGhCommand } }),
      { docsSweepHitsComment: "", holdAutoMerge: false },
    );

    assertEquals(result, { status: "continue" });
    assertEquals(
      gh.calls.some((a) => a.includes("--disable-auto")),
      false,
    );
  },
);

Deno.test(
  "recoverAndFinaliseExistingPr #4075 - a failed disarm is non-fatal and the standing-violation label is still applied",
  async () => {
    const gh = makeGh({ prState: "OPEN", issueState: "OPEN" });
    const disarmAttempts: string[][] = [];
    const labelCalls: { prNumber: number; labels: string[] }[] = [];

    const runGhCommand = (args: string[]): Promise<string> => {
      if (args.includes("--disable-auto")) {
        disarmAttempts.push([...args]);
        return Promise.reject(
          new Error("auto-merge is not enabled on this pull request"),
        );
      }
      return gh.runGhCommand(args);
    };

    const deps = createMockDeps({
      github: { runGhCommand },
      pr: {
        updatePrLabels: (
          _repo: string,
          prNumber: number,
          labels: string[],
        ) => {
          labelCalls.push({ prNumber, labels: [...labels] });
          return Promise.resolve({ ok: true, value: undefined });
        },
      },
    });

    const result = await recoverAndFinaliseExistingPr(
      HELD_PR_URL,
      makeContext(),
      makeState(),
      HELD_PR_BODY,
      deps,
      { docsSweepHitsComment: "", holdAutoMerge: true },
    );

    // The disarm was attempted and its failure did not abort finalisation.
    assertEquals(result, { status: "continue" });
    assertEquals(disarmAttempts, [
      ["pr", "merge", "27", "--repo", "org/repo", "--disable-auto"],
    ]);
    // The hold label path was not skipped.
    assertEquals(labelCalls, [
      { prNumber: 27, labels: [STANDING_VIOLATION_LABEL] },
    ]);
  },
);
