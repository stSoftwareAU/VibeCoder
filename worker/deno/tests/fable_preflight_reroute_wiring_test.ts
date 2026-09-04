/**
 * End-to-end wiring test for the pre-flight Fable reroute (Issue #3231).
 *
 * Asserts that when the cached Fable probe says `unavailable`, a
 * Fable-preferring phase dispatched through `runClaudeWithRetry()`:
 *   - actually invokes `claude` with `--model opus --effort max` (the override
 *     reaches the run options → the CLI args), and
 *   - carries `preflightDegraded: true` + the reason on the run record,
 * while `buildClaudeModelArgs("planning")` STILL resolves to `fable` (the
 * override lives at the invocation layer, not in PHASE_MODEL_DEFAULTS — the
 * #2720 served-vs-expected check must keep working).
 *
 * A stub agent — named by path (`agentBinaryPath`, Issue #959) rather than put
 * on the process-wide `PATH` — records the `--model`/`--effort` args and exits
 * 0, so no real model is called and the run stays well under the unit-test
 * budget. Every run reads an injected environment (`RunClaudeOptions.env`,
 * Issue #961), so an operator pin is stated by the test rather than exported
 * into the process every other test in the run shares.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  buildClaudeModelArgs,
  runClaudeWithRetry,
} from "../lib/claude_runner.ts";
import {
  setActiveRepoModelEffortOverrides,
  setPhaseEffortConfigOverrides,
  setPhaseModelConfigOverrides,
} from "../lib/claude_executor.ts";
import { FABLE_PREFLIGHT_DEGRADED_REASON } from "../lib/fable_routing.ts";
import { recordFableAvailability } from "../lib/health_check_cache.ts";
import { withAgentStub } from "./support/agent_stub.ts";
import { emptyEnv, envFrom } from "./support/env_lookup.ts";

/** Basename of the file the stub records its routing args in. */
const ARG_LOG = "args.log";

/**
 * A stub agent that records the value following `--model` and `--effort`
 * (one `key=value` per line) beside itself, prints a minimal stream-json
 * success line, and exits 0.
 *
 * The log is located from `$0`, so no path is baked into the body and the
 * helper needs no temp directory of its own.
 */
function buildArgRecordingStub(): string {
  return [
    `log="$(dirname "$0")/${ARG_LOG}"`,
    `prev=""`,
    `for arg in "$@"; do`,
    `  if [ "$prev" = "--model" ]; then printf 'model=%s\\n' "$arg" >> "$log"; fi`,
    `  if [ "$prev" = "--effort" ]; then printf 'effort=%s\\n' "$arg" >> "$log"; fi`,
    `  prev="$arg"`,
    `done`,
    `printf '%s\\n' '{"type":"result","result":"OK"}'`,
    `exit 0`,
  ].join("\n");
}

interface Stub {
  /** Absolute path to the stub, passed to the runner as `agentBinaryPath`. */
  path: string;
  /** Working directory (also holds the `.health_cache_fable` file). */
  cwd: string;
  /** Path the stub appends `model=…` / `effort=…` lines to. */
  argLog: string;
}

/**
 * Run `fn` with a stub agent and a fresh working directory.
 *
 * Nothing here touches process state: the stub is named by path (Issue #959)
 * and each test states the environment its run resolves against (Issue #961),
 * so the ambient `CLAUDE_MODEL*` / `CLAUDE_EFFORT*` of the worker session can
 * no longer perturb the reroute. The module-level repo/config overrides are
 * still reset, since Deno shares one process across the files of a run.
 */
function withStub<T>(fn: (stub: Stub) => Promise<T>): Promise<T> {
  setActiveRepoModelEffortOverrides(undefined);
  setPhaseModelConfigOverrides({});
  setPhaseEffortConfigOverrides({});
  return withAgentStub(
    buildArgRecordingStub(),
    (stub) =>
      fn({
        path: stub.path,
        cwd: stub.dir,
        argLog: `${stub.dir}/${ARG_LOG}`,
      }),
    { prefix: "fable_preflight_" },
  );
}

/** Parse the recorded `key=value` lines into an object. */
async function readArgs(
  argLog: string,
): Promise<{ model?: string; effort?: string }> {
  const out: { model?: string; effort?: string } = {};
  try {
    const text = await Deno.readTextFile(argLog);
    for (const line of text.split("\n")) {
      const [k, v] = line.split("=");
      if (k === "model") out.model = v;
      if (k === "effort") out.effort = v;
    }
  } catch { /* never invoked */ }
  return out;
}

