/**
 * RTK output filtering wired into the main-loop execute phase (Issue #2383,
 * part of #2328).
 *
 * The sibling suite `execute_claude_phase_rtk_test.ts` holds the standalone
 * issue command; this one holds the fleet path, where the same three
 * invariants must survive a different carrier:
 *
 *   - **A switched-off host spawns what it always spawned.** No `--settings`
 *     flag, an unchanged prompt, and no `rtk` process.
 *   - **The hook and the prompt line are indivisible.** Either the agent gets
 *     the `PreToolUse` entry *and* the line telling it how to recall a
 *     filtered command's full output, or it gets neither.
 *   - **Losing RTK never fails a run.** It is an accelerator: a host without
 *     the binary runs unfiltered, and the phase carries on.
 *
 * The outcome lands on `state.rtkOutput`, beside `state.codegraphContext`, so
 * a reader with no handle on the phase body can report the trial's figures.
 *
 * Every test drives the real `prepareRtkRun` through a scripted subprocess
 * seam, so nothing here spawns a binary.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { workOnIssueExecuteClaude } from "../lib/phases/execute_phase.ts";
import type {
  IssueContext,
  PhaseResult,
  PhaseState,
} from "../lib/issue_worker_types.ts";
import type { RunClaudeOptions } from "../lib/claude_runner.ts";
import { AGENT_PROVIDER_ENV } from "../lib/agent_provider.ts";
import {
  RTK_HOOK_COMMAND,
  RTK_HOOK_MATCHER,
  RTK_PROMPT_LINE,
} from "../lib/rtk_output.ts";
import {
  healthyRtkSeam,
  rtkMissing,
  type RtkSeam,
  rtkSeam,
} from "./support/rtk_seam.ts";

const REPO_PATH = "/tmp/rtk-2383-repo";

/** What one execute-phase run handed the agent, plus the resulting state. */
interface Observed {
  runOptions: RunClaudeOptions[];
  state: PhaseState;
  result: PhaseResult;
}

async function runPhase(enabled: boolean, seam: RtkSeam): Promise<Observed> {
  const config = buildDefaultWorkerConfig();
  config.rtkOutput = { enabled };
  const ctx: IssueContext = {
    repo: "org/repo",
    issueNumber: 2383,
    issueTitle: "Wire RTK in",
    issueBody: "Do the thing.",
    issueLabels: ["enhancement"],
    issueComments: "",
    githubUser: "testbot",
    config,
  };
  const state: PhaseState = {
    branchName: "issue-2383-wire-rtk-in",
    baseBranch: "main",
    defaultBranch: "main",
    repoPath: REPO_PATH,
    clarityStatus: "assessed_clear",
    claudeOutput: "",
    executeStartTime: Date.now(),
    baselineQualityPassed: true,
    baselineQualityOutput: "",
  };
  const runOptions: RunClaudeOptions[] = [];

  const deps = createMockDeps({
    claude: {
      runClaudeWithRetry: ((options: RunClaudeOptions) => {
        runOptions.push(options);
        return Promise.resolve({
          ok: true,
          value: { output: "done", exitCode: 0, timedOut: false },
        });
      }) as never,
      prepareRtkRun: seam.prepare as never,
    },
    pr: {
      findExistingPrForIssue: (() =>
        Promise.resolve({ ok: true, value: null })) as never,
    },
  });

  // The phase reads the run's *active* provider, which honours
  // `VIBE_AGENT_PROVIDER`; neutralise it so a host that exported a non-Claude
  // id cannot turn these runs into `unsupported` ones.
  const exported = Deno.env.get(AGENT_PROVIDER_ENV);
  Deno.env.delete(AGENT_PROVIDER_ENV);
  try {
    const result = await workOnIssueExecuteClaude(ctx, state, deps);
    return { runOptions, state, result };
  } finally {
    if (exported !== undefined) Deno.env.set(AGENT_PROVIDER_ENV, exported);
  }
}

/** The `PreToolUse` entries carried by a run's `--settings` payload. */
function preToolUseEntries(settingsJson: string | undefined): unknown[] {
  assert(settingsJson, "expected a --settings payload");
  const parsed = JSON.parse(settingsJson) as {
    hooks?: { PreToolUse?: unknown[] };
  };
  return parsed.hooks?.PreToolUse ?? [];
}

Deno.test("execute_phase - the switch off spawns no rtk, no settings and an unchanged prompt (Issue #2383)", async () => {
  const seam = rtkSeam([]);
  const observed = await runPhase(false, seam);

  assertEquals(seam.prepared[0]?.enabled, false);
  assertEquals(seam.calls.length, 0, "a switched-off host spawns no rtk");
  assertEquals(observed.runOptions[0]?.settingsJson, undefined);
  assertEquals(
    observed.runOptions[0]?.prompt?.includes(RTK_PROMPT_LINE),
    false,
    "an off run's prompt is the one it always sent",
  );
  assertEquals(observed.state.rtkOutput?.status, "off");
});

Deno.test("execute_phase - the switch on installs the hook and the prompt line together (Issue #2383)", async () => {
  const seam = healthyRtkSeam(100, 140);
  const observed = await runPhase(true, seam);

  // Filtering happens in the lane's own checkout — the path handed as `cwd`.
  assertEquals(seam.prepared[0]?.enabled, true);
  assertEquals(seam.prepared[0]?.cwd, REPO_PATH);

  // Half one: the hook rides on the command line, not in a settings file.
  const entries = preToolUseEntries(observed.runOptions[0]?.settingsJson);
  assertEquals(entries.length, 1);
  assertEquals(entries[0], {
    matcher: RTK_HOOK_MATCHER,
    hooks: [{ type: "command", command: RTK_HOOK_COMMAND }],
  });

  // Half two: the line, exactly once, at the tail of the built prompt.
  const prompt = observed.runOptions[0]?.prompt ?? "";
  assertStringIncludes(prompt, RTK_PROMPT_LINE);
  assertEquals(prompt.split(RTK_PROMPT_LINE).length - 1, 1);
  assertEquals(prompt.trimEnd().endsWith(RTK_PROMPT_LINE), true);

  // The figure is read again once the invocation is over, onto the same object
  // the phase state already holds.
  assertEquals(seam.calls.length, 3, "version, baseline, then the second read");
  assertEquals(observed.state.rtkOutput?.status, "ok");
  assertEquals(observed.state.rtkOutput?.savedTokens, 40);
});

Deno.test("execute_phase - a host without rtk runs unfiltered rather than failing (Issue #2383)", async () => {
  const seam = rtkSeam([rtkMissing()]);
  const observed = await runPhase(true, seam);

  assertEquals(observed.runOptions[0]?.settingsJson, undefined);
  assertEquals(
    observed.runOptions[0]?.prompt?.includes(RTK_PROMPT_LINE),
    false,
    "no hook means no line: the agent is never told output is filtered",
  );
  assertEquals(observed.state.rtkOutput?.status, "failed");
  assert(
    observed.result.status !== "failure",
    "losing RTK must not fail a run",
  );
  assert(observed.runOptions.length >= 1, "the agent must still be invoked");
});
