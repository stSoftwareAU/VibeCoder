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

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { classifyCodingFailure } from "../lib/coding_failure_ladder.ts";
import { deriveRunOutcome } from "../lib/run_outcome.ts";
import { callbackOutcomeFromRun } from "../lib/run_callback_context.ts";
import {
  detectFailureCategory,
  isInfrastructureFailure,
} from "../lib/failure_diagnosis.ts";
import { workOnIssueDeclaredHandoff } from "../lib/phases/declared_handoff_phase.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import type { GitHubClient, GitHubComment } from "../types.ts";
import { buildDeferralMarker } from "../lib/blocked_deferral.ts";
import { buildPlanningHandoffMarker } from "../lib/planning_handoff.ts";
import { UNFINISHED_RETRY_HEADING } from "../lib/unfinished_issue_retry.ts";
import { isWipCommitSubject } from "../lib/wip_commit_marker.ts";

const REPO = "stSoftwareAU/Example";

/** A deferral that stays in the future on whatever day the suite runs. */
const FUTURE_UNTIL = new Date(Date.now() + 2 * 86_400_000)
  .toISOString()
  .replace(/\.\d{3}Z$/, "Z");
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
  dependencyState: "OPEN" | "CLOSED" = "OPEN",
  lookup: "ok" | "throw" | "no-state" = "ok",
  dependencyAuthor = "human",
  dependencyCreatedAt = "",
): GitHubClient {
  return {
    getIssue: (_repo, number) => {
      if (lookup === "throw") {
        return Promise.reject(new Error("gh: not found"));
      }
      const dependency = number !== ISSUE;
      return Promise.resolve({
        number,
        title: "Example issue",
        body: "Original body.",
        labels: ["work-on"],
        author: dependency ? dependencyAuthor : "human",
        assignees: ["testbot"],
        createdAt: dependency ? dependencyCreatedAt : "",
        updatedAt: "",
        ...(lookup === "no-state"
          ? {}
          : { state: number === ISSUE ? "OPEN" : dependencyState }),
      });
    },
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
    assert(
      !calls.postComment.some((c) => c.includes("No code changes")),
      "a committed deferral must name the branch, not claim no code changed",
    );
    assert(
      calls.postComment.some((c) => c.includes("issue-3088-declared-handoff")),
    );
    assertEquals(result.outcome?.kind, "no_pr_expected");
    if (result.outcome?.kind === "no_pr_expected") {
      assertEquals(result.outcome.phase, "declared_handoff");
    }
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
    assert(
      calls.postComment.some((c) => c.includes("issue-3088-declared-handoff")),
    );
    assertEquals(result.outcome?.kind, "no_pr_expected");
    if (result.outcome?.kind === "no_pr_expected") {
      assertEquals(result.outcome.phase, "declared_handoff");
    }
  },
);

// (c) A planning marker WITHOUT the anchor label must not apply `planning`
// itself; the approved issue is retried (Issue #4227).
Deno.test(
  "declared_handoff_phase - planning marker without anchor retries, never a human (Issue #3088, #4227)",
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

    const retry = assertRetried(result, calls);
    assert(!calls.addLabel.includes("planning"));
    // The committed run's own reason, not the no-changes wording.
    assert(retry.includes("committed work"));
    assert(!retry.includes("made no code change"));
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
// deferral for the same dependency must not defer again; it is retried
// (Issue #4227).
Deno.test(
  "declared_handoff_phase - a repeat blocked deferral retries, never a human (Issue #3088, #4227)",
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

    const retry = assertRetried(result, calls);
    assert(retry.includes("committed work"));
    assert(!retry.includes("made no code change"));
  },
);

