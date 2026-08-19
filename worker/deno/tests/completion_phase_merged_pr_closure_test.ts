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
 *
 * Tests assert on observable behaviour (gh command args, linkPrToIssue
 * call count, phase result status) using injected WorkerDeps doubles —
 * they never inspect source text.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  answerLandingCalls,
  MERGED_PR_VIEW,
} from "./fixtures/merge_landing_stub.ts";
import { recoverAndFinaliseExistingPr } from "../lib/phases/completion_phase.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
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
            ? MERGED_PR_VIEW
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
