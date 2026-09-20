/**
 * Tests for RTK output filtering wired into the issue phase (Issue #2383).
 *
 * The hook is installed per spawn — one `--settings` payload on the command
 * line, nothing written to `~/.claude/settings.json` — and it travels with a
 * single prompt line telling the agent how to recall a filtered command's full
 * output. Three failure modes are held here:
 *
 *   - **A switched-off host must spawn what it always spawned.** No
 *     `--settings` flag, an unchanged prompt, and no `rtk` process.
 *   - **The hook and the prompt line are indivisible.** Telling the agent
 *     output is filtered when it is not sends it chasing recall ids that do not
 *     exist; filtering without telling it strands it on a truncated failure.
 *   - **Losing RTK must never fail a run.** It is an accelerator: a host
 *     without the binary, or a provider that takes no hooks, runs unfiltered.
 *
 * Every test calls the real `prepareRtkRun` with a scripted subprocess seam.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type ExecuteClaudePhaseDeps,
  type ExecuteClaudePhaseOptions,
  runExecuteClaudePhase,
} from "../lib/execute_claude_phase.ts";
import {
  RTK_HOOK_COMMAND,
  RTK_HOOK_MATCHER,
  RTK_PROMPT_LINE,
} from "../lib/rtk_output.ts";
import { CLAUDE_PROVIDER_ID } from "../lib/agent_provider.ts";
import {
  healthyRtkSeam,
  rtkMissing,
  type RtkSeam,
  rtkSeam,
} from "./support/rtk_seam.ts";
import type { RunClaudeOptions } from "../lib/claude_runner.ts";

/** What one phase run handed the agent. */
interface Observed {
  runOptions?: RunClaudeOptions;
}

function createDeps(
  observed: Observed,
  seam: RtkSeam,
): ExecuteClaudePhaseDeps {
  return {
    runClaudeWithRetry: (options: RunClaudeOptions) => {
      observed.runOptions = options;
      return Promise.resolve({
        ok: true as const,
        value: { exitCode: 0, output: "done", timedOut: false },
      });
    },
    prepareRtkRun: seam.prepare,
    prepareCodegraphContext: () =>
      Promise.resolve({
        enabled: false,
        status: "off" as const,
        queries: 0,
      }),
    buildIssuePrompt: () =>
      Promise.resolve({
        ok: true,
        value: { systemPrompt: "sys", prompt: "user" },
      }),
    buildCachedIssuePrompt: () =>
      Promise.resolve({
        ok: true as const,
        value: {
          systemPrompt: "sys",
          prompt: "---BEGIN UNTRUSTED---\nissue body\n---END UNTRUSTED---",
          promptSha: "a".repeat(64),
          cacheHit: false,
        },
      }),
    validateRepoState: () =>
      Promise.resolve({
        ok: true,
        value: { valid: true, actions: [], warnings: [] },
      }),
    findExistingPrForBranch: () =>
      Promise.resolve({ ok: false, error: new Error("No PR found") }),
    retargetPrToMilestone: () => Promise.resolve({ ok: true, value: "ok" }),
    finalisePr: () => Promise.resolve({ ok: true, value: "ok" }),
    ensureIssueClosedIfPrMerged: () =>
      Promise.resolve({ ok: true, value: undefined }),
    runGitCommand: () => Promise.resolve({ ok: true, value: "" }),
    recordHeartbeat: () => Promise.resolve({ ok: true, value: undefined }),
    clearHeartbeat: () => Promise.resolve({ ok: true, value: undefined }),
    getPromptsCommit: () => Promise.resolve({ ok: true, value: "abc1234" }),
    log: () => {},
  };
}

function options(
  overrides: Partial<ExecuteClaudePhaseOptions> = {},
): ExecuteClaudePhaseOptions {
  return {
    repo: "owner/repo",
    issueNumber: 2383,
    issueTitle: "Wire RTK in",
    issueBody: "Do the thing.",
    issueLabels: "enhancement",
    githubUser: "bot-user",
    branchName: "issue-2383-wire-rtk-in",
    baseBranch: "main",
    milestoneBranch: "",
    clarityStatus: "clear",
    workDir: "/tmp/rtk-2383-work",
    includeRecentActivity: false,
    includeCodebaseMap: false,
    agentProvider: CLAUDE_PROVIDER_ID,
    ...overrides,
  };
}

