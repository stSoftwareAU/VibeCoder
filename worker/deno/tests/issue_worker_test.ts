/**
 * Tests for issue_worker.ts — core issue processing pipeline phase functions.
 *
 * Issue #965: Part of the Deno worker orchestration migration (#918).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  type IssueContext,
  type PhaseState,
  workOnIssue,
  workOnIssueBaselineQuality,
  workOnIssueClarityPhase,
  workOnIssueCompletion,
  workOnIssueExecuteClaude,
  workOnIssueHandleNoChanges,
  workOnIssueQualityGate,
  workOnIssueSetupBranch,
} from "../lib/issue_worker.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { _resetGhSpawnRunner, _setGhSpawnRunner } from "../lib/gh_spawn.ts";
import type { GitHubClient, WorkerConfig } from "../types.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { CLARIFICATION_NEXT_STEP } from "../lib/phases/clarity_assessment_phase.ts";
import { MILESTONE_BRANCH_NEXT_STEP } from "../lib/phases/setup_branch_phase.ts";

/**
 * Stub GitHubClient that records mutation calls instead of running gh
 * subprocesses. Used by clarity-phase tests that exercise the
 * label-and-unassign routing added to fix infinite loops on complex /
 * unclear issues (FLEET#1626, private-repo-17#1085).
 */
interface StubGhCalls {
  addLabel: Array<{ repo: string; issueNumber: number; label: string }>;
  removeLabel: Array<{ repo: string; issueNumber: number; label: string }>;
  unassignIssue: Array<
    { repo: string; issueNumber: number; assignees: string[] }
  >;
  postComment: Array<{ repo: string; issueNumber: number; body: string }>;
  closeIssue: Array<{ repo: string; issueNumber: number; comment?: string }>;
  ensureLabelExists: Array<{ repo: string; label: string }>;
}

function makeStubGhClient(calls: StubGhCalls): GitHubClient {
  return {
    getIssue: () => {
      throw new Error("stub: getIssue not implemented");
    },
    // Issue #2210: return comments posted in this run (recent timestamps) so
    // escalateToHuman's dedup lookup can recognise a just-posted clarification
    // comment, mirroring production where getIssueComments refetches.
    getIssueComments: () =>
      Promise.resolve(
        calls.postComment.map((c, i) => ({
          id: i + 1,
          body: c.body,
          author: "testbot",
          createdAt: new Date().toISOString(),
          reactions: { thumbsUp: 0, eyes: 0, confused: 0 },
        })),
      ),
    addLabel: (repo, issueNumber, label) => {
      calls.addLabel.push({ repo, issueNumber, label });
      return Promise.resolve();
    },
    removeLabel: (repo, issueNumber, label) => {
      calls.removeLabel.push({ repo, issueNumber, label });
      return Promise.resolve();
    },
    postComment: (repo, issueNumber, body) => {
      calls.postComment.push({ repo, issueNumber, body });
      return Promise.resolve(undefined);
    },
    editIssue: () => Promise.resolve(),
    assignIssue: () => Promise.resolve(),
    unassignIssue: (repo, issueNumber, assignees) => {
      calls.unassignIssue.push({ repo, issueNumber, assignees });
      return Promise.resolve();
    },
    closeIssue: (repo, issueNumber, comment?) => {
      calls.closeIssue.push({ repo, issueNumber, comment });
      return Promise.resolve();
    },
  };
}

