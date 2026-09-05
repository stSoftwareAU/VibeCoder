/**
 * A claim refused in the setup phase must release nothing (Issue #1193).
 *
 * The fleet runs every host under one GitHub login, so
 * `gh issue edit --remove-assignee <githubUser>` removes **whichever**
 * host's assignment is on the issue. When `workOnIssue`'s setup phase was
 * refused a claim it returned `success: false` and the loop's failure/skip
 * path called `releaseIssueClaim`, which unassigned the *winner* and — via
 * `clearHeartbeat`'s canonical-marker adoption — patched the winner's live
 * heartbeat marker to `cleared`. The winner then ran unassigned with a
 * cleared marker and a third host could claim the issue.
 *
 * Issue #1139 added the mechanism (`claimNotHeld`) for the idle-task route;
 * these tests pin it for the standard pipeline: the refusal travels out of
 * `workOnIssueSetupBranch`, through `WorkOnIssueResult`, to the loop, which
 * then releases nothing.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  type IssueContext,
  type PhaseState,
  workOnIssue,
  workOnIssueSetupBranch,
} from "../lib/issue_worker.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { isExpectedSkipResult } from "../lib/issue_worker_types.ts";
import { CLAIM_MARKER_PREFIX, claimIssue } from "../lib/claim_issue.ts";
import { formatHeartbeatMarker } from "../lib/heartbeat_storage.ts";
import { FakeClaimHub } from "./support/fake_claim_hub.ts";
import type { WorkerConfig } from "../types.ts";

const REPO = "stSoftwareAU/VibeCoder";
const ISSUE = 1193;
/** Both fleet hosts run under the same login, as the real fleet does. */
const FLEET_USER = "stservice";

function makeConfig(overrides?: Partial<WorkerConfig>): WorkerConfig {
  return { ...buildDefaultWorkerConfig(), ...overrides };
}

function makeContext(overrides?: Partial<IssueContext>): IssueContext {
  return {
    repo: REPO,
    issueNumber: ISSUE,
    issueTitle: "Fix the date parser",
    issueBody: "The parser drops the timezone.",
    issueLabels: [],
    issueComments: "",
    githubUser: FLEET_USER,
    config: makeConfig(),
    ...overrides,
  };
}

function makeState(): PhaseState {
  return {
    branchName: "issue-1193-fix",
    baseBranch: "main",
    defaultBranch: "main",
    repoPath: "/tmp/test-repo",
    clarityStatus: "not_assessed",
    claudeOutput: "",
    executeStartTime: 0,
    baselineQualityPassed: true,
    baselineQualityOutput: "",
  };
}

Deno.test(
  "setupBranch - a refused claim reports that this run holds none",
  async () => {
    const ctx = makeContext();
    const deps = createMockDeps({
      issues: {
        claimIssue: () =>
          Promise.resolve({
            ok: true,
            value: {
              claimed: false,
              winnerId: "stservice-GRQ-3",
              reason: "race_lost" as const,
            },
          }),
      },
    });

    const result = await workOnIssueSetupBranch(ctx, makeState(), deps);

    assertEquals(result.status, "early_exit");
    assert(
      result.status === "early_exit" && result.claimNotHeld === true,
      "a refused claim must be marked as held by nobody here",
    );
  },
);

Deno.test(
  "setupBranch - claim churn escalation still releases: the claim was taken",
  async () => {
    const ctx = makeContext();
    const deps = createMockDeps({
      issues: {
        checkClaimChurn: () =>
          Promise.resolve({
            ok: true,
            value: { escalated: true, churnCount: 4 },
          }),
      },
    });

    const result = await workOnIssueSetupBranch(ctx, makeState(), deps);

    assertEquals(result.status, "early_exit");
    assert(
      result.status === "early_exit" &&
        result.reason === "claim_churn_escalation",
      `expected the churn escalation; got ${JSON.stringify(result)}`,
    );
    assertEquals(
      result.status === "early_exit" ? result.claimNotHeld : undefined,
      undefined,
      "the claim succeeded before the churn check, so it is ours to release",
    );
  },
);

Deno.test(
  "workOnIssue - carries the setup refusal out as claimNotHeld",
  async () => {
    const ctx = makeContext();
    const deps = createMockDeps({
      issues: {
        claimIssue: () =>
          Promise.resolve({
            ok: true,
            value: { claimed: false, reason: "already_assigned" as const },
          }),
      },
    });

    const result = await workOnIssue(ctx, deps);

    assertEquals(result.phase, "setup");
    assertEquals(result.success, false);
    assertEquals(result.claimNotHeld, true);
    // It is still the skip it always was — cooldown, no failure tracking.
    assertEquals(isExpectedSkipResult(result), true);
  },
);

Deno.test(
  "two hosts, one issue: a refused claim in setup leaves the holder's assignee and marker intact",
  async () => {
    const hub = new FakeClaimHub(FLEET_USER, ["work-on"]);
    const workDir = await Deno.makeTempDir();
    try {
      // Host A holds the issue: assignee plus a CLAIM_LOCK carrying a live
      // heartbeat marker, exactly as its own claim published them.
      const nowSeconds = Math.floor(Date.now() / 1000);
      hub.assignees = [FLEET_USER];
      hub.addComment(
        `${CLAIM_MARKER_PREFIX}${FLEET_USER}-GRQ-3 -->\nClaimed by GRQ-3\n` +
          formatHeartbeatMarker("machine-GRQ-3", nowSeconds),
      );
      const holderState = {
        assignees: [...hub.assignees],
        comments: hub.comments.map((c) => c.body),
      };

      // Host B works from a stale issue list and runs the standard pipeline.
      const ctx = makeContext({ config: makeConfig({ workDir }) });
      const deps = createMockDeps({
        issues: {
          claimIssue: (options) =>
            claimIssue({
              ...options,
              ghCommandFn: hub.gh("Mac-Ultra-M2"),
              sleepFn: () => Promise.resolve(),
            }),
        },
      });

      const result = await workOnIssue(ctx, deps);

      assertEquals(result.phase, "setup");
      assertEquals(result.success, false);
      // This is the flag the loop reads before calling `releaseIssueClaim`
      // (`run_core.ts` — covered there by "a run that never held the claim
      // releases nothing"). Without it the refused host unassigns the
      // holder and clears its marker.
      assertEquals(result.claimNotHeld, true);
      assertEquals(isExpectedSkipResult(result), true);

      // And the refused run itself wrote nothing to the issue: the holder
      // keeps its assignee and its live heartbeat marker.
      assertEquals(hub.writesBy("Mac-Ultra-M2"), []);
      assertEquals(hub.assignees, holderState.assignees);
      assertEquals(
        hub.comments.map((c) => c.body),
        holderState.comments,
        "the holder's heartbeat marker must be untouched",
      );
    } finally {
      await Deno.remove(workDir, { recursive: true });
    }
  },
);
