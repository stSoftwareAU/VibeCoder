/**
 * The pre-flight Fable reroute gate holds for every provider (Issue #417).
 *
 * Issue #398 gated the reroute on the invocation's resolved provider
 * descriptor, and proved it with a hand-written Codex case and a Claude
 * control. Two hand-written cases are not a gate: a provider registered
 * afterwards inherits no coverage, and the provider this issue is about —
 * DeepSeek — is the one where a missed gate is *worst*. Codex and Gemini
 * reject an unknown `--model` at their own CLI's argument layer; DeepSeek runs
 * the **Anthropic CLI**, which accepts `--model opus` as a perfectly
 * well-formed flag and forwards it to DeepSeek's endpoint, so the failure
 * lands as a remote unresolvable-model error mid-run.
 *
 * These tests close that gap two ways:
 *   - a **loop over `agentProviderIds()`** driving `runClaudeWithRetry` end to
 *     end against a stub CLI named by path (`agentBinaryPath`, Issue #959), so
 *     a further provider registered without the gate fails `deno test`
 *     immediately rather than at the next Fable outage;
 *   - a **DeepSeek regression test** driven through the real
 *     `resolveDeepSeekModel` routing (Issue #413). DeepSeek's descriptor is
 *     registered by Issue #414, so this exercises the routing the descriptor
 *     will delegate to, and the loop above picks the provider up for free the
 *     moment it lands.
 *
 * Nothing here hard-codes which providers carry the Fable tier: each expected
 * outcome is derived from the descriptor's own routing, which is exactly the
 * property the issue asks the gate to have.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { runClaudeWithRetry } from "../lib/claude_runner.ts";
import type { Logger } from "../types.ts";
import {
  type AgentProviderDescriptor,
  agentProviderIds,
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
  setActiveRepoGeminiModelOverrides,
  setGeminiPhaseModelConfigOverrides,
} from "../lib/gemini_executor.ts";
import {
  resolveDeepSeekModel,
  setActiveRepoDeepSeekModelOverrides,
  setDeepSeekPhaseModelConfigOverrides,
} from "../lib/deepseek_executor.ts";
import {
  applyFablePreflightRouting,
  clearFableTierWarnings,
  FABLE_PREFLIGHT_DEGRADED_REASON,
  FABLE_PREFLIGHT_EFFORT,
  FABLE_PREFLIGHT_MODEL,
  providerRoutesToFableTier,
  warnProviderHasNoFableTier,
} from "../lib/fable_routing.ts";
import { recordFableAvailability } from "../lib/health_check_cache.ts";
import { withAgentStub } from "./support/agent_stub.ts";
import { emptyEnv } from "./support/env_lookup.ts";

/** The phase under test: Quorum names its provider per call with no model. */
const PHASE = "quorum";

/** Anthropic tier aliases that must never reach a non-Fable provider's argv. */
const ANTHROPIC_TIER_ALIASES = ["fable", "opus", "sonnet", "haiku"] as const;

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

/** Reset every executor's module-level repo/config routing override state. */
function clearRoutingOverrides(): void {
  setActiveRepoModelEffortOverrides(undefined);
  setPhaseModelConfigOverrides({});
  setPhaseEffortConfigOverrides({});
  setActiveRepoCodexModelEffortOverrides(undefined);
  setCodexPhaseModelConfigOverrides({});
  setCodexPhaseEffortConfigOverrides({});
  setActiveRepoGeminiModelOverrides(undefined);
  setGeminiPhaseModelConfigOverrides({});
  setActiveRepoDeepSeekModelOverrides(undefined);
  setDeepSeekPhaseModelConfigOverrides({});
  clearFableTierWarnings();
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
 * Run `fn` with a stub agent CLI and a fresh working directory.
 *
 * Nothing here touches process state: the stub is named by path (Issue #959)
 * and every run reads {@link emptyEnv} (Issue #961), so a provider's routing
 * variables, the per-run provider override and the image stamp are all
 * invisible — which is what neutralises a newly registered provider's
 * variables without editing this file. No vendor credential is exported
 * either: the stub *is* the agent, so no provider's pre-flight reaches a
 * vendor.
 */
function withProviderStubs<T>(fn: (stub: Stub) => Promise<T>): Promise<T> {
  // Deno shares one process across test files: reset the module-level repo and
  // config routing overrides a sibling file may have set.
  clearRoutingOverrides();

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
  }, { prefix: "fable_deepseek_gate_" });
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

/** Assert a non-Fable provider's argv carries no Anthropic tier alias. */
function assertNoAnthropicTier(
  provider: AgentProviderDescriptor,
  args: string[],
): void {
  const argv = args.join(" ");
  for (const alias of ANTHROPIC_TIER_ALIASES) {
    assert(
      !args.includes(alias),
      `${provider.id} argv must carry no Anthropic tier alias ` +
        `"${alias}": ${argv}`,
    );
  }
  assert(
    !args.includes(FABLE_PREFLIGHT_EFFORT),
    `${provider.id} argv must carry no rerouted effort ` +
      `"${FABLE_PREFLIGHT_EFFORT}": ${argv}`,
  );
}

Deno.test({
  name:
    "gate: with Fable unavailable, every registered provider is rerouted only if its own routing is Fable-tier (Issue #417)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    for (const id of agentProviderIds()) {
      const provider = resolveAgentProvider(id);
      const warnings: string[] = [];
      const { result, args } = await withProviderStubs(async (stub) => {
        const recorded = recordFableAvailability(stub.cwd, false);
        assert(recorded.ok);

        const result = await runClaudeWithRetry(
          {
            prompt: "draft a plan",
            phase: PHASE,
            cwd: stub.cwd,
            timeoutSeconds: 30,
            agentProvider: id,
            agentBinaryPath: stub.path,
            env: emptyEnv,
            logger: recordingLogger(warnings),
          },
          { maxRetries: 0, maxWaitSeconds: 1, initialWaitInterval: 0 },
        );
        return { result, args: await stub.args() };
      });

      assert(
        result.ok,
        `${id}: expected ok, got ${!result.ok && result.error}`,
      );
      if (!result.ok) continue;

      // The descriptor decides the expectation — no provider id is named here.
      if (providerRoutesToFableTier(provider, PHASE, emptyEnv)) {
        assertEquals(
          args[args.indexOf("--model") + 1],
          FABLE_PREFLIGHT_MODEL,
          `${id}: Fable-tier provider must be rerouted`,
        );
        assertEquals(
          args[args.indexOf("--effort") + 1],
          FABLE_PREFLIGHT_EFFORT,
          `${id}: Fable-tier provider must run at the higher effort`,
        );
        assertEquals(result.value.preflightDegraded, true, `${id}: degraded`);
        assertEquals(
          result.value.preflightDegradedReason,
          FABLE_PREFLIGHT_DEGRADED_REASON,
        );
        continue;
      }

      // A provider without the Fable tier keeps its own routing untouched…
      assertNoAnthropicTier(provider, args);
      const own = provider.resolveModel(PHASE, emptyEnv);
      if (own) {
        assertEquals(
          args[args.indexOf("--model") + 1],
          own,
          `${id}: own routing must reach the CLI`,
        );
      }

      // …is not flagged degraded for a tier it never requested…
      assertEquals(
        result.value.preflightDegraded,
        undefined,
        `${id}: must not be flagged preflightDegraded`,
      );
      assertEquals(
        result.value.preflightDegradedReason,
        undefined,
        `${id}: must carry no preflightDegradedReason`,
      );

      // …and the skipped reroute is stated loudly, naming the provider.
      const gap = warnings.find((m) => m.includes("[fable-routing]"));
      assert(
        gap,
        `${id}: expected a no-Fable-tier warning, got: ${warnings.join("|")}`,
      );
      assert(gap.includes(id), `${id}: warning must name the provider: ${gap}`);
    }
  },
});