Deno.test({
  name:
    "wiring: unavailable Fable ⇒ planning dispatches --model opus --effort max, run flagged degraded",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const { result, args } = await withStub(async (stub) => {
      // Cache a fresh "unavailable" verdict in the run's cwd.
      const rec = recordFableAvailability(stub.cwd, false);
      assert(rec.ok);

      const result = await runClaudeWithRetry(
        {
          prompt: "plan it",
          phase: "planning",
          cwd: stub.cwd,
          agentBinaryPath: stub.path,
          env: emptyEnv,
          timeoutSeconds: 30,
        },
        { maxRetries: 0, maxWaitSeconds: 1, initialWaitInterval: 0 },
      );
      return { result, args: await readArgs(stub.argLog) };
    });

    assert(result.ok, `expected ok, got ${!result.ok && result.error}`);
    if (!result.ok) return;

    // The override reached the CLI invocation.
    assertEquals(args.model, "opus");
    assertEquals(args.effort, "max");

    // The degraded flag + reason are threaded onto the run record.
    assertEquals(result.value.preflightDegraded, true);
    assertEquals(
      result.value.preflightDegradedReason,
      FABLE_PREFLIGHT_DEGRADED_REASON,
    );

    // Regression guard: the expected-model derivation is untouched.
    assertEquals(buildClaudeModelArgs("planning", emptyEnv), [
      "--model",
      "fable",
    ]);
  },
});

Deno.test({
  name:
    "wiring: available Fable ⇒ planning dispatches --model fable, no degraded flag",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const { result, args } = await withStub(async (stub) => {
      const rec = recordFableAvailability(stub.cwd, true);
      assert(rec.ok);

      const result = await runClaudeWithRetry(
        {
          prompt: "plan it",
          phase: "planning",
          cwd: stub.cwd,
          agentBinaryPath: stub.path,
          env: emptyEnv,
          timeoutSeconds: 30,
        },
        { maxRetries: 0, maxWaitSeconds: 1, initialWaitInterval: 0 },
      );
      return { result, args: await readArgs(stub.argLog) };
    });

    assert(result.ok);
    if (!result.ok) return;

    // No reroute: the phase requests its normal Fable tier.
    assertEquals(args.model, "fable");
    // No degraded fields present on a healthy run.
    assertEquals(result.value.preflightDegraded, undefined);
    assertEquals(result.value.preflightDegradedReason, undefined);
  },
});

Deno.test({
  name:
    "wiring: operator model pin (CLAUDE_MODEL_PLANNING=sonnet) suppresses the reroute even when unavailable",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const { result, args } = await withStub(async (stub) => {
      const rec = recordFableAvailability(stub.cwd, false);
      assert(rec.ok);
      const result = await runClaudeWithRetry(
        {
          prompt: "plan it",
          phase: "planning",
          cwd: stub.cwd,
          agentBinaryPath: stub.path,
          // An operator pinned planning off the Fable tier.
          env: envFrom({ CLAUDE_MODEL_PLANNING: "sonnet" }),
          timeoutSeconds: 30,
        },
        { maxRetries: 0, maxWaitSeconds: 1, initialWaitInterval: 0 },
      );
      return { result, args: await readArgs(stub.argLog) };
    });

    assert(result.ok);
    if (!result.ok) return;

    // The operator's pin wins — no Opus reroute, run not flagged degraded.
    assertEquals(args.model, "sonnet");
    assertEquals(result.value.preflightDegraded, undefined);
  },
});

Deno.test({
  name:
    "wiring: explicit effort override (CLAUDE_EFFORT_PLANNING) suppresses the reroute even when unavailable",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const { result, args } = await withStub(async (stub) => {
      const rec = recordFableAvailability(stub.cwd, false);
      assert(rec.ok);
      const result = await runClaudeWithRetry(
        {
          prompt: "plan it",
          phase: "planning",
          cwd: stub.cwd,
          agentBinaryPath: stub.path,
          // An operator pinned planning effort — the probe must not bump to
          // max.
          env: envFrom({ CLAUDE_EFFORT_PLANNING: "high" }),
          timeoutSeconds: 30,
        },
        { maxRetries: 0, maxWaitSeconds: 1, initialWaitInterval: 0 },
      );
      return { result, args: await readArgs(stub.argLog) };
    });

    assert(result.ok);
    if (!result.ok) return;

    // No reroute: model stays on the phase default (fable), effort respected.
    assertEquals(args.model, "fable");
    assertEquals(args.effort, "high");
    assertEquals(result.value.preflightDegraded, undefined);
  },
});

Deno.test({
  name:
    "wiring: non-Fable-preferring phase is never rerouted even when unavailable",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const { result, args } = await withStub(async (stub) => {
      const rec = recordFableAvailability(stub.cwd, false);
      assert(rec.ok);

      // `issue` is not in the Fable-preferring set.
      const result = await runClaudeWithRetry(
        {
          prompt: "code it",
          phase: "issue",
          cwd: stub.cwd,
          agentBinaryPath: stub.path,
          env: emptyEnv,
          timeoutSeconds: 30,
        },
        { maxRetries: 0, maxWaitSeconds: 1, initialWaitInterval: 0 },
      );
      return { result, args: await readArgs(stub.argLog) };
    });

    assert(result.ok);
    if (!result.ok) return;

    // Not "opus" from a reroute — resolves via the issue phase's own default.
    assert(args.model !== undefined);
    assertEquals(result.value.preflightDegraded, undefined);
  },
});
