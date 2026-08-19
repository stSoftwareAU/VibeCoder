/**
 * Tests for the merged PR pre-flight check phase (Issue #1560).
 *
 * Covers the four scenarios called out in the acceptance criteria:
 * 1. Merged PR + open issue   -> issue is closed, early_exit returned.
 * 2. Merged PR + closed issue -> no close comment posted, early_exit returned.
 * 3. No PR for the issue      -> continue.
 * 4. findExistingPrForIssue errors -> warning logged, continue.
 *
 * Tests assert on observable behaviour (gh command arguments, phase
 * result status) using injected WorkerDeps doubles — they never inspect
 * source text.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  answerLandingCalls,
  MERGED_PR_VIEW,
} from "./fixtures/merge_landing_stub.ts";
import {
  MERGED_PR_PRECHECK_EARLY_EXIT_REASON,
  workOnIssueMergedPrPrecheck,
} from "../lib/phases/merged_pr_precheck_phase.ts";
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
    issueNumber: 42,
    issueTitle: "Already-fixed bug",
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
    branchName: "",
    baseBranch: "",
    defaultBranch: "",
    repoPath: "",
    clarityStatus: "not_assessed",
    claudeOutput: "",
    executeStartTime: 0,
    baselineQualityPassed: true,
    baselineQualityOutput: "",
  };
}

/** Build a gh command mock that dispatches on the first two args. */
function makeGh(handlers: {
  prView?: (prNumber: number) => string;
  issueView?: (issueNumber: number) => string;
  issueClose?: (issueNumber: number) => void;
  issueEdit?: (issueNumber: number) => void;
  other?: (args: string[]) => string;
}): {
  runGhCommand: (args: string[]) => Promise<string>;
  calls: string[][];
} {
  const calls: string[][] = [];
  const runGhCommand = (args: string[]): Promise<string> => {
    calls.push([...args]);
    // Issue #4396: the close path verifies the merge landed first.
    const landing = answerLandingCalls(args);
    if (landing !== null) return Promise.resolve(landing);
    if (args[0] === "pr" && args[1] === "view" && handlers.prView) {
      return Promise.resolve(handlers.prView(parseInt(args[2]!, 10)));
    }
    if (args[0] === "issue" && args[1] === "view" && handlers.issueView) {
      return Promise.resolve(handlers.issueView(parseInt(args[2]!, 10)));
    }
    if (args[0] === "issue" && args[1] === "close") {
      if (handlers.issueClose) handlers.issueClose(parseInt(args[2]!, 10));
      return Promise.resolve("");
    }
    if (args[0] === "issue" && args[1] === "edit") {
      if (handlers.issueEdit) handlers.issueEdit(parseInt(args[2]!, 10));
      return Promise.resolve("");
    }
    if (handlers.other) return Promise.resolve(handlers.other(args));
    return Promise.resolve("");
  };
  return { runGhCommand, calls };
}

// ---------------------------------------------------------------------------
// Scenario 1 — merged PR + open issue
// ---------------------------------------------------------------------------

Deno.test(
  "merged-pr-precheck - closes the issue and early-exits when a merged PR exists",
  async () => {
    const ctx = makeContext();
    const state = makeState();

    const closeCalls: number[] = [];
    const editCalls: number[] = [];
    const gh = makeGh({
      prView: (_n) => JSON.stringify(MERGED_PR_VIEW),
      issueView: (_n) => JSON.stringify({ state: "OPEN", milestone: null }),
      issueClose: (n) => closeCalls.push(n),
      issueEdit: (n) => editCalls.push(n),
    });

    const deps = createMockDeps({
      github: { runGhCommand: gh.runGhCommand },
      pr: {
        findExistingPrForIssue: () =>
          Promise.resolve({
            ok: true,
            value: "https://github.com/org/repo/pull/27",
          }),
      },
    });

    const result = await workOnIssueMergedPrPrecheck(ctx, state, deps);

    assertEquals(result, {
      status: "early_exit",
      reason: MERGED_PR_PRECHECK_EARLY_EXIT_REASON,
    });
    assertEquals(closeCalls, [42]);
    // The worker is unassigned after close.
    assertEquals(editCalls, [42]);
    // PR state was checked with the correct PR number and repo.
    const prViewCall = gh.calls.find(
      (a) => a[0] === "pr" && a[1] === "view",
    );
    assertEquals(prViewCall?.[2], "27");
    assertEquals(prViewCall?.includes("--repo"), true);
    assertEquals(prViewCall?.[prViewCall.indexOf("--repo") + 1], "org/repo");
  },
);

