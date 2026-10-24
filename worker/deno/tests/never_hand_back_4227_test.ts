/**
 * An approved issue is never handed back (Issue #4227).
 *
 * A run on an approved (`work-on`) issue that ends with no PR used to be
 * handed to a human as "analysis-only": `needs-human` was added and
 * `work-on`/`top-priority` were removed. GRQ-AutoTrader#3853 on 2026-10-23 is
 * the example: a clean run said the last criterion "can't be done on this
 * branch", and the issue waited for a person. The owner's rule (2026-10-24) is
 * that an approved issue that cannot be completed is a Vibe Coder bug. These
 * tests drive the real phases and assert both directions: an approved issue is
 * retried and never labelled, and an issue its author declared analysis-only
 * still gets the analysis hand-off.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { workOnIssueHandleNoChanges } from "../lib/phases/handle_no_changes_phase.ts";
import { workOnIssueDeclaredHandoff } from "../lib/phases/declared_handoff_phase.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { detectFailureCategory } from "../lib/failure_diagnosis.ts";
import { UNFINISHED_RETRY_HEADING } from "../lib/unfinished_issue_retry.ts";
import { ANALYSIS_ONLY_MARKER } from "../lib/analysis_only_handoff.ts";
import type {
  IssueContext,
  PhaseResult,
  PhaseState,
} from "../lib/issue_worker_types.ts";
import type { GitHubClient } from "../types.ts";

/** The clean run's own words on GRQ-AutoTrader#3853, 2026-10-23. */
const GRQ_3853_OUTPUT =
  "I made no code change for #3853. The one outstanding item can't be done " +
  "on this branch. The feed-status and quote-time work is already in. PR " +
  "#3995 added the scenario tests in crates/app/tests/attempt_evidence.rs.";

/** A planning marker with no usable reason — a hand-off the worker cannot honour. */
const UNHONOURABLE_PLANNING = "Work committed.\n\n<!-- vibe-needs-planning -->";

interface Calls {
  addLabel: string[];
  removeLabel: string[];
  postComment: string[];
}

function makeClient(calls: Calls): GitHubClient {
  return {
    getIssue: () => Promise.reject(new Error("stub: getIssue")),
    getIssueComments: () => Promise.resolve([]),
    addLabel: (_r, _n, label) => {
      calls.addLabel.push(label);
      return Promise.resolve();
    },
    removeLabel: (_r, _n, label) => {
      calls.removeLabel.push(label);
      return Promise.resolve();
    },
    postComment: (_r, _n, body) => {
      calls.postComment.push(body);
      return Promise.resolve(undefined);
    },
    editIssue: () => Promise.resolve(),
    assignIssue: () => Promise.resolve(),
    unassignIssue: () => Promise.resolve(),
    closeIssue: () => Promise.resolve(),
  } as GitHubClient;
}

function makeContext(overrides?: Partial<IssueContext>): IssueContext {
  return {
    repo: "org/repo",
    issueNumber: 3853,
    issueTitle: "Execution evidence: complete quote-quality assertions",
    issueBody: "- [ ] Assert the stale-quote hold on the engine path.",
    issueLabels: ["work-on", "top-priority"],
    issueComments: "",
    githubUser: "testbot",
    config: buildDefaultWorkerConfig(),
    ...overrides,
  };
}

function makeState(claudeOutput: string): PhaseState {
  return {
    branchName: "issue-3853-execution-evidence",
    baseBranch: "main",
    defaultBranch: "main",
    repoPath: "/tmp/test-repo",
    clarityStatus: "assessed_clear",
    claudeOutput,
    executeStartTime: Date.now(),
    baselineQualityPassed: true,
    baselineQualityOutput: "",
  };
}

/** The approved-issue invariant: retried, never handed to a human. */
function assertRetriedNotHandedBack(
  result: PhaseResult,
  calls: Calls,
  needsHumanLabel: string,
): void {
  assertEquals(result.status, "failure");
  if (result.status !== "failure") return;
  assertEquals(result.category, "no_changes");
  assertEquals(detectFailureCategory(result.reason), "no_changes");
  assert(
    !calls.addLabel.includes(needsHumanLabel),
    "an approved issue must never get needs-human",
  );
  assert(
    !calls.removeLabel.includes("work-on") &&
      !calls.removeLabel.includes("top-priority"),
    "the approval and its tier stay on the issue",
  );
  assert(
    !calls.postComment.some((c) => c.includes("Analysis-only issue")),
    "no analysis-only hand-off comment",
  );
  const retry = calls.postComment.filter((c) =>
    c.startsWith(UNFINISHED_RETRY_HEADING)
  );
  assertEquals(retry.length, 1, "one not-finished comment for the next run");
}

Deno.test("#4227 - a clean no-change run on an approved issue is retried, not handed to a human", async () => {
  const calls: Calls = { addLabel: [], removeLabel: [], postComment: [] };
  const ctx = makeContext();
  const deps = createMockDeps({
    github: { createClient: () => makeClient(calls) },
  });

  const result = await workOnIssueHandleNoChanges(
    ctx,
    makeState(GRQ_3853_OUTPUT),
    deps,
  );

  assertRetriedNotHandedBack(result, calls, ctx.config.needsHumanLabel);
  // The next run sees what this one said.
  assertStringIncludes(calls.postComment.at(-1)!, "can't be done");
});

Deno.test("#4227 - an unhonourable declared hand-off on committed work is retried, not handed to a human", async () => {
  const calls: Calls = { addLabel: [], removeLabel: [], postComment: [] };
  // No `planning` anchor label, so the planning request cannot be honoured.
  const ctx = makeContext({ issueLabels: ["top-priority"] });
  const deps = createMockDeps({
    github: { createClient: () => makeClient(calls) },
  });

  const result = await workOnIssueDeclaredHandoff(
    ctx,
    makeState(UNHONOURABLE_PLANNING),
    deps,
  );

  assertRetriedNotHandedBack(result, calls, ctx.config.needsHumanLabel);
  assert(!calls.addLabel.includes("planning"));
});

Deno.test("#4227 - an issue its author declared analysis-only still gets the analysis hand-off", async () => {
  // The other direction: the owner asked for analysis, not a PR, so the
  // analysis is the deliverable and a human reads it.
  const calls: Calls = { addLabel: [], removeLabel: [], postComment: [] };
  const ctx = makeContext({
    issueBody: `${ANALYSIS_ONLY_MARKER}\nWhy did fills drop last week?`,
  });
  const deps = createMockDeps({
    github: { createClient: () => makeClient(calls) },
  });

  const result = await workOnIssueHandleNoChanges(
    ctx,
    makeState(
      "A".repeat(200) + " The fills dropped because the feed was stale.",
    ),
    deps,
  );

  assertEquals(result.status, "early_exit");
  if (result.status !== "early_exit") return;
  assertEquals(result.reason, "analysis_only_handed_off");
  assert(calls.addLabel.includes(ctx.config.needsHumanLabel));
});
