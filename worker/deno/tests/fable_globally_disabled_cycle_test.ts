/**
 * Cross-cutting regression test for the Fable-globally-disabled cycle
 * (Issue #2737, parent #2720). Mirrors the rate-limit fallback loop test
 * (#2708) but stitches the two #2720 subsystems together end-to-end:
 *
 *   1. the in-run fallback (`runClaudeWithRetry` / `model_fallback.ts`, #2724),
 *      and
 *   2. the degraded-model flagging (`planning_run_stats.ts` /
 *      `planning_degraded_label.ts` / `grill_me_run_stats.ts`, #2649/#2717).
 *
 * Each sibling sub-issue carries its own unit tests; what was missing — and
 * what this file adds — is a single regression that drives the **real** fallback
 * subsystem (a stub agent named by path, exactly as the sibling tests do) and
 * feeds its **real** `ClaudeRunResult` (`fallbackModel` + `runStats`) into the
 * **real** flagging subsystem, for **both** top-tier phases (`planning` and
 * `grill_me`) and a per-repo `claude_model: "fable"` base-tier pin. So the whole
 * #2720 contract — disabled → fallback to Opus 4.8 + flagged; silent
 * substitution → flagged; restored → Fable used + not flagged — cannot silently
 * regress on any one path without this test going red.
 *
 * Assertions are on observable behaviour only (the `--model` sequence the stub
 * recorded, the recorded `fallbackModel`, the served models the API declared,
 * the degradation verdict, the `degraded-model` label applied, the stats
 * comment posted) — never on internal call shapes (WHAT not HOW; AGENTS.md).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { runClaudeWithRetry } from "../lib/claude_runner.ts";
import { setActiveRepoModelEffortOverrides } from "../lib/claude_executor.ts";
import type { GitHubClient, Logger } from "../types.ts";
import {
  buildDegradationReport,
  type DegradationVerdict,
} from "../lib/planning_run_stats.ts";
import {
  applyDegradedModelLabel,
  DEGRADED_MODEL_LABEL,
} from "../lib/planning_degraded_label.ts";
import { reportGrillMeDegradation } from "../lib/grill_me_run_stats.ts";
import { withAgentStub } from "./support/agent_stub.ts";
import { emptyEnv } from "./support/env_lookup.ts";
import { fakeClock } from "./support/fake_clock.ts";

// ---------------------------------------------------------------------------
// Stub harness — a fake agent, named by path (`agentBinaryPath`, Issue #959)
// rather than put on the process-wide `PATH`, that records each invocation's
// `--model` arg, so the recorded sequence proves the exact tier hop.
// ---------------------------------------------------------------------------

interface StubClaude {
  /** Absolute path to the stub, passed to the runner as `agentBinaryPath`. */
  path: string;
  /** Path the stub appends each invocation's `--model` value to. */
  modelLog: string;
}

/** Basename of the file the stub records each invocation's model in. */
const MODEL_LOG = "models.log";

/**
 * Stub body for the **globally-disabled** case: while the requested model is
 * `fable` it emits the Fable export-disable signature (matched by
 * `detectModelUnavailable`) and exits non-zero; for any other tier it succeeds.
 */
function disabledStubBody(): string {
  return [
    `log="$(dirname "$0")/${MODEL_LOG}"`,
    `model=""`,
    `prev=""`,
    `for arg in "$@"; do`,
    `  if [ "$prev" = "--model" ]; then`,
    `    model="$arg"`,
    `    printf '%s\\n' "$arg" >> "$log"`,
    `  fi`,
    `  prev="$arg"`,
    `done`,
    `if [ "$model" = "fable" ]; then`,
    `  printf '%s\\n' '{"type":"result","result":"API Error: 403 Fable is restricted in your region due to export controls"}'`,
    `  exit 1`,
    `fi`,
    `printf '%s\\n' '{"type":"result","result":"Done on Opus."}'`,
    `exit 0`,
  ].join("\n");
}

