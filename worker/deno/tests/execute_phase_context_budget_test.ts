/**
 * Tests for the hard context-budget ceiling in the live execute phase
 * (`lib/phases/execute_phase.ts`, Issue #3713).
 *
 * Before this change the budget check was purely observational, so an issue
 * whose prompt kept growing was bounded only by wall-clock while `loop.sh`
 * restarted the worker forever. The phase must now stop *before* the billed
 * Claude invocation. It never hands the issue to a human (Issue #4298): it
 * trims the comment history and retries, and an issue that still does not fit
 * goes to planning to be split.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { workOnIssueExecuteClaude } from "../lib/phases/execute_phase.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import type { GitHubClient, WorkerConfig } from "../types.ts";

interface StubGhCalls {
  addLabel: Array<{ label: string }>;
  postComment: Array<{ body: string }>;
  unassignIssue?: number;
}

function makeStubGhClient(calls: StubGhCalls): GitHubClient {
  return {
    getIssue: () => {
      throw new Error("stub: getIssue not implemented");
    },
    getIssueComments: () => Promise.resolve([]),
    addLabel: (_repo, _issueNumber, label) => {
      calls.addLabel.push({ label });
      return Promise.resolve();
    },
    removeLabel: () => Promise.resolve(),
    postComment: (_repo, _issueNumber, body) => {
      calls.postComment.push({ body });
      return Promise.resolve(undefined);
    },
    editIssue: () => Promise.resolve(),
    assignIssue: () => Promise.resolve(),
    unassignIssue: () => {
      calls.unassignIssue = (calls.unassignIssue ?? 0) + 1;
      return Promise.resolve();
    },
    closeIssue: () => Promise.resolve(),
  };
}

function makeConfig(overrides?: Partial<WorkerConfig>): WorkerConfig {
  return { ...buildDefaultWorkerConfig(), ...overrides };
}

function makeContext(config: WorkerConfig): IssueContext {
  return {
    repo: "org/repo",
    issueNumber: 42,
    issueTitle: "Non-converging issue",
    issueBody: "B".repeat(4000),
    issueLabels: [],
    issueComments: "",
    githubUser: "testbot",
    config,
  };
}

function makeState(): PhaseState {
  return {
    branchName: "issue-42-non-converging",
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

/** A Claude stub that counts its billed invocations. */
function countingClaude(counter: { calls: number }) {
  return {
    runClaudeWithRetry: (() => {
      counter.calls++;
      return Promise.resolve({
        ok: true,
        value: { output: "done", exitCode: 0, timedOut: false },
      });
    }) as never,
  };
}

/** A git runner reporting a changed file, so a run that executes continues. */
const CHANGED_TREE = {
  runGitCommand: (() =>
    Promise.resolve({
      ok: true,
      value: { stdout: "M src/main.ts", stderr: "", code: 0 },
    })) as never,
};

/**
 * A prompt builder whose output is oversized only while the comment history
 * is in it: the shape of an issue whose thread outgrew the window.
 */
function commentHeavyPromptBuilder(seen: Array<string | undefined>) {
  return ((input: { issueComments?: string }) => {
    seen.push(input.issueComments);
    return Promise.resolve({
      ok: true,
      value: {
        systemPrompt: "mock system",
        prompt: input.issueComments ? "C".repeat(400_000) : "mock prompt",
      },
    });
  }) as never;
}

Deno.test(
  "execute_phase - an oversized comment history is trimmed and the run proceeds (Issue #4298)",
  async () => {
    const calls: StubGhCalls = { addLabel: [], postComment: [] };
    const config = makeConfig({ contextBudgetBlockPercent: 5 });
    const ctx = {
      ...makeContext(config),
      issueLabels: ["work-on"],
      issueComments: "a long comment thread",
    };
    const seen: Array<string | undefined> = [];
    const claude = { calls: 0 };
    const deps = createMockDeps({
      github: { createClient: () => makeStubGhClient(calls) },
      claude: countingClaude(claude),
      git: CHANGED_TREE,
      infrastructure: { buildPrompt: commentHeavyPromptBuilder(seen) },
    });

    const result = await workOnIssueExecuteClaude(ctx, makeState(), deps);

    assertEquals(result.status, "continue");
    assertEquals(claude.calls, 1, "the trimmed prompt is sent");
    assertEquals(seen, ["a long comment thread", undefined]);
    assertEquals(calls.addLabel, [], "nothing is labelled");
    assertEquals(calls.postComment, [], "nobody is asked to trim it");
  },
);

