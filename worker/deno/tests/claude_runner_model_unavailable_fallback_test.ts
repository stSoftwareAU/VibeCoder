/**
 * End-to-end tests for the model-UNAVAILABLE fallback loop inside
 * `runClaudeWithRetry()` (Issue #2735, parent #2720, builds on #2724).
 *
 * The rate-limit fallback loop is covered by
 * `claude_runner_rate_limit_fallback_test.ts`, and the pure detection /
 * resolution helpers by `model_unavailable_fallback_test.ts` and
 * `model_fallback_test.ts`. What was untested is the *model-unavailable* wiring
 * end-to-end through the loop when Fable is requested **implicitly** — i.e. not
 * via an explicit `model:` option, but via:
 *
 *   - a top-tier `phase` default (`planning`, `grill_me` → fable), and
 *   - a per-repo `claude_model: "fable"` base tier (buildClaudeModelArgs step 3).
 *
 * These are exactly the paths #2720 promises self-heal for: every run
 * re-resolves the model from config (which still points at Fable), so when
 * Fable returns the worker requests it again with no manual change. The tests
 * prove the export-disable signal drives an immediate, wait-free `fable → opus`
 * (Opus 4.8) downgrade, and that absent the signal Fable is requested and used
 * unchanged (self-heal).
 *
 * The stub agent — named by path (`agentBinaryPath`, Issue #959) rather than
 * put on the process-wide `PATH` — emits the Fable export-disable error and
 * exits non-zero only while the requested `--model` is `fable`; for any other
 * tier it succeeds. So the recorded `--model` sequence proves the precise hop
 * and that the run then succeeds on Opus. The routing chain reads an injected
 * environment (`RunClaudeOptions.env`, Issue #961), so the phase resolves from
 * `PHASE_MODEL_DEFAULTS` whatever the worker session exports.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { runClaudeWithRetry } from "../lib/claude_runner.ts";
import { setActiveRepoModelEffortOverrides } from "../lib/claude_executor.ts";
import { withAgentStub } from "./support/agent_stub.ts";
import { emptyEnv } from "./support/env_lookup.ts";

// ---------------------------------------------------------------------------
// Stub harness — a fake agent, named by path (Issue #959), that records its
// --model arg. While the requested model is `fable` it emits a Fable
// export-disable error and exits non-zero; for any other model it emits a
// success result and exits 0. This makes the recorded sequence prove the
// fable → opus hop AND that the run recovers on Opus rather than continuing
// down the chain.
// ---------------------------------------------------------------------------

interface StubClaude {
  /** Absolute path to the stub, passed to the runner as `agentBinaryPath`. */
  path: string;
  /** Path the stub appends each invocation's --model value to. */
  modelLog: string;
}

/** Basename of the file the stub records each invocation's model in. */
const MODEL_LOG = "models.log";

/**
 * Build a stub agent body. It records each invocation's `--model` value beside
 * the stub, located from `$0` so no path is baked in. If that value is `fable`
 * it prints the export-disable error and exits `failExit`; otherwise it prints
 * a success result and exits 0.
 */
function buildUnavailableStubBody(failExit: number): string {
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
    // Export-control disable signature (matches detectModelUnavailable).
    `  printf '%s\\n' '{"type":"result","result":"API Error: 403 Fable is restricted in your region due to export controls"}'`,
    `  exit ${failExit}`,
    `fi`,
    `printf '%s\\n' '{"type":"result","result":"Done."}'`,
    `exit 0`,
  ].join("\n");
}

/**
 * Build a stub agent body that ALWAYS succeeds (Fable available again) — the
 * self-heal case. Records the `--model` value and exits 0 regardless of tier.
 */
