/**
 * Phase tests for the `work-on` → `planning` hand-off (Issue #2688).
 *
 * An oversized `work-on` epic must move to `planning` without a human; a
 * repeat request, a blocked run, a non-`work-on` pickup tier or an untrusted
 * image in front of the agent must not.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals } from "@std/assert";
import { workOnIssueHandleNoChanges } from "../lib/phases/handle_no_changes_phase.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import type { GitHubClient, GitHubComment } from "../types.ts";
import { buildPlanningHandoffMarker } from "../lib/planning_handoff.ts";
import { findImageReferences } from "../lib/untrusted_image_signal.ts";

/** A minimal `GitHubComment`, for feeding `getIssueComments` stubs. */
function comment(id: number, author: string, body: string): GitHubComment {
  return {
    id,
    author,
    body,
    createdAt: "",
    reactions: { thumbsUp: 0, eyes: 0, confused: 0 },
  };
}

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

function makeClient(
  calls: StubCalls,
  comments: GitHubComment[] = [],
): GitHubClient {
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
    getIssueComments: () => Promise.resolve(comments),
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
  const priorComment = comment(
    1,
    "testbot",
    `earlier\n${buildPlanningHandoffMarker()}`,
  );
  const deps = createMockDeps({
    github: { createClient: () => makeClient(calls, [priorComment]) },
  });

  const result = await workOnIssueHandleNoChanges(
    makeContext(),
    makeState(PLANNING_OUTPUT),
    deps,
  );

  assertEquals(result.status, "early_exit");
  if (result.status !== "early_exit") return;
  assertEquals(result.reason, "analysis_only_handed_off");
  assert(!calls.addLabel.includes("planning"));
  assert(calls.addLabel.includes("needs-human"));
});

Deno.test(
  "handle_no_changes_phase - Issue #2942: a prior hand-off dropped by the " +
    "prompt budget is still found on the full thread",
  async () => {
    // Thread: one worker hand-off comment amid a flood of human traffic that
    // would blow the implementation prompt's comment budget and drop the
    // marker from the blob the phase used to check.
    const priorComment = comment(
      1,
      "testbot",
      `## Handed off to planning\n\n…\n\n${buildPlanningHandoffMarker()}`,
    );
    const humanComments: string[] = [];
    for (let i = 0; i < 25; i++) {
      humanComments.push(`Just checking in, #${i}`);
    }
    const thread = [
      priorComment,
      ...humanComments.map((b, i) => comment(100 + i, "human", b)),
    ];
    // The budgeted blob the prompt saw never carried the marker.
    const budgetedComments = humanComments.join("\n");

    const calls = makeCalls();
    const deps = createMockDeps({
      github: { createClient: () => makeClient(calls, thread) },
    });

    const result = await workOnIssueHandleNoChanges(
      makeContext({ issueComments: budgetedComments }),
      makeState(PLANNING_OUTPUT),
      deps,
    );

    assertEquals(result.status, "early_exit");
    if (result.status !== "early_exit") return;
    assertEquals(result.reason, "analysis_only_handed_off");
    assert(!calls.addLabel.includes("planning"));
    assert(calls.addLabel.includes("needs-human"));
  },
);

Deno.test(
  "handle_no_changes_phase - a prior hand-off hidden by a failed thread " +
    "read falls back to the budgeted comments",
  async () => {
    const calls = makeCalls();
    const deps = createMockDeps({
      github: {
        createClient: () => {
          const client = makeClient(calls);
          return {
            ...client,
            getIssueComments: () => Promise.reject(new Error("boom")),
          };
        },
      },
    });

    const result = await workOnIssueHandleNoChanges(
      makeContext({
        issueComments: `earlier\n${buildPlanningHandoffMarker()}`,
      }),
      makeState(PLANNING_OUTPUT),
      deps,
    );

    assertEquals(result.status, "early_exit");
    if (result.status !== "early_exit") return;
    assertEquals(result.reason, "analysis_only_handed_off");
    assert(!calls.addLabel.includes("planning"));
    assert(calls.addLabel.includes("needs-human"));
  },
);

Deno.test(
  "handle_no_changes_phase - a failed thread read with an empty fallback " +
    "blob still hands off to planning",
  async () => {
    const calls = makeCalls();
    const deps = createMockDeps({
      github: {
        createClient: () => {
          const client = makeClient(calls);
          return {
            ...client,
            getIssueComments: () => Promise.reject(new Error("boom")),
          };
        },
      },
    });

    const result = await workOnIssueHandleNoChanges(
      makeContext({ issueComments: "" }),
      makeState(PLANNING_OUTPUT),
      deps,
    );

    assertEquals(result.status, "early_exit");
    if (result.status !== "early_exit") return;
    assertEquals(result.reason, "handed off to planning");
    assertEquals(calls.addLabel, ["planning"]);
  },
);

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

Deno.test("handle_no_changes_phase - an untrusted image withholds the planning hand-off", async () => {
  const calls = makeCalls();
  const deps = createMockDeps({
    github: { createClient: () => makeClient(calls) },
  });

  const result = await workOnIssueHandleNoChanges(
    makeContext({
      untrustedImages: findImageReferences("![a](https://evil.test/a.png)"),
    }),
    makeState(PLANNING_OUTPUT),
    deps,
  );

  assertEquals(result.status, "early_exit");
  if (result.status !== "early_exit") return;
  assertEquals(result.reason, "analysis_only_handed_off");
  assert(!calls.addLabel.includes("planning"));
  assert(calls.addLabel.includes("needs-human"));
});

Deno.test("handle_no_changes_phase - a non-work-on pickup tier is not handed to planning", async () => {
  const calls = makeCalls();
  const deps = createMockDeps({
    github: { createClient: () => makeClient(calls) },
  });

  const result = await workOnIssueHandleNoChanges(
    makeContext({ issueLabels: ["top-priority"] }),
    makeState(PLANNING_OUTPUT),
    deps,
  );

  assertEquals(result.status, "early_exit");
  if (result.status !== "early_exit") return;
  assertEquals(result.reason, "analysis_only_handed_off");
  assert(!calls.addLabel.includes("planning"));
  assert(calls.addLabel.includes("needs-human"));
});