// A finished summary that mentions a merged dependency is not a block.
Deno.test(
  "declared_handoff_phase - a completed summary that mentions a merged dependency continues (Issue #3088)",
  async () => {
    const calls = makeCalls();
    const deps = createMockDeps({
      github: { createClient: () => makeClient(calls) },
    });
    const summary = [
      "- Depends on #560, which has now merged; this change builds on it.",
      "Blocked-run deferral (#222) is unchanged by this PR.",
    ].join("\n");

    const result = await workOnIssueDeclaredHandoff(
      makeContext(),
      makeState(summary),
      deps,
    );

    assertEquals(result.status, "continue");
    assertEquals(calls.postComment, []);
    assertEquals(calls.editIssue, 0);
  },
);

// A real heading with no declaration line must not fall back to the first
// issue number mentioned in the prose.
Deno.test(
  "declared_handoff_phase - a Blocked heading without a declaration line continues (Issue #3088)",
  async () => {
    const calls = makeCalls();
    const deps = createMockDeps({
      github: { createClient: () => makeClient(calls) },
    });

    const result = await workOnIssueDeclaredHandoff(
      makeContext(),
      makeState(
        "## Blocked: the stub landed with #560\n\nThis builds on it.\n",
      ),
      deps,
    );

    assertEquals(result.status, "continue");
    assertEquals(calls.postComment, []);
  },
);

// Depending on an issue this run filed is not a deferral, even when the
// output names the current issue before the follow-up. The committed run
// is retried (Issue #4227) and raises no PR.
Deno.test(
  "declared_handoff_phase - a dependency this run filed retries and raises no PR (Issue #3088, #4227)",
  async () => {
    const calls = makeCalls();
    const deps = createMockDeps({
      github: {
        createClient: () =>
          makeClient(
            calls,
            [],
            "OPEN",
            "ok",
            "testbot",
            "2026-10-03T11:00:00Z",
          ),
      },
    });
    const output = [
      "## Blocked: Issue #3088 needs a product decision",
      "",
      "Filed a follow-up issue #560 for the decision.",
      "",
      "Depends on #560",
    ].join("\n");

    const result = await workOnIssueDeclaredHandoff(
      makeContext(),
      makeState(output),
      deps,
    );

    assertRetried(result, calls);
    assertEquals(calls.editIssue, 0);
  },
);

// Follow-up wording around a dependency that already existed does not turn
// a real open block into a retry.
Deno.test(
  "declared_handoff_phase - an older open dependency still defers when the output says it is tracked separately (Issue #3088)",
  async () => {
    const calls = makeCalls();
    const deps = createMockDeps({
      github: {
        createClient: () =>
          makeClient(calls, [], "OPEN", "ok", "human", "2020-01-01T00:00:00Z"),
      },
    });
    const output = [
      "## Blocked: waiting on the API",
      "",
      "The endpoint work is tracked separately in stSoftwareAU/Other#12, which is still open.",
      "This is out of scope until that issue closes.",
      "",
      `Depends on ${DEP}`,
    ].join("\n");

    const result = await workOnIssueDeclaredHandoff(
      makeContext(),
      makeState(output),
      deps,
    );

    assertEquals(result.status, "early_exit");
    if (result.status !== "early_exit") return;
    assert(result.reason.startsWith("deferred: depends on"), result.reason);
    assertEquals(calls.editIssue, 1);
    assert(!calls.addLabel.includes("needs-human"));
  },
);

// A sibling fleet login that filed the dependency during this run is the
// same case as this host filing it.
Deno.test(
  "declared_handoff_phase - a dependency a fleet author filed during this run retries (Issue #3088, #4227)",
  async () => {
    const calls = makeCalls();
    const deps = createMockDeps({
      github: {
        createClient: () =>
          makeClient(
            calls,
            [],
            "OPEN",
            "ok",
            "sibling-bot",
            "2026-10-03T11:00:00Z",
          ),
      },
    });
    const config = buildDefaultWorkerConfig();
    config.fleetPrAuthors = ["sibling-bot"];

    const result = await workOnIssueDeclaredHandoff(
      makeContext({ config }),
      makeState(BLOCKED_OUTPUT),
      deps,
    );

    assertRetried(result, calls);
    assertEquals(calls.editIssue, 0);
  },
);