function makeStubGhCalls(): StubGhCalls {
  return {
    addLabel: [],
    removeLabel: [],
    unassignIssue: [],
    postComment: [],
    closeIssue: [],
    ensureLabelExists: [],
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides?: Partial<WorkerConfig>): WorkerConfig {
  return { ...buildDefaultWorkerConfig(), ...overrides };
}

function makeContext(overrides?: Partial<IssueContext>): IssueContext {
  return {
    repo: "org/repo",
    issueNumber: 42,
    issueTitle: "Fix login bug",
    issueBody: "The login button on `src/auth/login.ts:45` does not work.",
    issueLabels: [],
    issueComments: "",
    githubUser: "testbot",
    config: makeConfig(),
    ...overrides,
  };
}

function makeState(overrides?: Partial<PhaseState>): PhaseState {
  return {
    branchName: "issue-42-fix-login-bug",
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

// ============================================================================
// Phase 1 — Setup Branch
// ============================================================================

Deno.test("setupBranch - succeeds with valid claim", async () => {
  const ctx = makeContext();
  const state = makeState();
  const deps = createMockDeps();

  const result = await workOnIssueSetupBranch(ctx, state, deps);

  assertEquals(result.status, "continue");
  assertEquals(state.branchName.length > 0, true);

  // Cleanup heartbeat to avoid resource leak
  if (state.heartbeatHandle) {
    const { stopHeartbeat } = await import("../lib/heartbeat.ts");
    await stopHeartbeat(state.heartbeatHandle);
  }
});

// Issue #3150: the setup phase must feed claimIssue the fleet-author union
// (host + allowedAuthors + fleetPrAuthors) and the milestone title so the
// live claim-time re-check can see a sibling PR opened in the
// discovery→claim window.
Deno.test("setupBranch - passes fleet authors and milestone title to claimIssue (Issue #3150)", async () => {
  const ctx = makeContext({
    githubUser: "hostbot",
    milestoneTitle: "My Milestone",
    config: makeConfig({
      allowedAuthors: ["hostbot", "trusted-human"],
      fleetPrAuthors: ["sibling-bot"],
    }),
  });
  const state = makeState();
  let captured: { fleetAuthors?: string[]; milestoneTitle?: string } = {};
  const deps = createMockDeps({
    issues: {
      claimIssue: (
        opts: { fleetAuthors?: string[]; milestoneTitle?: string },
      ) => {
        captured = {
          fleetAuthors: opts.fleetAuthors,
          milestoneTitle: opts.milestoneTitle,
        };
        return Promise.resolve({ ok: true, value: { claimed: true } });
      },
    },
  });

  await workOnIssueSetupBranch(ctx, state, deps);

  // Union of host login, allowedAuthors, and fleetPrAuthors, deduplicated.
  assertEquals(captured.fleetAuthors, [
    "hostbot",
    "trusted-human",
    "sibling-bot",
  ]);
  assertEquals(captured.milestoneTitle, "My Milestone");

  if (state.heartbeatHandle) {
    const { stopHeartbeat } = await import("../lib/heartbeat.ts");
    await stopHeartbeat(state.heartbeatHandle);
  }
});

// Issue #3150: a claim aborted by the live fleet-PR re-check must surface
// as an early_exit naming the fleet_pr_exists reason, not proceed to work.
Deno.test("setupBranch - early exits when claim aborts on a live fleet PR (Issue #3150)", async () => {
  const ctx = makeContext();
  const state = makeState();
  const deps = createMockDeps({
    issues: {
      claimIssue: () =>
        Promise.resolve({
          ok: true,
          value: {
            claimed: false,
            reason: "fleet_pr_exists" as const,
            reasonDetail: "open PR #648 already targets this work stream",
          },
        }),
    },
  });

  const result = await workOnIssueSetupBranch(ctx, state, deps);

  assertEquals(result.status, "early_exit");
  const reason = (result as { reason: string }).reason;
  assertEquals(
    reason.includes("fleet_pr_exists"),
    true,
    `expected fleet_pr_exists in reason; got: ${reason}`,
  );
});

Deno.test("setupBranch - early exits when claim is rejected", async () => {
  const ctx = makeContext();
  const state = makeState();
  const deps = createMockDeps({
    issues: {
      claimIssue: () =>
        Promise.resolve({
          ok: true,
          value: {
            claimed: false,
            winnerId: "other-worker",
            reason: "race_lost" as const,
          },
        }),
    },
  });

  const result = await workOnIssueSetupBranch(ctx, state, deps);

  assertEquals(result.status, "early_exit");
  assertEquals(
    (result as { reason: string }).reason.includes("Issue not available"),
    true,
  );
});

// Issue #2325: not_assignable (worker is not a collaborator) must surface
// in the early_exit reason instead of the misleading
// "already assigned or closed" catch-all.
Deno.test("setupBranch - surfaces not_assignable reason when worker is not a collaborator", async () => {
  const ctx = makeContext();
  const state = makeState();
  const deps = createMockDeps({
    issues: {
      claimIssue: () =>
        Promise.resolve({
          ok: true,
          value: {
            claimed: false,
            reason: "not_assignable" as const,
            reasonDetail:
              "HTTP 422: Validation Failed - 'assignees' is invalid",
          },
        }),
    },
  });

  const result = await workOnIssueSetupBranch(ctx, state, deps);

  assertEquals(result.status, "early_exit");
  const reason = (result as { reason: string }).reason;
  assertEquals(
    reason.includes("not_assignable"),
    true,
    `expected not_assignable in reason; got: ${reason}`,
  );
  assertEquals(
    reason.includes("not a collaborator"),
    true,
    `expected collaborator hint; got: ${reason}`,
  );
  assertEquals(
    reason.includes("already assigned or closed"),
    false,
    "must not fall back to the misleading catch-all message",
  );
});

Deno.test("setupBranch - surfaces already_closed reason directly", async () => {
  const ctx = makeContext();
  const state = makeState();
  const deps = createMockDeps({
    issues: {
      claimIssue: () =>
        Promise.resolve({
          ok: true,
          value: { claimed: false, reason: "already_closed" as const },
        }),
    },
  });

  const result = await workOnIssueSetupBranch(ctx, state, deps);

  assertEquals(result.status, "early_exit");
  const reason = (result as { reason: string }).reason;
  assertEquals(
    reason.includes("already_closed"),
    true,
    `expected already_closed; got: ${reason}`,
  );
});

Deno.test("setupBranch - fails when claim errors", async () => {
  const ctx = makeContext();
  const state = makeState();
  const deps = createMockDeps({
    issues: {
      claimIssue: () =>
        Promise.resolve({ ok: false, error: new Error("API rate limit") }),
    },
  });

  const result = await workOnIssueSetupBranch(ctx, state, deps);

  assertEquals(result.status, "failure");
});

Deno.test("setupBranch - early exits on claim churn escalation", async () => {
  const ctx = makeContext();
  const state = makeState();
  const deps = createMockDeps({
    issues: {
      checkClaimChurn: () =>
        Promise.resolve({
          ok: true,
          value: { churnCount: 5, escalated: true },
        }),
    },
  });

  const result = await workOnIssueSetupBranch(ctx, state, deps);

  assertEquals(result.status, "early_exit");
  assertEquals((result as { reason: string }).reason, "claim_churn_escalation");
});

Deno.test("clarityPhase - issues with many checkboxes are NOT rejected as complex", async () => {
  // Checkboxes indicate a well-defined issue, not a complex one.
  // The clarity phase should proceed normally.
  // A specific title: the default "Fix login bug" is one of the vague
  // patterns the heuristic asks questions about, and this test is about
  // checkbox COUNT not vagueness. (It used to pass anyway only because the
  // mock deps handed out the real GitHub client, whose clarification
  // postComment failed against org/repo after 14 s of retries and was
  // swallowed — Issue #4347.)
  const ctx = makeContext({
    issueTitle: "Add the release checklist to docs/RELEASE.md",
    issueBody: `## Acceptance Criteria
- [ ] Step 1
- [ ] Step 2
- [ ] Step 3
- [ ] Step 4
- [ ] Step 5
- [ ] Step 6
- [ ] Step 7
- [ ] Step 8
- [ ] Step 9
- [ ] Step 10
- [ ] Step 11`,
  });
  const state = makeState();
  const deps = createMockDeps();

  const result = await workOnIssueClarityPhase(ctx, state, deps);

  // Should proceed to clarity assessment, not be rejected
  assertEquals(result.status, "continue");
});

Deno.test("setupBranch - calls setupRepo and uses repo-specific work directory", async () => {
  const ctx = makeContext({ repo: "org/my-project" });
  const state = makeState();
  let setupRepoCalled = false;
  let setupRepoArg = "";
  const deps = createMockDeps({
    git: {
      setupRepo: ((repo: string, _workDir: string) => {
        setupRepoCalled = true;
        setupRepoArg = repo;
        return Promise.resolve({ ok: true, value: "/tmp/work/my-project" });
      }) as never,
    },
  });

  const result = await workOnIssueSetupBranch(ctx, state, deps);

  assertEquals(result.status, "continue");
  assertEquals(setupRepoCalled, true);
  assertEquals(setupRepoArg, "org/my-project");
  assertEquals(state.repoPath, "/tmp/work/my-project");

  if (state.heartbeatHandle) {
    const { stopHeartbeat } = await import("../lib/heartbeat.ts");
    await stopHeartbeat(state.heartbeatHandle);
  }
});

Deno.test("setupBranch - fails when setupRepo fails", async () => {
  const ctx = makeContext();
  const state = makeState();
  const deps = createMockDeps({
    git: {
      setupRepo: (() =>
        Promise.resolve({
          ok: false,
          error: new Error("clone failed"),
        })) as never,
    },
  });

  const result = await workOnIssueSetupBranch(ctx, state, deps);

  assertEquals(result.status, "failure");
  assertEquals(
    (result as { reason: string }).reason.includes("clone failed"),
    true,
  );
});

Deno.test("setupBranch - sets milestone branch when milestone provided", async () => {
  const ctx = makeContext({ milestoneTitle: "OIDC Authentication" });
  const state = makeState();
  const deps = createMockDeps();

  await workOnIssueSetupBranch(ctx, state, deps);

  assertEquals(state.milestoneBranch, "milestone/oidc-authentication");
  assertEquals(state.baseBranch, "milestone/oidc-authentication");

  // Cleanup heartbeat
  if (state.heartbeatHandle) {
    const { stopHeartbeat } = await import("../lib/heartbeat.ts");
    await stopHeartbeat(state.heartbeatHandle);
  }
});

Deno.test("setupBranch - calls ensureMilestoneBranchExists for milestone issues", async () => {
  const ctx = makeContext({ milestoneTitle: "fitness-performance" });
  const state = makeState();
  let ensureCalled = false;
  let calledWithBranch = "";
  let calledWithDefault = "";
  const deps = createMockDeps({
    git: {
      ensureMilestoneBranchExists:
        ((milestoneBranch: string, defaultBranch: string) => {
          ensureCalled = true;
          calledWithBranch = milestoneBranch;
          calledWithDefault = defaultBranch;
          return Promise.resolve({ ok: true, value: "created" });
        }) as unknown as typeof deps.git.ensureMilestoneBranchExists,
    },
  });

  const result = await workOnIssueSetupBranch(ctx, state, deps);

  assertEquals(result.status, "continue");
  assertEquals(ensureCalled, true);
  assertEquals(calledWithBranch, "milestone/fitness-performance");
  assertEquals(calledWithDefault, "main");
  assertEquals(state.baseBranch, "milestone/fitness-performance");

  // Cleanup heartbeat
  if (state.heartbeatHandle) {
    const { stopHeartbeat } = await import("../lib/heartbeat.ts");
    await stopHeartbeat(state.heartbeatHandle);
  }
});

// Issue #3910: this test previously asserted the opposite — that a failure to
// ensure the milestone branch silently retargeted the work at the default
// branch. That fallback removed the milestone's single-merge review gate, so
// the behaviour is inverted here: the run fails and the base is never swapped.
Deno.test("setupBranch - fails the run when milestone branch cannot be ensured", async () => {
  const ctx = makeContext({ milestoneTitle: "fitness-performance" });
  const state = makeState();
  const calls = makeStubGhCalls();
  const deps = createMockDeps({
    git: {
      ensureMilestoneBranchExists: (() =>
        Promise.resolve({
          ok: false,
          error: new Error(
            "Failed to push milestone branch milestone/fitness-performance: " +
              "git push -u origin milestone/fitness-performance failed (exit code 1): " +
              "protected branch hook declined",
          ),
        })) as unknown as typeof deps.git.ensureMilestoneBranchExists,
    },
    github: {
      createClient: () => makeStubGhClient(calls),
    },
  });

  const result = await workOnIssueSetupBranch(ctx, state, deps);

  assertEquals(result.status, "failure");
  // The failure reason names the branch and carries the underlying git error.
  const reason = (result as { reason: string }).reason;
  assertStringIncludes(reason, "milestone/fitness-performance");
  assertStringIncludes(reason, "protected branch hook declined");
  // The base branch is never swapped to the default branch.
  assertEquals(state.baseBranch, "milestone/fitness-performance");
  assertEquals(state.milestoneBranch, "milestone/fitness-performance");
  // The failure is handed off on the issue with the git error text.
  assertEquals(calls.postComment.length, 1);
  assertStringIncludes(
    calls.postComment[0]?.body ?? "",
    "protected branch hook declined",
  );
  assertStringIncludes(
    calls.postComment[0]?.body ?? "",
    MILESTONE_BRANCH_NEXT_STEP,
  );
  assertEquals(calls.addLabel.length, 1);
  assertEquals(calls.addLabel[0]?.label, ctx.config.needsHumanLabel);

  // Cleanup heartbeat
  if (state.heartbeatHandle) {
    const { stopHeartbeat } = await import("../lib/heartbeat.ts");
    await stopHeartbeat(state.heartbeatHandle);
  }
});

// Issue #3910 / #3906: a milestone branch deleted from the remote must be
// recreated from the default branch and used as the base — not fallen back on.
Deno.test("setupBranch - uses the recreated milestone branch when it was missing", async () => {
  const ctx = makeContext({ milestoneTitle: "fitness-performance" });
  const state = makeState();
  const remoteBranches = new Set<string>(["main"]);
  const deps = createMockDeps({
    git: {
      ensureMilestoneBranchExists:
        ((milestoneBranch: string, defaultBranch: string) => {
          if (!remoteBranches.has(defaultBranch)) {
            return Promise.resolve({
              ok: false,
              error: new Error(`missing default branch ${defaultBranch}`),
            });
          }
          // Recreate from the default branch, as production does.
          remoteBranches.add(milestoneBranch);
          return Promise.resolve({
            ok: true,
            value:
              `Milestone branch ${milestoneBranch} created and pushed to origin`,
          });
        }) as unknown as typeof deps.git.ensureMilestoneBranchExists,
    },
  });

  const result = await workOnIssueSetupBranch(ctx, state, deps);

  assertEquals(result.status, "continue");
  assertEquals(remoteBranches.has("milestone/fitness-performance"), true);
  assertEquals(state.baseBranch, "milestone/fitness-performance");
  assertEquals(state.milestoneBranch, "milestone/fitness-performance");

  // Cleanup heartbeat
  if (state.heartbeatHandle) {
    const { stopHeartbeat } = await import("../lib/heartbeat.ts");
    await stopHeartbeat(state.heartbeatHandle);
  }
});

Deno.test("setupBranch - does not call ensureMilestoneBranchExists for non-milestone issues", async () => {
  const ctx = makeContext(); // no milestoneTitle
  const state = makeState();
  let ensureCalled = false;
  const deps = createMockDeps({
    git: {
      ensureMilestoneBranchExists: (() => {
        ensureCalled = true;
        return Promise.resolve({ ok: true, value: "created" });
      }) as unknown as typeof deps.git.ensureMilestoneBranchExists,
    },
  });

  const result = await workOnIssueSetupBranch(ctx, state, deps);

  assertEquals(result.status, "continue");
  assertEquals(ensureCalled, false);
  // Issue #3910: non-milestone issues keep basing on the default branch.
  assertEquals(state.baseBranch, "main");
  assertEquals(state.milestoneBranch, undefined);

  // Cleanup heartbeat
  if (state.heartbeatHandle) {
    const { stopHeartbeat } = await import("../lib/heartbeat.ts");
    await stopHeartbeat(state.heartbeatHandle);
  }
});

Deno.test("setupBranch - fails when branch creation fails", async () => {
  const ctx = makeContext();
  const state = makeState();
  const deps = createMockDeps({
    git: {
      createFeatureBranchFromBase: () =>
        Promise.resolve({
          ok: false,
          error: new Error("Branch already exists"),
        }),
    },
  });

  const result = await workOnIssueSetupBranch(ctx, state, deps);

  assertEquals(result.status, "failure");
  assertEquals(
    (result as { reason: string }).reason.includes("feature branch"),
    true,
  );

  // Cleanup heartbeat (started before branch creation failed)
  if (state.heartbeatHandle) {
    const { stopHeartbeat } = await import("../lib/heartbeat.ts");
    await stopHeartbeat(state.heartbeatHandle);
  }
});

Deno.test("setupBranch - runs pre-setup command when configured", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const ctx = makeContext({
      config: makeConfig({
        repoConfig: {
          "org/repo": {
            preSetupCommand: `echo "pre-setup-ran" > ${tmpDir}/marker.txt`,
          },
        },
      }),
    });
    const state = makeState();
    const deps = createMockDeps({
      git: {
        setupRepo: (() =>
          Promise.resolve({ ok: true, value: tmpDir })) as never,
      },
    });

    const result = await workOnIssueSetupBranch(ctx, state, deps);

    assertEquals(result.status, "continue");
    const marker = await Deno.readTextFile(`${tmpDir}/marker.txt`);
    assertEquals(marker.trim(), "pre-setup-ran");

    if (state.heartbeatHandle) {
      const { stopHeartbeat } = await import("../lib/heartbeat.ts");
      await stopHeartbeat(state.heartbeatHandle);
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("setupBranch - continues when pre-setup command fails (non-fatal)", async () => {
  const ctx = makeContext({
    config: makeConfig({
      repoConfig: {
        "org/repo": { preSetupCommand: "exit 1" },
      },
    }),
  });
  const state = makeState();
  let warningLogged = false;
  const deps = createMockDeps({
    logger: {
      warn: (msg: string) => {
        if (msg.includes("Pre-setup command failed")) {
          warningLogged = true;
        }
      },
    },
  });

  const result = await workOnIssueSetupBranch(ctx, state, deps);

  assertEquals(result.status, "continue");
  assertEquals(warningLogged, true);

  if (state.heartbeatHandle) {
    const { stopHeartbeat } = await import("../lib/heartbeat.ts");
    await stopHeartbeat(state.heartbeatHandle);
  }
});

Deno.test("setupBranch - skips pre-setup when no command configured", async () => {
  const ctx = makeContext({
    config: makeConfig({ repoConfig: {} }),
  });
  const state = makeState();
  const infoMessages: string[] = [];
  const deps = createMockDeps({
    logger: {
      info: (msg: string) => {
        infoMessages.push(msg);
      },
    },
  });

  const result = await workOnIssueSetupBranch(ctx, state, deps);

  assertEquals(result.status, "continue");
  assertEquals(
    infoMessages.some((m) => m.includes("Pre-setup command completed")),
    false,
  );

  if (state.heartbeatHandle) {
    const { stopHeartbeat } = await import("../lib/heartbeat.ts");
    await stopHeartbeat(state.heartbeatHandle);
  }
});

// ============================================================================
// Phase 2 — Clarity Assessment
// ============================================================================

Deno.test("clarityPhase - continues for clear issue", async () => {
  const ctx = makeContext({
    issueBody:
      "Fix the bug in `src/auth/login.ts:45` where the handler returns null",
  });
  const state = makeState();
  const deps = createMockDeps();

  const result = await workOnIssueClarityPhase(ctx, state, deps);

  assertEquals(result.status, "continue");
  assertEquals(state.clarityStatus, "assessed_clear");
});

Deno.test("clarityPhase - early exits for refine label and releases claim", async () => {
  const config = makeConfig();
  const ctx = makeContext({
    issueLabels: [config.refineIssueLabel],
    config,
  });
  const state = makeState();
  const calls = makeStubGhCalls();
  const deps = createMockDeps({
    github: {
      createClient: () => makeStubGhClient(calls),
    },
  });

  const result = await workOnIssueClarityPhase(ctx, state, deps);

  assertEquals(result.status, "early_exit");
  assertEquals((result as { reason: string }).reason, "refine_label_routing");
  // Worker must release its claim so Priority 1.75 refinement can pick it up.
  assertEquals(calls.unassignIssue.length, 1);
  assertEquals(calls.unassignIssue[0]?.assignees, [ctx.githubUser]);
});

Deno.test("clarityPhase - early exits for question label and releases claim", async () => {
  const config = makeConfig();
  const ctx = makeContext({
    issueLabels: [config.questionLabel],
    config,
  });
  const state = makeState();
  const calls = makeStubGhCalls();
  const deps = createMockDeps({
    github: {
      createClient: () => makeStubGhClient(calls),
    },
  });

  const result = await workOnIssueClarityPhase(ctx, state, deps);

  assertEquals(result.status, "early_exit");
  assertEquals((result as { reason: string }).reason, "question_label_routing");
  // Worker must release its claim so Priority 1.8 question handler can pick it up.
  assertEquals(calls.unassignIssue.length, 1);
});

Deno.test("clarityPhase - skips when max clarification rounds reached", async () => {
  const config = makeConfig({ maxClarificationRounds: 2 });
  const ctx = makeContext({
    issueComments: "## Clarification Needed\nQ1\n## Clarification Needed\nQ2",
    config,
  });
  const state = makeState();
  const deps = createMockDeps();

  const result = await workOnIssueClarityPhase(ctx, state, deps);

  assertEquals(result.status, "continue");
  assertEquals(state.clarityStatus, "skipped");
});

Deno.test("clarityPhase - detailed issue bodies proceed normally", async () => {
  // Detailed issues with numbered steps and checkboxes are well-defined,
  // not complex. The clarity phase should not reject them.
  const detailedBody = `## What needs to be done

1. Add logging to src/auth/login.ts
2. Fix the handler in src/api/users.ts
3. Update config in src/config/settings.ts
4. Add tests in tests/auth/login_test.ts
5. Add tests in tests/api/users_test.ts

- [ ] Task 1 in src/frontend/
- [ ] Task 2 in src/backend/
- [ ] Task 3 in src/database/
- [ ] Task 4 in src/middleware/
- [ ] Task 5 in src/utils/`;

  const ctx = makeContext({ issueBody: detailedBody });
  const state = makeState();
  const deps = createMockDeps();

  const result = await workOnIssueClarityPhase(ctx, state, deps);

  assertEquals(result.status, "continue");
});

Deno.test("clarityPhase - removes stale planning label from issue (Issue #1215)", async () => {
  // When an issue has the planning label but was selected for implementation
  // (label added between find and fetch), the Deno worker must remove the
  // stale planning label — matching the bash version behaviour.
  const config = makeConfig();
  const ctx = makeContext({
    issueLabels: [config.planningLabel],
    config,
  });
  const state = makeState();
  const calls = makeStubGhCalls();
  const deps = createMockDeps({
    github: {
      createClient: () => makeStubGhClient(calls),
    },
  });

  const result = await workOnIssueClarityPhase(ctx, state, deps);

  // Should continue with implementation (not early_exit)
  assertEquals(result.status, "continue");
  // Must have removed the planning label from the issue
  assertEquals(calls.removeLabel.length, 1);
  assertEquals(calls.removeLabel[0]?.label, config.planningLabel);
  assertEquals(calls.removeLabel[0]?.repo, "org/repo");
});

Deno.test("clarityPhase - unassigns worker even when addLabel fails during clarification (Issue #1215)", async () => {
  // When addLabel fails during the clarification workflow, the worker must
  // still unassign itself to release the claim.
  const ctx = makeContext({
    issueBody: "Do something",
    issueTitle: "Unclear issue",
  });
  const state = makeState();
  const calls = makeStubGhCalls();
  const deps = createMockDeps({
    github: {
      createClient: () =>
        ({
          ...makeStubGhClient(calls),
          addLabel: () => Promise.reject(new Error("addLabel failed")),
        }) as GitHubClient,
    },
  });

  const result = await workOnIssueClarityPhase(ctx, state, deps);

  // If clarification questions were generated and comment was posted,
  // the worker should still try to unassign even if addLabel fails.
  // If no clarification questions generated, it proceeds with implementation.
  if (
    result.status === "early_exit" &&
    (result as { reason: string }).reason === "waiting_for_clarification"
  ) {
    assertEquals(calls.unassignIssue.length, 1);
  }
  // Either way the function must not throw
});

Deno.test("clarityPhase - clarification comment states the next step and routes label via escalateToHuman (Issue #2210)", async () => {
  const ctx = makeContext({
    issueTitle: "Tidy things",
    issueBody: "clean up the helper code",
    issueLabels: [],
  });
  const state = makeState();
  const calls = makeStubGhCalls();
  const deps = createMockDeps({
    github: {
      createClient: () => makeStubGhClient(calls),
    },
  });

  const result = await workOnIssueClarityPhase(ctx, state, deps);

  assertEquals(result.status, "early_exit");
  assertEquals(
    (result as { reason: string }).reason,
    "waiting_for_clarification",
  );
  // Label routed through escalateToHuman.
  assertEquals(
    calls.addLabel.some((c) => c.label === ctx.config.needsHumanLabel),
    true,
  );
  // Exactly one comment — the helper deduped against the marker rather than
  // posting a second escalation comment.
  assertEquals(
    calls.postComment.length,
    1,
    "dedup must suppress the helper's duplicate comment",
  );
  const body = calls.postComment[0]!.body;
  assertEquals(body.includes("## Clarification Needed"), true);
  assertEquals(body.includes(CLARIFICATION_NEXT_STEP), true);
});

// ============================================================================
// Phase 2b — Baseline Quality Check (Issue #1183)
// ============================================================================

Deno.test("baselineQuality - stores passed result in state", async () => {
  const ctx = makeContext();
  const state = makeState();
  const deps = createMockDeps({
    quality: {
      runQualityGate: () =>
        Promise.resolve({
          ok: true,
          value: {
            checks: [],
            summary: { text: "passed", passed: true },
            passed: true,
            output: "all good",
          },
        }),
    },
  });

  const result = await workOnIssueBaselineQuality(ctx, state, deps);

  assertEquals(result.status, "continue");
  assertEquals(state.baselineQualityPassed, true);
  assertEquals(state.baselineQualityOutput, "");
});

Deno.test("baselineQuality - stores failed result and output in state", async () => {
  const ctx = makeContext();
  const state = makeState();
  const deps = createMockDeps({
    quality: {
      runQualityGate: () =>
        Promise.resolve({
          ok: true,
          value: {
            checks: [],
            summary: { text: "failed", passed: false },
            passed: false,
            output: "lint error on line 42",
          },
        }),
    },
  });

  const result = await workOnIssueBaselineQuality(ctx, state, deps);

  assertEquals(result.status, "continue");
  assertEquals(state.baselineQualityPassed, false);
  assertEquals(state.baselineQualityOutput, "lint error on line 42");
});

Deno.test("baselineQuality - continues when quality gate errors (non-blocking)", async () => {
  const ctx = makeContext();
  const state = makeState();
  const deps = createMockDeps({
    quality: {
      runQualityGate: () =>
        Promise.resolve({ ok: false, error: new Error("Script not found") }),
    },
  });

  const result = await workOnIssueBaselineQuality(ctx, state, deps);

  assertEquals(result.status, "continue");
  assertEquals(state.baselineQualityPassed, true);
  assertEquals(state.baselineQualityOutput, "");
});

Deno.test("baselineQuality - continues when quality gate throws (non-blocking)", async () => {
  const ctx = makeContext();
  const state = makeState();
  const deps = createMockDeps({
    quality: {
      runQualityGate: () => {
        throw new Error("Unexpected crash");
      },
    },
  });

  const result = await workOnIssueBaselineQuality(ctx, state, deps);

  assertEquals(result.status, "continue");
  assertEquals(state.baselineQualityPassed, true);
});

Deno.test("baselineQuality - captures generic diffable gate findings (Issue #2604)", async () => {
  const ctx = makeContext();
  const state = makeState();
  const captured = [
    {
      check: "mermaid" as const,
      key: "mermaid|d.md|flowchart|boom",
      display: "d.md:3 (flowchart): boom",
    },
  ];
  const deps = createMockDeps({
    quality: {
      runQualityGate: () =>
        Promise.resolve({
          ok: true,
          value: {
            checks: [],
            summary: { text: "passed", passed: true },
            passed: true,
            output: "",
          },
        }),
      collectDiffableGateFindings: () => Promise.resolve(captured),
    },
  });

  await workOnIssueBaselineQuality(ctx, state, deps);

  assertEquals(state.baselineGateFindings, captured);
});

Deno.test("baselineQuality - logs warning when baseline fails", async () => {
  const ctx = makeContext();
  const state = makeState();
  let warningLogged = false;
  const deps = createMockDeps({
    logger: {
      warn: (msg: string) => {
        if (msg.includes("Baseline quality check failed")) {
          warningLogged = true;
        }
      },
    },
    quality: {
      runQualityGate: () =>
        Promise.resolve({
          ok: true,
          value: {
            checks: [],
            summary: { text: "failed", passed: false },
            passed: false,
            output: "error",
          },
        }),
    },
  });

  await workOnIssueBaselineQuality(ctx, state, deps);

  assertEquals(warningLogged, true);
});

// ============================================================================
// Phase 3 — Execute Claude
// ============================================================================

Deno.test("executeClaude - continues when changes detected via commits", async () => {
  const ctx = makeContext();
  const state = makeState();
  const deps = createMockDeps({
    git: {
      runGitCommand: ((args: string[]) => {
        if (args[0] === "diff") {
          return Promise.resolve({
            ok: true,
            value: { code: 0, stdout: "", stderr: "" },
          });
        }
        if (args[0] === "log") {
          // New commits found
          return Promise.resolve({
            ok: true,
            value: { code: 0, stdout: "abc123 Fix login", stderr: "" },
          });
        }
        return Promise.resolve({
          ok: true,
          value: { code: 0, stdout: "", stderr: "" },
        });
      }) as unknown as typeof deps.git.runGitCommand,
    },
  });

  const result = await workOnIssueExecuteClaude(ctx, state, deps);

  assertEquals(result.status, "continue");
});

Deno.test("executeClaude - early exits with no_changes when no changes detected", async () => {
  const ctx = makeContext();
  const state = makeState();
  const deps = createMockDeps({
    git: {
      runGitCommand: () =>
        Promise.resolve({
          ok: true,
          value: { code: 0, stdout: "", stderr: "" },
        }),
    },
    pr: {
      findExistingPrForIssue: () =>
        Promise.resolve({ ok: false, error: new Error("No PR found") }),
    },
  });

  const result = await workOnIssueExecuteClaude(ctx, state, deps);

  assertEquals(result.status, "early_exit");
  assertEquals((result as { reason: string }).reason, "no_changes");
});

Deno.test("executeClaude - fails when repo validation fails", async () => {
  const ctx = makeContext();
  const state = makeState();
  const deps = createMockDeps({
    git: {
      validateRepoState: () =>
        Promise.resolve({ ok: false, error: new Error("Detached HEAD") }),
    },
  });

  const result = await workOnIssueExecuteClaude(ctx, state, deps);

  assertEquals(result.status, "failure");
  assertEquals(
    (result as { reason: string }).reason.includes(
      "Repository validation failed",
    ),
    true,
  );
});

Deno.test("executeClaude - fails when prompt building fails", async () => {
  const ctx = makeContext();
  const state = makeState();
  const deps = createMockDeps({
    infrastructure: {
      buildPrompt: () =>
        Promise.resolve({ ok: false, error: new Error("Template not found") }),
    },
  });

  const result = await workOnIssueExecuteClaude(ctx, state, deps);

  assertEquals(result.status, "failure");
  assertEquals(
    (result as { reason: string }).reason.includes("build prompt"),
    true,
  );
});

Deno.test("executeClaude - fails on Claude auth error", async () => {
  const ctx = makeContext();
  const state = makeState();
  const deps = createMockDeps({
    claude: {
      // Issue #45: a genuine auth failure is a NON-ZERO exit whose error
      // surface matches, with no commits produced.
      runClaudeWithRetry: () =>
        Promise.resolve({
          ok: true,
          value: {
            exitCode: 1,
            output: "Invalid API key · Please run /login",
            stderr: "Invalid API key",
            timedOut: false,
          },
        }) as never,
      isClaudeAuthError: () => true,
    },
    git: {
      runGitCommand: () =>
        Promise.resolve({
          ok: true,
          value: { code: 0, stdout: "", stderr: "" },
        }),
    },
  });

  const result = await workOnIssueExecuteClaude(ctx, state, deps);

  assertEquals(result.status, "failure");
  assertEquals(
    (result as { reason: string }).reason.includes("authentication"),
    true,
  );
  // The evidence must survive (Issue #3234): a live fleet outage was
  // undiagnosable because the auth path discarded Claude's own words —
  // "authentication error" with no output could be a login failure, a usage
  // limit, or a classifier false positive on issue content.
  assertEquals(
    (result as { reason: string }).reason.includes("Last output"),
    true,
    (result as { reason: string }).reason,
  );
});

Deno.test("executeClaude #46 - an external SIGTERM fails the phase, not continue", async () => {
  // The old code let a `terminated` result fall through to change detection
  // and `continue`, so completion ran over a half-done tree and failed for the
  // wrong reason. An external SIGTERM must fail the phase with the kill reason.
  const ctx = makeContext();
  const state = makeState();
  const deps = createMockDeps({
    claude: {
      runClaudeWithRetry: () =>
        Promise.resolve({
          ok: true,
          value: {
            exitCode: 143,
            rawExitCode: 143,
            externalSigterm: true,
            output: "…26 tool calls…",
            stderr: "",
            timedOut: false,
          },
        }) as never,
    },
    pr: {
      findExistingPrForIssue: () =>
        Promise.resolve({ ok: false, error: new Error("no PR") }),
    },
  });

  const result = await workOnIssueExecuteClaude(ctx, state, deps);
  assertEquals(result.status, "failure");
  assertStringIncludes((result as { reason: string }).reason, "SIGTERM");
});

Deno.test("executeClaude #46 - an external SIGTERM self-heals when a PR already exists", async () => {
  const ctx = makeContext();
  const state = makeState();
  const deps = createMockDeps({
    claude: {
      runClaudeWithRetry: () =>
        Promise.resolve({
          ok: true,
          value: {
            exitCode: 143,
            rawExitCode: 143,
            externalSigterm: true,
            output: "…",
            stderr: "",
            timedOut: false,
          },
        }) as never,
    },
    pr: {
      findExistingPrForIssue: () =>
        Promise.resolve({
          ok: true,
          value: "https://github.com/org/repo/pull/7",
        }),
    },
  });

  const result = await workOnIssueExecuteClaude(ctx, state, deps);
  assertEquals(result.status, "continue");
});

Deno.test("executeClaude #45 - a clean exit is never an auth error, even if the transcript mentions api keys", async () => {
  // Reproduces VibeCoder#36: a redaction issue whose prose says "api key" and
  // exits 0 having produced commits must NOT be recorded as an auth failure.
  const ctx = makeContext();
  const state = makeState();
  const deps = createMockDeps({
    claude: {
      runClaudeWithRetry: () =>
        Promise.resolve({
          ok: true,
          value: {
            exitCode: 0,
            output: "Redacted the bare OpenAI API key sk-…; tests: 0 failed.",
            timedOut: false,
          },
        }) as never,
      // Even a matcher that would fire on the prose must not be consulted for
      // a clean exit.
      isClaudeAuthError: () => true,
    },
    git: {
      runGitCommand: (args: string[]) =>
        Promise.resolve({
          ok: true,
          value: {
            code: 0,
            stdout: args[0] === "rev-list"
              ? "2"
              : args[0] === "log"
              ? "abc123 delivered"
              : "",
            stderr: "",
          },
        }),
    },
  });

  const result = await workOnIssueExecuteClaude(ctx, state, deps);
  assertEquals(result.status, "continue");
});

Deno.test("executeClaude #45 - an auth match with commits ahead is a false positive, not a failure", async () => {
  // Non-zero exit AND the matcher fires, but the branch has commits ahead of
  // base — the run did real work, so it must not be released as "no PR raised".
  const ctx = makeContext();
  const state = makeState();
  const deps = createMockDeps({
    claude: {
      runClaudeWithRetry: () =>
        Promise.resolve({
          ok: true,
          value: {
            exitCode: 1,
            output: "…api key… done",
            stderr: "invalid api key",
            timedOut: false,
          },
        }) as never,
      isClaudeAuthError: () => true,
    },
    git: {
      runGitCommand: (args: string[]) =>
        Promise.resolve({
          ok: true,
          value: {
            code: 0,
            stdout: args[0] === "rev-list"
              ? "2"
              : args[0] === "log"
              ? "abc123 delivered"
              : "",
            stderr: "",
          },
        }),
    },
  });

  const result = await workOnIssueExecuteClaude(ctx, state, deps);
  assertEquals(result.status, "continue");
});

Deno.test("executeClaude - self-heals when PR exists despite timeout", async () => {
  const ctx = makeContext();
  const state = makeState();
  const deps = createMockDeps({
    claude: {
      runClaudeWithRetry: () =>
        Promise.resolve({
          ok: true,
          value: {
            exitCode: 124,
            output: "timed out",
            timedOut: true,
            outputFile: "",
          },
        }),
    },
    pr: {
      findExistingPrForIssue: () =>
        Promise.resolve({
          ok: true,
          value: "https://github.com/org/repo/pull/99",
        }),
    },
  });

  const result = await workOnIssueExecuteClaude(ctx, state, deps);

  assertEquals(result.status, "continue");
});

Deno.test("executeClaude #47 - a timeout with a dirty tree reports uncommitted changes, not 'no changes'", async () => {
  const ctx = makeContext();
  const state = makeState();
  const deps = createMockDeps({
    claude: {
      runClaudeWithRetry: () =>
        Promise.resolve({
          ok: true,
          value: {
            exitCode: 124,
            output: "…ran quality.sh on my changes…",
            timedOut: true,
          },
        }) as never,
    },
    git: {
      runGitCommand: (args: string[]) =>
        Promise.resolve({
          ok: true,
          value: {
            code: 0,
            stdout: args[0] === "status" ? " M a.ts\n M b.ts" : "",
            stderr: "",
          },
        }),
    },
    pr: {
      findExistingPrForIssue: () =>
        Promise.resolve({ ok: false, error: new Error("no PR") }),
    },
  });

  const result = await workOnIssueExecuteClaude(ctx, state, deps);
  assertEquals(result.status, "failure");
  assertStringIncludes(
    (result as { reason: string }).reason,
    "uncommitted changes (2 files)",
  );
});

Deno.test("executeClaude #47 - a timeout with a clean tree still says 'without creating changes'", async () => {
  const ctx = makeContext();
  const state = makeState();
  const deps = createMockDeps({
    claude: {
      runClaudeWithRetry: () =>
        Promise.resolve({
          ok: true,
          value: {
            exitCode: 124,
            output: "…thinking, no edits…",
            timedOut: true,
          },
        }) as never,
    },
    git: {
      runGitCommand: () =>
        Promise.resolve({
          ok: true,
          value: { code: 0, stdout: "", stderr: "" },
        }),
    },
    pr: {
      findExistingPrForIssue: () =>
        Promise.resolve({ ok: false, error: new Error("no PR") }),
    },
  });

  const result = await workOnIssueExecuteClaude(ctx, state, deps);
  assertEquals(result.status, "failure");
  assertStringIncludes(
    (result as { reason: string }).reason,
    "without creating changes",
  );
});

Deno.test("executeClaude - passes quality and custom instructions from repo config to prompt builder", async () => {
  const ctx = makeContext({
    config: makeConfig({
      repoConfig: {
        "org/repo": {
          qualityCommand: "make check",
          customInstructions: "Always use pytest for testing.",
        },
      },
    }),
  });
  const state = makeState();

  let capturedOptions: Record<string, unknown> | undefined;
  const deps = createMockDeps({
    infrastructure: {
      buildPrompt: ((options: Record<string, unknown>) => {
        capturedOptions = options;
        return Promise.resolve({
          ok: true,
          value: { systemPrompt: "mock system", prompt: "mock prompt" },
        });
      }) as unknown as typeof deps.infrastructure.buildPrompt,
    },
  });

  await workOnIssueExecuteClaude(ctx, state, deps);

  assertEquals(capturedOptions !== undefined, true);
  assertEquals(
    (capturedOptions!.qualityInstructions as string).includes("make check"),
    true,
  );
  assertEquals(
    capturedOptions!.customInstructions,
    "Always use pytest for testing.",
  );
});

Deno.test("executeClaude - uses default quality instructions when no repo config", async () => {
  const ctx = makeContext();
  const state = makeState();

  let capturedOptions: Record<string, unknown> | undefined;
  const deps = createMockDeps({
    infrastructure: {
      buildPrompt: ((options: Record<string, unknown>) => {
        capturedOptions = options;
        return Promise.resolve({
          ok: true,
          value: { systemPrompt: "mock system", prompt: "mock prompt" },
        });
      }) as unknown as typeof deps.infrastructure.buildPrompt,
    },
  });

  await workOnIssueExecuteClaude(ctx, state, deps);

  assertEquals(capturedOptions !== undefined, true);
  assertEquals(
    (capturedOptions!.qualityInstructions as string).includes("./quality.sh"),
    true,
  );
  assertEquals(capturedOptions!.customInstructions, "");
});

Deno.test("executeClaude - self-heals when remote commits exist despite no local changes", async () => {
  const ctx = makeContext();
  const branchName = "issue-42-fix-login-bug";
  const state = makeState({ branchName });
  const deps = createMockDeps({
    git: {
      runGitCommand: ((args: string[]) => {
        // Third call: remote diff — check for origin/ prefix in any arg
        const argsStr = args.join(" ");
        if (argsStr.includes(`origin/${branchName}`)) {
          return Promise.resolve({
            ok: true,
            value: { code: 0, stdout: "abc123 Fix", stderr: "" },
          });
        }
        // First two calls: diff and log (no local changes)
        return Promise.resolve({
          ok: true,
          value: { code: 0, stdout: "", stderr: "" },
        });
      }) as unknown as typeof deps.git.runGitCommand,
    },
  });

  const result = await workOnIssueExecuteClaude(ctx, state, deps);

  assertEquals(result.status, "continue");
});

// ============================================================================
// Phase 3b — Handle No Changes
// ============================================================================

Deno.test("handleNoChanges - detects already complete issue and closes it (Issue #1364)", async () => {
  const calls = makeStubGhCalls();
  const ctx = makeContext();
  const state = makeState({
    // Issue #241: the close path requires cited evidence, so the run names the
    // commit that landed the fix. What this test asserts — closed, commented,
    // unassigned — is unchanged.
    claudeOutput:
      "The login fix is already implemented in commit `ab12cd3`. No changes " +
      "needed.",
  });
  const deps = createMockDeps({
    github: {
      createClient: () => makeStubGhClient(calls),
    },
  });

  const result = await workOnIssueHandleNoChanges(ctx, state, deps);

  assertEquals(result.status, "early_exit");
  assertEquals((result as { reason: string }).reason, "already_complete");
  // Verify the issue was closed (Issue #1364)
  assertEquals(calls.closeIssue.length, 1);
  assertEquals(calls.closeIssue[0]?.repo, "org/repo");
  assertEquals(calls.closeIssue[0]?.issueNumber, 42);
  assertEquals(typeof calls.closeIssue[0]?.comment, "string");
  assertEquals(
    calls.closeIssue[0]?.comment?.includes("Already Complete"),
    true,
  );
  // Verify the worker was unassigned
  assertEquals(calls.unassignIssue.length, 1);
  assertEquals(calls.unassignIssue[0]?.assignees, ["testbot"]);
});

Deno.test("handleNoChanges - close comment includes Claude's analysis snippet (Issue #1364)", async () => {
  const calls = makeStubGhCalls();
  const ctx = makeContext();
  const analysisText =
    "This feature was already implemented in PR #100. No changes needed.";
  const state = makeState({
    claudeOutput: analysisText,
  });
  const deps = createMockDeps({
    github: {
      createClient: () => makeStubGhClient(calls),
    },
  });

  await workOnIssueHandleNoChanges(ctx, state, deps);

  assertEquals(calls.closeIssue.length, 1);
  const comment = calls.closeIssue[0]?.comment ?? "";
  assertEquals(comment.includes(analysisText), true);
  assertEquals(comment.includes("Claude's analysis"), true);
});

Deno.test("handleNoChanges - does not close issue for non-complete output", async () => {
  const calls = makeStubGhCalls();
  const longOutput = "A".repeat(200) + " Here is my analysis of the issue...";
  const ctx = makeContext();
  const state = makeState({ claudeOutput: longOutput });
  const deps = createMockDeps({
    github: {
      createClient: () => makeStubGhClient(calls),
    },
  });

  const result = await workOnIssueHandleNoChanges(ctx, state, deps);

  assertEquals(result.status, "early_exit");
  // Issue #2849: the partial-answer path now hands off to needs-human.
  assertEquals(
    (result as { reason: string }).reason,
    "analysis_only_handed_off",
  );
  // Issue should NOT be closed for partial answers / hand-offs.
  assertEquals(calls.closeIssue.length, 0);
});

Deno.test("handleNoChanges - posts partial answer for text output", async () => {
  const calls = makeStubGhCalls();
  const longOutput = "A".repeat(200) + " Here is my analysis of the issue...";
  const ctx = makeContext();
  const state = makeState({ claudeOutput: longOutput });
  const deps = createMockDeps({
    github: {
      createClient: () => makeStubGhClient(calls),
    },
  });

  const result = await workOnIssueHandleNoChanges(ctx, state, deps);

  assertEquals(result.status, "early_exit");
  // Issue #2849: no-code-change text output is the analysis-only signal —
  // hand off to needs-human rather than leaving the issue to re-loop.
  assertEquals(
    (result as { reason: string }).reason,
    "analysis_only_handed_off",
  );
});

Deno.test("handleNoChanges - does not add the question label in the partial-answer branch (Issue #1475, #2849)", async () => {
  // Operational labels added by the worker's service account are stripped
  // by the trusted-label security layer (Issue #1344). The worker must not
  // call addLabel(questionLabel) here — instead the comment invites a
  // trusted human to add it themselves.
  //
  // Issue #2849: the path now ALSO hands the analysis-only issue off to
  // `needs-human` (the one operational label the worker is allowed to add,
  // via the sanctioned escalation chokepoint). So `question` must still
  // NOT be added, but `needs-human` is.
  const calls = makeStubGhCalls();
  const longOutput = "A".repeat(200) + " Here is my analysis of the issue...";
  const ctx = makeContext({
    config: makeConfig({ questionLabel: "question" }),
  });
  const state = makeState({ claudeOutput: longOutput });
  const deps = createMockDeps({
    github: {
      createClient: () => makeStubGhClient(calls),
    },
  });

  const result = await workOnIssueHandleNoChanges(ctx, state, deps);

  assertEquals(result.status, "early_exit");
  assertEquals(
    (result as { reason: string }).reason,
    "analysis_only_handed_off",
  );
  // The worker must not add the question label itself — only needs-human.
  assertEquals(
    calls.addLabel.some((c) => c.label === "question"),
    false,
  );
  assertEquals(
    calls.addLabel.some((c) => c.label === ctx.config.needsHumanLabel),
    true,
  );
  // Two comments: the partial answer (with the question-label invite) and
  // the needs-human hand-off explanation.
  assertEquals(calls.postComment.length, 2);
  const body = calls.postComment[0]?.body ?? "";
  assertEquals(body.includes("Partial Answer"), true);
  assertEquals(body.includes("`question`"), true);
  assertEquals(body.includes("trusted reviewer"), true);
  // The worker still unassigns itself (claim released by the hand-off).
  assertEquals(calls.unassignIssue.length, 1);
  assertEquals(calls.unassignIssue[0]?.assignees, ["testbot"]);
});

Deno.test("handleNoChanges - fails for empty output", async () => {
  const ctx = makeContext();
  const state = makeState({ claudeOutput: "" });
  const deps = createMockDeps();

  const result = await workOnIssueHandleNoChanges(ctx, state, deps);

  assertEquals(result.status, "failure");
  assertEquals(
    (result as { reason: string }).reason.includes("No code changes"),
    true,
  );
});

Deno.test("handleNoChanges - fails for short non-completion output", async () => {
  const ctx = makeContext();
  const state = makeState({ claudeOutput: "Error occurred" });
  const deps = createMockDeps();

  const result = await workOnIssueHandleNoChanges(ctx, state, deps);

  assertEquals(result.status, "failure");
});

// ============================================================================
// Phase 4 — Quality Gate
// ============================================================================

Deno.test("qualityGate - continues when quality passes", async () => {
  const ctx = makeContext();
  const state = makeState();
  const deps = createMockDeps();

  const result = await workOnIssueQualityGate(ctx, state, deps);

  assertEquals(result.status, "continue");
});

Deno.test("qualityGate - attempts fix when quality fails then passes", async () => {
  const ctx = makeContext();
  const state = makeState();
  let callCount = 0;
  const deps = createMockDeps({
    quality: {
      runQualityGate: () => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            ok: true,
            value: {
              checks: [],
              summary: { text: "failed", passed: false },
              passed: false,
              output: "lint error",
            },
          });
        }
        return Promise.resolve({
          ok: true,
          value: {
            checks: [],
            summary: { text: "passed", passed: true },
            passed: true,
            output: "all good",
          },
        });
      },
    },
  });

  const result = await workOnIssueQualityGate(ctx, state, deps);

  assertEquals(result.status, "continue");
  assertEquals(callCount, 2);
});

Deno.test("qualityGate - passes quality_fix phase to Claude invocation (Issue #1082)", async () => {
  const ctx = makeContext();
  const state = makeState();
  let capturedPhase: string | undefined;
  let callCount = 0;
  const deps = createMockDeps({
    quality: {
      runQualityGate: () => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            ok: true,
            value: {
              checks: [],
              summary: { text: "failed", passed: false },
              passed: false,
              output: "lint error",
            },
          });
        }
        return Promise.resolve({
          ok: true,
          value: {
            checks: [],
            summary: { text: "passed", passed: true },
            passed: true,
            output: "all good",
          },
        });
      },
    },
    claude: {
      runClaudeWithRetry: ((options: { phase?: string }) => {
        capturedPhase = options.phase;
        return Promise.resolve({
          ok: true,
          value: { output: "fixed", exitCode: 0 },
        });
      }) as unknown as typeof deps.claude.runClaudeWithRetry,
    },
  });

  await workOnIssueQualityGate(ctx, state, deps);

  assertEquals(capturedPhase, "quality_fix");
});

