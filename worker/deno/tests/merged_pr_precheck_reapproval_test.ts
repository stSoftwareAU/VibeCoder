/**
 * Tests for the merged-PR pre-check's re-approval skip (Issue #1618).
 *
 * #1562 was grilled to Ready and given `top-priority` at 00:21; at 00:41 the
 * pre-check found PR #1567 — matched by issue number in its title — merged at
 * 22:49 the previous day, and closed the issue. Re-opening did not help: the
 * pre-check runs on every claim. When a trusted author's approval label
 * post-dates the linked PR's merge, the remaining scope has been re-approved,
 * so the pre-check must skip the close and let the run proceed.
 *
 * Tests assert on observable behaviour (phase result, gh command arguments,
 * warning text) using injected WorkerDeps doubles.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { answerLandingCalls } from "./fixtures/merge_landing_stub.ts";
import {
  MERGED_PR_PRECHECK_EARLY_EXIT_REASON,
  workOnIssueMergedPrPrecheck,
} from "../lib/phases/merged_pr_precheck_phase.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import type { WorkerConfig } from "../types.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** When the linked PR merged — the #1562 shape (22:49 the night before). */
const MERGED_AT = "2026-09-07T22:49:00Z";
/** A trusted approval applied the next morning, after the merge. */
const AFTER_MERGE = "2026-09-08T00:21:00Z";
/** An approval applied before the merge — the ordinary close case. */
const BEFORE_MERGE = "2026-09-07T09:00:00Z";

const MERGED_PR_WITH_TIME = {
  state: "MERGED",
  mergedAt: MERGED_AT,
  mergeCommit: { oid: "abc123" },
  baseRefName: "Develop",
  headRefName: "issue-42-already-merged-work",
};

function makeConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    ...buildDefaultWorkerConfig(),
    allowedAuthors: ["trusted-human"],
    fleetPrAuthors: ["sibling-worker"],
    serviceAccounts: ["fleet-service"],
    ...overrides,
  };
}

