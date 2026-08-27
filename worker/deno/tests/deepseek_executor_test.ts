/**
 * Tests for DeepSeek per-phase model routing (Issue #413, parent #396).
 *
 * DeepSeek is carried on the *Claude* CLI, so its argv shape is Claude's — and
 * Claude's routing resolves to tier aliases (`fable`, `opus`, `sonnet`,
 * `haiku`), not model ids. A DeepSeek phase that resolved through Claude's
 * tables, or through no table at all, would send an Anthropic tier alias to an
 * endpoint that cannot resolve it and fail mid-run. These tests pin the
 * DeepSeek phase table, the six-step override chain with DeepSeek-named keys,
 * and the regression itself: no phase resolves to an Anthropic tier alias.
 *
 * Every test calls the real resolvers with real data.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  clearDeepSeekEffortWarnings,
  resolveDeepSeekEffort,
  resolveDeepSeekModel,
  setActiveRepoDeepSeekModelOverrides,
  setDeepSeekPhaseModelConfigOverrides,
  warnDeepSeekEffortUnsupported,
} from "../lib/deepseek_executor.ts";
import * as configDefaults from "../lib/config_defaults.ts";
import {
  DEEPSEEK_PHASE_MODEL_DEFAULTS,
  DEFAULT_DEEPSEEK_MODEL,
  DEFAULT_DEEPSEEK_MODEL_TOP_TIER,
  PHASE_EFFORT_DEFAULTS,
  PHASE_MODEL_DEFAULTS,
} from "../lib/config_defaults.ts";
import {
  detectUnknownConfigKeys,
  KNOWN_CONFIG_KEYS,
} from "../lib/config_unknown_keys.ts";
import { validateConfigFileJson } from "../lib/validation.ts";
import { loadConfig } from "../lib/config.ts";

/** Every DeepSeek routing env var a test may set, cleared before each run. */
const ROUTING_ENV_VARS = [
  "DEEPSEEK_MODEL",
  "DEEPSEEK_MODEL_PLANNING",
  "DEEPSEEK_MODEL_TOTALLY_UNKNOWN_PHASE",
];

/** The Anthropic tier aliases Claude's own routing resolves to (Issue #413). */
const ANTHROPIC_TIER_ALIASES = ["fable", "opus", "sonnet", "haiku"];

/**
 * Run `fn` with the DeepSeek routing state reset — no env vars, no config
 * overrides, no per-repo overrides, no recorded effort warnings — and restore
 * the environment afterwards.
 */