// A fleet-authored dependency that predates the run is a real block.
Deno.test(
  "declared_handoff_phase - a fleet-authored dependency created before this run still defers (Issue #3088)",
  async () => {
    const calls = makeCalls();
    const deps = createMockDeps({
      github: {
        createClient: () =>
          makeClient(
            calls,
            [],
            "OPEN",
            "ok",
            "testbot",
            "2020-01-01T00:00:00Z",
          ),
      },
    });
    const state = makeState(BLOCKED_OUTPUT);
    state.executeStartTime = Date.parse("2026-10-03T12:00:00Z");

    const result = await workOnIssueDeclaredHandoff(
      makeContext(),
      state,
      deps,
    );

    assertEquals(result.status, "early_exit");
    if (result.status !== "early_exit") return;
    assert(result.reason.startsWith("deferred: depends on"), result.reason);
    assert(!calls.addLabel.includes("needs-human"));
  },
);

// A later execute attempt must not move the start used for "filed during
// this run". A follow-up filed on attempt 1 is still this run's.
Deno.test(
  "declared_handoff_phase - a dependency filed before a later execute attempt still retries (Issue #3088, #4227)",
  async () => {
    const calls = makeCalls();
    const deps = createMockDeps({
      github: {
        createClient: () =>
          makeClient(
            calls,
            [],
            "OPEN",
            "ok",
            "testbot",
            "2026-10-03T11:00:00Z",
          ),
      },
    });
    const state = makeState(BLOCKED_OUTPUT);
    state.runStartTime = Date.parse("2026-10-03T10:00:00Z");
    state.executeStartTime = Date.parse("2026-10-03T12:00:00Z");

    const result = await workOnIssueDeclaredHandoff(
      makeContext(),
      state,
      deps,
    );

    assertRetried(result, calls);
    assertEquals(calls.editIssue, 0);
  },
);

// A documented block whose dependency has already closed does not defer.
// The committed run is retried (Issue #4227) and raises no PR.
Deno.test(
  "declared_handoff_phase - a closed dependency retries and raises no PR (Issue #3088, #4227)",
  async () => {
    const calls = makeCalls();
    const deps = createMockDeps({
      github: { createClient: () => makeClient(calls, [], "CLOSED") },
    });

    const result = await workOnIssueDeclaredHandoff(
      makeContext(),
      makeState(BLOCKED_OUTPUT),
      deps,
    );

    const retry = assertRetried(result, calls);
    assertEquals(calls.editIssue, 0);
    assert(retry.includes("committed work"));
  },
);

// A planning marker quoted in a fence is the template, not a request.
Deno.test(
  "declared_handoff_phase - a planning marker inside a code fence continues (Issue #3088)",
  async () => {
    const calls = makeCalls();
    const deps = createMockDeps({
      github: { createClient: () => makeClient(calls) },
    });
    const quoted = [
      "The prompt's template looks like this:",
      "```",
      '<!-- vibe-needs-planning reason="three independent subsystems" -->',
      "```",
      "",
      "Implemented the change.",
    ].join("\n");

    const result = await workOnIssueDeclaredHandoff(
      makeContext({ issueLabels: ["work-on"] }),
      makeState(quoted),
      deps,
    );

    assertEquals(result.status, "continue");
    assertEquals(calls.addLabel, []);
    assertEquals(calls.postComment, []);
  },
);

// An exhausted time deferral on a committed run states its own reason, not
// the no-changes wording, and is retried (Issue #4227).
Deno.test(
  "declared_handoff_phase - an exhausted time deferral retries with its own reason (Issue #3088, #4227)",
  async () => {
    const calls = makeCalls();
    const prior = [1, 2, 3].map((id) =>
      comment(
        id,
        "testbot",
        `<!-- vibe-time-deferral until="2026-09-0${id}T00:00:00Z" -->`,
      )
    );
    const deps = createMockDeps({
      github: { createClient: () => makeClient(calls, prior) },
    });
    const output =
      `<!-- vibe-defer-until until="${FUTURE_UNTIL}" reason="the export has not landed" -->`;

    const result = await workOnIssueDeclaredHandoff(
      makeContext(),
      makeState(output),
      deps,
    );

    const retry = assertRetried(result, calls);
    // The exhausted deferral's own reason, not the no-changes wording.
    assert(retry.includes("deferrals"));
    assert(!retry.includes("made no code change"));
  },
);