Deno.test("qualityGate - fails after max fix attempts", async () => {
  const ctx = makeContext();
  const state = makeState();
  const deps = createMockDeps({
    quality: {
      runQualityGate: () =>
        Promise.resolve({
          ok: true,
          value: {
            checks: [],
            summary: { text: "failed", passed: false },
            passed: false,
            output: "lint error",
          },
        }),
    },
  });

  const result = await workOnIssueQualityGate(ctx, state, deps);

  assertEquals(result.status, "failure");
  assertEquals(
    (result as { reason: string }).reason.includes("Quality gate failed"),
    true,
  );
});

Deno.test("qualityGate - fails when quality gate errors", async () => {
  const ctx = makeContext();
  const state = makeState();
  const deps = createMockDeps({
    quality: {
      runQualityGate: () =>
        Promise.resolve({ ok: false, error: new Error("Script not found") }),
    },
  });

  const result = await workOnIssueQualityGate(ctx, state, deps);

  assertEquals(result.status, "failure");
  assertEquals(
    (result as { reason: string }).reason.includes("Quality gate error"),
    true,
  );
});

Deno.test("qualityGate - includes baseline context in failure message when baseline failed (Issue #1183)", async () => {
  const ctx = makeContext();
  const state = makeState({
    baselineQualityPassed: false,
    baselineQualityOutput: "pre-existing lint error on line 10",
  });
  let capturedFailureMessage = "";
  const deps = createMockDeps({
    quality: {
      runQualityGate: () =>
        Promise.resolve({
          ok: true,
          value: {
            checks: [],
            summary: { text: "failed", passed: false },
            passed: false,
            output: "lint error",
          },
        }),
    },
    github: {
      handleIssueFailure: ((opts: { failureMessage: string }) => {
        capturedFailureMessage = opts.failureMessage;
        return Promise.resolve({
          ok: true,
          value: {
            markedAsFailed: false,
            markedAsFailedOnce: true,
            failureCategory: "unknown",
            isInfrastructure: false,
          },
        });
      }) as never,
    },
  });

  const result = await workOnIssueQualityGate(ctx, state, deps);

  assertEquals(result.status, "failure");
  assertEquals(
    capturedFailureMessage.includes("already failing"),
    true,
    "Failure message should mention pre-existing failures",
  );
  assertEquals(
    capturedFailureMessage.includes("pre-existing lint error"),
    true,
    "Failure message should include baseline output",
  );
});

