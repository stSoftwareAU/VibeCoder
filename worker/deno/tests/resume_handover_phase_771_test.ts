/**
 * A re-claim resumes from the committed handover file, on any host or
 * provider (Issue #771).
 *
 * Two phases are pinned end to end:
 *   - setup reads the handover file out of the resumed working tree, and does
 *     so whether `enable_session_resume` is on or off — that flag gates the
 *     host-local `--resume` transcript, never the portable file;
 *   - execute splices what setup read into the prompt, and falls back to the
 *     generic note when the branch carries no handover (every branch preserved
 *     before #769 does not).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { workOnIssueSetupBranch } from "../lib/phases/setup_branch_phase.ts";
import { workOnIssueExecuteClaude } from "../lib/phases/execute_phase.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import type { GitHubClient, WorkerConfig } from "../types.ts";
import { handoverFilePath } from "../lib/preserved_wip_branch.ts";
import { HANDOVER_FRAMING } from "../lib/handover_prompt_note.ts";
import { PRIOR_PROGRESS_PROMPT_NOTE } from "../lib/resume_state_store.ts";
import { stopHeartbeat } from "../lib/heartbeat.ts";

const ISSUE = 771;
const WIP_BRANCH = "issue-771-resuming-claim-reads-the-handover-file";
const HANDOVER_BODY = "# Handover — issue 771\n\n" +
  "- Completed: the handover reader.\n" +
  "- Remains: splice it into the execute prompt.\n" +
  "- Blocker: none.\n";

function buildState(repoPath = "/tmp/test-repo"): PhaseState {
  return {
    branchName: "",
    baseBranch: "main",
    defaultBranch: "main",
    repoPath,
    clarityStatus: "not_assessed",
    claudeOutput: "",
    executeStartTime: 0,
    baselineQualityPassed: true,
    baselineQualityOutput: "",
  };
}

function buildContext(config: WorkerConfig): IssueContext {
  return {
    repo: "stSoftwareAU/VibeCoder",
    issueNumber: ISSUE,
    issueTitle: "Resuming claim reads the handover file",
    issueBody: "Read the committed handover into the execute prompt.",
    issueLabels: ["work-on"],
    issueComments: "",
    githubUser: "vibe-worker",
    config,
  };
}

/** A working tree carrying the handover file, or not. */
async function makeTree(withHandover: boolean): Promise<string> {
  const repoPath = await Deno.makeTempDir({ prefix: "issue771-repo-" });
  if (withHandover) {
    const path = `${repoPath}/${handoverFilePath(ISSUE)}`;
    await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(path, HANDOVER_BODY);
  }
  return repoPath;
}

/** Mock deps whose remote carries the preserved branch, cloned to `repoPath`. */
function depsResumingInto(repoPath: string) {
  return createMockDeps({
    git: {
      setupRepo: () => Promise.resolve({ ok: true as const, value: repoPath }),
      listRemoteIssueBranches: () =>
        Promise.resolve({
          ok: true as const,
          value: [{ branch: WIP_BRANCH, sha: "7bc5ea8" }],
        }),
      countCommitsAhead: () => Promise.resolve({ ok: true as const, value: 2 }),
      resumeFeatureBranchFromRemote: () =>
        Promise.resolve({ ok: true as const, value: true }),
    },
  });
}

/** Run setup against a tree and report what it put on the phase state. */
async function setupWith(
  withHandover: boolean,
  enableSessionResume: boolean,
): Promise<{ state: PhaseState; status: string }> {
  const workDir = await Deno.makeTempDir({ prefix: "issue771-work-" });
  const repoPath = await makeTree(withHandover);
  try {
    const ctx = buildContext({
      ...buildDefaultWorkerConfig(),
      workDir,
      enableSessionResume,
    });
    const state = buildState(repoPath);
    const result = await workOnIssueSetupBranch(
      ctx,
      state,
      depsResumingInto(repoPath),
    );
    if (state.heartbeatHandle) await stopHeartbeat(state.heartbeatHandle);
    return { state, status: result.status };
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
    await Deno.remove(repoPath, { recursive: true }).catch(() => undefined);
  }
}

Deno.test("setup #771 - a resumed branch's handover file is read into the phase state", async () => {
  for (const enableSessionResume of [true, false]) {
    const { state, status } = await setupWith(true, enableSessionResume);
    assertEquals(status, "continue");
    assertEquals(state.resumedFromCheckpoint, true);
    assertEquals(
      state.handoverNote,
      HANDOVER_BODY.trim(),
      `handover must be read with enable_session_resume=${enableSessionResume}`,
    );
  }
});

Deno.test("setup #771 - a resumed branch with no handover file still resumes", async () => {
  for (const enableSessionResume of [true, false]) {
    const { state, status } = await setupWith(false, enableSessionResume);
    assertEquals(status, "continue");
    assertEquals(state.resumedFromCheckpoint, true);
    assertEquals(state.branchName, WIP_BRANCH);
    assertEquals(state.handoverNote, undefined);
  }
});