function makeContext(overrides: Partial<IssueContext> = {}): IssueContext {
  return {
    repo: "org/repo",
    issueNumber: 42,
    issueTitle: "Re-approved remaining scope",
    issueBody: "",
    issueLabels: ["top-priority"],
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

/** A timeline JSON body with one `labeled` event for `label`. */
function timelineWith(
  events: Array<{ label: string; actor: string; at: string }>,
): string {
  return JSON.stringify(
    events.map((e) => ({
      event: "labeled",
      label: { name: e.label },
      actor: { login: e.actor },
      created_at: e.at,
    })),
  );
}

/**
 * Model `gh pr view --json <fields>`: the response object carries the
 * requested fields and nothing else. An unrecognised field is simply absent,
 * exactly as a caller that never asked for it would see.
 */
function projectJsonFields(
  args: string[],
  view: Record<string, unknown>,
): Record<string, unknown> {
  const jsonIndex = args.indexOf("--json");
  if (jsonIndex === -1) return {};
  const fields = (args[jsonIndex + 1] ?? "").split(",").map((f) => f.trim());
  const projected: Record<string, unknown> = {};
  for (const field of fields) {
    if (field in view) projected[field] = view[field];
  }
  return projected;
}

/**
 * Build a gh double answering PR view, the timeline, and issue lifecycle.
 *
 * `pr view` models gh's own rule: the answer carries exactly the fields
 * `--json` asked for. A pre-check that never requests `mergedAt` therefore
 * cannot see one, and the decision tests below go red on their own.
 */
function makeGh(handlers: {
  prView?: (prNumber: number) => Record<string, unknown>;
  /** Answers one timeline page; `page` is the 1-based page requested. */
  timeline?: (page: number) => string;
  timelineThrows?: boolean;
}): {
  runGhCommand: (args: string[]) => Promise<string>;
  calls: string[][];
} {
  const calls: string[][] = [];
  const runGhCommand = (args: string[]): Promise<string> => {
    calls.push([...args]);
    const landing = answerLandingCalls(args);
    if (landing !== null) return Promise.resolve(landing);
    if (args[0] === "pr" && args[1] === "view") {
      const view = handlers.prView
        ? handlers.prView(parseInt(args[2]!, 10))
        : MERGED_PR_WITH_TIME;
      return Promise.resolve(JSON.stringify(projectJsonFields(args, view)));
    }
    if (args[0] === "api" && String(args[1]).includes("/timeline")) {
      if (handlers.timelineThrows) {
        return Promise.reject(new Error("timeline API unavailable"));
      }
      const pageMatch = String(args[1]).match(/[?&]page=(\d+)/);
      const page = pageMatch ? parseInt(pageMatch[1]!, 10) : 1;
      return Promise.resolve(
        handlers.timeline ? handlers.timeline(page) : "[]",
      );
    }
    if (args[0] === "issue" && args[1] === "view") {
      return Promise.resolve(
        JSON.stringify({ state: "OPEN", milestone: null }),
      );
    }
    return Promise.resolve("");
  };
  return { runGhCommand, calls };
}

function makeDeps(
  gh: { runGhCommand: (args: string[]) => Promise<string> },
  warnings: Array<{ message: string; context?: Record<string, unknown> }>,
) {
  return createMockDeps({
    logger: {
      info: () => {},
      warn: (message: string, context?: Record<string, unknown>) =>
        warnings.push({ message, context }),
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
      findExistingPrForIssue: () =>
        Promise.resolve({
          ok: true,
          value: "https://github.com/org/repo/pull/27",
        }),
    },
  });
}

function closeAttempted(calls: string[][]): boolean {
  return calls.some((a) => a[0] === "issue" && a[1] === "close");
}

// ---------------------------------------------------------------------------
// The skip — a trusted approval that post-dates the merge
// ---------------------------------------------------------------------------

Deno.test(
  "merged-pr-precheck - does not close when a trusted top-priority add post-dates the merge",
  async () => {
    const warnings: Array<
      { message: string; context?: Record<string, unknown> }
    > = [];
    const gh = makeGh({
      timeline: () =>
        timelineWith([
          { label: "top-priority", actor: "trusted-human", at: AFTER_MERGE },
        ]),
    });

    const result = await workOnIssueMergedPrPrecheck(
      makeContext(),
      makeState(),
      makeDeps(gh, warnings),
    );

    assertEquals(result, { status: "continue" });
    assertEquals(closeAttempted(gh.calls), false);

    const warned = warnings.find((w) =>
      w.message.includes("NOT closing — approval post-dates merge")
    );
    assertEquals(warned !== undefined, true);
    assertEquals(warned?.context?.issueNumber, 42);
    assertEquals(warned?.context?.prNumber, 27);
    assertEquals(warned?.context?.label, "top-priority");
    assertEquals(warned?.context?.addedBy, "trusted-human");
    assertEquals(
      warned?.context?.addedAt,
      Math.floor(Date.parse(AFTER_MERGE) / 1000),
    );
    assertEquals(warned?.context?.mergedAt, MERGED_AT);
  },
);

Deno.test(
  "merged-pr-precheck - does not close when a trusted work-on add post-dates the merge",
  async () => {
    const warnings: Array<
      { message: string; context?: Record<string, unknown> }
    > = [];
    const gh = makeGh({
      timeline: () =>
        timelineWith([
          { label: "work-on", actor: "trusted-human", at: AFTER_MERGE },
        ]),
    });

    const result = await workOnIssueMergedPrPrecheck(
      makeContext({ issueLabels: ["work-on"] }),
      makeState(),
      makeDeps(gh, warnings),
    );

    assertEquals(result, { status: "continue" });
    assertEquals(closeAttempted(gh.calls), false);
    assertEquals(
      warnings.some((w) => (w.context?.label as string) === "work-on"),
      true,
    );
  },
);

// ---------------------------------------------------------------------------
// The unchanged close — everything that is not a fresh trusted approval
// ---------------------------------------------------------------------------

Deno.test(
  "merged-pr-precheck - closes as before when the trusted add pre-dates the merge",
  async () => {
    const warnings: Array<
      { message: string; context?: Record<string, unknown> }
    > = [];
    const gh = makeGh({
      timeline: () =>
        timelineWith([
          { label: "top-priority", actor: "trusted-human", at: BEFORE_MERGE },
        ]),
    });

    const result = await workOnIssueMergedPrPrecheck(
      makeContext(),
      makeState(),
      makeDeps(gh, warnings),
    );

    assertEquals(result, {
      status: "early_exit",
      reason: MERGED_PR_PRECHECK_EARLY_EXIT_REASON,
    });
    assertEquals(closeAttempted(gh.calls), true);
  },
);

Deno.test(
  "merged-pr-precheck - closes as before when an untrusted login added the label",
  async () => {
    const warnings: Array<
      { message: string; context?: Record<string, unknown> }
    > = [];
    const gh = makeGh({
      timeline: () =>
        timelineWith([
          { label: "top-priority", actor: "random-drive-by", at: AFTER_MERGE },
        ]),
    });

    const result = await workOnIssueMergedPrPrecheck(
      makeContext(),
      makeState(),
      makeDeps(gh, warnings),
    );

    assertEquals(result.status, "early_exit");
    assertEquals(closeAttempted(gh.calls), true);
  },
);

Deno.test(
  "merged-pr-precheck - closes as before when a fleet login added the label",
  async () => {
    const warnings: Array<
      { message: string; context?: Record<string, unknown> }
    > = [];
    // A fleet service account that is also trusted is still fleet maintenance,
    // never a human's re-approval.
    const ctx = makeContext({
      config: makeConfig({
        allowedAuthors: ["trusted-human", "fleet-service"],
      }),
    });
    const gh = makeGh({
      timeline: () =>
        timelineWith([
          { label: "top-priority", actor: "fleet-service", at: AFTER_MERGE },
        ]),
    });

    const result = await workOnIssueMergedPrPrecheck(
      ctx,
      makeState(),
      makeDeps(gh, warnings),
    );

    assertEquals(result.status, "early_exit");
    assertEquals(closeAttempted(gh.calls), true);
  },
);

Deno.test(
  "merged-pr-precheck - closes as before when the label is no longer on the issue",
  async () => {
    const warnings: Array<
      { message: string; context?: Record<string, unknown> }
    > = [];
    const gh = makeGh({
      timeline: () =>
        timelineWith([
          { label: "top-priority", actor: "trusted-human", at: AFTER_MERGE },
        ]),
    });

    const result = await workOnIssueMergedPrPrecheck(
      // The historical add is real, but the label has since been removed.
      makeContext({ issueLabels: ["bug"] }),
      makeState(),
      makeDeps(gh, warnings),
    );

    assertEquals(result.status, "early_exit");
    assertEquals(closeAttempted(gh.calls), true);
    // No timeline read at all when no approval label is present.
    assertEquals(
      gh.calls.some((a) =>
        a[0] === "api" && String(a[1]).includes("/timeline")
      ),
      false,
    );
  },
);

// ---------------------------------------------------------------------------
// Unverifiable approval time — keep today's behaviour, say so
// ---------------------------------------------------------------------------

Deno.test(
  "merged-pr-precheck - a timeline lookup error warns and still closes",
  async () => {
    const warnings: Array<
      { message: string; context?: Record<string, unknown> }
    > = [];
    const gh = makeGh({ timelineThrows: true });

    const result = await workOnIssueMergedPrPrecheck(
      makeContext(),
      makeState(),
      makeDeps(gh, warnings),
    );

    assertEquals(result.status, "early_exit");
    assertEquals(closeAttempted(gh.calls), true);
    const warned = warnings.find((w) =>
      w.message.includes("approval-time lookup")
    );
    assertEquals(warned !== undefined, true);
  },
);

Deno.test(
  "merged-pr-precheck - a missing mergedAt warns and still closes",
  async () => {
    const warnings: Array<
      { message: string; context?: Record<string, unknown> }
    > = [];
    const gh = makeGh({
      // A PR view with no merge time at all — the field is absent from the
      // upstream answer, not merely unrequested.
      prView: () => ({
        state: "MERGED",
        mergeCommit: { oid: "abc123" },
        baseRefName: "Develop",
        headRefName: "issue-42-already-merged-work",
      }),
      timeline: () =>
        timelineWith([
          { label: "top-priority", actor: "trusted-human", at: AFTER_MERGE },
        ]),
    });

    const result = await workOnIssueMergedPrPrecheck(
      makeContext(),
      makeState(),
      makeDeps(gh, warnings),
    );

    assertEquals(result.status, "early_exit");
    assertEquals(closeAttempted(gh.calls), true);
    const warned = warnings.find((w) => w.message.includes("merge time"));
    assertEquals(warned !== undefined, true);
    assertStringIncludes(warned!.message, "merge time");
  },
);

Deno.test(
  "merged-pr-precheck - an unparseable mergedAt warns and still closes",
  async () => {
    const warnings: Array<
      { message: string; context?: Record<string, unknown> }
    > = [];
    const gh = makeGh({
      prView: () => ({ ...MERGED_PR_WITH_TIME, mergedAt: "last Tuesday" }),
      timeline: () =>
        timelineWith([
          { label: "top-priority", actor: "trusted-human", at: AFTER_MERGE },
        ]),
    });

    const result = await workOnIssueMergedPrPrecheck(
      makeContext(),
      makeState(),
      makeDeps(gh, warnings),
    );

    assertEquals(result.status, "early_exit");
    assertEquals(closeAttempted(gh.calls), true);
    const warned = warnings.find((w) => w.message.includes("merge time"));
    assertEquals(warned?.context?.mergedAt, "last Tuesday");
  },
);

// ---------------------------------------------------------------------------
// A busy issue — the approval is the newest event, so page 1 is not enough
// ---------------------------------------------------------------------------

Deno.test(
  "merged-pr-precheck - an approval beyond timeline page 1 still skips the close",
  async () => {
    const warnings: Array<
      { message: string; context?: Record<string, unknown> }
    > = [];
    // A full first page (100 events) of unrelated label activity, with the
    // re-approval on page 2 — the #1562 shape, grilled to Ready over many
    // rounds. A page-1-only read cannot see it.
    const filler = Array.from({ length: 100 }, () => ({
      label: "documentation",
      actor: "trusted-human",
      at: BEFORE_MERGE,
    }));
    const gh = makeGh({
      timeline: (page) =>
        page === 1 ? timelineWith(filler) : timelineWith([
          { label: "top-priority", actor: "trusted-human", at: AFTER_MERGE },
        ]),
    });

    const result = await workOnIssueMergedPrPrecheck(
      makeContext(),
      makeState(),
      makeDeps(gh, warnings),
    );

    assertEquals(result, { status: "continue" });
    assertEquals(closeAttempted(gh.calls), false);
    assertEquals(
      warnings.some((w) =>
        w.message.includes("NOT closing — approval post-dates merge")
      ),
      true,
    );
  },
);

// ---------------------------------------------------------------------------
// Issue #1862 — the re-approval is recorded for the claim-release site
// ---------------------------------------------------------------------------

Deno.test(
  "merged-pr-precheck - records the re-approval and the merged PR on the phase state (Issue #1862)",
  async () => {
    const warnings: Array<
      { message: string; context?: Record<string, unknown> }
    > = [];
    const gh = makeGh({
      timeline: () =>
        timelineWith([
          { label: "work-on", actor: "trusted-human", at: AFTER_MERGE },
        ]),
    });
    const state = makeState();

    const result = await workOnIssueMergedPrPrecheck(
      makeContext({ issueLabels: ["work-on"] }),
      state,
      makeDeps(gh, warnings),
    );

    assertEquals(result, { status: "continue" });
    // Both halves of the loop the hand-off needs: which label a trusted human
    // re-applied, and which merged PR it post-dates.
    assertEquals(state.postMergeReapproval, {
      label: "work-on",
      addedBy: "trusted-human",
      addedAt: Math.floor(Date.parse(AFTER_MERGE) / 1000),
      prNumber: 27,
      mergedAt: MERGED_AT,
    });
  },
);

Deno.test(
  "merged-pr-precheck - records nothing when the trusted add pre-dates the merge (Issue #1862)",
  async () => {
    const warnings: Array<
      { message: string; context?: Record<string, unknown> }
    > = [];
    const gh = makeGh({
      timeline: () =>
        timelineWith([
          { label: "top-priority", actor: "trusted-human", at: BEFORE_MERGE },
        ]),
    });
    const state = makeState();

    await workOnIssueMergedPrPrecheck(
      makeContext(),
      state,
      makeDeps(gh, warnings),
    );

    assertEquals(state.postMergeReapproval, undefined);
  },
);