/**
 * Stub body for the **silent-substitution** case: a clean exit 0 whose
 * assistant line declares a non-Fable served model (`claude-opus-4-8`) even
 * though Fable was requested. No unavailable signal → no fallback fires; the
 * run already ran on Opus, so only the served-model mismatch surfaces it.
 */
function silentSubstitutionStubBody(): string {
  return [
    `log="$(dirname "$0")/${MODEL_LOG}"`,
    `model=""`,
    `prev=""`,
    `for arg in "$@"; do`,
    `  if [ "$prev" = "--model" ]; then`,
    `    model="$arg"`,
    `    printf '%s\\n' "$arg" >> "$log"`,
    `  fi`,
    `  prev="$arg"`,
    `done`,
    `if [ "$model" = "fable" ]; then`,
    `  printf '%s\\n' '{"type":"assistant","message":{"model":"claude-opus-4-8"}}'`,
    `fi`,
    `printf '%s\\n' '{"type":"result","result":"Done."}'`,
    `exit 0`,
  ].join("\n");
}

/**
 * Stub body for the **self-heal** case: Fable is available again. Records the
 * requested model, declares Fable as the served model, and exits 0 regardless.
 */
function selfHealStubBody(): string {
  return [
    `log="$(dirname "$0")/${MODEL_LOG}"`,
    `prev=""`,
    `for arg in "$@"; do`,
    `  if [ "$prev" = "--model" ]; then`,
    `    printf '%s\\n' "$arg" >> "$log"`,
    `  fi`,
    `  prev="$arg"`,
    `done`,
    `printf '%s\\n' '{"type":"assistant","message":{"model":"claude-fable-5-20250101"}}'`,
    `printf '%s\\n' '{"type":"result","result":"Done on Fable."}'`,
    `exit 0`,
  ].join("\n");
}

/**
 * Create the stub for the duration of `fn`, then clean up. The runner is
 * handed the stub's path (Issue #959), so nothing here touches `PATH`.
 */
function withStub<T>(
  body: string,
  fn: (stub: StubClaude) => Promise<T>,
): Promise<T> {
  return withAgentStub(
    body,
    (stub) => fn({ path: stub.path, modelLog: `${stub.dir}/${MODEL_LOG}` }),
    { prefix: "fable_cycle_stub_" },
  );
}