/** Run the execute phase once and report the prompt the runner saw. */
async function capturedPrompt(
  state: PhaseState,
  config: WorkerConfig,
): Promise<string> {
  const seen: string[] = [];
  const deps = createMockDeps({
    claude: {
      runClaudeWithRetry: ((options: Record<string, unknown>) => {
        seen.push(String(options.prompt));
        return Promise.resolve({
          ok: true,
          value: { output: "done", exitCode: 0, timedOut: false },
        });
      }) as never,
    },
    pr: {
      findExistingPrForIssue: (() =>
        Promise.resolve({ ok: true, value: null })) as never,
    },
  });
  await workOnIssueExecuteClaude(buildContext(config), state, deps);
  assertEquals(seen.length >= 1, true, "the runner must be invoked");
  return seen[0]!;
}

/** A phase state as setup leaves it on a re-claim. */
function resumedState(handoverNote?: string): PhaseState {
  return {
    ...buildState(),
    branchName: WIP_BRANCH,
    clarityStatus: "assessed_clear",
    executeStartTime: Date.now(),
    resumedFromCheckpoint: true,
    ...(handoverNote ? { handoverNote } : {}),
  };
}

Deno.test("execute #771 - the handover content reaches the prompt, session resume on or off", async () => {
  for (const enableSessionResume of [true, false]) {
    const config = {
      ...buildDefaultWorkerConfig(),
      enableSessionResume,
    };
    const prompt = await capturedPrompt(resumedState(HANDOVER_BODY), config);
    assertStringIncludes(prompt, "Completed: the handover reader.");
    assertStringIncludes(prompt, "Remains: splice it into the execute prompt.");
    // Framed as a prior-run status report rather than as a directive.
    assertStringIncludes(prompt, HANDOVER_FRAMING);
    assertStringIncludes(prompt, handoverFilePath(ISSUE));
  }
});

Deno.test("execute #771 - a resume with no handover falls back to the generic note", async () => {
  const prompt = await capturedPrompt(
    resumedState(),
    buildDefaultWorkerConfig(),
  );
  assertStringIncludes(prompt, PRIOR_PROGRESS_PROMPT_NOTE);
  assertEquals(prompt.includes(HANDOVER_FRAMING), false);
});

Deno.test("execute #771 - a fresh claim gets no prior-progress note at all", async () => {
  const state = {
    ...resumedState(HANDOVER_BODY),
    resumedFromCheckpoint: false,
  };
  const prompt = await capturedPrompt(state, buildDefaultWorkerConfig());
  assertEquals(prompt.includes("Prior progress exists on this branch"), false);
  assertEquals(prompt.includes(HANDOVER_BODY.split("\n")[2]!), false);
});

function makeStubGhClient(labels: string[]): GitHubClient {
  return {
    getIssue: () => {
      throw new Error("stub: getIssue not implemented");
    },
    getIssueComments: () => Promise.resolve([]),
    addLabel: (_repo, _issueNumber, label) => {
      labels.push(label);
      return Promise.resolve();
    },
    removeLabel: () => Promise.resolve(),
    postComment: () => Promise.resolve(undefined),
    editIssue: () => Promise.resolve(),
    assignIssue: () => Promise.resolve(),
    unassignIssue: () => Promise.resolve(),
    closeIssue: () => Promise.resolve(),
  };
}

/** Execute once under a fixed budget ceiling; report whether it was blocked. */
async function blockedByBudget(handoverNote?: string): Promise<boolean> {
  const labels: string[] = [];
  let claudeCalls = 0;
  const deps = createMockDeps({
    github: { createClient: () => makeStubGhClient(labels) },
    claude: {
      runClaudeWithRetry: (() => {
        claudeCalls++;
        return Promise.resolve({
          ok: true,
          value: { output: "done", exitCode: 0, timedOut: false },
        });
      }) as never,
    },
    pr: {
      findExistingPrForIssue: (() =>
        Promise.resolve({ ok: true, value: null })) as never,
    },
  });
  // A ceiling the mock prompt plus the generic note clears, but which a
  // 20,000-character handover does not: the handover must be measured.
  const config = {
    ...buildDefaultWorkerConfig(),
    contextBudgetBlockPercent: 0.1,
  };
  const result = await workOnIssueExecuteClaude(
    buildContext(config),
    resumedState(handoverNote),
    deps,
  );
  return result.status === "early_exit" &&
    (result as { reason: string }).reason === "context_budget_exceeded" &&
    claudeCalls === 0;
}

Deno.test("execute #771 - handover content is counted against the context budget", async () => {
  assertEquals(
    await blockedByBudget(),
    false,
    "the baseline resume prompt must clear the ceiling",
  );
  assert(
    await blockedByBudget("H ".repeat(30_000)),
    "an oversized handover must be measured, not slipped past the ceiling",
  );
});
