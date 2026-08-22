/**
 * Regression tests for the blocked-run deferral in the no-changes phase
 * (Issue #222).
 *
 * NEAT-AI-Backpropagation#94: the run correctly found the work blocked on
 * NEAT-AI-core#560, and the handler described that answer as
 * "analysis-only / recommendation-only", escalated it to `needs-human`, and
 * the agent closed the issue as `not planned`. Blocked-shaped output must
 * instead **defer**: issue left open, dependency recorded, no `needs-human`,
 * no closure, and a release comment saying `deferred: depends on owner/repo#N`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { workOnIssueHandleNoChanges } from "../lib/phases/handle_no_changes_phase.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import type { GitHubClient, GitHubIssue } from "../types.ts";
import { extractDependencyReferencesDetailed } from "../lib/issue_dependencies.ts";
import {
  buildDeferralMarker,
  hasPriorDeferral,
} from "../lib/blocked_deferral.ts";

const REPO = "stSoftwareAU/NEAT-AI-Backpropagation";
const ISSUE = 94;
const DEP = "stSoftwareAU/NEAT-AI-core#560";

/** The blocked answer the real run produced, in its own shape. */
const BLOCKED_OUTPUT =
  `## Blocked: \`neat_core::creature_validate\` has no rule bodies

\`creature_validate\` in NEAT-AI-core \`Develop\` returns an unconditional
failure until the rule bodies land, so every trained creature would be
rejected. No code change is possible here yet.

Depends on ${DEP}
`;

interface StubCalls {
  addLabel: string[];
  removeLabel: string[];
  postComment: string[];
  editIssue: Array<{ title?: string; body?: string }>;
  closeIssue: number;
  unassignIssue: number;
}

function makeCalls(): StubCalls {
  return {
    addLabel: [],
    removeLabel: [],
    postComment: [],
    editIssue: [],
    closeIssue: 0,
    unassignIssue: 0,
  };
}