function buildAlwaysOkStubBody(): string {
  return [
    `log="$(dirname "$0")/${MODEL_LOG}"`,
    `prev=""`,
    `for arg in "$@"; do`,
    `  if [ "$prev" = "--model" ]; then`,
    `    printf '%s\\n' "$arg" >> "$log"`,
    `  fi`,
    `  prev="$arg"`,
    `done`,
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
    { prefix: "claude_unavail_stub_" },
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

// maxRetries=0 so the model-unavailable branch is taken on the first failure of
// each tier with no wait — keeps the run well under the unit-test budget.
const FAST_RETRY = {
  maxRetries: 0,
  maxWaitSeconds: 1,
  initialWaitInterval: 0,
} as const;

/**
 * Clear the per-repo routing state so `phase` resolves purely from
 * `PHASE_MODEL_DEFAULTS`.
 *
 * The env half of the old spelling is gone: every run below injects
 * {@link emptyEnv} as `RunClaudeOptions.env` (Issue #961), so a
 * `CLAUDE_MODEL*` the worker session happens to export is invisible to the
 * routing chain and nothing has to be deleted from — and restored to — a
 * process every other test in the run shares.
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
// Both top-tier phases: an implicit fable (resolved from the phase default)
// falls back to opus and the run succeeds there — no explicit model option.
// ---------------------------------------------------------------------------

for (const phase of ["planning", "grill_me"] as const) {
  Deno.test({
    name:
      `runClaudeWithRetry - ${phase} phase: export-disabled fable falls back to opus and succeeds (Issue #2735)`,
    permissions: { run: true, read: true, write: true, env: true },
    ignore: Deno.build.os === "windows",
    async fn() {
      const { result, models } = await withCleanModelState(() =>
        withStub(
          buildUnavailableStubBody(1),
          async (stub) => {
            const result = await runClaudeWithRetry(
              {
                prompt: "test",
                phase,
                agentBinaryPath: stub.path,
                env: emptyEnv,
                enableModelFallback: true,
                timeoutSeconds: 30,
                killAfterSeconds: 2,
              },
              FAST_RETRY,
            );
            return { result, models: await readModelSequence(stub.modelLog) };
          },
        )
      );

      assert(result.ok, `expected ok result`);
      if (!result.ok) return;
      // Recovered on Opus 4.8 (the `opus` alias) with no wait.
      assertEquals(result.value.exitCode, 0);
      assertEquals(result.value.fallbackModel, "opus");
      assertEquals(result.value.timedOut, false);
      // Implicit fable requested first, then the wait-free downgrade to opus.
      assertEquals(models, ["fable", "opus"]);
    },
  });
}

// ---------------------------------------------------------------------------
// Per-repo `claude_model: "fable"` base tier (buildClaudeModelArgs step 3) —
// the fallback covers the base-tier path, not just per-phase defaults.
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "runClaudeWithRetry - per-repo claude_model:fable base tier falls back to opus and succeeds (Issue #2735)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const { result, models } = await withCleanModelState(() => {
      // Repo pins fable as the base tier for every phase.
      setActiveRepoModelEffortOverrides({ claudeModel: "fable" });
      return withStub(
        buildUnavailableStubBody(1),
        async (stub) => {
          const result = await runClaudeWithRetry(
            {
              prompt: "test",
              phase: "issue",
              agentBinaryPath: stub.path,
              env: emptyEnv,
              enableModelFallback: true,
              timeoutSeconds: 30,
              killAfterSeconds: 2,
            },
            FAST_RETRY,
          );
          return { result, models: await readModelSequence(stub.modelLog) };
        },
      );
    });

    assert(result.ok);
    if (!result.ok) return;
    assertEquals(result.value.exitCode, 0);
    assertEquals(result.value.fallbackModel, "opus");
    assertEquals(models, ["fable", "opus"]);
  },
});

// ---------------------------------------------------------------------------
// Self-heal: once Fable is available again, a run requests fable and uses it —
// the fallback only fires while the unavailable signal is present.
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "runClaudeWithRetry - self-heal: fable requested and used when available (no fallback), Issue #2735",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const { result, models } = await withCleanModelState(() =>
      withStub(
        buildAlwaysOkStubBody(),
        async (stub) => {
          const result = await runClaudeWithRetry(
            {
              prompt: "test",
              phase: "planning",
              agentBinaryPath: stub.path,
              env: emptyEnv,
              enableModelFallback: true,
              timeoutSeconds: 30,
              killAfterSeconds: 2,
            },
            FAST_RETRY,
          );
          return { result, models: await readModelSequence(stub.modelLog) };
        },
      )
    );

    assert(result.ok);
    if (!result.ok) return;
    assertEquals(result.value.exitCode, 0);
    // No downgrade happened — fable was used and never replaced.
    assertEquals(result.value.fallbackModel, undefined);
    assertEquals(models, ["fable"]);
  },
});

// ---------------------------------------------------------------------------
// enableModelFallback:false still gates the behaviour — a phase-resolved fable
// that is export-disabled gives up cleanly with no downgrade.
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "runClaudeWithRetry - enableModelFallback:false gives up with no downgrade for a phase-resolved fable (Issue #2735)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const { result, models } = await withCleanModelState(() =>
      withStub(
        buildUnavailableStubBody(1),
        async (stub) => {
          const result = await runClaudeWithRetry(
            {
              prompt: "test",
              phase: "grill_me",
              agentBinaryPath: stub.path,
              env: emptyEnv,
              enableModelFallback: false,
              timeoutSeconds: 30,
              killAfterSeconds: 2,
            },
            FAST_RETRY,
          );
          return { result, models: await readModelSequence(stub.modelLog) };
        },
      )
    );

    assert(result.ok);
    if (!result.ok) return;
    // Give-up branch: no model mutation, the failing exit is returned.
    assertEquals(result.value.exitCode, 1);
    assertEquals(result.value.fallbackModel, undefined);
    assertEquals(models, ["fable"]);
  },
});
