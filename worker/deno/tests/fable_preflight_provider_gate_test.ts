/**
 * The pre-flight Fable reroute is provider-gated (Issue #398).
 *
 * `--model opus` is an Anthropic tier alias. Before this gate, a cached
 * `unavailable` Fable verdict rerouted **every** Fable-preferring phase at the
 * `runClaudeWithRetry` chokepoint, whichever agent the invocation named — so a
 * Quorum draft running `agentProvider: "codex"` was handed a model that CLI
 * cannot resolve and the run was flagged `preflightDegraded` for a tier it
 * never requested.
 *
 * These tests drive `runClaudeWithRetry` end to end against a stub agent named
 * by path (`agentBinaryPath`, Issue #959), with a cached `unavailable` verdict
 * in the run's cwd, and assert:
 *   - a Codex `quorum` invocation carries no `opus` / `max` in its argv and is
 *     not flagged degraded, while its own top-tier routing still reaches the
 *     CLI, and the skipped reroute is reported loudly;
 *   - the Claude invocation of the same phase is still rerouted, so the gate
 *     narrowed the behaviour rather than removing it.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { runClaudeWithRetry } from "../lib/claude_runner.ts";
import type { Logger } from "../types.ts";
import { resolveAgentProvider } from "../lib/agent_provider.ts";
import {
  setActiveRepoModelEffortOverrides,
  setPhaseEffortConfigOverrides,
  setPhaseModelConfigOverrides,
} from "../lib/claude_executor.ts";
import {
  setActiveRepoCodexModelEffortOverrides,
  setCodexPhaseEffortConfigOverrides,
  setCodexPhaseModelConfigOverrides,
} from "../lib/codex_executor.ts";
import {
  clearFableTierWarnings,
  FABLE_PREFLIGHT_DEGRADED_REASON,
} from "../lib/fable_routing.ts";
import { recordFableAvailability } from "../lib/health_check_cache.ts";
import { withAgentStub } from "./support/agent_stub.ts";
import { emptyEnv } from "./support/env_lookup.ts";
import { fakeClock } from "./support/fake_clock.ts";

/** Basename of the file the stub records its argv in. */
const ARG_LOG = "argv.log";

/**
 * A stub agent CLI: records its whole argv beside itself, then exits 0 with a
 * result line. The log is located from `$0`, so the same body serves whichever
 * provider the invocation names.
 */
function stubBody(): string {
  return [
    `log="$(dirname "$0")/${ARG_LOG}"`,
    `for arg in "$@"; do printf '%s\\n' "$arg" >> "$log"; done`,
    `printf '%s\\n' '{"type":"result","result":"OK"}'`,
    "exit 0",
  ].join("\n");
}

interface Stub {
  /** Absolute path to the stub, passed to the runner as `agentBinaryPath`. */
  path: string;
  /** Working directory, also holding the cached Fable verdict. */
  cwd: string;
  /** Argv recorded by the stub, one element per line. */
  args: () => Promise<string[]>;
}

/**
 * Run `fn` with a stub agent and a fresh working directory.
 *
 * Nothing here touches process state: the stub is named by path (Issue #959)
 * and each run reads {@link emptyEnv} (Issue #961), so the ambient
 * `CLAUDE_*` / `CODEX_*` routing variables, the per-run provider override and
 * the image stamp are all invisible to the gate — it is exercised against the
 * designed defaults. No vendor credential is exported either: the stub is the
 * agent, so no provider pre-flight reaches a vendor.
 */
function withStubs<T>(fn: (stub: Stub) => Promise<T>): Promise<T> {
  // Deno shares one process across test files: reset the module-level repo and
  // config routing overrides a sibling file may have set.
  setActiveRepoModelEffortOverrides(undefined);
  setPhaseModelConfigOverrides({});
  setPhaseEffortConfigOverrides({});
  setActiveRepoCodexModelEffortOverrides(undefined);
  setCodexPhaseModelConfigOverrides({});
  setCodexPhaseEffortConfigOverrides({});
  clearFableTierWarnings();

  return withAgentStub(stubBody(), async (stub) => {
    try {
      return await fn({
        path: stub.path,
        cwd: stub.dir,
        args: async () =>
          (await Deno.readTextFile(`${stub.dir}/${ARG_LOG}`).catch(() => ""))
            .split("\n").filter((line) => line !== ""),
      });
    } finally {
      clearFableTierWarnings();
    }
  }, { prefix: "fable_provider_gate_" });
}