Deno.test("qualityGate - excludes baseline context when baseline passed (Issue #1183)", async () => {
  const ctx = makeContext();
  const state = makeState({
    baselineQualityPassed: true,
    baselineQualityOutput: "",
  });
  let capturedFailureMessage = "";
  const deps = createMockDeps({
    quality: {
      runQualityGate: () =>
        Promise.resolve({
          ok: true,
          value: {
            checks: [],
            summary: { text: "failed", passed: false },
            passed: false,
            output: "lint error",
          },
        }),
    },
    github: {
      handleIssueFailure: ((opts: { failureMessage: string }) => {
        capturedFailureMessage = opts.failureMessage;
        return Promise.resolve({
          ok: true,
          value: {
            markedAsFailed: false,
            markedAsFailedOnce: true,
            failureCategory: "unknown",
            isInfrastructure: false,
          },
        });
      }) as never,
    },
  });

  const result = await workOnIssueQualityGate(ctx, state, deps);

  assertEquals(result.status, "failure");
  assertEquals(
    capturedFailureMessage.includes("already failing"),
    false,
    "Failure message should NOT mention pre-existing failures when baseline passed",
  );
});

// ============================================================================
// Phase 5 — Completion
// ============================================================================

Deno.test("completion - creates PR and finalises successfully", async () => {
  const ctx = makeContext();
  const state = makeState();
  const deps = createMockDeps({
    github: {
      runGhCommand: () => Promise.resolve("https://github.com/org/repo/pull/1"),
    },
    pr: {
      findExistingPrForIssue: () =>
        Promise.resolve({ ok: false, error: new Error("No PR found") }),
    },
  });

  const result = await workOnIssueCompletion(ctx, state, deps);

  assertEquals(result.status, "continue");
});