// A state that cannot be read, or that the payload omits, does not defer.
// The committed run is retried (Issue #4227) and raises no PR.
Deno.test(
  "declared_handoff_phase - a dependency lookup that fails retries and raises no PR (Issue #3088, #4227)",
  async () => {
    const calls = makeCalls();
    const deps = createMockDeps({
      github: { createClient: () => makeClient(calls, [], "OPEN", "throw") },
    });

    const result = await workOnIssueDeclaredHandoff(
      makeContext(),
      makeState(BLOCKED_OUTPUT),
      deps,
    );

    assertRetried(result, calls);
    assertEquals(calls.editIssue, 0);
  },
);

Deno.test(
  "declared_handoff_phase - a dependency with no state retries and raises no PR (Issue #3088, #4227)",
  async () => {
    const calls = makeCalls();
    const deps = createMockDeps({
      github: {
        createClient: () => makeClient(calls, [], "OPEN", "no-state"),
      },
    });

    const result = await workOnIssueDeclaredHandoff(
      makeContext(),
      makeState(BLOCKED_OUTPUT),
      deps,
    );

    assertRetried(result, calls);
    assertEquals(calls.editIssue, 0);
  },
);

// A quoted time-deferral marker is the template, not a request to park.
Deno.test(
  "declared_handoff_phase - a quoted time-deferral marker continues (Issue #3088)",
  async () => {
    const marker =
      `<!-- vibe-defer-until until="${FUTURE_UNTIL}" reason="the export has not landed" -->`;
    for (
      const output of [
        ["The summary quotes the marker:", "```", marker, "```", ""].join(
          "\n",
        ),
        `The template is \`${marker}\`.`,
      ]
    ) {
      const calls = makeCalls();
      const deps = createMockDeps({
        github: { createClient: () => makeClient(calls) },
      });
      const result = await workOnIssueDeclaredHandoff(
        makeContext(),
        makeState(output),
        deps,
      );
      assertEquals(result.status, "continue");
      assertEquals(calls.postComment, []);
      assertEquals(calls.addLabel, []);
    }
  },
);

/** A date past the 30-day horizon, computed so the suite never hard-codes one. */
const OVER_HORIZON_UNTIL = new Date(Date.now() + 31 * 86_400_000)
  .toISOString()
  .replace(/\.\d{3}Z$/, "Z");

/**
 * The approved-issue invariant (Issue #4227): a declared hand-off the worker
 * cannot honour raises no PR and closes nothing, and the issue is retried —
 * never `needs-human`, and the approval stays. Returns the one not-finished
 * comment.
 */
function assertRetried(
  result: Awaited<ReturnType<typeof workOnIssueDeclaredHandoff>>,
  calls: StubCalls,
): string {
  assertEquals(result.status, "failure");
  if (result.status !== "failure") return "";
  assertEquals(result.category, "no_changes");
  assert(
    !calls.addLabel.includes("needs-human"),
    "an approved issue must never get needs-human",
  );
  assert(
    !calls.removeLabel.includes("work-on") &&
      !calls.removeLabel.includes("top-priority"),
    "the approval and its tier stay on the issue",
  );
  assertEquals(calls.closeIssue, 0);
  const retry = calls.postComment.filter((c) =>
    c.startsWith(UNFINISHED_RETRY_HEADING)
  );
  assertEquals(retry.length, 1, "exactly one not-finished comment");
  return retry[0]!;
}

Deno.test(
  "declared_handoff_phase - an over-horizon defer marker retries, no PR (Issue #3088, #4227)",
  async () => {
    const calls = makeCalls();
    const deps = createMockDeps({
      github: { createClient: () => makeClient(calls) },
    });
    const output =
      `<!-- vibe-defer-until until="${OVER_HORIZON_UNTIL}" reason="the export lands later" -->`;

    const result = await workOnIssueDeclaredHandoff(
      makeContext(),
      makeState(output),
      deps,
    );

    assertRetried(result, calls);
  },
);