function makeClient(calls: StubCalls, body = "Original body."): GitHubClient {
  const issue: GitHubIssue = {
    number: ISSUE,
    title: "Validate every trained creature before returning it",
    body,
    labels: ["work-on"],
    author: "human",
    assignees: ["testbot"],
    createdAt: "",
    updatedAt: "",
  };
  return {
    getIssue: () => Promise.resolve(issue),
    getIssueComments: () => Promise.resolve([]),
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
    editIssue: (_r, _i, updates) => {
      calls.editIssue.push(updates);
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
    issueTitle: "Validate every trained creature before returning it",
    issueBody: "Use `neat_core::creature_validate` on every trained creature.",
    issueLabels: ["work-on"],
    issueComments: "",
    githubUser: "testbot",
    config: buildDefaultWorkerConfig(),
    ...overrides,
  };
}

function makeState(claudeOutput: string): PhaseState {
  return {
    branchName: "issue-94-validate",
    baseBranch: "Develop",
    defaultBranch: "Develop",
    repoPath: "/tmp/test-repo",
    clarityStatus: "not_assessed",
    claudeOutput,
    executeStartTime: 0,
    baselineQualityPassed: true,
    baselineQualityOutput: "",
  };
}

Deno.test(
  "handle_no_changes_phase - blocked output defers instead of closing or escalating",
  async () => {
    const calls = makeCalls();
    const deps = createMockDeps({
      github: { createClient: () => makeClient(calls) },
    });

    const result = await workOnIssueHandleNoChanges(
      makeContext(),
      makeState(BLOCKED_OUTPUT),
      deps,
    );

    assertEquals(result.status, "early_exit");
    assertEquals(
      (result as { reason: string }).reason,
      `deferred: depends on ${DEP}`,
    );

    // The issue is never closed, and never handed to a human.
    assertEquals(calls.closeIssue, 0);
    assertEquals(calls.addLabel, []);
    // The discovery label is left in place — no `work-on` strip.
    assertEquals(calls.removeLabel, []);

    // The dependency is recorded in the form the dependency gate reads.
    assertEquals(calls.editIssue.length, 1);
    const newBody = calls.editIssue[0]?.body ?? "";
    assertStringIncludes(newBody, `Depends on ${DEP}`);
    const refs = extractDependencyReferencesDetailed(newBody);
    assertEquals(refs.length, 1);
    assertEquals(refs[0]?.repo, "stSoftwareAU/NEAT-AI-core");
    assertEquals(refs[0]?.number, 560);

    // One comment: the deferral, quoting the run's own reason — NOT the
    // "looks analysis-only / recommendation-only" hand-off text.
    assertEquals(calls.postComment.length, 1);
    assertStringIncludes(calls.postComment[0]!, "Deferred");
    assertStringIncludes(calls.postComment[0]!, "creature_validate");
    assert(
      !calls.postComment[0]!.includes("analysis-only"),
      "a blocked run must not be described as analysis-only",
    );
    // The comment carries the loop-guard marker naming the dependency.
    assertStringIncludes(calls.postComment[0]!, buildDeferralMarker(DEP));

    // Claim released, with the outcome the release comment states.
    assertEquals(calls.unassignIssue, 1);
    const outcome = (result as { outcome?: { kind: string; summary?: string } })
      .outcome;
    assertEquals(outcome?.kind, "no_pr_expected");
    assertEquals(outcome?.summary, `deferred: depends on ${DEP}`);
  },
);

Deno.test(
  "handle_no_changes_phase - a blocked run is never treated as already complete",
  async () => {
    // The completion indicators ("no changes needed") appear in plenty of
    // blocked answers; the deferral must win, because closing is the one
    // outcome the next scan cannot undo.
    const calls = makeCalls();
    const deps = createMockDeps({
      github: { createClient: () => makeClient(calls) },
    });

    const output = `## Blocked: upstream validation is unimplemented

No changes needed here until the rule bodies land.

Depends on ${DEP}
`;
    const result = await workOnIssueHandleNoChanges(
      makeContext(),
      makeState(output),
      deps,
    );

    assertEquals(result.status, "early_exit");
    assertEquals(calls.closeIssue, 0);
    assertEquals(
      (result as { reason: string }).reason,
      `deferred: depends on ${DEP}`,
    );
  },
);

Deno.test(
  "handle_no_changes_phase - a second deferral on the same dependency hands off instead of looping",
  async () => {
    // The gate did not hold (the dependency closed and the run still reports
    // itself blocked), so deferring again would spin a fresh agent run every
    // scan. The repeat escalates to a human — and is still never closed.
    const calls = makeCalls();
    const deps = createMockDeps({
      github: { createClient: () => makeClient(calls) },
    });

    const priorComment = `## Deferred — blocked on ${DEP}\n\n…\n\n${
      buildDeferralMarker(DEP)
    }`;
    const result = await workOnIssueHandleNoChanges(
      makeContext({ issueComments: priorComment }),
      makeState(BLOCKED_OUTPUT),
      deps,
    );

    assertEquals(
      (result as { reason: string }).reason,
      "analysis_only_handed_off",
    );
    assertEquals(calls.closeIssue, 0);
    // No second dependency line, and no second deferral comment.
    assertEquals(calls.editIssue.length, 0);
    assert(
      !calls.postComment.some((c) => c.includes("## Deferred")),
      "a repeat deferral must not post another deferral comment",
    );
  },
);

Deno.test(
  "handle_no_changes_phase - non-blocked analysis-only output still hands off",
  async () => {
    // The deferral must not swallow the existing analysis-only behaviour.
    const calls = makeCalls();
    const deps = createMockDeps({
      github: { createClient: () => makeClient(calls) },
    });

    const output = "A".repeat(200) +
      " Here is my analysis: nothing here is blocked by anything.";
    const result = await workOnIssueHandleNoChanges(
      makeContext(),
      makeState(output),
      deps,
    );

    assertEquals(
      (result as { reason: string }).reason,
      "analysis_only_handed_off",
    );
    assertEquals(calls.editIssue.length, 0);
  },
);

Deno.test("hasPriorDeferral matches only the same dependency", () => {
  const comments = `Some chatter\n\n${buildDeferralMarker(DEP)}\n`;
  assert(hasPriorDeferral(comments, DEP));
  // Case-insensitive: the reference is rendered from the agent's own text.
  assert(hasPriorDeferral(comments, DEP.toUpperCase()));
  // A deferral on a different dependency is a fresh block, not a repeat.
  assert(!hasPriorDeferral(comments, "stSoftwareAU/NEAT-AI-core#561"));
  assert(!hasPriorDeferral("", DEP));
});