Deno.test("completion - recovers from push failure", async () => {
  const ctx = makeContext();
  const state = makeState();
  // Mock-internal counter drives the fail-then-succeed push; it is NOT asserted
  // on — the observable contract is "a rejected push is recovered and the phase
  // continues", not the exact retry count (Issue #2492).
  let pushAttempt = 0;
  let recoveryAttempted = false;
  const deps = createMockDeps({
    git: {
      pushUnpushedCommits: (() => {
        pushAttempt++;
        if (pushAttempt === 1) {
          return Promise.resolve({ ok: false, error: new Error("rejected") });
        }
        return Promise.resolve({ ok: true, value: 1 });
      }) as unknown as typeof deps.git.pushUnpushedCommits,
      recoverFromPushRejection: (() => {
        recoveryAttempted = true;
        return Promise.resolve({ ok: true, value: "recovered" });
      }) as unknown as typeof deps.git.recoverFromPushRejection,
    },
    github: {
      runGhCommand: () => Promise.resolve("https://github.com/org/repo/pull/1"),
    },
    pr: {
      findExistingPrForIssue: () =>
        Promise.resolve({ ok: false, error: new Error("No PR found") }),
    },
  });

  const result = await workOnIssueCompletion(ctx, state, deps);

  // WHAT, not HOW: a push rejection triggers recovery and the phase continues.
  assertEquals(result.status, "continue");
  assertEquals(
    recoveryAttempted,
    true,
    "Push rejection should trigger recovery",
  );
});

Deno.test("completion - fails when push and recovery both fail", async () => {
  const ctx = makeContext();
  // Issue #1550: skip the in-process retry backoff so this test stays fast.
  ctx.config.infraRetryBackoffMs = 0;
  const state = makeState();
  const deps = createMockDeps({
    git: {
      pushUnpushedCommits: () =>
        Promise.resolve({ ok: false, error: new Error("rejected") }),
      recoverFromPushRejection: () =>
        Promise.resolve({ ok: false, error: new Error("rebase conflict") }),
    },
  });

  const result = await workOnIssueCompletion(ctx, state, deps);

  assertEquals(result.status, "failure");
  assertEquals(
    (result as { reason: string }).reason.includes("recovery unsuccessful"),
    true,
  );
});

Deno.test("completion - reuses existing PR (idempotency)", async () => {
  const ctx = makeContext();
  const state = makeState();
  const deps = createMockDeps({
    pr: {
      findExistingPrForIssue: () =>
        Promise.resolve({
          ok: true,
          value: "https://github.com/org/repo/pull/99",
        }),
    },
  });

  const result = await workOnIssueCompletion(ctx, state, deps);

  assertEquals(result.status, "continue");
});

Deno.test("completion - self-heals when PR creation fails but PR exists", async () => {
  const ctx = makeContext();
  const state = makeState();
  // Mock-internal counter sequences the lookups (not-found until the PR exists);
  // it is NOT asserted on. The observable contract is "the existing PR found
  // after a failed creation is the one recovered" (Issue #2492).
  let lookupAttempt = 0;
  let recoveredPrUrl: string | null = null;
  const deps = createMockDeps({
    github: {
      runGhCommand: () => {
        throw new Error("already exists");
      },
    },
    pr: {
      findExistingPrForIssue: (() => {
        lookupAttempt++;
        // Not found until the self-healing lookup after the creation error.
        if (lookupAttempt <= 2) {
          return Promise.resolve({
            ok: false,
            error: new Error("No PR found"),
          });
        }
        return Promise.resolve({
          ok: true,
          value: "https://github.com/org/repo/pull/99",
        });
      }) as unknown as typeof deps.pr.findExistingPrForIssue,
      recoverExistingPr: ((_repo: string, _issue: number, prUrl: string) => {
        recoveredPrUrl = prUrl;
        return Promise.resolve({ ok: true, value: "recovered" });
      }) as unknown as typeof deps.pr.recoverExistingPr,
    },
  });

  const result = await workOnIssueCompletion(ctx, state, deps);

  // WHAT, not HOW: a failed `gh pr create` self-heals onto the existing PR.
  assertEquals(result.status, "continue");
  assertEquals(
    recoveredPrUrl,
    "https://github.com/org/repo/pull/99",
    "Self-healing should recover the existing PR discovered after the creation error",
  );
});

Deno.test(
  "completion - bails out before gh pr create when branch has zero commits ahead of base (private-repo-22#42 regression)",
  async () => {
    // Repro for the production failure observed on private-repo-22#42:
    //   "PR creation failed: GraphQL: No commits between Develop and
    //    issue-42-eliminate-per-worker-creature-recompilation-in-mul"
    // pushUnpushedCommits succeeded but the branch had no commits ahead of
    // base, so `gh pr create` produced an opaque GraphQL error. The pre-flight
    // check must intercept this and surface a clear, diagnostic failure
    // BEFORE invoking gh.
    const ctx = makeContext();
    const state = makeState();

    let ghPrCreateCalled = false;
    const deps = createMockDeps({
      git: {
        pushUnpushedCommits: (() =>
          Promise.resolve({
            ok: true,
            value: 0,
          })) as unknown as typeof deps.git.pushUnpushedCommits,
        runGitCommand: ((args: string[]) => {
          // The pre-flight check counts commits between base and HEAD.
          if (args[0] === "rev-list" && args[1] === "--count") {
            return Promise.resolve({
              ok: true,
              value: { code: 0, stdout: "0\n", stderr: "" },
            });
          }
          // Diagnostic: report uncommitted changes so the failure message
          // includes the "Claude likely modified files but did not commit"
          // hint, mirroring the most common production cause.
          if (args[0] === "status" && args[1] === "--porcelain") {
            return Promise.resolve({
              ok: true,
              value: { code: 0, stdout: " M src/foo.ts\n", stderr: "" },
            });
          }
          return Promise.resolve({
            ok: true,
            value: { code: 0, stdout: "", stderr: "" },
          });
        }) as unknown as typeof deps.git.runGitCommand,
      },
      github: {
        runGhCommand: (() => {
          ghPrCreateCalled = true;
          return Promise.resolve("https://github.com/org/repo/pull/999");
        }) as unknown as typeof deps.github.runGhCommand,
      },
    });

    const result = await workOnIssueCompletion(ctx, state, deps);

    assertEquals(result.status, "failure");
    const reason = (result as { reason: string }).reason;
    assertEquals(
      reason.includes("no commits ahead"),
      true,
      `Failure reason should call out the empty-branch state. Got: ${reason}`,
    );
    assertEquals(
      reason.includes("uncommitted changes"),
      true,
      `Failure reason should include the uncommitted-changes diagnostic. Got: ${reason}`,
    );
    assertEquals(
      ghPrCreateCalled,
      false,
      "gh pr create MUST NOT be invoked when the branch has zero commits ahead of base",
    );
  },
);

Deno.test("completion - adds milestone section when milestone present", async () => {
  const ctx = makeContext({ milestoneTitle: "OIDC Auth" });
  const state = makeState({ milestoneBranch: "milestone/oidc-auth" });
  let prBody = "";
  const deps = createMockDeps({
    github: {
      runGhCommand: ((args: string[]) => {
        const bodyIdx = args.indexOf("--body");
        if (bodyIdx >= 0) {
          prBody = args[bodyIdx + 1] ?? "";
        }
        return Promise.resolve("https://github.com/org/repo/pull/1");
      }) as unknown as typeof deps.github.runGhCommand,
    },
    pr: {
      findExistingPrForIssue: () =>
        Promise.resolve({ ok: false, error: new Error("No PR found") }),
    },
  });

  const result = await workOnIssueCompletion(ctx, state, deps);

  assertEquals(result.status, "continue");
  assertEquals(prBody.includes("Closes #42"), true);
});

// Issue #1136 supersedes the Issue #1125 skip below. #1125 skipped auto-merge
// for "milestone PRs", but the PR this path raises is a milestone *child* — the
// worker branch into `milestone/**` — not the summary PR into the default
// branch, which `milestone_completion.ts` raises and `decideSummaryPrMerge`
// re-gates at merge time (Issue #3909). The skip therefore left every child PR
// unarmed at creation, so the only mechanism that could land it was the
// once-per-cycle sweep that runs *before* the work which creates it. PR #1133
// sat green and unmerged for 51 minutes as a result.
Deno.test("completion - arms auto-merge on a milestone child PR at creation (Issue #1136)", async () => {
  const ctx = makeContext({ milestoneTitle: "OIDC Auth" });
  const state = makeState({ milestoneBranch: "milestone/oidc-auth" });
  let capturedSkipAutoMerge: boolean | undefined;
  const deps = createMockDeps({
    github: {
      runGhCommand: () => Promise.resolve("https://github.com/org/repo/pull/5"),
    },
    pr: {
      findExistingPrForIssue: () =>
        Promise.resolve({ ok: false, error: new Error("No PR found") }),
      finalisePr: ((opts: { skipAutoMerge?: boolean }) => {
        capturedSkipAutoMerge = opts.skipAutoMerge;
        return Promise.resolve({ ok: true, value: "finalised" });
      }) as unknown as typeof deps.pr.finalisePr,
    },
  });

  const result = await workOnIssueCompletion(ctx, state, deps);

  assertEquals(result.status, "continue");
  assertEquals(
    capturedSkipAutoMerge,
    false,
    "A milestone child PR is armed at creation, not left for the next cycle",
  );
});

Deno.test("completion - enables auto-merge for non-milestone PRs (Issue #1125)", async () => {
  const ctx = makeContext(); // no milestoneTitle
  const state = makeState(); // no milestoneBranch
  let capturedSkipAutoMerge: boolean | undefined;
  const deps = createMockDeps({
    github: {
      runGhCommand: () => Promise.resolve("https://github.com/org/repo/pull/5"),
    },
    pr: {
      findExistingPrForIssue: () =>
        Promise.resolve({ ok: false, error: new Error("No PR found") }),
      finalisePr: ((opts: { skipAutoMerge?: boolean }) => {
        capturedSkipAutoMerge = opts.skipAutoMerge;
        return Promise.resolve({ ok: true, value: "finalised" });
      }) as unknown as typeof deps.pr.finalisePr,
    },
  });

  const result = await workOnIssueCompletion(ctx, state, deps);

  assertEquals(result.status, "continue");
  assertEquals(
    capturedSkipAutoMerge,
    false,
    "Auto-merge should be enabled for non-milestone PRs",
  );
});

Deno.test("completion - the arming outcome is logged at PR creation (Issue #1136)", async () => {
  // Arming is now the primary mechanism, so a refusal on this path must not
  // be silent — the same lesson as Issue #470, applied where the sweep's
  // `recordOutcome` does not reach.
  const ctx = makeContext({ milestoneTitle: "OIDC Auth" });
  const state = makeState({ milestoneBranch: "milestone/oidc-auth" });
  const logMessages: string[] = [];
  const deps = createMockDeps({
    github: {
      runGhCommand: () => Promise.resolve("https://github.com/org/repo/pull/5"),
    },
    pr: {
      findExistingPrForIssue: () =>
        Promise.resolve({ ok: false, error: new Error("No PR found") }),
      finalisePr: (() =>
        Promise.resolve({
          ok: true,
          value: "PR #5 left on milestone/oidc-auth: checks pending",
        })) as unknown as typeof deps.pr.finalisePr,
    },
  });
  const originalInfo = deps.logger.info;
  deps.logger.info = ((msg: string, data?: Record<string, unknown>) => {
    logMessages.push(msg);
    return originalInfo.call(deps.logger, msg, data);
  }) as typeof deps.logger.info;

  const result = await workOnIssueCompletion(ctx, state, deps);

  assertEquals(result.status, "continue");
  assertEquals(
    logMessages.some((m) =>
      m.includes("Auto-merge armed at creation") && m.includes("checks pending")
    ),
    true,
    `expected the arming outcome in the log: ${logMessages.join(" | ")}`,
  );
});

// Issue #1136: the recovery path arms the same way the creation path does —
// see the note above the milestone child test.
Deno.test("completion - arms auto-merge on a recovered milestone child PR (idempotency, Issue #1136)", async () => {
  const ctx = makeContext({ milestoneTitle: "OIDC Auth" });
  const state = makeState({ milestoneBranch: "milestone/oidc-auth" });
  let capturedSkipAutoMerge: boolean | undefined;
  const deps = createMockDeps({
    pr: {
      findExistingPrForIssue: () =>
        Promise.resolve({
          ok: true,
          value: "https://github.com/org/repo/pull/99",
        }),
      finalisePr: ((opts: { skipAutoMerge?: boolean }) => {
        capturedSkipAutoMerge = opts.skipAutoMerge;
        return Promise.resolve({ ok: true, value: "finalised" });
      }) as unknown as typeof deps.pr.finalisePr,
    },
  });

  const result = await workOnIssueCompletion(ctx, state, deps);

  assertEquals(result.status, "continue");
  assertEquals(
    capturedSkipAutoMerge,
    false,
    "A recovered milestone child PR is armed too — the sweep is the backstop",
  );
});