/** The `PreToolUse` entries carried by a run's `--settings` payload. */
function preToolUseEntries(settingsJson: string | undefined): unknown[] {
  assert(settingsJson, "expected a --settings payload");
  const parsed = JSON.parse(settingsJson) as {
    hooks?: { PreToolUse?: unknown[] };
  };
  return parsed.hooks?.PreToolUse ?? [];
}

Deno.test("issue phase - the switch off spawns no rtk, no settings and an unchanged prompt (Issue #2383)", async () => {
  const observed: Observed = {};
  const seam = rtkSeam([]);

  const result = await runExecuteClaudePhase(
    options({ rtkOutputEnabled: false }),
    createDeps(observed, seam),
  );

  assertEquals(seam.prepared[0]?.enabled, false);
  assertEquals(seam.calls.length, 0, "a switched-off host spawns no rtk");
  assertEquals(observed.runOptions?.settingsJson, undefined);
  assertEquals(
    observed.runOptions?.prompt?.includes(RTK_PROMPT_LINE),
    false,
    "an off run's prompt is the one it always sent",
  );
  assertEquals(result.rtkOutput?.status, "off");
});

Deno.test("issue phase - the switch on installs the hook and the prompt line together (Issue #2383)", async () => {
  const observed: Observed = {};
  const seam = healthyRtkSeam(100, 140);

  const result = await runExecuteClaudePhase(
    options({ rtkOutputEnabled: true }),
    createDeps(observed, seam),
  );

  // The preparation saw the host switch, the run's provider and its checkout.
  assertEquals(seam.prepared[0]?.enabled, true);
  assertEquals(seam.prepared[0]?.providerId, CLAUDE_PROVIDER_ID);
  assertEquals(seam.prepared[0]?.cwd, "/tmp/rtk-2383-work/repo");

  // Half one: the hook rides on the command line, not in a settings file.
  const entries = preToolUseEntries(observed.runOptions?.settingsJson);
  assertEquals(entries.length, 1);
  assertEquals(
    entries[0],
    {
      matcher: RTK_HOOK_MATCHER,
      hooks: [{ type: "command", command: RTK_HOOK_COMMAND }],
    },
  );

  // Half two: the line, exactly once, outside the untrusted issue fences.
  const prompt = observed.runOptions?.prompt ?? "";
  assertStringIncludes(prompt, RTK_PROMPT_LINE);
  assertEquals(prompt.split(RTK_PROMPT_LINE).length - 1, 1);
  assert(
    prompt.indexOf(RTK_PROMPT_LINE) > prompt.indexOf("---END UNTRUSTED---"),
    "the line belongs after the untrusted fence, not inside it",
  );
  assertEquals(prompt.trimEnd().endsWith(RTK_PROMPT_LINE), true);

  // The figure is read again once the invocation is over.
  assertEquals(seam.calls.length, 3, "version, baseline, then the second read");
  assertEquals(result.rtkOutput?.status, "ok");
  assertEquals(result.rtkOutput?.savedTokens, 40);
});

Deno.test("issue phase - a host without rtk runs unfiltered rather than failing (Issue #2383)", async () => {
  const observed: Observed = {};
  const seam = rtkSeam([rtkMissing()]);

  const result = await runExecuteClaudePhase(
    options({ rtkOutputEnabled: true }),
    createDeps(observed, seam),
  );

  assertEquals(observed.runOptions?.settingsJson, undefined);
  assertEquals(
    observed.runOptions?.prompt?.includes(RTK_PROMPT_LINE),
    false,
    "no hook means no line: the agent is never told output is filtered",
  );
  assertEquals(result.rtkOutput?.status, "failed");
  assert(result.action !== "failure", "losing RTK must not fail a run");
});

Deno.test("issue phase - a provider that takes no hooks is reported, not filtered (Issue #2383)", async () => {
  const observed: Observed = {};
  const seam = rtkSeam([]);

  const result = await runExecuteClaudePhase(
    options({ rtkOutputEnabled: true, agentProvider: "gemini" }),
    createDeps(observed, seam),
  );

  assertEquals(seam.calls.length, 0, "an unsupported provider spawns no rtk");
  assertEquals(observed.runOptions?.settingsJson, undefined);
  assertEquals(
    observed.runOptions?.prompt?.includes(RTK_PROMPT_LINE),
    false,
  );
  assertEquals(result.rtkOutput?.status, "unsupported");
  assert(result.action !== "failure", "an unsupported provider still runs");
});