// ---------------------------------------------------------------------------
// Scenario 2 — merged PR + already-closed issue
// ---------------------------------------------------------------------------

Deno.test(
  "merged-pr-precheck - early-exits idempotently when the issue is already closed",
  async () => {
    const ctx = makeContext();
    const state = makeState();

    const closeCalls: number[] = [];
    const gh = makeGh({
      prView: () => JSON.stringify(MERGED_PR_VIEW),
      issueView: () => JSON.stringify({ state: "CLOSED", milestone: null }),
      issueClose: (n) => closeCalls.push(n),
    });

    const deps = createMockDeps({
      github: { runGhCommand: gh.runGhCommand },
      pr: {
        findExistingPrForIssue: () =>
          Promise.resolve({
            ok: true,
            value: "https://github.com/org/repo/pull/27",
          }),
      },
    });

    const result = await workOnIssueMergedPrPrecheck(ctx, state, deps);

    assertEquals(result, {
      status: "early_exit",
      reason: MERGED_PR_PRECHECK_EARLY_EXIT_REASON,
    });
    // Idempotent: no close comment posted when the issue is already closed.
    assertEquals(closeCalls, []);
  },
);

// ---------------------------------------------------------------------------
// Scenario 3 — no PR exists for the issue
// ---------------------------------------------------------------------------

Deno.test(
  "merged-pr-precheck - returns continue when no PR exists for the issue",
  async () => {
    const ctx = makeContext();
    const state = makeState();

    const gh = makeGh({});
    const deps = createMockDeps({
      github: { runGhCommand: gh.runGhCommand },
      pr: {
        findExistingPrForIssue: () =>
          Promise.resolve({
            ok: false,
            error: new Error("No PR found for issue #42"),
          }),
      },
    });

    const result = await workOnIssueMergedPrPrecheck(ctx, state, deps);

    assertEquals(result, { status: "continue" });
    // No PR view or issue close lookups should have been attempted.
    assertEquals(
      gh.calls.some((a) => a[0] === "pr" && a[1] === "view"),
      false,
    );
    assertEquals(
      gh.calls.some((a) => a[0] === "issue" && a[1] === "close"),
      false,
    );
  },
);

// ---------------------------------------------------------------------------
// Scenario 4 — findExistingPrForIssue throws
// ---------------------------------------------------------------------------

Deno.test(
  "merged-pr-precheck - returns continue when findExistingPrForIssue throws",
  async () => {
    const ctx = makeContext();
    const state = makeState();

    const warnEvents: Array<{ message: string }> = [];

    const gh = makeGh({});
    const deps = createMockDeps({
      logger: {
        info: () => {},
        warn: (message: string) => warnEvents.push({ message }),
        error: () => {},
        debug: () => {},
        security: () => {},
        skipReason: () => {},
        timing: () => {},
        scanSummary: () => {},
        workerSummary: () => {},
      },
      github: { runGhCommand: gh.runGhCommand },
      pr: {
        findExistingPrForIssue: () => {
          throw new Error("gh API unavailable");
        },
      },
    });

    const result = await workOnIssueMergedPrPrecheck(ctx, state, deps);

    assertEquals(result, { status: "continue" });
    // The error was logged as a warning (non-fatal).
    assertEquals(warnEvents.length >= 1, true);
    // No corrective gh calls were attempted.
    assertEquals(gh.calls.length, 0);
  },
);

// ---------------------------------------------------------------------------
// Bonus — PR exists but is not merged (e.g. OPEN)
// ---------------------------------------------------------------------------

Deno.test(
  "merged-pr-precheck - returns continue when the PR exists but is not merged",
  async () => {
    const ctx = makeContext();
    const state = makeState();

    const closeCalls: number[] = [];
    const gh = makeGh({
      prView: () => JSON.stringify({ state: "OPEN" }),
      issueClose: (n) => closeCalls.push(n),
    });

    const deps = createMockDeps({
      github: { runGhCommand: gh.runGhCommand },
      pr: {
        findExistingPrForIssue: () =>
          Promise.resolve({
            ok: true,
            value: "https://github.com/org/repo/pull/27",
          }),
      },
    });

    const result = await workOnIssueMergedPrPrecheck(ctx, state, deps);

    assertEquals(result, { status: "continue" });
    assertEquals(closeCalls, []);
  },
);