Deno.test("completion - uses PR summary file content in body", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "completion-summary-test-" });
  try {
    const summaryContent = "## Summary\n\nFixed the login bug. Closes #42.";
    await Deno.mkdir(`${tmpDir}/docs`, { recursive: true });
    await Deno.writeTextFile(`${tmpDir}/docs/pr-summary-42.md`, summaryContent);

    const ctx = makeContext();
    const state = makeState({ repoPath: tmpDir });
    let capturedBody = "";
    const deps = createMockDeps({
      github: {
        runGhCommand: ((args: string[]) => {
          const bodyIndex = args.indexOf("--body");
          if (bodyIndex >= 0) {
            capturedBody = args[bodyIndex + 1]!;
          }
          return Promise.resolve("https://github.com/org/repo/pull/1");
        }) as unknown as typeof deps.github.runGhCommand,
      },
      pr: {
        findExistingPrForIssue: () =>
          Promise.resolve({ ok: false, error: new Error("No PR found") }),
      },
    });

    const result = await workOnIssueCompletion(ctx, state, deps);

    assertEquals(result.status, "continue");
    assertEquals(
      capturedBody.includes("Fixed the login bug"),
      true,
      "PR body should contain summary file content",
    );
    assertEquals(
      capturedBody.includes("Closes #42"),
      true,
      "PR body should contain closing keyword from summary",
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("completion - falls back to minimal body when no summary file exists", async () => {
  const tmpDir = await Deno.makeTempDir({
    prefix: "completion-nosummary-test-",
  });
  try {
    const ctx = makeContext();
    const state = makeState({ repoPath: tmpDir });
    let capturedBody = "";
    const deps = createMockDeps({
      github: {
        runGhCommand: ((args: string[]) => {
          const bodyIndex = args.indexOf("--body");
          if (bodyIndex >= 0) {
            capturedBody = args[bodyIndex + 1]!;
          }
          return Promise.resolve("https://github.com/org/repo/pull/1");
        }) as unknown as typeof deps.github.runGhCommand,
      },
      pr: {
        findExistingPrForIssue: () =>
          Promise.resolve({ ok: false, error: new Error("No PR found") }),
      },
    });

    const result = await workOnIssueCompletion(ctx, state, deps);

    assertEquals(result.status, "continue");
    assertEquals(
      capturedBody.includes("## Summary"),
      true,
      "Fallback body should have Summary heading",
    );
    assertEquals(
      capturedBody.includes("Closes #42"),
      true,
      "Fallback body should reference issue",
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("completion - recovers existing PR by branch name when issue-number check fails (Issue #1189)", async () => {
  const ctx = makeContext();
  const state = makeState();
  let recoverCalled = false;
  let recoverBody = "";
  const deps = createMockDeps({
    pr: {
      findExistingPrForIssue: () =>
        Promise.resolve({ ok: false, error: new Error("No PR found") }),
      findExistingPrForBranch: () =>
        Promise.resolve({
          ok: true,
          value: "https://github.com/org/repo/pull/77",
        }),
      recoverExistingPr: ((
        _repo: string,
        _issueNumber: number,
        _prUrl: string,
        prBody?: string,
      ) => {
        recoverCalled = true;
        recoverBody = prBody ?? "";
        return Promise.resolve({ ok: true, value: "recovered" });
      }) as unknown as typeof deps.pr.recoverExistingPr,
    },
  });

  const result = await workOnIssueCompletion(ctx, state, deps);

  assertEquals(result.status, "continue");
  assertEquals(
    recoverCalled,
    true,
    "recoverExistingPr should be called for branch-name match",
  );
  assertEquals(
    recoverBody.includes("Closes #42"),
    true,
    "Recovery should pass PR body with issue reference",
  );
});

Deno.test("completion - updates existing PR body on issue-number recovery (Issue #1189)", async () => {
  const ctx = makeContext();
  const state = makeState();
  let recoverBody = "";
  const deps = createMockDeps({
    pr: {
      findExistingPrForIssue: () =>
        Promise.resolve({
          ok: true,
          value: "https://github.com/org/repo/pull/99",
        }),
      recoverExistingPr: ((
        _repo: string,
        _issueNumber: number,
        _prUrl: string,
        prBody?: string,
      ) => {
        recoverBody = prBody ?? "";
        return Promise.resolve({ ok: true, value: "recovered" });
      }) as unknown as typeof deps.pr.recoverExistingPr,
    },
  });

  const result = await workOnIssueCompletion(ctx, state, deps);

  assertEquals(result.status, "continue");
  assertEquals(
    recoverBody.length > 0,
    true,
    "PR body should be passed to recovery",
  );
  assertEquals(
    recoverBody.includes("Closes #42"),
    true,
    "Recovered body should reference issue",
  );
});

Deno.test("completion - updates existing PR labels on recovery (Issue #1189)", async () => {
  // The issue is `bug`-labelled, so the reproduction-status gate (Issue #521)
  // now requires a `## Reproduction` block in the PR summary before the PR is
  // raised or recovered. The summary file is written here so this test keeps
  // exercising label propagation rather than the new gate.
  const repoPath = await Deno.makeTempDir();
  await Deno.mkdir(`${repoPath}/docs/archive/pr-summaries`, {
    recursive: true,
  });
  await Deno.writeTextFile(
    `${repoPath}/docs/archive/pr-summaries/pr-summary-42.md`,
    `## Summary

Fixed the login button. Closes #42.

## Reproduction

- **symptom** — the login button did nothing on click
- **status** — \`verified\` — the regression test failed against the unfixed code and passes after the fix
- **regression test** — \`tests/auth/login_test.ts::submits the form\`
`,
  );

  const ctx = makeContext({ issueLabels: ["bug", "priority-high"] });
  const state = makeState({ repoPath });
  let labelsCaptured: string[] = [];
  const deps = createMockDeps({
    pr: {
      findExistingPrForIssue: () =>
        Promise.resolve({
          ok: true,
          value: "https://github.com/org/repo/pull/99",
        }),
      recoverExistingPr: () =>
        Promise.resolve({ ok: true, value: "recovered" }),
      updatePrLabels: ((_repo: string, _prNumber: number, labels: string[]) => {
        labelsCaptured = labels;
        return Promise.resolve({ ok: true, value: undefined });
      }) as unknown as typeof deps.pr.updatePrLabels,
    },
  });

  const result = await workOnIssueCompletion(ctx, state, deps);

  assertEquals(result.status, "continue");
  assertEquals(
    labelsCaptured.includes("bug"),
    true,
    "Issue labels should be applied to existing PR",
  );
  assertEquals(
    labelsCaptured.includes("priority-high"),
    true,
    "All issue labels should be applied",
  );

  await Deno.remove(repoPath, { recursive: true });
});

Deno.test("completion - defence-in-depth re-checks by issue number after branch check fails (Issue #1189)", async () => {
  const ctx = makeContext();
  const state = makeState();
  // Mock-internal counter makes the issue-number pre-check miss first, so the
  // defence-in-depth re-check is the lookup that finds the PR. The counter is
  // NOT asserted on — the observable contract is "the PR found by the
  // defence-in-depth re-check is the one recovered" (Issue #2492).
  let issueLookupAttempt = 0;
  let recoveredPrUrl: string | null = null;
  const deps = createMockDeps({
    pr: {
      findExistingPrForIssue: (() => {
        issueLookupAttempt++;
        if (issueLookupAttempt === 1) {
          return Promise.resolve({
            ok: false,
            error: new Error("No PR found"),
          });
        }
        return Promise.resolve({
          ok: true,
          value: "https://github.com/org/repo/pull/88",
        });
      }) as unknown as typeof deps.pr.findExistingPrForIssue,
      findExistingPrForBranch: () =>
        Promise.resolve({ ok: false, error: new Error("No PR found") }),
      recoverExistingPr: ((_repo: string, _issue: number, prUrl: string) => {
        recoveredPrUrl = prUrl;
        return Promise.resolve({ ok: true, value: "recovered" });
      }) as unknown as typeof deps.pr.recoverExistingPr,
    },
  });

  const result = await workOnIssueCompletion(ctx, state, deps);

  // WHAT, not HOW: when the branch check misses, the defence-in-depth re-check
  // by issue number finds the PR and that PR is the one recovered.
  assertEquals(result.status, "continue");
  assertEquals(
    recoveredPrUrl,
    "https://github.com/org/repo/pull/88",
    "Defence-in-depth re-check should recover the PR it found by issue number",
  );
});

// ============================================================================
// Orchestrator — workOnIssue
// ============================================================================

Deno.test({
  name: "workOnIssue - runs all phases successfully",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const ctx = makeContext({
      issueBody:
        "Fix the bug in `src/auth/login.ts:45` where the handler returns null",
    });
    const deps = createMockDeps({
      git: {
        runGitCommand: ((args: string[]) => {
          if (
            args[0] === "log" && args.length > 1 &&
            typeof args[1] === "string" && args[1].includes("..HEAD")
          ) {
            return Promise.resolve({
              ok: true,
              value: { code: 0, stdout: "abc123 Fix login", stderr: "" },
            });
          }
          return Promise.resolve({
            ok: true,
            value: { code: 0, stdout: "", stderr: "" },
          });
        }) as unknown as typeof deps.git.runGitCommand,
      },
      github: {
        runGhCommand: () =>
          Promise.resolve("https://github.com/org/repo/pull/1"),
      },
      pr: {
        findExistingPrForIssue: () =>
          Promise.resolve({ ok: false, error: new Error("No PR found") }),
      },
    });

    const result = await workOnIssue(ctx, deps);

    assertEquals(result.success, true);
    assertEquals(result.phase, "completion");
    // The run outcome names the PR the completion phase raised (Issue #4325).
    assertEquals(result.outcome, {
      kind: "pr",
      prUrl: "https://github.com/org/repo/pull/1",
      prNumber: 1,
    });
    assertEquals(typeof result.timings.setup, "number");
    assertEquals(typeof result.timings.clarity, "number");
    assertEquals(typeof result.timings.baseline_quality, "number");
    assertEquals(typeof result.timings.execute, "number");
    assertEquals(typeof result.timings.quality_gate, "number");
    assertEquals(typeof result.timings.completion, "number");
  },
});

Deno.test(
  "workOnIssue - bare idle-task label (non-wrapper title/body) passes the guard and is worked normally",
  async () => {
    // `idle-task` is just the lowest of the four work-trigger
    // priorities, NOT a scan-only marker. An idle-task issue whose
    // title and body match no registered template is ordinary work, so
    // the guard must NOT fire on the bare label — execution proceeds
    // into the standard pipeline. (The guard only keys on genuine
    // wrapper signals: a title or body fingerprint match.) We reach
    // setup (not idle_task_guard); the mock claim error proves we
    // passed the guard.
    const ctx = makeContext({
      issueLabels: ["idle-task"],
      issueTitle: "dead-code: unused export `foo` in src/bar.ts",
      issueBody: "Remove the unused export `foo`.",
    });
    const deps = createMockDeps({
      issues: {
        claimIssue: () =>
          Promise.resolve({ ok: false, error: new Error("mock claim error") }),
      },
    });
    const result = await workOnIssue(ctx, deps);
    assertEquals(result.phase, "setup");
  },
);

Deno.test(
  "workOnIssue - refuses to run when title matches a registered template (Issue #2083 guard)",
  async () => {
    // Regression: private-repo-22#97 lost its `idle-task` label yet
    // its title still read "Run a security scan". The orchestrator
    // must catch this by title and bail out.
    const ctx = makeContext({
      issueTitle: "Run a security scan",
      issueLabels: ["failed-once"],
    });
    const deps = createMockDeps();
    const result = await workOnIssue(ctx, deps);
    assertEquals(result.success, false);
    assertEquals(result.phase, "idle_task_guard");
  },
);

Deno.test(
  "workOnIssue - normal issues bypass the idle-task guard",
  async () => {
    // Sanity: the guard must not block ordinary issues. We only need
    // to confirm execution proceeds past the guard — the setup phase
    // will fail on the mock claim, which is fine for this assertion.
    const ctx = makeContext({
      issueTitle: "Fix the date parser",
      issueLabels: ["bug"],
    });
    const deps = createMockDeps({
      issues: {
        claimIssue: () =>
          Promise.resolve({ ok: false, error: new Error("mock claim error") }),
      },
    });
    const result = await workOnIssue(ctx, deps);
    // We reach setup (not idle_task_guard) — the failure category
    // proves we passed the guard.
    assertEquals(result.phase, "setup");
    // A failed run carries a no_pr outcome naming the dying phase and the
    // raw reason (Issue #4325); the category is detectFailureCategory's.
    assertEquals(result.outcome?.kind, "no_pr");
    if (result.outcome?.kind === "no_pr") {
      assertEquals(result.outcome.phase, "setup");
      assertEquals(result.outcome.message, result.reason);
    }
  },
);

Deno.test(
  "workOnIssue - refuses to run when body matches a template fingerprint (Issue #2087)",
  async () => {
    // Regression: VibeCoder#2086 saw a security-scan wrapper drop
    // into the standard pipeline because both its label and title had
    // changed in flight. The body fingerprint catches this last-ditch
    // scenario — the prompt's distinctive H1 heading is enough to bail
    // out before the standard pipeline runs Claude and posts a
    // Partial Answer.
    const ctx = makeContext({
      issueTitle: "Investigate dependency bloat",
      issueLabels: ["bug"],
      issueBody: "# MythOS-style Security Audit — Four-Phase Scan (v2)\n\n" +
        "You are a security auditor performing a static, evidence-backed " +
        "audit...",
    });
    const deps = createMockDeps();
    const result = await workOnIssue(ctx, deps);
    assertEquals(result.success, false);
    assertEquals(result.phase, "idle_task_guard");
  },
);

Deno.test("workOnIssue #53 - a repository-admin finding hands off to needs-human before setup/execute", async () => {
  const ctx = makeContext({
    issueBody:
      "<!-- finding-id: BP-REPO-RULESET-NO-REVIEW -->\n\n## Suggested fix\n\n" +
      "Repository admin action — the worker cannot change repository settings. " +
      "Settings → Rules → require a review.",
  });
  let claudeRan = false;
  const deps = createMockDeps({
    claude: {
      runClaudeWithRetry: () => {
        claudeRan = true;
        return Promise.resolve({
          ok: true,
          value: { exitCode: 0, output: "", timedOut: false },
        }) as never;
      },
    },
  });

  const result = await workOnIssue(ctx, deps);

  assertEquals(result.success, true, "a clean hand-off is not a failure");
  assertEquals(result.phase, "admin_only_handoff");
  assertEquals(result.reason, "admin_only_finding");
  assertEquals(claudeRan, false, "the agent must not run for an admin finding");
});

Deno.test("workOnIssue - stops at setup failure", async () => {
  const ctx = makeContext();
  const deps = createMockDeps({
    issues: {
      claimIssue: () =>
        Promise.resolve({ ok: false, error: new Error("API error") }),
    },
  });

  const result = await workOnIssue(ctx, deps);

  assertEquals(result.success, false);
  assertEquals(result.phase, "setup");
});

Deno.test("workOnIssue - claim churn escalation returns failure not success", async () => {
  const ctx = makeContext();
  const deps = createMockDeps({
    issues: {
      checkClaimChurn: () =>
        Promise.resolve({
          ok: true,
          value: { churnCount: 5, escalated: true },
        }),
    },
  });

  const result = await workOnIssue(ctx, deps);

  assertEquals(
    result.success,
    false,
    "churn escalation must not be treated as success",
  );
  assertEquals(result.phase, "setup");
  assertEquals(result.reason, "claim_churn_escalation");
});

Deno.test("workOnIssue - early exits at clarity phase gracefully", async () => {
  const config = makeConfig();
  const ctx = makeContext({
    issueLabels: [config.refineIssueLabel],
    config,
  });
  const calls = makeStubGhCalls();
  const deps = createMockDeps({
    github: {
      createClient: () => makeStubGhClient(calls),
    },
  });

  const result = await workOnIssue(ctx, deps);

  assertEquals(result.success, true);
  assertEquals(result.phase, "clarity");
  assertEquals(result.reason, "refine_label_routing");
  // Clarity early-exit must release the claim so refinement can pick up.
  assertEquals(calls.unassignIssue.length, 1);
});

Deno.test({
  name: "workOnIssue - handles no-changes flow",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const ctx = makeContext({
      issueBody:
        "Fix the bug in `src/auth/login.ts:45` where the handler returns null",
    });
    const deps = createMockDeps({
      claude: {
        runClaudeWithRetry: () =>
          Promise.resolve({
            ok: true,
            value: {
              exitCode: 0,
              // Issue #241: cited evidence is required to close.
              output:
                "The fix is already implemented in PR #100. No changes needed.",
              timedOut: false,
            },
          }),
      },
      git: {
        runGitCommand: () =>
          Promise.resolve({
            ok: true,
            value: { code: 0, stdout: "", stderr: "" },
          }),
      },
      pr: {
        findExistingPrForIssue: () =>
          Promise.resolve({ ok: false, error: new Error("No PR found") }),
      },
    });

    const result = await workOnIssue(ctx, deps);

    assertEquals(result.success, true);
    assertEquals(result.phase, "handle_no_changes");
    assertEquals(result.reason, "already_complete");
  },
});

Deno.test({
  name:
    "workOnIssue - suspicious untrusted image flag escalates to needs-human and does not act (Issue #3389)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const calls = makeStubGhCalls();
    const ctx = makeContext({
      issueBody: "Implement the parser fix in `src/parser.ts`.",
    });
    // Claude ran, viewed an untrusted image, and flagged it — even though it
    // also produced a code change, the worker must NOT act on the image.
    const deps = createMockDeps({
      github: {
        createClient: () => makeStubGhClient(calls),
      },
      claude: {
        runClaudeWithRetry: () =>
          Promise.resolve({
            ok: true,
            value: {
              exitCode: 0,
              output: [
                "I inspected the attached screenshot.",
                '<!-- vibe-suspicious-image-detected source="issue attachment" reason="low-contrast text tells the agent to run a shell command" -->',
                "Per policy I will not act on the image.",
              ].join("\n"),
              timedOut: false,
            },
          }),
      },
      pr: {
        findExistingPrForIssue: () =>
          Promise.resolve({ ok: false, error: new Error("No PR found") }),
      },
    });

    const result = await workOnIssue(ctx, deps);

    // Clean flag-and-stop — success, dedicated phase, not a failure.
    assertEquals(result.success, true);
    assertEquals(result.phase, "suspicious_image_handoff");
    assertEquals(result.reason, "suspicious_image_flagged");
    // The worker did NOT proceed to act on the image: no quality gate,
    // no completion / PR phase ran.
    assertEquals(result.timings["quality_gate"], undefined);
    assertEquals(result.timings["completion"], undefined);
    // needs-human applied, explanation comment posted, claim released.
    assertEquals(
      calls.addLabel.some((c) => c.label === ctx.config.needsHumanLabel),
      true,
    );
    assertEquals(calls.postComment.length, 1);
    assertEquals(
      calls.postComment[0]!.body.includes("Suspicious untrusted image"),
      true,
    );
    assertEquals(calls.unassignIssue.length, 1);
  },
});

Deno.test({
  name:
    "workOnIssue - up-front analysis-only marker hands off to needs-human before running Claude (Issue #2849)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const calls = makeStubGhCalls();
    let claudeRan = false;
    const ctx = makeContext({
      issueBody:
        "Produce a coverage matrix for the auth module.\n\n<!-- analysis-only -->\n",
    });
    const deps = createMockDeps({
      github: {
        createClient: () => makeStubGhClient(calls),
      },
      claude: {
        runClaudeWithRetry: () => {
          claudeRan = true;
          return Promise.resolve({
            ok: true,
            value: { exitCode: 0, output: "", timedOut: false },
          });
        },
      },
      pr: {
        findExistingPrForIssue: () =>
          Promise.resolve({ ok: false, error: new Error("No PR found") }),
      },
    });

    const result = await workOnIssue(ctx, deps);

    // Clean hand-off — success, dedicated phase, not a failure.
    assertEquals(result.success, true);
    assertEquals(result.phase, "analysis_only_handoff");
    assertEquals(result.reason, "analysis_only_marker");
    // Claude was never run, and no setup/execute phase ran.
    assertEquals(claudeRan, false);
    assertEquals(result.timings["execute"], undefined);
    assertEquals(result.timings["setup"], undefined);
    // needs-human applied, explanation comment posted, claim released.
    assertEquals(
      calls.addLabel.some((c) => c.label === ctx.config.needsHumanLabel),
      true,
    );
    assertEquals(calls.postComment.length, 1);
    assertEquals(calls.unassignIssue.length, 1);
  },
});

Deno.test({
  name:
    "workOnIssue - suspicious-image flag in Claude output hands off to needs-human and raises no PR (Issue #3389)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const calls = makeStubGhCalls();
    let prCreated = false;
    const ctx = makeContext({
      issueBody: "Fix the layout described in the attached screenshot.",
    });
    const deps = createMockDeps({
      github: {
        createClient: () => makeStubGhClient(calls),
        // Only a real creation counts (Issue #344): read-only `gh` calls —
        // the pre-write claim-freshness `gh issue view` among them — are not
        // PR creations, and the assertion below is about raising a PR.
        runGhCommand: (args: string[]) => {
          if (args[0] === "pr" && args[1] === "create") prCreated = true;
          return Promise.resolve("https://github.com/org/repo/pull/1");
        },
      },
      claude: {
        runClaudeWithRetry: () =>
          Promise.resolve({
            ok: true,
            value: {
              exitCode: 0,
              output:
                "The attached image contains overlaid instructions aimed at an AI " +
                "agent. I will not act on it.\n" +
                '<!-- vibe-suspicious-image-detected source="issue #42 attachment" ' +
                'reason="low-contrast text telling the agent to exfiltrate secrets" -->',
              timedOut: false,
            },
          }),
      },
      pr: {
        findExistingPrForIssue: () =>
          Promise.resolve({ ok: false, error: new Error("No PR found") }),
      },
    });

    const result = await workOnIssue(ctx, deps);

    // Clean hand-off — success, dedicated phase, not a failure.
    assertEquals(result.success, true);
    assertEquals(result.phase, "suspicious_image_handoff");
    assertEquals(result.reason, "suspicious_image_flagged");
    // needs-human applied + explanation comment posted + claim released.
    assertEquals(
      calls.addLabel.some((c) => c.label === ctx.config.needsHumanLabel),
      true,
    );
    assertEquals(calls.postComment.length, 1);
    assertStringIncludes(calls.postComment[0]!.body, "issue #42 attachment");
    assertEquals(calls.unassignIssue.length, 1);
    // Crucially, the worker never proceeded to raise a PR on the flagged image.
    assertEquals(prCreated, false);
    // The quality-gate / completion phases never ran.
    assertEquals(result.timings["completion"], undefined);
  },
});

Deno.test({
  name: "workOnIssue - records timings for all phases",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const ctx = makeContext({
      issueBody:
        "Fix the bug in `src/auth/login.ts:45` where the handler returns null",
    });
    const deps = createMockDeps({
      git: {
        runGitCommand: ((args: string[]) => {
          if (
            args[0] === "log" && args.length > 1 &&
            typeof args[1] === "string" && args[1].includes("..HEAD")
          ) {
            return Promise.resolve({
              ok: true,
              value: { code: 0, stdout: "abc123 Fix", stderr: "" },
            });
          }
          return Promise.resolve({
            ok: true,
            value: { code: 0, stdout: "", stderr: "" },
          });
        }) as unknown as typeof deps.git.runGitCommand,
      },
      github: {
        runGhCommand: () =>
          Promise.resolve("https://github.com/org/repo/pull/1"),
      },
      pr: {
        findExistingPrForIssue: () =>
          Promise.resolve({ ok: false, error: new Error("No PR found") }),
      },
    });

    const result = await workOnIssue(ctx, deps);

    assertEquals(result.success, true);
    // All phase timings should be recorded
    const expectedPhases = [
      "setup",
      "clarity",
      "baseline_quality",
      "execute",
      "quality_gate",
      "completion",
    ];
    for (const phase of expectedPhases) {
      assertEquals(
        typeof result.timings[phase],
        "number",
        `Expected timing for phase: ${phase}`,
      );
      assertEquals(
        result.timings[phase]! >= 0,
        true,
        `Timing for ${phase} should be non-negative`,
      );
    }
  },
});

