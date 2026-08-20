/**
 * The hand-off that makes preserved WIP resumable (Issue #148).
 *
 * Preservation writes the work to the issue branch; the resume pointer is
 * how the NEXT claim finds it. Two links in that chain are pinned here:
 * the release keeps the pointer when (and only when) the run preserved WIP,
 * and the setup phase records where the resumed branch started so the
 * completion phase can tell an advanced branch from an untouched one.
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

Deno.test("setup #148 - resuming a checkpoint records the branch head it resumed", async () => {
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
    const deps = createMockDeps({
      git: {
        resumeFeatureBranchFromRemote: () =>
          Promise.resolve({ ok: true as const, value: true }),
        runGitCommand: (args: string[]) =>
          Promise.resolve({
            ok: true as const,
            value: {
              code: 0,
              stdout: args[0] === "rev-parse" && args[1] === "HEAD"
                ? "ff00ba9deadbeef\n"
                : "",
              stderr: "",
            },
          }),
      },
    });

    // The resume file must name the branch the setup phase derives.
    const branchName = deps.git.createBranchName(148, ctx.issueTitle);
    await saveResumeState(workDir, ctx.repo, 148, {
      sessionId: "sess-148",
      phaseCount: 3,
      branch: branchName,
    });

    const result = await workOnIssueSetupBranch(ctx, state, deps);

    assertEquals(result.status, "continue");
    assertEquals(state.resumedFromCheckpoint, true);
    assertEquals(state.resumedCheckpointHead, "ff00ba9deadbeef");
    // The pointer that got us here is still on disk for the next claim.
    assert(await loadResumeState(workDir, ctx.repo, 148));

    if (state.heartbeatHandle) await stopHeartbeat(state.heartbeatHandle);
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("setup #148 - a run that starts clean records no resumed head", async () => {
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
    assertEquals(state.resumedCheckpointHead, undefined);

    if (state.heartbeatHandle) await stopHeartbeat(state.heartbeatHandle);
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
});