Deno.test(
  "declared_handoff_phase - a reasonless planning marker retries, no PR (Issue #3088, #4227)",
  async () => {
    const calls = makeCalls();
    const deps = createMockDeps({
      github: { createClient: () => makeClient(calls) },
    });

    const result = await workOnIssueDeclaredHandoff(
      makeContext(),
      makeState("<!-- vibe-needs-planning -->"),
      deps,
    );

    assertRetried(result, calls);
  },
);

Deno.test(
  "declared_handoff_phase - a valid time deferral names the committed branch (Issue #3088)",
  async () => {
    const calls = makeCalls();
    const deps = createMockDeps({
      github: { createClient: () => makeClient(calls) },
    });
    const output =
      `<!-- vibe-defer-until until="${FUTURE_UNTIL}" reason="the export has not landed" -->`;

    const result = await workOnIssueDeclaredHandoff(
      makeContext(),
      makeState(output),
      deps,
    );

    assertEquals(result.status, "early_exit");
    if (result.status !== "early_exit") return;
    assert(result.reason.startsWith("deferred: until "), result.reason);
    assert(
      !calls.postComment.some((c) => c.includes("No code changes")),
    );
    assert(
      calls.postComment.some((c) => c.includes("issue-3088-declared-handoff")),
    );
    assertEquals(result.outcome?.kind, "no_pr_expected");
    if (result.outcome?.kind === "no_pr_expected") {
      assertEquals(result.outcome.phase, "declared_handoff");
    }
  },
);

Deno.test(
  "declared_handoff_phase - a committed deferral pushes the branch before the comment, even with session resume off (Issue #3088)",
  async () => {
    const calls = makeCalls();
    const order: string[] = [];
    const deps = createMockDeps({
      github: {
        createClient: () => {
          const client = makeClient(calls);
          const post = client.postComment.bind(client);
          client.postComment = (repo, issue, body) => {
            order.push("comment");
            return post(repo, issue, body);
          };
          return client;
        },
      },
      git: {
        commitAndPushPending: () => {
          order.push("push");
          return Promise.resolve({
            ok: true as const,
            value: {
              committedNewChanges: false,
              commitsPushed: 1,
              finalUnpushedCount: 0,
              finalUnpushedSource: "remote-head" as const,
            },
          });
        },
      },
    });

    const result = await workOnIssueDeclaredHandoff(
      makeContext({
        config: {
          ...buildDefaultWorkerConfig(),
          enableSessionResume: false,
        },
      }),
      makeState(BLOCKED_OUTPUT),
      deps,
    );

    assertEquals(result.status, "early_exit");
    assertEquals(order[0], "push");
    assert(order.includes("comment"));
    assert(
      calls.postComment.some((c) => c.includes("issue-3088-declared-handoff")),
    );
  },
);

