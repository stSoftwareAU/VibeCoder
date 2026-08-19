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
 * The stub `claude` on PATH emits the Fable export-disable error and exits
 * non-zero only while the requested `--model` is `fable`; for any other tier it
 * succeeds. So the recorded `--model` sequence proves the precise hop and that
 * the run then succeeds on Opus.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { runClaudeWithRetry } from "../lib/claude_runner.ts";
import { setActiveRepoModelEffortOverrides } from "../lib/claude_executor.ts";

// ---------------------------------------------------------------------------
// Stub harness — a fake `claude` on PATH that records its --model arg. While
// the requested model is `fable` it emits a Fable export-disable error and
// exits non-zero; for any other model it emits a success result and exits 0.
// This makes the recorded sequence prove the fable → opus hop AND that the run
// recovers on Opus rather than continuing down the chain.
// ---------------------------------------------------------------------------

interface StubClaude {
  dir: string;
  modelLog: string;
}

/**
 * Build a stub `claude` body. It records each invocation's `--model` value to
 * `modelLog`. If that value is `fable` it prints the export-disable error and
 * exits `failExit`; otherwise it prints a success result and exits 0.
 */
function buildUnavailableStubBody(modelLog: string, failExit: number): string {
  return [
    `model=""`,
    `prev=""`,
    `for arg in "$@"; do`,
    `  if [ "$prev" = "--model" ]; then`,
    `    model="$arg"`,
    `    printf '%s\\n' "$arg" >> '${modelLog}'`,
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
 * Build a stub `claude` body that ALWAYS succeeds (Fable available again) — the
 * self-heal case. Records the `--model` value and exits 0 regardless of tier.
 */
function buildAlwaysOkStubBody(modelLog: string): string {
  return [
    `prev=""`,
    `for arg in "$@"; do`,
    `  if [ "$prev" = "--model" ]; then`,
    `    printf '%s\\n' "$arg" >> '${modelLog}'`,
    `  fi`,
    `  prev="$arg"`,
    `done`,
    `printf '%s\\n' '{"type":"result","result":"Done on Fable."}'`,
    `exit 0`,
  ].join("\n");
}

async function withStub<T>(
  body: (modelLog: string) => string,
  fn: (stub: StubClaude) => Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "claude_unavail_stub_" });
  const modelLog = `${dir}/models.log`;
  const stubPath = `${dir}/claude`;
  await Deno.writeTextFile(
    stubPath,
    `#!/usr/bin/env bash\n${body(modelLog)}\n`,
  );
  await Deno.chmod(stubPath, 0o755);
  const originalPath = Deno.env.get("PATH") ?? "";
  Deno.env.set("PATH", `${dir}:${originalPath}`);
  try {
    return await fn({ dir, modelLog });
  } finally {
    Deno.env.set("PATH", originalPath);
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
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

/** Clear env/per-repo state so `phase` resolves purely from PHASE_MODEL_DEFAULTS. */
function withCleanModelEnv<T>(fn: () => Promise<T>): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (
    const key of [
      "CLAUDE_MODEL",
      "CLAUDE_MODEL_PLANNING",
      "CLAUDE_MODEL_GRILL_ME",
      "CLAUDE_MODEL_ISSUE",
    ]
  ) {
    saved.set(key, Deno.env.get(key));
    Deno.env.delete(key);
  }
  setActiveRepoModelEffortOverrides(undefined);
  return (async () => {
    try {
      return await fn();
    } finally {
      setActiveRepoModelEffortOverrides(undefined);
      for (const [key, value] of saved) {
        if (value !== undefined) Deno.env.set(key, value);
        else Deno.env.delete(key);
      }
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
      const { result, models } = await withCleanModelEnv(() =>
        withStub(
          (log) => buildUnavailableStubBody(log, 1),
          async (stub) => {
            const result = await runClaudeWithRetry(
              {
                prompt: "test",
                phase,
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
    const { result, models } = await withCleanModelEnv(() => {
      // Repo pins fable as the base tier for every phase.
      setActiveRepoModelEffortOverrides({ claudeModel: "fable" });
      return withStub(
        (log) => buildUnavailableStubBody(log, 1),
        async (stub) => {
          const result = await runClaudeWithRetry(
            {
              prompt: "test",
              phase: "issue",
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
    const { result, models } = await withCleanModelEnv(() =>
      withStub(
        (log) => buildAlwaysOkStubBody(log),
        async (stub) => {
          const result = await runClaudeWithRetry(
            {
              prompt: "test",
              phase: "planning",
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
    const { result, models } = await withCleanModelEnv(() =>
      withStub(
        (log) => buildUnavailableStubBody(log, 1),
        async (stub) => {
          const result = await runClaudeWithRetry(
            {
              prompt: "test",
              phase: "grill_me",
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