Deno.test(
  "execute_phase - a prompt still over the ceiling goes to planning, never to a human (Issue #4298)",
  async () => {
    const calls: StubGhCalls = { addLabel: [], postComment: [] };
    // A 0.01% ceiling on a 1M window blocks any realistic prompt.
    const config = makeConfig({ contextBudgetBlockPercent: 0.01 });
    const ctx = { ...makeContext(config), issueLabels: ["work-on"] };
    const claude = { calls: 0 };
    const deps = createMockDeps({
      github: { createClient: () => makeStubGhClient(calls) },
      claude: countingClaude(claude),
    });

    const result = await workOnIssueExecuteClaude(ctx, makeState(), deps);

    assertEquals(result.status, "early_exit");
    assertEquals(
      (result as { reason: string }).reason,
      "context_budget_exceeded",
    );
    assertEquals(claude.calls, 0, "no billed invocation past the ceiling");
    assertEquals(calls.addLabel.map((c) => c.label), [config.planningLabel]);
    assertEquals(calls.postComment.length, 1, "the planning hand-off comment");
    assertStringIncludes(
      calls.postComment[0]!.body,
      "## Handed off to planning",
    );
    assertEquals(calls.unassignIssue, 1, "the claim is released");
  },
);

Deno.test(
  "execute_phase - an oversized prompt that planning cannot take is retried, never handed back (Issue #4298)",
  async () => {
    const calls: StubGhCalls = { addLabel: [], postComment: [] };
    const config = makeConfig({ contextBudgetBlockPercent: 0.01 });
    // No `work-on` anchor: label security would not trust the worker's own
    // `planning`, so the hand-off is not attempted.
    const ctx = makeContext(config);
    const claude = { calls: 0 };
    const deps = createMockDeps({
      github: { createClient: () => makeStubGhClient(calls) },
      claude: countingClaude(claude),
    });

    const result = await workOnIssueExecuteClaude(ctx, makeState(), deps);

    assertEquals(result.status, "failure");
    assertEquals(claude.calls, 0);
    assertEquals(calls.addLabel, [], "no `needs-human`, no stray label");
    assert(
      !calls.postComment.some((c) => c.body.includes("needs-human")),
      "nobody is asked to step in",
    );
  },
);

Deno.test(
  "execute_phase - a prompt under the ceiling still runs Claude (Issue #3713)",
  async () => {
    const calls: StubGhCalls = { addLabel: [], postComment: [] };
    const ctx = makeContext(makeConfig());
    const state = makeState();

    let claudeCalls = 0;
    const deps = createMockDeps({
      github: { createClient: () => makeStubGhClient(calls) },
      claude: {
        runClaudeWithRetry: (() => {
          claudeCalls++;
          return Promise.resolve({
            ok: true,
            value: { output: "done", exitCode: 0, timedOut: false },
          });
        }) as never,
      },
      git: {
        runGitCommand: (() =>
          Promise.resolve({
            ok: true,
            value: { stdout: "M src/main.ts", stderr: "", code: 0 },
          })) as never,
      },
    });

    const result = await workOnIssueExecuteClaude(ctx, state, deps);

    assertEquals(result.status, "continue");
    assertEquals(claudeCalls, 1);
    assertEquals(calls.addLabel.length, 0, "no escalation under the ceiling");
  },
);

Deno.test(
  "execute_phase - a zero ceiling restores warn-only behaviour (Issue #3713)",
  async () => {
    const calls: StubGhCalls = { addLabel: [], postComment: [] };
    const ctx = makeContext(makeConfig({ contextBudgetBlockPercent: 0 }));
    const state = makeState();

    let claudeCalls = 0;
    const deps = createMockDeps({
      github: { createClient: () => makeStubGhClient(calls) },
      claude: {
        runClaudeWithRetry: (() => {
          claudeCalls++;
          return Promise.resolve({
            ok: true,
            value: { output: "done", exitCode: 0, timedOut: false },
          });
        }) as never,
      },
      git: {
        runGitCommand: (() =>
          Promise.resolve({
            ok: true,
            value: { stdout: "M src/main.ts", stderr: "", code: 0 },
          })) as never,
      },
    });

    const result = await workOnIssueExecuteClaude(ctx, state, deps);

    assertEquals(result.status, "continue");
    assertEquals(claudeCalls, 1);
    assertEquals(calls.addLabel.length, 0);
  },
);