async function readModelSequence(modelLog: string): Promise<string[]> {
  try {
    const text = await Deno.readTextFile(modelLog);
    return text.split("\n").filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

// maxRetries=0 so the unavailable branch fires on the first failure of each
// tier with no wait — keeps the run well under the unit-test budget.
const FAST_RETRY = {
  maxRetries: 0,
  maxWaitSeconds: 1,
  initialWaitInterval: 0,
} as const;

/**
 * Clear the per-repo routing state so a phase resolves purely from its default.
 *
 * The env half of the old spelling is gone: both the run and the flagging read
 * {@link emptyEnv} (Issue #961), so a `CLAUDE_MODEL*` the worker session
 * exports is invisible to either and nothing has to be deleted from — and
 * restored to — a process every other test in the run shares.
 */
function withCleanModelState<T>(fn: () => Promise<T>): Promise<T> {
  setActiveRepoModelEffortOverrides(undefined);
  return (async () => {
    try {
      return await fn();
    } finally {
      setActiveRepoModelEffortOverrides(undefined);
    }
  })();
}

// ---------------------------------------------------------------------------
// GitHub fakes — record the label adds and comment posts the flagging triggers.
// ---------------------------------------------------------------------------

function recordingLogger(): Logger {
  const noop = () => {};
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    security: noop,
    skipReason: noop,
    timing: noop,
    scanSummary: noop,
    workerSummary: noop,
  } as unknown as Logger;
}

/** A gh runner that records every add-label call; succeeds by default. */
function fakeGh() {
  const addLabelCalls: Array<{ issue: number; label: string }> = [];
  const ghCommandFn = (args: string[]): Promise<string> => {
    if (args[0] === "label" && args[1] === "list") return Promise.resolve("[]");
    const labelArg = args.find((a) => a.startsWith("labels[]="));
    if (labelArg) {
      const idx = args.findIndex((a) => /\/issues\/\d+\/labels$/.test(a));
      const issue = idx >= 0
        ? parseInt(args[idx]!.match(/\/issues\/(\d+)\/labels$/)![1]!, 10)
        : -1;
      addLabelCalls.push({ issue, label: labelArg.replace("labels[]=", "") });
      return Promise.resolve("");
    }
    if (args[0] === "issue" && args[1] === "edit") {
      const issue = parseInt(args[2]!, 10);
      const li = args.findIndex((a) => a === "--add-label");
      addLabelCalls.push({ issue, label: li >= 0 ? args[li + 1]! : "" });
      return Promise.resolve("");
    }
    return Promise.resolve("");
  };
  return { ghCommandFn, addLabelCalls };
}

/** A minimal GitHubClient that records postComment bodies. */
function fakeClient() {
  const comments: Array<{ issue: number; body: string }> = [];
  const ghClient = {
    postComment: (_repo: string, issue: number, body: string) => {
      comments.push({ issue, body });
      return Promise.resolve();
    },
  } as unknown as GitHubClient;
  return { ghClient, comments };
}

// ---------------------------------------------------------------------------
// Flagging entry points — the REAL planning and grill_me flagging, fed the
// real ClaudeRunResult so the cross-cutting data flow is exercised end-to-end.
// ---------------------------------------------------------------------------

interface ClaudeResultSlice {
  runStats?: import("../lib/run_stats.ts").RunStats;
  fallbackModel?: string;
}

interface FlagOutcome {
  verdict: DegradationVerdict;
  section: string;
  labelledIssues: Array<{ issue: number; label: string }>;
  comments: Array<{ issue: number; body: string }>;
}

/**
 * Run the planning-style flagging (buildDegradationReport → applyDegradedModelLabel)
 * for a phase, exactly as `planning_processor.ts` wires it. The optional
 * `phase` lets the per-repo-pin case judge a non-`planning` phase (`issue`)
 * against its base-tier routing.
 */
async function flagPlanning(
  result: ClaudeResultSlice,
  opts: {
    repo: string;
    parentIssue: number;
    subIssues: number[];
    phase?: string;
  },
): Promise<FlagOutcome> {
  const phase = opts.phase ?? "planning";
  const { ghCommandFn, addLabelCalls } = fakeGh();
  const report = buildDegradationReport({
    invocations: [{
      phase,
      runStats: result.runStats,
      fallbackModel: result.fallbackModel,
    }],
    phase,
    env: emptyEnv,
  });
  if (report.verdict.degraded) {
    await applyDegradedModelLabel({
      repo: opts.repo,
      parentIssueNumber: opts.parentIssue,
      subIssueNumbers: opts.subIssues,
      ghCommandFn,
      logger: recordingLogger(),
      cacheDir: await Deno.makeTempDir({ prefix: "fable_cycle_label_" }),
    });
  }
  return {
    verdict: report.verdict,
    section: report.section,
    labelledIssues: addLabelCalls,
    comments: [],
  };
}

/** Run the REAL grill_me flagging (reportGrillMeDegradation). */
async function flagGrillMe(
  result: ClaudeResultSlice,
  opts: { repo: string; issue: number },
): Promise<FlagOutcome> {
  const { ghCommandFn, addLabelCalls } = fakeGh();
  const { ghClient, comments } = fakeClient();
  const verdict = await reportGrillMeDegradation({
    repo: opts.repo,
    issueNumber: opts.issue,
    claudeResult: result,
    ghClient,
    runGhCommand: ghCommandFn,
    logger: recordingLogger(),
    cacheDir: await Deno.makeTempDir({ prefix: "fable_cycle_grill_" }),
    env: emptyEnv,
  });
  return { verdict, section: "", labelledIssues: addLabelCalls, comments };
}

const TEST_PERMS = {
  run: true,
  read: true,
  write: true,
  env: true,
} as const;

// ===========================================================================
// 1. Globally disabled → fallback to Opus 4.8 + flagged (both phases).
// ===========================================================================

Deno.test({
  name:
    "Fable cycle - planning: globally disabled → fallback to opus AND flagged degraded (#2737)",
  permissions: TEST_PERMS,
  ignore: Deno.build.os === "windows",
  async fn() {
    const { result, models, flag } = await withCleanModelState(() =>
      withStub(disabledStubBody(), async (stub) => {
        const result = await runClaudeWithRetry(
          {
            clock: fakeClock(),
            prompt: "plan",
            phase: "planning",
            agentBinaryPath: stub.path,
            env: emptyEnv,
            enableModelFallback: true,
            timeoutSeconds: 30,
            killAfterSeconds: 2,
          },
          FAST_RETRY,
        );
        const models = await readModelSequence(stub.modelLog);
        assert(result.ok);
        const flag = result.ok
          ? await flagPlanning(result.value, {
            repo: "owner/repo",
            parentIssue: 100,
            subIssues: [101, 102],
          })
          : undefined;
        return { result, models, flag };
      })
    );

    // Fallback subsystem: wait-free fable → opus, recovered on Opus 4.8.
    assert(result.ok);
    if (!result.ok || !flag) return;
    assertEquals(result.value.exitCode, 0);
    assertEquals(result.value.fallbackModel, "opus");
    assertEquals(models, ["fable", "opus"]);

    // Flagging subsystem: degraded via the explicit fallback signal, label on
    // the parent + every sub-issue, stats section rendered.
    assert(flag.verdict.degraded, "expected a degraded verdict");
    assertStringIncludes(flag.verdict.reason ?? "", "fallback");
    assertStringIncludes(flag.section, "## Planning run model stats");
    assertStringIncludes(flag.section, "Degraded:");
    assertEquals(
      flag.labelledIssues.map((c) => c.issue).sort(),
      [100, 101, 102],
    );
    assert(flag.labelledIssues.every((c) => c.label === DEGRADED_MODEL_LABEL));
  },
});

Deno.test({
  name:
    "Fable cycle - grill_me: globally disabled → fallback to opus AND flagged degraded (#2737)",
  permissions: TEST_PERMS,
  ignore: Deno.build.os === "windows",
  async fn() {
    const { result, models, flag } = await withCleanModelState(() =>
      withStub(disabledStubBody(), async (stub) => {
        const result = await runClaudeWithRetry(
          {
            clock: fakeClock(),
            prompt: "grill",
            phase: "grill_me",
            agentBinaryPath: stub.path,
            env: emptyEnv,
            enableModelFallback: true,
            timeoutSeconds: 30,
            killAfterSeconds: 2,
          },
          FAST_RETRY,
        );
        const models = await readModelSequence(stub.modelLog);
        assert(result.ok);
        const flag = result.ok
          ? await flagGrillMe(result.value, { repo: "owner/repo", issue: 200 })
          : undefined;
        return { result, models, flag };
      })
    );

    assert(result.ok);
    if (!result.ok || !flag) return;
    assertEquals(result.value.fallbackModel, "opus");
    assertEquals(models, ["fable", "opus"]);

    // Grill-me labels + posts only on a degraded round.
    assert(flag.verdict.degraded);
    assertStringIncludes(flag.verdict.reason ?? "", "fallback");
    assertEquals(flag.labelledIssues.length, 1);
    assertEquals(flag.labelledIssues[0]!.issue, 200);
    assertEquals(flag.labelledIssues[0]!.label, DEGRADED_MODEL_LABEL);
    assertEquals(flag.comments.length, 1);
    assertStringIncludes(flag.comments[0]!.body, "## Grill-me run model stats");
  },
});

// ===========================================================================
// 2. Silent substitution → flagged (no fallback needed; both phases).
// ===========================================================================

Deno.test({
  name:
    "Fable cycle - planning: silent substitution (served opus, exit 0) → flagged degraded, no fallback (#2737)",
  permissions: TEST_PERMS,
  ignore: Deno.build.os === "windows",
  async fn() {
    const { result, models, flag } = await withCleanModelState(() =>
      withStub(silentSubstitutionStubBody(), async (stub) => {
        const result = await runClaudeWithRetry(
          {
            clock: fakeClock(),
            prompt: "plan",
            phase: "planning",
            agentBinaryPath: stub.path,
            env: emptyEnv,
            enableModelFallback: true,
            timeoutSeconds: 30,
            killAfterSeconds: 2,
          },
          FAST_RETRY,
        );
        const models = await readModelSequence(stub.modelLog);
        assert(result.ok);
        const flag = result.ok
          ? await flagPlanning(result.value, {
            repo: "owner/repo",
            parentIssue: 300,
            subIssues: [301],
          })
          : undefined;
        return { result, models, flag };
      })
    );

    assert(result.ok);
    if (!result.ok || !flag) return;
    // No fallback fired — it already ran on Opus under a Fable request.
    assertEquals(result.value.fallbackModel, undefined);
    assertEquals(models, ["fable"]);
    assertEquals(result.value.runStats?.servedModels, ["claude-opus-4-8"]);

    // Flagged via the served-model mismatch, not a fallback.
    assert(flag.verdict.degraded);
    assertStringIncludes(flag.verdict.reason ?? "", "does not match");
    assertEquals(
      flag.labelledIssues.map((c) => c.issue).sort(),
      [300, 301],
    );
  },
});

Deno.test({
  name:
    "Fable cycle - grill_me: silent substitution (served opus, exit 0) → flagged degraded, no fallback (#2737)",
  permissions: TEST_PERMS,
  ignore: Deno.build.os === "windows",
  async fn() {
    const { result, models, flag } = await withCleanModelState(() =>
      withStub(silentSubstitutionStubBody(), async (stub) => {
        const result = await runClaudeWithRetry(
          {
            clock: fakeClock(),
            prompt: "grill",
            phase: "grill_me",
            agentBinaryPath: stub.path,
            env: emptyEnv,
            enableModelFallback: true,
            timeoutSeconds: 30,
            killAfterSeconds: 2,
          },
          FAST_RETRY,
        );
        const models = await readModelSequence(stub.modelLog);
        assert(result.ok);
        const flag = result.ok
          ? await flagGrillMe(result.value, { repo: "owner/repo", issue: 400 })
          : undefined;
        return { result, models, flag };
      })
    );

    assert(result.ok);
    if (!result.ok || !flag) return;
    assertEquals(result.value.fallbackModel, undefined);
    assertEquals(models, ["fable"]);
    assert(flag.verdict.degraded);
    assertStringIncludes(flag.verdict.reason ?? "", "does not match");
    assertEquals(flag.labelledIssues.length, 1);
    assertEquals(flag.comments.length, 1);
  },
});

// ===========================================================================
// 3. Self-heal → Fable used + NOT flagged (both phases).
// ===========================================================================

Deno.test({
  name:
    "Fable cycle - planning: Fable available again → requested, no fallback, NOT flagged (#2737)",
  permissions: TEST_PERMS,
  ignore: Deno.build.os === "windows",
  async fn() {
    const { result, models, flag } = await withCleanModelState(() =>
      withStub(selfHealStubBody(), async (stub) => {
        const result = await runClaudeWithRetry(
          {
            clock: fakeClock(),
            prompt: "plan",
            phase: "planning",
            agentBinaryPath: stub.path,
            env: emptyEnv,
            enableModelFallback: true,
            timeoutSeconds: 30,
            killAfterSeconds: 2,
          },
          FAST_RETRY,
        );
        const models = await readModelSequence(stub.modelLog);
        assert(result.ok);
        const flag = result.ok
          ? await flagPlanning(result.value, {
            repo: "owner/repo",
            parentIssue: 500,
            subIssues: [501],
          })
          : undefined;
        return { result, models, flag };
      })
    );

    assert(result.ok);
    if (!result.ok || !flag) return;
    // Fable requested and used, no downgrade.
    assertEquals(result.value.fallbackModel, undefined);
    assertEquals(models, ["fable"]);
    // NOT flagged: served Fable matches expected Fable, no label applied.
    assertEquals(flag.verdict.degraded, false);
    assertEquals(flag.labelledIssues.length, 0);
    assertStringIncludes(flag.section, "**Degraded:** no");
  },
});

Deno.test({
  name:
    "Fable cycle - grill_me: Fable available again → requested, no fallback, NOT flagged (#2737)",
  permissions: TEST_PERMS,
  ignore: Deno.build.os === "windows",
  async fn() {
    const { result, models, flag } = await withCleanModelState(() =>
      withStub(selfHealStubBody(), async (stub) => {
        const result = await runClaudeWithRetry(
          {
            clock: fakeClock(),
            prompt: "grill",
            phase: "grill_me",
            agentBinaryPath: stub.path,
            env: emptyEnv,
            enableModelFallback: true,
            timeoutSeconds: 30,
            killAfterSeconds: 2,
          },
          FAST_RETRY,
        );
        const models = await readModelSequence(stub.modelLog);
        assert(result.ok);
        const flag = result.ok
          ? await flagGrillMe(result.value, { repo: "owner/repo", issue: 600 })
          : undefined;
        return { result, models, flag };
      })
    );

    assert(result.ok);
    if (!result.ok || !flag) return;
    assertEquals(result.value.fallbackModel, undefined);
    assertEquals(models, ["fable"]);
    // Healthy grill-me round reports nothing: no label, no comment.
    assertEquals(flag.verdict.degraded, false);
    assertEquals(flag.labelledIssues.length, 0);
    assertEquals(flag.comments.length, 0);
  },
});

// ===========================================================================
// 4. Per-repo pin: Fable requested via `claude_model: "fable"` base tier
//    (not the per-phase default) — the cycle holds on that path too.
// ===========================================================================

Deno.test({
  name:
    "Fable cycle - per-repo claude_model:fable base tier: disabled → fallback to opus AND flagged degraded (#2737)",
  permissions: TEST_PERMS,
  ignore: Deno.build.os === "windows",
  async fn() {
    const { result, models, flag } = await withCleanModelState(() => {
      // The repo pins Fable as the base tier for every phase. `issue` defaults
      // to opus, so a Fable request here proves it came from the base tier
      // (buildClaudeModelArgs step 3), not a per-phase default.
      setActiveRepoModelEffortOverrides({ claudeModel: "fable" });
      return withStub(disabledStubBody(), async (stub) => {
        const result = await runClaudeWithRetry(
          {
            clock: fakeClock(),
            prompt: "work the issue",
            phase: "issue",
            agentBinaryPath: stub.path,
            env: emptyEnv,
            enableModelFallback: true,
            timeoutSeconds: 30,
            killAfterSeconds: 2,
          },
          FAST_RETRY,
        );
        const models = await readModelSequence(stub.modelLog);
        assert(result.ok);
        // The override is still active, so the flagging derives `fable` as the
        // expected model from the same base-tier routing.
        const flag = result.ok
          ? await flagPlanning(result.value, {
            repo: "owner/repo",
            parentIssue: 700,
            subIssues: [],
            phase: "issue",
          })
          : undefined;
        return { result, models, flag };
      });
    });

    assert(result.ok);
    if (!result.ok || !flag) return;
    assertEquals(result.value.fallbackModel, "opus");
    assertEquals(models, ["fable", "opus"]);
    assert(flag.verdict.degraded, "base-tier fable must flag degraded too");
    assertStringIncludes(flag.verdict.reason ?? "", "fallback");
    assertEquals(flag.labelledIssues.map((c) => c.issue), [700]);
    assertEquals(flag.labelledIssues[0]!.label, DEGRADED_MODEL_LABEL);
  },
});
