/**
 * Tests for the bump-rejection PR comment surfaced by
 * `workOnIssueCompletion` (Issue #1613).
 *
 * After a successful PR creation, the completion phase consults
 * `state.bumpInfo`. When a bump was rejected (either by the script or
 * by the audit gate), it posts a single explanatory comment on the PR
 * thread so reviewers can see what was attempted and why it was dropped.
 *
 * Australian English used throughout (behaviour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { workOnIssueCompletion } from "../lib/phases/completion_phase.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type { GitHubClient, WorkerConfig } from "../types.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { BumpInfo } from "../lib/bump_deps.ts";

interface RecordedComment {
  repo: string;
  issueNumber: number;
  body: string;
}

function makeStubClient(comments: RecordedComment[]): GitHubClient {
  return {
    getIssue: () => {
      throw new Error("stub: getIssue not implemented");
    },
    getIssueComments: () => Promise.resolve([]),
    addLabel: () => Promise.resolve(),
    removeLabel: () => Promise.resolve(),
    postComment: (repo, issueNumber, body) => {
      comments.push({ repo, issueNumber, body });
      return Promise.resolve(undefined);
    },
    editIssue: () => Promise.resolve(),
    assignIssue: () => Promise.resolve(),
    unassignIssue: () => Promise.resolve(),
    closeIssue: () => Promise.resolve(),
  };
}

function makeConfig(): WorkerConfig {
  return buildDefaultWorkerConfig();
}

function makeContext(overrides?: Partial<IssueContext>): IssueContext {
  return {
    repo: "org/repo",
    issueNumber: 1613,
    issueTitle: "Bump deps",
    issueBody: "",
    issueLabels: [],
    issueComments: "",
    githubUser: "testbot",
    config: makeConfig(),
    ...overrides,
  };
}

function makeState(overrides?: Partial<PhaseState>): PhaseState {
  return {
    branchName: "issue-1613-bump",
    baseBranch: "main",
    defaultBranch: "main",
    repoPath: "/tmp/test-repo",
    clarityStatus: "not_assessed",
    claudeOutput: "",
    executeStartTime: 0,
    baselineQualityPassed: true,
    baselineQualityOutput: "",
    ...overrides,
  };
}

function makeDeps(comments: RecordedComment[]) {
  return createMockDeps({
    github: {
      createClient: () => makeStubClient(comments),
      runGhCommand: () =>
        Promise.resolve("https://github.com/org/repo/pull/42"),
    },
    pr: {
      findExistingPrForIssue: () =>
        Promise.resolve({ ok: false, error: new Error("No PR found") }),
    },
  });
}

// =============================================================================
// rejected_by_script — comment posted on the PR
// =============================================================================

Deno.test(
  "completion - posts comment on PR when bump was rejected by bump-deps.sh",
  async () => {
    const ctx = makeContext();
    const bumpInfo: BumpInfo = {
      status: "rejected_by_script",
      files: ["package.json"],
      output: "audit: dep XYZ flagged",
      rejectionReason: "`bump-deps.sh` exited with status 7 — bump reverted.",
    };
    const state = makeState({ bumpInfo });
    const comments: RecordedComment[] = [];

    const result = await workOnIssueCompletion(ctx, state, makeDeps(comments));

    assertEquals(result.status, "continue");
    const bumpComment = comments.find((c) =>
      c.body.includes("rejected by `bump-deps.sh`")
    );
    assertEquals(
      bumpComment !== undefined,
      true,
      "must post a bump-rejection comment after PR creation",
    );
    assertEquals(
      bumpComment!.issueNumber,
      42,
      "comment must target the PR number",
    );
    assertStringIncludes(bumpComment!.body, "package.json");
  },
);

// =============================================================================
// rejected_by_audit — comment posted on the PR
// =============================================================================

Deno.test(
  "completion - posts comment on PR when bump was rejected by quality audit",
  async () => {
    const ctx = makeContext();
    const bumpInfo: BumpInfo = {
      status: "rejected_by_audit",
      files: ["go.mod"],
      output: "",
      rejectionReason:
        "Quality gate failed with the bump applied but passed once it was reverted.",
    };
    const state = makeState({ bumpInfo });
    const comments: RecordedComment[] = [];

    const result = await workOnIssueCompletion(ctx, state, makeDeps(comments));

    assertEquals(result.status, "continue");
    const bumpComment = comments.find((c) =>
      c.body.includes("rejected by quality audit")
    );
    assertEquals(
      bumpComment !== undefined,
      true,
      "must post audit-rejection comment after PR creation",
    );
    assertStringIncludes(bumpComment!.body, "go.mod");
  },
);

// =============================================================================
// applied / noop / absent — no comment posted
// =============================================================================

Deno.test(
  "completion - posts no bump comment when bump was applied cleanly",
  async () => {
    const ctx = makeContext();
    const bumpInfo: BumpInfo = {
      status: "applied",
      files: ["package.json"],
      output: "bumped",
      sha: "deadbeef",
      beforeBumpSha: "cafebabe",
    };
    const state = makeState({ bumpInfo });
    const comments: RecordedComment[] = [];

    const result = await workOnIssueCompletion(ctx, state, makeDeps(comments));

    assertEquals(result.status, "continue");
    const bumpComment = comments.find((c) =>
      c.body.includes("Dependency bump rejected")
    );
    assertEquals(
      bumpComment,
      undefined,
      "must not post a rejection comment for an applied bump",
    );
  },
);

Deno.test(
  "completion - posts no bump comment when bumpInfo is absent",
  async () => {
    const ctx = makeContext();
    const state = makeState(); // no bumpInfo
    const comments: RecordedComment[] = [];

    const result = await workOnIssueCompletion(ctx, state, makeDeps(comments));

    assertEquals(result.status, "continue");
    const bumpComment = comments.find((c) =>
      c.body.includes("Dependency bump")
    );
    assertEquals(
      bumpComment,
      undefined,
      "must not post a bump comment when no bump phase ran",
    );
  },
);
