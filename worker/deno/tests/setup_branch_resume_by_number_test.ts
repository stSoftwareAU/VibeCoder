/**
 * Resume-on-reclaim keys on the issue number, not the title (Issue #220).
 *
 * Retitling #211 between two claims changed the title-derived branch name,
 * so the second claim never looked at the pushed 20-file WIP branch. These
 * tests pin the setup phase's half of the fix: the branch is discovered by
 * issue number, the discovery does not wait on `enable_session_resume`, and
 * every claim logs which branch it resumed (or that none existed).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { workOnIssueSetupBranch } from "../lib/phases/setup_branch_phase.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import type { GitDeps } from "../lib/issue_worker_wiring.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { saveResumeState } from "../lib/resume_state_store.ts";
import { stopHeartbeat } from "../lib/heartbeat.ts";

const REPO = "stSoftwareAU/VibeCoder";
const WIP_BRANCH =
  "issue-220-two-hosts-maintaining-the-same-pr-after-a-sibling";

function buildContext(
  workDir: string,
  overrides: Partial<IssueContext["config"]> = {},
): IssueContext {
  return {
    repo: REPO,
    issueNumber: 220,
    // The retitled issue — its slug no longer matches the WIP branch.
    issueTitle: "False push failed on single-branch clones",
    issueBody: "",
    issueLabels: ["top-priority"],
    issueComments: "",
    githubUser: "vibe-worker",
    config: { ...buildDefaultWorkerConfig(), workDir, ...overrides },
  };
}

function buildState(): PhaseState {
  return {
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
}

/** Git mocks that report one resumable branch for the issue. */
function gitFindsWip(
  branch = WIP_BRANCH,
  resumed = true,
): Partial<GitDeps> {
  return {
    findResumableIssueBranch: () =>
      Promise.resolve({
        ok: true as const,
        value: {
          candidate: { branch, sha: "7bc5ea8".padEnd(40, "0"), aheadCount: 3 },
          considered: [branch],
          alternatives: [],
          reason: "resumable" as const,
        },
      }),
    resumeFeatureBranchFromRemote: () =>
      Promise.resolve({ ok: true as const, value: resumed }),
  };
}