// ---------------------------------------------------------------------------
// Issue #106 — change detection resolves an origin-only milestone base and
// fails loud on a git error rather than misclassifying a run as no-changes.
// ---------------------------------------------------------------------------

/** A git runner deciding each command by `handler`; unknowns succeed empty. */
function gitRunnerFrom(
  handler: (args: string[]) => { code: number; stdout?: string } | undefined,
) {
  return ((args: string[]) => {
    const r = handler(args) ?? { code: 0, stdout: "" };
    return Promise.resolve({
      ok: true,
      value: { code: r.code, stdout: r.stdout ?? "", stderr: "" },
    });
  }) as never;
}

const MILESTONE = "milestone/4136-promotion-gate";
const OKCLAUDE = {
  runClaudeWithRetry: (() =>
    Promise.resolve({
      ok: true,
      value: { output: "done", exitCode: 0, timedOut: false },
    })) as never,
};

Deno.test(
  "execute_phase - change detection resolves an origin-only milestone base (Issue #106)",
  async () => {
    const calls: StubGhCalls = { addLabel: [], postComment: [] };
    const ctx = makeContext(makeConfig());
    const state = { ...makeState(), baseBranch: MILESTONE };

    const deps = createMockDeps({
      github: { createClient: () => makeStubGhClient(calls) },
      claude: OKCLAUDE,
      git: {
        runGitCommand: gitRunnerFrom((args) => {
          // Local milestone branch is absent in this clone …
          if (
            args[0] === "rev-parse" && args.includes(`${MILESTONE}^{commit}`)
          ) {
            return { code: 1 };
          }
          // … but the remote-tracking ref resolves.
          if (
            args[0] === "rev-parse" &&
            args.includes(`origin/${MILESTONE}^{commit}`)
          ) {
            return { code: 0, stdout: "a".repeat(40) };
          }
          // Not shallow — ensureHistoryDepth returns early.
          if (args.includes("--is-shallow-repository")) {
            return { code: 0, stdout: "false" };
          }
          // No uncommitted changes …
          if (args[0] === "diff") return { code: 0, stdout: "" };
          // … but the branch is ahead of the resolved base (the real work).
          if (args[0] === "log" && args.includes(`origin/${MILESTONE}..HEAD`)) {
            return { code: 0, stdout: "abc123 the delivered commit" };
          }
          return undefined;
        }),
      },
    });

    const result = await workOnIssueExecuteClaude(ctx, state, deps);

    // Resolved base + real commits → continue, NOT a no_changes early_exit.
    assertEquals(result.status, "continue");
    assertEquals(
      calls.addLabel.some((c) => c.label === ctx.config.needsHumanLabel),
      false,
      "a resolved-base run must not be escalated to needs-human",
    );
  },
);

Deno.test(
  "execute_phase - a git-log error fails loud, not silently as no_changes (Issue #106)",
  async () => {
    const calls: StubGhCalls = { addLabel: [], postComment: [] };
    const ctx = makeContext(makeConfig());
    const state = makeState(); // baseBranch "main"

    const deps = createMockDeps({
      github: { createClient: () => makeStubGhClient(calls) },
      claude: OKCLAUDE,
      pr: {
        // No existing PR to self-heal from.
        findExistingPrForIssue: (() =>
          Promise.resolve({ ok: true, value: undefined })) as never,
      },
      git: {
        runGitCommand: gitRunnerFrom((args) => {
          if (args[0] === "rev-parse" && args.includes("main^{commit}")) {
            return { code: 0, stdout: "a".repeat(40) }; // base resolves
          }
          if (args.includes("--is-shallow-repository")) {
            return { code: 0, stdout: "false" };
          }
          if (args[0] === "diff") return { code: 0, stdout: "" };
          // The range comparison itself errors (e.g. a corrupt object).
          if (args[0] === "log") return { code: 128, stdout: "" };
          return undefined;
        }),
      },
    });

    const result = await workOnIssueExecuteClaude(ctx, state, deps);

    assertEquals(result.status, "failure");
    assertStringIncludes(
      (result as { reason: string }).reason,
      "change detection failed",
    );
  },
);
