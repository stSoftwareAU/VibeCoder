/**
 * The hand-off that makes preserved WIP resumable (Issue #148).
 *
 * Preservation writes the work to the issue branch; the resume pointer is
 * how the NEXT claim finds it. Two links in that chain are pinned here:
 * the release keeps the pointer when (and only when) the run preserved WIP,
 * and the setup phase flags the claim as resumed so the execute phase
 * continues the prior attempt rather than restarting from zero.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  loadResumeState,
  resumeStateSurvivesRelease,
  saveResumeState,
} from "../lib/resume_state_store.ts";
import { workOnIssueSetupBranch } from "../lib/phases/setup_branch_phase.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { stopHeartbeat } from "../lib/heartbeat.ts";

const PRESERVED_REASON =
  "Claude timed out with uncommitted changes (6 files) — WIP preserved: " +
  "committed and pushed to 'issue-148-preserve-wip' — the next claim " +
  "resumes from that branch (Issue #47)";

Deno.test("release #148 - a preserved-WIP timeout keeps its resume pointer", () => {
  assert(
    resumeStateSurvivesRelease({
      kind: "no_pr",
      message: PRESERVED_REASON,
    }),
  );
});

Deno.test("release #148 - every other release still clears the pointer", () => {
  for (
    const outcome of [
      { kind: "no_pr", message: "Quality checks failed after 3 attempts" },
      {
        kind: "no_pr",
        message: "Claude timed out with uncommitted changes (6 files) — WIP " +
          "preservation failed (push rejected) — uncommitted work remains " +
          "only in the local clone (Issue #47)",
      },
      { kind: "pr", message: undefined },
      { kind: "no_pr_expected", message: PRESERVED_REASON },
      undefined,
    ]
  ) {
    assertFalse(
      resumeStateSurvivesRelease(outcome),
      JSON.stringify(outcome),
    );
  }
});

Deno.test("setup #148 - a matching resume pointer resumes the checkpointed branch", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "issue148-setup-" });
  try {
    const config = {
      ...buildDefaultWorkerConfig(),
      workDir,
      enableSessionResume: true,
    };
    const ctx: IssueContext = {
      repo: "stSoftwareAU/VibeCoder",
      issueNumber: 148,
      issueTitle: "Preserve a timed-out run's WIP",
      issueBody: "",
      issueLabels: ["work-on"],
      issueComments: "",
      githubUser: "vibe-worker",
      config,
    };
    const state: PhaseState = {
      branchName: "",
      baseBranch: "main",
      defaultBranch: "main",
      repoPath: "/tmp/test-repo",
      clarityStatus: "not_assessed",
      claudeOutput: "",
      executeStartTime: 0,
      baselineQualityPassed: true,
      baselineQualityOutput: "",
    };
    // The branch the pointer names must exist on the remote for the #220
    // issue-number lookup to find it. The lookup runs through the injected
    // git deps, so the mock answers the branch listing, the checkout and the
    // ahead-of-base count directly.
    const checkpointBranch = "issue-148-preserve-a-timed-out-run-s-wip";
    const checkpointSha = "7bc5ea8aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const deps = createMockDeps({
      git: {
        listRemoteIssueBranches: () =>
          Promise.resolve({
            ok: true as const,
            value: [{ branch: checkpointBranch, sha: checkpointSha }],
          }),
        countCommitsAhead: () =>
          Promise.resolve({ ok: true as const, value: 2 }),
        resumeFeatureBranchFromRemote: () =>
          Promise.resolve({ ok: true as const, value: true }),
      },
    });

    const branchName = checkpointBranch;
    await saveResumeState(workDir, ctx.repo, 148, {
      sessionId: "sess-148",
      phaseCount: 3,
      branch: branchName,
    });

    const result = await workOnIssueSetupBranch(ctx, state, deps);

    assertEquals(result.status, "continue");
    assertEquals(state.resumedFromCheckpoint, true);
    // The pointer that got us here is still on disk for the next claim.
    assert(await loadResumeState(workDir, ctx.repo, 148));

    if (state.heartbeatHandle) await stopHeartbeat(state.heartbeatHandle);
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("setup #148 - a run that starts clean is never flagged as resumed", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "issue148-setup-" });
  try {
    const config = {
      ...buildDefaultWorkerConfig(),
      workDir,
      enableSessionResume: true,
    };
    const ctx: IssueContext = {
      repo: "stSoftwareAU/VibeCoder",
      issueNumber: 148,
      issueTitle: "Preserve a timed-out run's WIP",
      issueBody: "",
      issueLabels: ["work-on"],
      issueComments: "",
      githubUser: "vibe-worker",
      config,
    };
    const state: PhaseState = {
      branchName: "",
      baseBranch: "main",
      defaultBranch: "main",
      repoPath: "/tmp/test-repo",
      clarityStatus: "not_assessed",
      claudeOutput: "",
      executeStartTime: 0,
      baselineQualityPassed: true,
      baselineQualityOutput: "",
    };
    // No resume file at all — nothing to resume from.
    const deps = createMockDeps();

    const result = await workOnIssueSetupBranch(ctx, state, deps);

    assertEquals(result.status, "continue");
    assertEquals(state.resumedFromCheckpoint, false);

    if (state.heartbeatHandle) await stopHeartbeat(state.heartbeatHandle);
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
});