async function withWorkDir(
  fn: (workDir: string) => Promise<void>,
): Promise<void> {
  const workDir = await Deno.makeTempDir({ prefix: "issue220-setup-" });
  try {
    await fn(workDir);
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
}

Deno.test("setup #220 - a retitled issue resumes the branch found by issue number", async () => {
  await withWorkDir(async (workDir) => {
    const ctx = buildContext(workDir);
    const state = buildState();
    const deps = createMockDeps({ git: gitFindsWip() });

    const result = await workOnIssueSetupBranch(ctx, state, deps);

    assertEquals(result.status, "continue");
    assertEquals(state.resumedFromCheckpoint, true);
    // The phase continues on the branch that holds the work, not the one
    // the new title derives.
    assertEquals(state.branchName, WIP_BRANCH);

    if (state.heartbeatHandle) await stopHeartbeat(state.heartbeatHandle);
  });
});

Deno.test("setup #220 - the persisted branch is resumed when it differs from the title-derived one", async () => {
  await withWorkDir(async (workDir) => {
    const ctx = buildContext(workDir);
    const state = buildState();
    const lookups: Array<Record<string, unknown>> = [];
    const deps = createMockDeps({
      git: {
        ...gitFindsWip(),
        findResumableIssueBranch: (params) => {
          lookups.push({ ...params, options: undefined });
          return Promise.resolve({
            ok: true as const,
            value: {
              candidate: {
                branch: params.persistedBranch ?? "",
                sha: "a".repeat(40),
                aheadCount: 1,
              },
              considered: [params.persistedBranch ?? ""],
              alternatives: [],
              reason: "resumable" as const,
            },
          });
        },
      },
    });

    await saveResumeState(workDir, REPO, 220, {
      sessionId: "3f1b6b3e-2c0a-4c9e-9b1a-1f2c3d4e5f60",
      phaseCount: 2,
      branch: WIP_BRANCH,
    });

    const result = await workOnIssueSetupBranch(ctx, state, deps);

    assertEquals(result.status, "continue");
    assertEquals(lookups.length, 1);
    // The lookup is handed both the persisted branch and the title-derived
    // one; the persisted branch wins.
    assertEquals(lookups[0]!.persistedBranch, WIP_BRANCH);
    assertEquals(lookups[0]!.issueNumber, 220);
    assert(
      typeof lookups[0]!.titleBranch === "string" &&
        lookups[0]!.titleBranch !== WIP_BRANCH,
      "the title-derived branch should differ from the persisted branch",
    );
    assertEquals(state.branchName, WIP_BRANCH);
    assertEquals(state.resumedFromCheckpoint, true);

    if (state.heartbeatHandle) await stopHeartbeat(state.heartbeatHandle);
  });
});

Deno.test("setup #220 - pushed WIP is used even with session resume disabled", async () => {
  await withWorkDir(async (workDir) => {
    const ctx = buildContext(workDir, { enableSessionResume: false });
    const state = buildState();
    const deps = createMockDeps({ git: gitFindsWip() });

    await saveResumeState(workDir, REPO, 220, {
      sessionId: "3f1b6b3e-2c0a-4c9e-9b1a-1f2c3d4e5f60",
      phaseCount: 2,
      branch: WIP_BRANCH,
    });

    await workOnIssueSetupBranch(ctx, state, deps);

    assertEquals(state.resumedFromCheckpoint, true);
    // The flag still gates the CLI conversation replay, and only that.
    assertEquals(state.sessionResumeState, undefined);

    if (state.heartbeatHandle) await stopHeartbeat(state.heartbeatHandle);
  });
});

Deno.test("setup #220 - session resume enabled primes the CLI replay from the persisted state", async () => {
  await withWorkDir(async (workDir) => {
    const ctx = buildContext(workDir, { enableSessionResume: true });
    const state = buildState();
    const deps = createMockDeps({ git: gitFindsWip() });

    await saveResumeState(workDir, REPO, 220, {
      sessionId: "3f1b6b3e-2c0a-4c9e-9b1a-1f2c3d4e5f60",
      phaseCount: 2,
      branch: WIP_BRANCH,
    });

    await workOnIssueSetupBranch(ctx, state, deps);

    assertEquals(state.sessionResumeState, {
      sessionId: "3f1b6b3e-2c0a-4c9e-9b1a-1f2c3d4e5f60",
      phaseCount: 2,
    });

    if (state.heartbeatHandle) await stopHeartbeat(state.heartbeatHandle);
  });
});

Deno.test("setup #220 - every claim logs which branch was resumed", async () => {
  await withWorkDir(async (workDir) => {
    const messages: string[] = [];
    const ctx = buildContext(workDir);
    const state = buildState();
    const deps = createMockDeps({
      git: gitFindsWip(),
      logger: { info: (message: string) => void messages.push(message) },
    });

    await workOnIssueSetupBranch(ctx, state, deps);

    const line = messages.find((m) => m.includes("Resuming prior progress"));
    assert(line, `expected a resume log line, got: ${messages.join(" | ")}`);
    assertStringIncludes(line, WIP_BRANCH);

    if (state.heartbeatHandle) await stopHeartbeat(state.heartbeatHandle);
  });
});

Deno.test("setup #220 - a claim with no prior work says so and branches from base", async () => {
  await withWorkDir(async (workDir) => {
    const messages: string[] = [];
    const ctx = buildContext(workDir);
    const state = buildState();
    // The default mock reports no candidate at all.
    const deps = createMockDeps({
      logger: { info: (message: string) => void messages.push(message) },
    });

    const result = await workOnIssueSetupBranch(ctx, state, deps);

    assertEquals(result.status, "continue");
    assertEquals(state.resumedFromCheckpoint, false);
    assertEquals(
      state.branchName,
      deps.git.createBranchName(220, ctx.issueTitle),
    );
    assert(
      messages.some((m) => m.includes("No prior progress branch to resume")),
      `expected a "nothing to resume" log line, got: ${messages.join(" | ")}`,
    );

    if (state.heartbeatHandle) await stopHeartbeat(state.heartbeatHandle);
  });
});

Deno.test("setup #220 - a failed lookup is loud and the claim starts from base", async () => {
  await withWorkDir(async (workDir) => {
    const warnings: string[] = [];
    const ctx = buildContext(workDir);
    const state = buildState();
    const deps = createMockDeps({
      git: {
        findResumableIssueBranch: () =>
          Promise.resolve({
            ok: false as const,
            error: new Error("git ls-remote exited 128: could not read remote"),
          }),
      },
      logger: { warn: (message: string) => void warnings.push(message) },
    });

    const result = await workOnIssueSetupBranch(ctx, state, deps);

    assertEquals(result.status, "continue");
    assertEquals(state.resumedFromCheckpoint, false);
    assert(
      warnings.some((m) => m.includes("prior progress")),
      `expected a loud lookup warning, got: ${warnings.join(" | ")}`,
    );

    if (state.heartbeatHandle) await stopHeartbeat(state.heartbeatHandle);
  });
});

Deno.test("setup #220 - a checkout that fails does not claim a resume", async () => {
  await withWorkDir(async (workDir) => {
    const ctx = buildContext(workDir);
    const state = buildState();
    const deps = createMockDeps({ git: gitFindsWip(WIP_BRANCH, false) });

    const result = await workOnIssueSetupBranch(ctx, state, deps);

    assertEquals(result.status, "continue");
    assertEquals(state.resumedFromCheckpoint, false);
    // Falls back to the title-derived branch created from base.
    assertEquals(
      state.branchName,
      deps.git.createBranchName(220, ctx.issueTitle),
    );

    if (state.heartbeatHandle) await stopHeartbeat(state.heartbeatHandle);
  });
});
