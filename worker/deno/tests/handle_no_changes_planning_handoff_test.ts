/**
 * Phase tests for the `work-on` → `planning` hand-off (Issue #2688).
 *
 * An oversized `work-on` epic must move to `planning` without a human; a
 * repeat request or a blocked run must not.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals } from "@std/assert";
import { workOnIssueHandleNoChanges } from "../lib/phases/handle_no_changes_phase.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import type { GitHubClient } from "../types.ts";
import { buildPlanningHandoffMarker } from "../lib/planning_handoff.ts";

const REPO = "stSoftwareAU/Example";
const ISSUE = 2688;

const PLANNING_OUTPUT = `## Too large for one PR

This epic spans the scheduler, the dashboard and the telemetry store; each
part is an independent PR.

<!-- vibe-needs-planning reason="three independent subsystems, one PR each" -->
`;

interface StubCalls {
  addLabel: string[];
  postComment: string[];
  unassignIssue: number;
  closeIssue: number;
}

function makeCalls(): StubCalls {
  return { addLabel: [], postComment: [], unassignIssue: 0, closeIssue: 0 };
}

function makeClient(calls: StubCalls): GitHubClient {
  return {
    getIssue: () =>
      Promise.resolve({
        number: ISSUE,
        title: "Epic",
        body: "",
        labels: ["work-on"],
        author: "human",
        assignees: ["testbot"],
        createdAt: "",
        updatedAt: "",
      }),
    getIssueComments: () => Promise.resolve([]),
    addLabel: (_r, _i, label) => {
      calls.addLabel.push(label);
      return Promise.resolve();
    },
    removeLabel: () => Promise.resolve(),
    postComment: (_r, _i, b) => {
      calls.postComment.push(b);
      return Promise.resolve(undefined);
    },
    editIssue: () => Promise.resolve(),
    assignIssue: () => Promise.resolve(),
    unassignIssue: () => {
      calls.unassignIssue++;
      return Promise.resolve();
    },
    closeIssue: () => {
      calls.closeIssue++;
      return Promise.resolve();
    },
  };
}

function makeContext(overrides?: Partial<IssueContext>): IssueContext {
  return {
    repo: REPO,
    issueNumber: ISSUE,
    issueTitle: "Epic",
    issueBody: "Rebuild the scheduler, dashboard and telemetry store.",
    issueLabels: ["work-on"],
    issueComments: "",
    githubUser: "testbot",
    config: buildDefaultWorkerConfig(),
    ...overrides,
  };
}

function makeState(claudeOutput: string): PhaseState {
  return {
    branchName: "issue-2688-epic",
    baseBranch: "main",
    defaultBranch: "main",
    repoPath: "/tmp/test-repo",
    clarityStatus: "not_assessed",
    claudeOutput,
    executeStartTime: 0,
    baselineQualityPassed: true,
    baselineQualityOutput: "",
  };
}

Deno.test("handle_no_changes_phase - an oversized issue is handed off to planning", async () => {
  const calls = makeCalls();
  const deps = createMockDeps({
    github: { createClient: () => makeClient(calls) },
  });

  const result = await workOnIssueHandleNoChanges(
    makeContext(),
    makeState(PLANNING_OUTPUT),
    deps,
  );

  assertEquals(result.status, "early_exit");
  if (result.status !== "early_exit") return;
  assertEquals(result.reason, "handed off to planning");
  assertEquals(result.expectedSkip, true);
  assertEquals(calls.addLabel, ["planning"]);
  assert(!calls.addLabel.includes("needs-human"));
  assert(
    calls.postComment.some((c) => c.includes(buildPlanningHandoffMarker())),
  );
  assertEquals(calls.unassignIssue, 1);
  assertEquals(calls.closeIssue, 0);
});

Deno.test("handle_no_changes_phase - a repeat planning request goes to a human", async () => {
  const calls = makeCalls();
  const deps = createMockDeps({
    github: { createClient: () => makeClient(calls) },
  });

  const result = await workOnIssueHandleNoChanges(
    makeContext({ issueComments: `earlier\n${buildPlanningHandoffMarker()}` }),
    makeState(PLANNING_OUTPUT),
    deps,
  );

  assertEquals(result.status, "early_exit");
  if (result.status !== "early_exit") return;
  assertEquals(result.reason, "analysis_only_handed_off");
  assert(!calls.addLabel.includes("planning"));
  assert(calls.addLabel.includes("needs-human"));
});

Deno.test("handle_no_changes_phase - a blocked run defers rather than planning", async () => {
  const calls = makeCalls();
  const deps = createMockDeps({
    github: { createClient: () => makeClient(calls) },
  });

  const result = await workOnIssueHandleNoChanges(
    makeContext(),
    makeState(
      `## Blocked: waiting on the API\n\nDepends on stSoftwareAU/Other#12\n\n` +
        `<!-- vibe-needs-planning reason="too big" -->`,
    ),
    deps,
  );

  assertEquals(result.status, "early_exit");
  if (result.status !== "early_exit") return;
  assert(result.reason.startsWith("deferred: depends on"), result.reason);
  assert(!calls.addLabel.includes("planning"));
});