function withCleanRouting(fn: () => void): void {
  const saved = new Map<string, string | undefined>(
    ROUTING_ENV_VARS.map((name) => [name, Deno.env.get(name)]),
  );
  for (const name of ROUTING_ENV_VARS) Deno.env.delete(name);
  setDeepSeekPhaseModelConfigOverrides({});
  setActiveRepoDeepSeekModelOverrides(undefined);
  clearDeepSeekEffortWarnings();
  try {
    fn();
  } finally {
    setDeepSeekPhaseModelConfigOverrides({});
    setActiveRepoDeepSeekModelOverrides(undefined);
    clearDeepSeekEffortWarnings();
    for (const [name, value] of saved) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
}

/** Capture everything `console.warn` receives while `fn` runs. */
function captureWarnings(fn: () => void): string[] {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    fn();
  } finally {
    console.warn = original;
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// The phase table
// ---------------------------------------------------------------------------

Deno.test("deepseek routing - the full phase table routes as designed", () => {
  withCleanRouting(() => {
    const expected: Record<string, string> = {
      planning: "deepseek-reasoner",
      grill_me: "deepseek-reasoner",
      quorum: "deepseek-reasoner",
      quorum_judge: "deepseek-reasoner",
      refinement: "deepseek-reasoner",
      revision: "deepseek-reasoner",
      question: "deepseek-reasoner",
      clarification: "deepseek-reasoner",
      issue: "deepseek-chat",
      ci_fix: "deepseek-chat",
      pr_feedback: "deepseek-chat",
      quality_fix: "deepseek-chat",
      spelling_fix: "deepseek-chat",
      summarise: "deepseek-chat",
      health: "deepseek-chat",
    };

    for (const [phase, model] of Object.entries(expected)) {
      assertEquals(
        resolveDeepSeekModel(phase),
        model,
        `phase ${phase} must route to ${model}`,
      );
    }
    assertEquals(DEEPSEEK_PHASE_MODEL_DEFAULTS, expected);
  });
});

Deno.test("deepseek routing - planning reasons, summarise chats", () => {
  withCleanRouting(() => {
    assertEquals(resolveDeepSeekModel("planning"), "deepseek-reasoner");
    assertEquals(resolveDeepSeekModel("summarise"), "deepseek-chat");
    assertEquals(
      DEFAULT_DEEPSEEK_MODEL_TOP_TIER as string,
      "deepseek-reasoner",
    );
    assertEquals(DEFAULT_DEEPSEEK_MODEL as string, "deepseek-chat");
  });
});

Deno.test("deepseek routing - the table covers the same phase keys as the Claude table", () => {
  assertEquals(
    Object.keys(DEEPSEEK_PHASE_MODEL_DEFAULTS).sort(),
    Object.keys(PHASE_MODEL_DEFAULTS).sort(),
  );
});

Deno.test("deepseek routing - no phase resolves to an Anthropic tier alias", () => {
  withCleanRouting(() => {
    // The regression this issue exists to prevent: DeepSeek rides the Claude
    // CLI, so a missing table entry (or a pasted Claude tier) would send
    // `fable`/`opus`/`sonnet`/`haiku` to an endpoint that cannot resolve it.
    for (const phase of Object.keys(PHASE_MODEL_DEFAULTS)) {
      const model = resolveDeepSeekModel(phase);
      assert(model, `phase ${phase} must resolve to a DeepSeek model id`);
      assert(
        !ANTHROPIC_TIER_ALIASES.includes(model),
        `phase ${phase} resolved to the Anthropic tier alias "${model}"`,
      );
      assertStringIncludes(model, "deepseek");
    }
  });
});

Deno.test("deepseek routing - a phase-less call leaves the CLI on its default, quietly", () => {
  withCleanRouting(() => {
    const warnings = captureWarnings(() => {
      assertEquals(resolveDeepSeekModel(), undefined);
      assertEquals(resolveDeepSeekEffort(), undefined);
    });
    assertEquals(warnings.length, 0, "a phase-less call is deliberate");
  });
});

// ---------------------------------------------------------------------------
// The six-step override chain, with DeepSeek-named keys
// ---------------------------------------------------------------------------

Deno.test("deepseek routing - a phase-specific env var beats every other source", () => {
  withCleanRouting(() => {
    Deno.env.set("DEEPSEEK_MODEL_PLANNING", "deepseek-env");
    Deno.env.set("DEEPSEEK_MODEL", "deepseek-base");
    setDeepSeekPhaseModelConfigOverrides({ planning: "deepseek-global" });
    setActiveRepoDeepSeekModelOverrides({
      deepseekModel: "deepseek-repo-base",
      deepseekPhaseModelOverrides: { planning: "deepseek-repo-phase" },
    });

    assertEquals(resolveDeepSeekModel("planning"), "deepseek-env");
  });
});

Deno.test("deepseek routing - a per-repo phase override beats the per-repo base tier", () => {
  withCleanRouting(() => {
    setActiveRepoDeepSeekModelOverrides({
      deepseekModel: "deepseek-repo-base",
      deepseekPhaseModelOverrides: { planning: "deepseek-repo-phase" },
    });

    assertEquals(resolveDeepSeekModel("planning"), "deepseek-repo-phase");
    // A phase the repo does not re-pin still takes the repo base tier.
    assertEquals(resolveDeepSeekModel("health"), "deepseek-repo-base");
  });
});

Deno.test("deepseek routing - the per-repo base tier beats the global config override", () => {
  withCleanRouting(() => {
    setDeepSeekPhaseModelConfigOverrides({ planning: "deepseek-global" });
    setActiveRepoDeepSeekModelOverrides({
      deepseekModel: "deepseek-repo-base",
    });

    assertEquals(resolveDeepSeekModel("planning"), "deepseek-repo-base");
  });
});

Deno.test("deepseek routing - a global config override beats the phase default", () => {
  withCleanRouting(() => {
    setDeepSeekPhaseModelConfigOverrides({ planning: "deepseek-global" });

    assertEquals(resolveDeepSeekModel("planning"), "deepseek-global");
  });
});

Deno.test("deepseek routing - the base env var covers a phase with no table entry", () => {
  withCleanRouting(() => {
    Deno.env.set("DEEPSEEK_MODEL", "deepseek-base");

    const warnings = captureWarnings(() => {
      assertEquals(
        resolveDeepSeekModel("totally_unknown_phase"),
        "deepseek-base",
      );
    });
    assertEquals(
      warnings.length,
      0,
      "an explicitly configured base value is not a missing default",
    );
  });
});

Deno.test("deepseek routing - a phase with no model anywhere warns", () => {
  withCleanRouting(() => {
    const warnings = captureWarnings(() => {
      assertEquals(resolveDeepSeekModel("totally_unknown_phase"), undefined);
    });

    assertEquals(warnings.length, 1);
    assertStringIncludes(warnings[0]!, "totally_unknown_phase");
    assertStringIncludes(warnings[0]!, "deepseek-executor");
    assertStringIncludes(warnings[0]!, "--model");
  });
});

Deno.test("deepseek routing - per-repo overrides are replaced, never merged, on a repo switch", () => {
  withCleanRouting(() => {
    setActiveRepoDeepSeekModelOverrides({
      deepseekModel: "deepseek-premium",
      deepseekPhaseModelOverrides: { planning: "deepseek-premium-planning" },
    });
    assertEquals(resolveDeepSeekModel("planning"), "deepseek-premium-planning");

    // The next repo configures no DeepSeek routing: the premium tier must not
    // leak into it.
    setActiveRepoDeepSeekModelOverrides({});
    assertEquals(
      resolveDeepSeekModel("planning"),
      DEFAULT_DEEPSEEK_MODEL_TOP_TIER,
    );
  });
});

// ---------------------------------------------------------------------------
// Effort: reported, never turned into an argument
// ---------------------------------------------------------------------------

Deno.test("deepseek effort - the resolver reports the effort the phase was asked to run at", () => {
  withCleanRouting(() => {
    for (const phase of Object.keys(PHASE_MODEL_DEFAULTS)) {
      assertEquals(resolveDeepSeekEffort(phase), PHASE_EFFORT_DEFAULTS[phase]);
    }
    assertEquals(resolveDeepSeekEffort("totally_unknown_phase"), undefined);
  });
});

Deno.test("deepseek effort - there is no DeepSeek effort table or effort config key", () => {
  // Either would be configuration that can never be applied: DeepSeek's
  // Anthropic-compatible endpoint does not implement Anthropic's effort
  // control, so the value is reported rather than configured (Issue #3234).
  assertEquals("DEEPSEEK_PHASE_EFFORT_DEFAULTS" in configDefaults, false);
  assertEquals(KNOWN_CONFIG_KEYS.has("deepseek_phase_effort_overrides"), false);
  assertEquals(KNOWN_CONFIG_KEYS.has("deepseek_effort"), false);
});

Deno.test("deepseek effort - an unhonourable effort warns once per phase", () => {
  withCleanRouting(() => {
    const warnings = captureWarnings(() => {
      for (let i = 0; i < 3; i++) {
        warnDeepSeekEffortUnsupported("high", "planning");
      }
      // A different phase is a different gap, so it states its own case.
      warnDeepSeekEffortUnsupported("medium", "ci_fix");
    });

    assertEquals(warnings.length, 2);
    assertStringIncludes(warnings[0]!, "planning");
    assertStringIncludes(warnings[0]!, "high");
    assertStringIncludes(warnings[1]!, "ci_fix");
    for (const warning of warnings) {
      assertEquals(
        warning.includes("--effort"),
        false,
        "the warning must not advertise a flag the endpoint rejects",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The config keys are recognised
// ---------------------------------------------------------------------------

Deno.test("deepseek config - the global override key passes the unknown-key check", () => {
  const warnings = detectUnknownConfigKeys({
    deepseek_phase_model_overrides: { planning: "deepseek-reasoner" },
  });
  assertEquals(warnings, []);
  assertEquals(KNOWN_CONFIG_KEYS.has("deepseek_phase_model_overrides"), true);
});

Deno.test("deepseek config - the global override key validates as a string map", () => {
  const ok = validateConfigFileJson({
    deepseek_phase_model_overrides: { planning: "deepseek-reasoner" },
  });
  assertEquals(ok.ok, true);

  const bad = validateConfigFileJson({
    deepseek_phase_model_overrides: { planning: 7 },
  });
  assertEquals(bad.ok, false);
});

Deno.test("deepseek config - repo and global DeepSeek keys survive loadConfig", async () => {
  const path = await Deno.makeTempFile({ suffix: ".json" });
  try {
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        deepseek_phase_model_overrides: { planning: "deepseek-global" },
        repo_config: {
          "org/repo": {
            deepseek_model: "deepseek-repo-base",
            deepseek_phase_model_overrides: { issue: "deepseek-repo-issue" },
          },
        },
      }),
    );

    const config = await loadConfig(path);
    assertEquals(config.deepseekPhaseModelOverrides, {
      planning: "deepseek-global",
    });
    const repo = config.repoConfig?.["org/repo"];
    assertEquals(repo?.deepseekModel, "deepseek-repo-base");
    assertEquals(repo?.deepseekPhaseModelOverrides, {
      issue: "deepseek-repo-issue",
    });

    // And they route: the loaded repo config drives the resolver.
    withCleanRouting(() => {
      setDeepSeekPhaseModelConfigOverrides(config.deepseekPhaseModelOverrides);
      setActiveRepoDeepSeekModelOverrides(repo);
      assertEquals(resolveDeepSeekModel("issue"), "deepseek-repo-issue");
      assertEquals(resolveDeepSeekModel("planning"), "deepseek-repo-base");
    });
  } finally {
    await Deno.remove(path);
  }
});