/** A logger that keeps every warning, discarding the rest. */
function recordingLogger(warnings: string[]): Logger {
  return {
    info: () => {},
    warn: (message: string) => {
      warnings.push(message);
    },
    error: () => {},
    debug: () => {},
    security: () => {},
    skipReason: () => {},
    timing: () => {},
    scanSummary: () => {},
    workerSummary: () => {},
  } as unknown as Logger;
}

Deno.test({
  name:
    "gate: unavailable Fable ⇒ a Codex quorum invocation keeps its own routing, no --model opus, not degraded (Issue #398)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const warnings: string[] = [];
    const { result, args } = await withStubs(async (stub) => {
      const recorded = recordFableAvailability(stub.cwd, false);
      assert(recorded.ok);

      const result = await runClaudeWithRetry(
        {
          clock: fakeClock(),
          prompt: "draft a plan",
          phase: "quorum",
          cwd: stub.cwd,
          timeoutSeconds: 30,
          agentProvider: "codex",
          agentBinaryPath: stub.path,
          env: emptyEnv,
          logger: recordingLogger(warnings),
        },
        { maxRetries: 0, maxWaitSeconds: 1, initialWaitInterval: 0 },
      );
      return { result, args: await stub.args() };
    });

    assert(result.ok, `expected ok, got ${!result.ok && result.error}`);
    if (!result.ok) return;

    // The Anthropic tier alias never reaches the Codex CLI.
    assert(
      !args.includes("opus"),
      `Codex argv must carry no Anthropic tier alias: ${args.join(" ")}`,
    );
    assert(
      !args.some((arg) => arg.includes("max")),
      `Codex argv must carry no Claude-only effort: ${args.join(" ")}`,
    );

    // Codex's own top-tier routing for the phase still reaches the CLI.
    const codexModel = resolveAgentProvider("codex").resolveModel(
      "quorum",
      emptyEnv,
    );
    assert(codexModel, "codex must route the quorum phase to a model");
    assertEquals(args[args.indexOf("--model") + 1], codexModel);

    // The run is not flagged degraded for a tier it never requested.
    assertEquals(result.value.preflightDegraded, undefined);
    assertEquals(result.value.preflightDegradedReason, undefined);

    // The skipped reroute is reported loudly rather than passing in silence.
    const gap = warnings.find((message) => message.includes("[fable-routing]"));
    assert(gap, `expected a no-Fable-tier warning, got: ${warnings.join("|")}`);
    assert(gap.includes("codex"), gap);
  },
});

Deno.test({
  name:
    "gate: unavailable Fable ⇒ the Claude quorum invocation is still rerouted to opus @ max and flagged degraded",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const { result, args } = await withStubs(async (stub) => {
      const recorded = recordFableAvailability(stub.cwd, false);
      assert(recorded.ok);

      const result = await runClaudeWithRetry(
        {
          clock: fakeClock(),
          prompt: "draft a plan",
          phase: "quorum",
          cwd: stub.cwd,
          timeoutSeconds: 30,
          agentProvider: "claude",
          agentBinaryPath: stub.path,
          env: emptyEnv,
        },
        { maxRetries: 0, maxWaitSeconds: 1, initialWaitInterval: 0 },
      );
      return { result, args: await stub.args() };
    });

    assert(result.ok, `expected ok, got ${!result.ok && result.error}`);
    if (!result.ok) return;

    assertEquals(args[args.indexOf("--model") + 1], "opus");
    assertEquals(args[args.indexOf("--effort") + 1], "max");
    assertEquals(result.value.preflightDegraded, true);
    assertEquals(
      result.value.preflightDegradedReason,
      FABLE_PREFLIGHT_DEGRADED_REASON,
    );
  },
});
