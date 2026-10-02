/**
 * Phase tests for the declared-handoff phase (Issue #3088).
 *
 * `work-on` can commit code AND, in the same final message, declare a
 * `## Blocked:` dependency, a `vibe-defer-until` time deferral or a
 * `<!-- vibe-needs-planning -->` planning request. Those signals must be
 * caught on a commit-producing run too, not only on a no-changes run — a
 * blocked/deferred/planning-requested run that also committed code must
 * never be allowed through to `bump_deps` → `quality_gate` → `completion`,
 * which would raise a `Closes #N` PR that closes the very issue the agent
 * asked to defer or hand off.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals } from "@std/assert";
import { workOnIssueDeclaredHandoff } from "../lib/phases/declared_handoff_phase.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import type { GitHubClient, GitHubComment } from "../types.ts";
import { buildDeferralMarker } from "../lib/blocked_deferral.ts";
import { buildPlanningHandoffMarker } from "../lib/planning_handoff.ts";

const REPO = "stSoftwareAU/Example";
const ISSUE = 3088;
const DEP = "stSoftwareAU/Other#12";

const BLOCKED_OUTPUT = `## Blocked: waiting on the API

The schema change landed in the API repo but is not released yet.

Depends on ${DEP}
`;

const PLANNING_OUTPUT = `## Too large for one PR

This epic spans the scheduler, the dashboard and the telemetry store; each
part is an independent PR.

<!-- vibe-needs-planning reason="three independent subsystems, one PR each" -->
`;

const PLAIN_OUTPUT = `## Summary

Implemented the requested change and added tests.
`;

interface StubCalls {
  addLabel: string[];
  removeLabel: string[];
  postComment: string[];
  editIssue: number;
  closeIssue: number;
  unassignIssue: number;
}

function makeCalls(): StubCalls {
  return {
    addLabel: [],
    removeLabel: [],
    postComment: [],
    editIssue: 0,
    closeIssue: 0,
    unassignIssue: 0,
  };
}

function comment(id: number, author: string, body: string): GitHubComment {
  return {
    id,
    author,
    body,
    createdAt: "",
    reactions: { thumbsUp: 0, eyes: 0, confused: 0 },
  };
}

function makeClient(
  calls: StubCalls,
  comments: GitHubComment[] = [],
): GitHubClient {
  return {
    getIssue: () =>
      Promise.resolve({
        number: ISSUE,
        title: "Example issue",
        body: "Original body.",
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
    removeLabel: (_r, _i, label) => {
      calls.removeLabel.push(label);
      return Promise.resolve();
    },
    postComment: (_r, _i, b) => {
      calls.postComment.push(b);
      return Promise.resolve(undefined);
    },
    editIssue: () => {
      calls.editIssue++;
      return Promise.resolve();
    },
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
    issueTitle: "Example issue",
    issueBody: "Do the thing.",
    issueLabels: ["work-on"],
    issueComments: "",
    githubUser: "testbot",
    config: buildDefaultWorkerConfig(),
    ...overrides,
  };
}

function makeState(claudeOutput: string): PhaseState {
  return {
    branchName: "issue-3088-declared-handoff",
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

// (a) A blocked output, with commits already made, must still defer rather
// than proceeding to completion.
Deno.test(
  "declared_handoff_phase - blocked output defers (Issue #3088)",
  async () => {
    const calls = makeCalls();
    const deps = createMockDeps({
      github: { createClient: () => makeClient(calls) },
    });

    const result = await workOnIssueDeclaredHandoff(
      makeContext(),
      makeState(BLOCKED_OUTPUT),
      deps,
    );

    assertEquals(result.status, "early_exit");
    if (result.status !== "early_exit") return;
    assert(result.reason.startsWith("deferred: depends on"), result.reason);
    assertEquals(calls.closeIssue, 0);
    assert(calls.postComment.some((c) => c.includes(buildDeferralMarker(DEP))));
  },
);

// (b) A planning marker with the anchor label present must hand off to
// planning.
Deno.test(
  "declared_handoff_phase - planning marker with anchor hands off to planning (Issue #3088)",
  async () => {
    const calls = makeCalls();
    const deps = createMockDeps({
      github: { createClient: () => makeClient(calls) },
    });

    const result = await workOnIssueDeclaredHandoff(
      makeContext({ issueLabels: ["work-on"] }),
      makeState(PLANNING_OUTPUT),
      deps,
    );

    assertEquals(result.status, "early_exit");
    if (result.status !== "early_exit") return;
    assertEquals(result.reason, "handed off to planning");
    assertEquals(calls.addLabel, ["planning"]);
    assert(
      calls.postComment.some((c) => c.includes(buildPlanningHandoffMarker())),
    );
  },
);

// (c) A planning marker WITHOUT the anchor label must hand off to a human,
// not apply `planning` itself.
Deno.test(
  "declared_handoff_phase - planning marker without anchor hands off to a human (Issue #3088)",
  async () => {
    const calls = makeCalls();
    const deps = createMockDeps({
      github: { createClient: () => makeClient(calls) },
    });

    const result = await workOnIssueDeclaredHandoff(
      makeContext({ issueLabels: ["top-priority"] }),
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

// (d) Plain summary output (no declared hand-off signal) must continue, with
// no GitHub writes at all.
Deno.test(
  "declared_handoff_phase - plain summary output continues without any writes (Issue #3088)",
  async () => {
    const calls = makeCalls();
    const deps = createMockDeps({
      github: { createClient: () => makeClient(calls) },
    });

    const result = await workOnIssueDeclaredHandoff(
      makeContext(),
      makeState(PLAIN_OUTPUT),
      deps,
    );

    assertEquals(result.status, "continue");
    assertEquals(calls.addLabel, []);
    assertEquals(calls.postComment, []);
    assertEquals(calls.editIssue, 0);
    assertEquals(calls.closeIssue, 0);
    assertEquals(calls.unassignIssue, 0);
  },
);

// (e) A blocked output repeated on a thread that already carries a prior
// deferral for the same dependency must hand off to a human, not defer
// again.
Deno.test(
  "declared_handoff_phase - a repeat blocked deferral hands off to a human (Issue #3088)",
  async () => {
    const calls = makeCalls();
    const priorComment = comment(
      1,
      "testbot",
      `## Deferred — blocked on ${DEP}\n\n…\n\n${buildDeferralMarker(DEP)}`,
    );
    const deps = createMockDeps({
      github: { createClient: () => makeClient(calls, [priorComment]) },
    });

    const result = await workOnIssueDeclaredHandoff(
      makeContext(),
      makeState(BLOCKED_OUTPUT),
      deps,
    );

    assertEquals(result.status, "early_exit");
    if (result.status !== "early_exit") return;
    assertEquals(result.reason, "analysis_only_handed_off");
    assertEquals(calls.closeIssue, 0);
    assert(calls.addLabel.includes("needs-human"));
  },
);