// ============================================================================
// Issue #1190 — Documentation label bypass
// ============================================================================

Deno.test("clarityPhase - documentation label bypasses clarity assessment", async () => {
  const config = makeConfig();
  const ctx = makeContext({
    issueLabels: ["documentation"],
    issueBody: "",
    issueTitle: "Update README",
    config,
  });
  const state = makeState();
  const deps = createMockDeps();

  const result = await workOnIssueClarityPhase(ctx, state, deps);

  assertEquals(result.status, "continue");
  assertEquals(state.clarityStatus, "skipped");
});

// ============================================================================
// Issue #1190, #844 — Prompt revision logging
// ============================================================================

Deno.test("executeClaude - logs the prompts commit before execution", async () => {
  const ctx = makeContext();
  const state = makeState();
  const logMessages: string[] = [];
  const deps = createMockDeps({
    infrastructure: {
      buildPrompt: () =>
        Promise.resolve({
          ok: true,
          value: { systemPrompt: "mock system", prompt: "mock prompt" },
        }),
    },
  });
  const originalInfo = deps.logger.info;
  deps.logger.info = ((msg: string, _data?: Record<string, unknown>) => {
    logMessages.push(msg);
    return originalInfo.call(deps.logger, msg, _data);
  }) as typeof deps.logger.info;

  await workOnIssueExecuteClaude(ctx, state, deps);

  // Issue #844: versions are gone; the checkout's commit hash is what pins
  // the prompt text a run used.
  const commitLog = logMessages.find((m) => m.includes("prompts from commit"));
  assertEquals(
    commitLog !== undefined,
    true,
    "Should log the prompts commit before Claude execution",
  );
});

// ============================================================================
// Issue #1190 — Worker footer in PR body
// ============================================================================

Deno.test("completion - includes worker footer in PR body", async () => {
  const ctx = makeContext({ config: makeConfig({ workerName: "TestWorker" }) });
  const state = makeState();
  let prBody = "";
  const deps = createMockDeps({
    github: {
      runGhCommand: ((args: string[]) => {
        const bodyIdx = args.indexOf("--body");
        if (bodyIdx >= 0) {
          prBody = args[bodyIdx + 1] ?? "";
        }
        return Promise.resolve("https://github.com/org/repo/pull/1");
      }) as unknown as typeof deps.github.runGhCommand,
    },
    pr: {
      findExistingPrForIssue: () =>
        Promise.resolve({ ok: false, error: new Error("No PR found") }),
    },
  });

  const result = await workOnIssueCompletion(ctx, state, deps);

  assertEquals(result.status, "continue");
  assertEquals(
    prBody.includes("Processed by: TestWorker"),
    true,
    "PR body should include worker footer",
  );
});

// ============================================================================
// Milestone branch targeting regression tests (Issue #1295)
// ============================================================================

Deno.test("executeClaude - passes milestoneBranch to buildPrompt when milestone present (Issue #1295)", async () => {
  const ctx = makeContext({ milestoneTitle: "OIDC Authentication" });
  const state = makeState({ milestoneBranch: "milestone/oidc-authentication" });

  let capturedOptions: Record<string, unknown> | undefined;
  const deps = createMockDeps({
    infrastructure: {
      buildPrompt: ((options: Record<string, unknown>) => {
        capturedOptions = options;
        return Promise.resolve({
          ok: true,
          value: { systemPrompt: "mock system", prompt: "mock prompt" },
        });
      }) as unknown as typeof deps.infrastructure.buildPrompt,
    },
  });

  await workOnIssueExecuteClaude(ctx, state, deps);

  assertEquals(
    capturedOptions !== undefined,
    true,
    "buildPrompt should have been called",
  );
  assertEquals(
    capturedOptions!.milestoneBranch,
    "milestone/oidc-authentication",
    "milestoneBranch must be passed to buildPrompt so Claude receives targeting instructions",
  );
});

Deno.test("executeClaude - does not pass milestoneBranch to buildPrompt when no milestone (Issue #1295)", async () => {
  const ctx = makeContext(); // no milestoneTitle
  const state = makeState(); // no milestoneBranch

  let capturedOptions: Record<string, unknown> | undefined;
  const deps = createMockDeps({
    infrastructure: {
      buildPrompt: ((options: Record<string, unknown>) => {
        capturedOptions = options;
        return Promise.resolve({
          ok: true,
          value: { systemPrompt: "mock system", prompt: "mock prompt" },
        });
      }) as unknown as typeof deps.infrastructure.buildPrompt,
    },
  });

  await workOnIssueExecuteClaude(ctx, state, deps);

  assertEquals(
    capturedOptions !== undefined,
    true,
    "buildPrompt should have been called",
  );
  assertEquals(
    capturedOptions!.milestoneBranch ?? "",
    "",
    "milestoneBranch should be absent or empty when no milestone is set",
  );
});