Deno.test(
  "declared_handoff_phase - the hand-off commit subject is a WIP marker (Issue #3088)",
  async () => {
    let subject = "";
    const deps = createMockDeps({
      github: { createClient: () => makeClient(makeCalls()) },
      git: {
        commitAndPushPending: (_branch: string, message: string) => {
          subject = message;
          return Promise.resolve({
            ok: true as const,
            value: {
              committedNewChanges: true,
              commitsPushed: 1,
              finalUnpushedCount: 0,
              finalUnpushedSource: "remote-head" as const,
            },
          });
        },
        runGitCommand: (args: string[]) => {
          const stdout = args[0] === "status" && args[1] === "--porcelain"
            ? " M worker/deno/lib/example.ts\n"
            : "";
          return Promise.resolve({
            ok: true as const,
            value: { code: 0, stdout, stderr: "" },
          });
        },
      },
    });

    const result = await workOnIssueDeclaredHandoff(
      makeContext(),
      makeState(BLOCKED_OUTPUT),
      deps,
    );

    assertEquals(result.status, "early_exit");
    assertEquals(isWipCommitSubject(subject), true, subject);
    // Issue #3499: no fixed VibeCoder issue number in a target-repo subject.
    assertEquals(/#\d+/.test(subject), false, subject);
    assertStringIncludes(subject, "1 uncommitted file(s)");
    assertStringIncludes(subject, "declared hand-off");
  },
);

Deno.test(
  "declared_handoff_phase - a failed push applies no deferral and names no branch (Issue #3088)",
  async () => {
    const calls = makeCalls();
    const deps = createMockDeps({
      github: { createClient: () => makeClient(calls) },
      git: {
        commitAndPushPending: () =>
          Promise.resolve({
            ok: false as const,
            error: new Error("push rejected"),
          }),
      },
    });

    const result = await workOnIssueDeclaredHandoff(
      makeContext(),
      makeState(BLOCKED_OUTPUT),
      deps,
    );

    assertEquals(result.status, "failure");
    assertEquals(calls.postComment.length, 0);
    if (result.status === "failure") {
      assert(!result.reason.includes("issue-3088-declared-handoff"));
      assertStringIncludes(result.reason, "Git push failed");
      assertStringIncludes(result.reason, "push rejected");
      assertEquals(detectFailureCategory(result.reason), "push_failure");
    }
  },
);

Deno.test(
  "declared_handoff_phase - a workflow-scope push refusal is token_scope and applies no hand-off (Issue #3088)",
  async () => {
    const calls = makeCalls();
    const deps = createMockDeps({
      github: { createClient: () => makeClient(calls) },
      git: {
        commitAndPushPending: () =>
          Promise.resolve({
            ok: false as const,
            error: new Error(
              "remote: refusing to allow an OAuth App to create or update " +
                "workflow `.github/workflows/ci.yml` without `workflow` scope",
            ),
          }),
      },
    });

    const result = await workOnIssueDeclaredHandoff(
      makeContext(),
      makeState(BLOCKED_OUTPUT),
      deps,
    );

    assertEquals(result.status, "failure");
    assertEquals(calls.postComment.length, 0);
    if (result.status === "failure") {
      assert(!result.reason.includes("issue-3088-declared-handoff"));
      assertStringIncludes(result.reason, "lacks the 'workflow' scope");
      assertEquals(detectFailureCategory(result.reason), "token_scope");
    }
  },
);

Deno.test("declared handoff retains network and token causes through the failure decision and callback (Issue #3738)", async () => {
  for (
    const [message, category] of [
      ["Could not resolve host github.com", "push_failure"],
      [
        "refusing to allow an OAuth App to create or update workflow `.github/workflows/ci.yml` without `workflow` scope",
        "token_scope",
      ],
    ] as const
  ) {
    const calls = makeCalls();
    const deps = createMockDeps({
      github: { createClient: () => makeClient(calls) },
      git: {
        commitAndPushPending: () =>
          Promise.resolve({ ok: false as const, error: new Error(message) }),
      },
    });
    const phase = await workOnIssueDeclaredHandoff(
      makeContext(),
      makeState(BLOCKED_OUTPUT),
      deps,
    );
    assert(phase.status === "failure");
    assertEquals(phase.category, category);
    assert(isInfrastructureFailure(phase.category));
    const decision = classifyCodingFailure(
      "outer wrapper quotes timeout",
      phase.category,
    );
    assertEquals(decision.disposition, "transient");
    assertEquals(calls.postComment.length, 0);
    const outcome = deriveRunOutcome({
      success: false,
      phase: "declared_handoff",
      reason: phase.reason,
      category: phase.category,
    });
    const emitted = callbackOutcomeFromRun({
      repo: REPO,
      issueNumber: ISSUE,
      result: "failure",
      startedAtEpochMs: 0,
      finishedAtEpochMs: 1,
      outcome,
    });
    assertEquals(emitted?.category, category);
  }
});