Deno.test({
  name:
    "gate: the reroute helper itself refuses every non-Fable-tier registered provider (Issue #417)",
  permissions: { env: true },
  fn() {
    clearRoutingOverrides();
    // The end-to-end loop above passes through `runClaudeWithRetry`, whose own
    // explicit-override detection would mask a gate removed from
    // `fable_routing.ts`. Drive the helper directly so the descriptor-derived
    // gate is covered in its own right, once per registered provider.
    for (const id of agentProviderIds()) {
      const provider = resolveAgentProvider(id);
      const applied = applyFablePreflightRouting(
        { phase: PHASE } as { phase?: string; model?: string; effort?: string },
        "unavailable",
        false,
        provider,
      );
      if (providerRoutesToFableTier(provider, PHASE, emptyEnv)) {
        assertEquals(applied.options.model, FABLE_PREFLIGHT_MODEL, id);
        assertEquals(applied.options.effort, FABLE_PREFLIGHT_EFFORT, id);
        assertEquals(applied.routing.degraded, true, id);
        continue;
      }
      assertEquals(applied.options.model, undefined, id);
      assertEquals(applied.options.effort, undefined, id);
      assertEquals(applied.routing.degraded, false, id);
      assertEquals(applied.routing.reason, undefined, id);
    }
  },
});

Deno.test({
  name:
    "gate: a DeepSeek quorum invocation keeps its own model, gains no opus/max and is not degraded (Issue #417)",
  permissions: { env: true },
  fn() {
    clearRoutingOverrides();
    // The routing DeepSeek's descriptor delegates to (Issue #413/#414). The
    // model is real, so this is DeepSeek's behaviour rather than a fixture.
    const deepseek = { id: "deepseek", resolveModel: resolveDeepSeekModel };
    const routed = resolveDeepSeekModel(PHASE, emptyEnv);
    assert(routed, "DeepSeek must route the quorum phase to a model");
    assert(
      !ANTHROPIC_TIER_ALIASES.some((alias) => routed.includes(alias)),
      `DeepSeek's own model must not read as an Anthropic tier: ${routed}`,
    );

    const options = { phase: PHASE } as {
      phase?: string;
      model?: string;
      effort?: string;
    };
    const applied = applyFablePreflightRouting(
      options,
      "unavailable",
      false,
      deepseek,
      emptyEnv,
    );

    // No Anthropic tier alias is forced onto the Anthropic CLI DeepSeek rides.
    assertEquals(applied.options.model, undefined);
    assertEquals(applied.options.effort, undefined);
    assertEquals(applied.routing.degraded, false);
    assertEquals(applied.routing.reason, undefined);
    // The invocation is left on the model DeepSeek's own routing resolved.
    assertEquals(resolveDeepSeekModel(PHASE, emptyEnv), routed);

    // The skipped reroute is reported once, naming DeepSeek and its model.
    const warnings: string[] = [];
    warnProviderHasNoFableTier(deepseek, PHASE, "unavailable", {
      warn: (message: string) => {
        warnings.push(message);
      },
    }, emptyEnv);
    assertEquals(warnings.length, 1, warnings.join("|"));
    const gap = warnings[0] ?? "";
    assert(gap.includes("deepseek"), gap);
    assert(gap.includes(routed), gap);
    clearFableTierWarnings();
  },
});
