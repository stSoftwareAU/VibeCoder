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
 * These tests drive `runClaudeWithRetry` end to end against stub `codex` and
 * `claude` binaries on PATH, with a cached `unavailable` verdict in the run's
 * cwd, and assert:
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
import {
  IMAGE_AGENT_PROVIDERS_ENV,
  resolveAgentProvider,
} from "../lib/agent_provider.ts";
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

/** A stub agent CLI: records its whole argv, then exits 0 with a result line. */
function stubBody(argLog: string): string {
  return [
    "#!/usr/bin/env bash",
    `for arg in "$@"; do printf '%s\\n' "$arg" >> '${argLog}'; done`,
    `printf '%s\\n' '{"type":"result","result":"OK"}'`,
    "exit 0",
  ].join("\n");
}

interface Stub {
  /** Working directory, also holding the cached Fable verdict. */
  cwd: string;
  /** Argv recorded by the stub, one element per line. */
  args: (binary: string) => Promise<string[]>;
}

/**
 * Environment whose ambient values would perturb model/effort resolution for
 * either provider. Cleared for the duration of each test and restored after,
 * so the gate is exercised against the designed defaults.
 */
const MANAGED_ENV = [
  "CLAUDE_EFFORT",
  "CLAUDE_EFFORT_QUORUM",
  "CLAUDE_MODEL",
  "CLAUDE_MODEL_QUORUM",
  "CODEX_EFFORT",
  "CODEX_EFFORT_QUORUM",
  "CODEX_MODEL",
  "CODEX_MODEL_QUORUM",
  "VIBE_AGENT_PROVIDER",
  IMAGE_AGENT_PROVIDERS_ENV,
] as const;

/**
 * Run `fn` with stub `claude` and `codex` binaries on PATH and a fresh working
 * directory. PATH, the managed environment and the temp dir are restored or
 * cleaned afterwards.
 */
async function withStubs<T>(fn: (stub: Stub) => Promise<T>): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "fable_provider_gate_" });
  for (const binary of ["claude", "codex"]) {
    const path = `${dir}/${binary}`;
    await Deno.writeTextFile(path, `${stubBody(`${dir}/${binary}.args`)}\n`);
    await Deno.chmod(path, 0o755);
  }

  const saved = new Map<string, string | undefined>();
  const setEnv = (name: string, value: string | undefined) => {
    if (!saved.has(name)) saved.set(name, Deno.env.get(name));
    if (value === undefined) Deno.env.delete(name);
    else Deno.env.set(name, value);
  };
  for (const name of MANAGED_ENV) setEnv(name, undefined);
  setEnv("PATH", `${dir}:${Deno.env.get("PATH") ?? ""}`);
  // Dummy credentials so neither provider's preflight has to reach a vendor.
  setEnv("ANTHROPIC_API_KEY", "test-anthropic-key");
  setEnv("OPENAI_API_KEY", "test-openai-key");

  // Deno shares one process across test files: reset the module-level repo and
  // config routing overrides a sibling file may have set.
  setActiveRepoModelEffortOverrides(undefined);
  setPhaseModelConfigOverrides({});
  setPhaseEffortConfigOverrides({});
  setActiveRepoCodexModelEffortOverrides(undefined);
  setCodexPhaseModelConfigOverrides({});
  setCodexPhaseEffortConfigOverrides({});
  clearFableTierWarnings();

  try {
    return await fn({
      cwd: dir,
      args: async (binary: string) =>
        (await Deno.readTextFile(`${dir}/${binary}.args`).catch(() => ""))
          .split("\n").filter((line) => line !== ""),
    });
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
    clearFableTierWarnings();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
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
          prompt: "draft a plan",
          phase: "quorum",
          cwd: stub.cwd,
          timeoutSeconds: 30,
          agentProvider: "codex",
          logger: recordingLogger(warnings),
        },
        { maxRetries: 0, maxWaitSeconds: 1, initialWaitInterval: 0 },
      );
      return { result, args: await stub.args("codex") };
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
    const codexModel = resolveAgentProvider("codex").resolveModel("quorum");
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
          prompt: "draft a plan",
          phase: "quorum",
          cwd: stub.cwd,
          timeoutSeconds: 30,
          agentProvider: "claude",
        },
        { maxRetries: 0, maxWaitSeconds: 1, initialWaitInterval: 0 },
      );
      return { result, args: await stub.args("claude") };
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
