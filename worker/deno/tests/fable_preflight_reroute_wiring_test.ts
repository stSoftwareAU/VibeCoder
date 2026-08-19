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
 * A stub `claude` on PATH records the `--model`/`--effort` args and exits 0, so
 * no real model is called and the run stays well under the unit-test budget.
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

/**
 * A stub `claude` that records the value following `--model` and `--effort`
 * (one `key=value` per line) to `argLog`, prints a minimal stream-json success
 * line, and exits 0.
 */
function buildArgRecordingStub(argLog: string): string {
  return [
    `prev=""`,
    `for arg in "$@"; do`,
    `  if [ "$prev" = "--model" ]; then printf 'model=%s\\n' "$arg" >> '${argLog}'; fi`,
    `  if [ "$prev" = "--effort" ]; then printf 'effort=%s\\n' "$arg" >> '${argLog}'; fi`,
    `  prev="$arg"`,
    `done`,
    `printf '%s\\n' '{"type":"result","result":"OK"}'`,
    `exit 0`,
  ].join("\n");
}

interface Stub {
  /** Working directory (also holds the `.health_cache_fable` file). */
  cwd: string;
  /** Path the stub appends `model=…` / `effort=…` lines to. */
  argLog: string;
}

/**
 * Run `fn` with a stub `claude` on PATH and a fresh working directory. The
 * stub records its `--model`/`--effort` args; PATH and the temp dir are
 * restored/cleaned afterwards.
 */
// Env vars whose ambient values would perturb model/effort resolution. Cleared
// for the duration of each test and restored afterwards, so the reroute is
// exercised against the designed defaults (planning ⇒ fable @ its default
// effort), independent of the worker session's own environment.
const MANAGED_ENV = [
  "CLAUDE_EFFORT",
  "CLAUDE_EFFORT_PLANNING",
  "CLAUDE_MODEL",
  "CLAUDE_MODEL_PLANNING",
] as const;

async function withStub<T>(fn: (stub: Stub) => Promise<T>): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "fable_preflight_" });
  const argLog = `${dir}/args.log`;
  const stubPath = `${dir}/claude`;
  await Deno.writeTextFile(
    stubPath,
    `#!/usr/bin/env bash\n${buildArgRecordingStub(argLog)}\n`,
  );
  await Deno.chmod(stubPath, 0o755);
  const originalPath = Deno.env.get("PATH") ?? "";
  const savedEnv = new Map<string, string | undefined>();
  for (const key of MANAGED_ENV) {
    savedEnv.set(key, Deno.env.get(key));
    Deno.env.delete(key);
  }
  Deno.env.set("PATH", `${dir}:${originalPath}`);
  // Reset module-level repo/config overrides so state set by a sibling test
  // file (Deno shares one process across files) cannot perturb resolution.
  setActiveRepoModelEffortOverrides(undefined);
  setPhaseModelConfigOverrides({});
  setPhaseEffortConfigOverrides({});
  try {
    return await fn({ cwd: dir, argLog });
  } finally {
    Deno.env.set("PATH", originalPath);
    for (const [key, value] of savedEnv) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
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
    assertEquals(buildClaudeModelArgs("planning"), ["--model", "fable"]);
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
      // An operator pinned planning off the Fable tier.
      Deno.env.set("CLAUDE_MODEL_PLANNING", "sonnet");

      const result = await runClaudeWithRetry(
        {
          prompt: "plan it",
          phase: "planning",
          cwd: stub.cwd,
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
      // An operator pinned planning effort — the probe must not bump to max.
      Deno.env.set("CLAUDE_EFFORT_PLANNING", "high");

      const result = await runClaudeWithRetry(
        {
          prompt: "plan it",
          phase: "planning",
          cwd: stub.cwd,
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