Deno.test("completion - passes --base milestone branch to gh pr create (Issue #1295)", async () => {
  const ctx = makeContext({ milestoneTitle: "OIDC Auth" });
  const state = makeState({ milestoneBranch: "milestone/oidc-auth" });

  let capturedBase = "";
  const deps = createMockDeps({
    github: {
      runGhCommand: ((args: string[]) => {
        const baseIdx = args.indexOf("--base");
        if (baseIdx >= 0) {
          capturedBase = args[baseIdx + 1] ?? "";
        }
        return Promise.resolve("https://github.com/org/repo/pull/1");
      }) as unknown as typeof deps.github.runGhCommand,
    },
    pr: {
      findExistingPrForIssue: () =>
        Promise.resolve({ ok: false, error: new Error("No PR found") }),
    },
  });

  const result = await workOnIssueCompletion(ctx, state, deps);

  assertEquals(result.status, "continue");
  assertEquals(
    capturedBase,
    "milestone/oidc-auth",
    "gh pr create must use --base milestone/oidc-auth for milestone issues",
  );
});

Deno.test("completion - passes --base default branch when no milestone (Issue #1295)", async () => {
  const ctx = makeContext(); // no milestoneTitle
  const state = makeState({ defaultBranch: "main" }); // no milestoneBranch

  let capturedBase = "";
  const deps = createMockDeps({
    github: {
      runGhCommand: ((args: string[]) => {
        const baseIdx = args.indexOf("--base");
        if (baseIdx >= 0) {
          capturedBase = args[baseIdx + 1] ?? "";
        }
        return Promise.resolve("https://github.com/org/repo/pull/1");
      }) as unknown as typeof deps.github.runGhCommand,
    },
    pr: {
      findExistingPrForIssue: () =>
        Promise.resolve({ ok: false, error: new Error("No PR found") }),
    },
  });

  const result = await workOnIssueCompletion(ctx, state, deps);

  assertEquals(result.status, "continue");
  assertEquals(
    capturedBase,
    "main",
    "gh pr create must use --base main for non-milestone issues",
  );
});

Deno.test("workOnIssue - handles unexpected error in phase", async () => {
  const ctx = makeContext();
  const deps = createMockDeps({
    issues: {
      claimIssue: () => {
        throw new Error("Unexpected crash");
      },
    },
  });

  const result = await workOnIssue(ctx, deps);

  assertEquals(result.success, false);
  assertEquals(result.phase, "setup");
  assertEquals(result.reason.includes("Unexpected error"), true);
});

Deno.test("executeClaude #47 - a deadline timeout with a dirty tree preserves WIP on the issue branch", async () => {
  const tempWorkDir = await Deno.makeTempDir({ prefix: "issue47-wip-" });
  try {
    const ctx = makeContext({ config: makeConfig({ workDir: tempWorkDir }) });
    const state = makeState();
    const pushes: Array<{ branch: string; message: string }> = [];
    const deps = createMockDeps({
      claude: {
        runClaudeWithRetry: () =>
          Promise.resolve({
            ok: true,
            value: {
              exitCode: 124,
              output: "…mid test run…",
              timedOut: true,
            },
          }) as never,
      },
      git: {
        runGitCommand: (args: string[]) =>
          Promise.resolve({
            ok: true,
            value: {
              code: 0,
              stdout: args[0] === "status"
                ? " M a.ts\n M b.ts"
                : args[0] === "rev-parse"
                ? state.branchName
                : "",
              stderr: "",
            },
          }),
        commitAndPushPending: ((branch: string, message: string) => {
          pushes.push({ branch, message });
          return Promise.resolve({
            ok: true,
            value: {
              committedNewChanges: true,
              commitsPushed: 1,
              finalUnpushedCount: 0,
            },
          });
        }) as never,
      },
      pr: {
        findExistingPrForIssue: () =>
          Promise.resolve({ ok: false, error: new Error("no PR") }),
      },
    });

    const result = await workOnIssueExecuteClaude(ctx, state, deps);
    assertEquals(result.status, "failure");
    const reason = (result as { reason: string }).reason;
    assertStringIncludes(reason, "uncommitted changes (2 files)");
    assertStringIncludes(reason, "WIP preserved");
    assertEquals(pushes.length, 1);
    assertEquals(pushes[0]?.branch, state.branchName);
    assertStringIncludes(pushes[0]?.message ?? "", "wip: execute timed out");
    assertStringIncludes(pushes[0]?.message ?? "", "Issue #47");
  } finally {
    await Deno.remove(tempWorkDir, { recursive: true });
  }
});

Deno.test("executeClaude #47 - a failed WIP push is reported in the failure reason", async () => {
  const ctx = makeContext();
  const state = makeState();
  const deps = createMockDeps({
    claude: {
      runClaudeWithRetry: () =>
        Promise.resolve({
          ok: true,
          value: {
            exitCode: 124,
            output: "…mid test run…",
            timedOut: true,
          },
        }) as never,
    },
    git: {
      runGitCommand: (args: string[]) =>
        Promise.resolve({
          ok: true,
          value: {
            code: 0,
            stdout: args[0] === "status"
              ? " M a.ts"
              : args[0] === "rev-parse"
              ? state.branchName
              : "",
            stderr: "",
          },
        }),
      commitAndPushPending: (() =>
        Promise.resolve({
          ok: false,
          error: new Error("push rejected"),
        })) as never,
    },
    pr: {
      findExistingPrForIssue: () =>
        Promise.resolve({ ok: false, error: new Error("no PR") }),
    },
  });

  const result = await workOnIssueExecuteClaude(ctx, state, deps);
  assertEquals(result.status, "failure");
  const reason = (result as { reason: string }).reason;
  assertStringIncludes(reason, "uncommitted changes (1 file)");
  assertStringIncludes(reason, "WIP preservation failed");
  assertStringIncludes(reason, "push rejected");
});

Deno.test("executeClaude #148 - a timeout with a CLEAN tree commits nothing and pushes nothing", async () => {
  const ctx = makeContext();
  const state = makeState();
  const pushes: Array<{ branch: string; message: string }> = [];
  const deps = createMockDeps({
    claude: {
      runClaudeWithRetry: () =>
        Promise.resolve({
          ok: true,
          value: {
            exitCode: 124,
            output: "…mid test run…",
            timedOut: true,
          },
        }) as never,
    },
    git: {
      // `git status --porcelain` reports nothing: there is no work to park.
      runGitCommand: (args: string[]) =>
        Promise.resolve({
          ok: true,
          value: {
            code: 0,
            stdout: args[0] === "rev-parse" ? state.branchName : "",
            stderr: "",
          },
        }),
      commitAndPushPending: ((branch: string, message: string) => {
        pushes.push({ branch, message });
        return Promise.resolve({
          ok: true,
          value: {
            committedNewChanges: true,
            commitsPushed: 1,
            finalUnpushedCount: 0,
          },
        });
      }) as never,
    },
    pr: {
      findExistingPrForIssue: () =>
        Promise.resolve({ ok: false, error: new Error("no PR") }),
    },
  });

  const result = await workOnIssueExecuteClaude(ctx, state, deps);

  assertEquals(result.status, "failure");
  const reason = (result as { reason: string }).reason;
  assertStringIncludes(reason, "without creating changes");
  assertEquals(pushes, [], "a clean tree must produce no WIP commit or push");
  assertEquals(
    reason.includes("WIP preserved"),
    false,
    `a clean tree claims no preservation: ${reason}`,
  );
});

// ---------------------------------------------------------------------------
// Issue #175 — a pre-check that cannot resolve the issue is a bounce
// ---------------------------------------------------------------------------

Deno.test(
  "workOnIssue - an orphaned merged PR is reported as an expected skip, not a success",
  async () => {
    // GRQ#4173: PR #27 merged into `milestone/4168-…` hours after that
    // milestone's rollup PR #4195 had merged into Develop, so the merge
    // commit never reached Develop. Reporting the refusal as a success made
    // the scan forget the issue immediately and both pool slots re-claimed
    // it every cycle.
    const branch = "milestone/4168-feed-completion-signal";
    const gh = (args: string[]): Promise<string> => {
      const key = args.join(" ");
      if (key.includes(".default_branch")) return Promise.resolve("Develop\n");
      if (args[0] === "api" && key.includes("/compare/")) {
        return Promise.resolve(
          key.includes(".ahead_by")
            ? "4"
            : JSON.stringify({ status: "diverged" }),
        );
      }
      if (args[0] === "pr" && args[1] === "list") {
        return Promise.resolve(
          args.includes("all")
            ? JSON.stringify([{
              number: 4195,
              state: "MERGED",
              baseRefName: "Develop",
              mergedAt: "2026-08-20T08:29:52Z",
            }])
            : "[]",
        );
      }
      if (args[0] === "pr" && args[1] === "view") {
        return Promise.resolve(
          args[2] === "4195"
            ? JSON.stringify({ mergedAt: "2026-08-20T08:29:52Z" })
            : JSON.stringify({
              state: "MERGED",
              mergeCommit: { oid: "09ad4105" },
              baseRefName: branch,
              mergedAt: "2026-08-20T18:02:11Z",
            }),
        );
      }
      if (args[0] === "pr" && args[1] === "create") {
        return Promise.resolve("https://github.com/org/repo/pull/4400\n");
      }
      return Promise.resolve("");
    };

    const deps = createMockDeps({
      github: { runGhCommand: gh },
      pr: {
        findExistingPrForIssue: () =>
          Promise.resolve({
            ok: true,
            value: "https://github.com/org/repo/pull/27",
          }),
      },
    });

    const result = await workOnIssue(makeContext(), deps);

    assertEquals(result.phase, "merged_pr_precheck");
    assertEquals(result.success, false);
    assertEquals(result.expectedSkip, true);
    assertStringIncludes(result.reason, "merged_pr_did_not_land");
    // A bounce raised no PR by design — it is not diagnosed as a failure.
    assertEquals(result.outcome?.kind, "no_pr_expected");
  },
);

Deno.test({
  name:
    "workOnIssue - a declared dependency PR is opened by the worker and cross-linked (Issue #182)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const calls = makeStubGhCalls();
    const prUrl = "https://github.com/stSoftwareAU/NEAT-AI-Discovery/pull/9";
    const ghArgs: string[][] = [];
    // The worker's own gh chokepoint, faked: reachable + pushable dep repo,
    // the branch the agent pushed, no PR yet, then the created PR URL.
    _setGhSpawnRunner((args) => {
      ghArgs.push([...args]);
      const joined = args.join(" ");
      const reply = (stdout: string) =>
        Promise.resolve({ code: 0, success: true, stdout, stderr: "" });
      if (joined.includes("pr create")) return reply(`${prUrl}\n`);
      if (joined.includes("pr list")) return reply("");
      if (joined.includes("/branches/")) return reply('{"name":"branch"}');
      return reply(
        JSON.stringify({
          full_name: "stSoftwareAU/NEAT-AI-Discovery",
          default_branch: "Develop",
          permissions: { push: true },
        }),
      );
    });
    const ctx = makeContext({
      issueBody: "The root cause is in the NEAT-AI-Discovery scorer.",
    });
    const deps = createMockDeps({
      github: {
        createClient: () => makeStubGhClient(calls),
      },
      claude: {
        runClaudeWithRetry: () =>
          Promise.resolve({
            ok: true,
            value: {
              exitCode: 0,
              output: [
                "Fixed the root cause in the dependency and pushed the branch.",
                '<!-- vibe-cross-repo-pr repo="stSoftwareAU/NEAT-AI-Discovery" ' +
                'branch="fix/4140-lock-free-kept-candidate-signal" base="Develop" ' +
                'title="Fix the lock-free kept-candidate signal" ' +
                'summary="Root cause of the consuming issue lives here." -->',
              ].join("\n"),
              timedOut: false,
            },
          }),
      },
      pr: {
        findExistingPrForIssue: () =>
          Promise.resolve({ ok: false, error: new Error("No PR found") }),
      },
    });

    try {
      const result = await workOnIssue(ctx, deps);

      // The bridge ran and opened the PR the agent could not open itself.
      assertEquals(typeof result.timings["cross_repo_pr_handoff"], "number");
      assertEquals(
        ghArgs.some((a) => a.join(" ").includes("pr create")),
        true,
      );
      // It is cross-linked on the consuming issue, and it is not an escalation.
      const linked = calls.postComment.find((c) => c.body.includes(prUrl));
      assertEquals(linked?.repo, ctx.repo);
      // The bridge itself did not escalate — the PR was opened, not stranded.
      assertEquals(
        calls.postComment.some((c) =>
          c.body.includes("Dependency PR could not be opened")
        ),
        false,
      );
    } finally {
      _resetGhSpawnRunner();
    }
  },
});

Deno.test({
  name:
    "workOnIssue - a dependency PR the worker cannot open escalates instead of stranding the branch (Issue #182)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const calls = makeStubGhCalls();
    // The dependency repo is unreachable — the PR cannot be opened.
    _setGhSpawnRunner(() =>
      Promise.resolve({
        code: 1,
        success: false,
        stdout: "",
        stderr: "gh: Not Found (HTTP 404)",
      })
    );
    const ctx = makeContext();
    const deps = createMockDeps({
      github: {
        createClient: () => makeStubGhClient(calls),
      },
      claude: {
        runClaudeWithRetry: () =>
          Promise.resolve({
            ok: true,
            value: {
              exitCode: 0,
              output:
                '<!-- vibe-cross-repo-pr repo="stSoftwareAU/NEAT-AI-Discovery" ' +
                'branch="fix/4140-lock-free-kept-candidate-signal" ' +
                'title="Fix the lock-free kept-candidate signal" -->',
              timedOut: false,
            },
          }),
      },
      pr: {
        findExistingPrForIssue: () =>
          Promise.resolve({ ok: false, error: new Error("No PR found") }),
      },
    });

    try {
      const result = await workOnIssue(ctx, deps);

      assertEquals(typeof result.timings["cross_repo_pr_handoff"], "number");
      // Fails loud: needs-human plus a paired comment naming the branch.
      assertEquals(
        calls.addLabel.some((c) => c.label === ctx.config.needsHumanLabel),
        true,
      );
      const escalation = calls.postComment.find((c) =>
        c.body.includes("fix/4140-lock-free-kept-candidate-signal")
      );
      assertEquals(escalation?.repo, ctx.repo);
    } finally {
      _resetGhSpawnRunner();
    }
  },
});
