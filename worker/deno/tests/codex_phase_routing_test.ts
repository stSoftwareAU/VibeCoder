/**
 * Tests for Codex per-phase model and reasoning-effort routing (Issue #363,
 * parent #357).
 *
 * Before this, `CODEX_PROVIDER.buildInvocation()` forwarded only an *explicit*
 * model/effort, so every Codex phase — the cheapest comment and the most
 * expensive planning run alike — landed on whatever the CLI was configured
 * with. These tests pin the phase tables, the six-step override chain with
 * Codex-named keys, and the fail-loud warning for a phase that resolves to
 * nothing.
 *
 * Every test calls the real resolvers and the real descriptor with real data.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  CODEX_PROVIDER_ID,
  resolveAgentProvider,
} from "../lib/agent_provider.ts";
import {
  resolveCodexEffort,
  resolveCodexModel,
  setActiveRepoCodexModelEffortOverrides,
  setCodexPhaseEffortConfigOverrides,
  setCodexPhaseModelConfigOverrides,
} from "../lib/codex_executor.ts";
import {
  CODEX_PHASE_EFFORT_DEFAULTS,
  CODEX_PHASE_MODEL_DEFAULTS,
  DEFAULT_CODEX_MODEL_CHEAP_TIER,
  DEFAULT_CODEX_MODEL_TOP_TIER,
  PHASE_EFFORT_DEFAULTS,
  PHASE_MODEL_DEFAULTS,
} from "../lib/config_defaults.ts";

/** The Codex descriptor under test. */
const codex = resolveAgentProvider(CODEX_PROVIDER_ID);

/** Every Codex routing env var a test may set, cleared before each run. */
const ROUTING_ENV_VARS = [
  "CODEX_MODEL",
  "CODEX_EFFORT",
  "CODEX_MODEL_PLANNING",
  "CODEX_EFFORT_PLANNING",
  "CODEX_MODEL_TOTALLY_UNKNOWN_PHASE",
  "CODEX_EFFORT_TOTALLY_UNKNOWN_PHASE",
];

/**
 * Run `fn` with the Codex routing state reset — no env vars, no config
 * overrides, no per-repo overrides — and restore the environment afterwards.
 */
function withCleanRouting(fn: () => void): void {
  const saved = new Map<string, string | undefined>(
    ROUTING_ENV_VARS.map((name) => [name, Deno.env.get(name)]),
  );
  for (const name of ROUTING_ENV_VARS) Deno.env.delete(name);
  setCodexPhaseModelConfigOverrides({});
  setCodexPhaseEffortConfigOverrides({});
  setActiveRepoCodexModelEffortOverrides(undefined);
  try {
    fn();
  } finally {
    setCodexPhaseModelConfigOverrides({});
    setCodexPhaseEffortConfigOverrides({});
    setActiveRepoCodexModelEffortOverrides(undefined);
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

/** The value Codex's `-c model_reasoning_effort=…` argument carries. */
function effortArg(args: string[]): string | undefined {
  const flag = args.find((arg) => arg.startsWith("model_reasoning_effort="));
  return flag?.replace(/^model_reasoning_effort="(.*)"$/, "$1");
}

/** The value the argv's `--model` flag carries. */
function modelArg(args: string[]): string | undefined {
  const index = args.indexOf("--model");
  return index === -1 ? undefined : args[index + 1];
}

// ---------------------------------------------------------------------------
// The phase tables reach argv
// ---------------------------------------------------------------------------

Deno.test("codex routing - planning runs on the top tier at high effort", () => {
  withCleanRouting(() => {
    const args = codex.buildInvocation({ prompt: "PROMPT", phase: "planning" });

    assertEquals(modelArg(args), DEFAULT_CODEX_MODEL_TOP_TIER);
    assertEquals(effortArg(args), "high");
    assertEquals(args.at(-1), "PROMPT", "the prompt stays last");
  });
});

Deno.test("codex routing - every phase key reaches argv with its designed default", () => {
  withCleanRouting(() => {
    for (const phase of Object.keys(CODEX_PHASE_MODEL_DEFAULTS)) {
      const args = codex.buildInvocation({ prompt: "PROMPT", phase });
      assertEquals(
        modelArg(args),
        CODEX_PHASE_MODEL_DEFAULTS[phase],
        `phase ${phase} must carry its designed model`,
      );
      assertEquals(
        effortArg(args),
        CODEX_PHASE_EFFORT_DEFAULTS[phase],
        `phase ${phase} must carry its designed effort`,
      );
    }
  });
});

Deno.test("codex routing - the tables cover the same phase keys as the Claude tables", () => {
  assertEquals(
    Object.keys(CODEX_PHASE_MODEL_DEFAULTS).sort(),
    Object.keys(PHASE_MODEL_DEFAULTS).sort(),
  );
  assertEquals(
    Object.keys(CODEX_PHASE_EFFORT_DEFAULTS).sort(),
    Object.keys(PHASE_EFFORT_DEFAULTS).sort(),
  );
});

Deno.test("codex routing - Codex effort values stay inside the CLI's four levels", () => {
  const allowed = ["minimal", "low", "medium", "high"];
  for (const [phase, effort] of Object.entries(CODEX_PHASE_EFFORT_DEFAULTS)) {
    assert(
      allowed.includes(effort),
      `${phase} routes to "${effort}", which Codex does not accept`,
    );
  }
});

Deno.test("codex routing - a cheap phase is cheaper than planning on both levers", () => {
  withCleanRouting(() => {
    for (const phase of ["spelling_fix", "summarise", "health"]) {
      assertEquals(resolveCodexModel(phase), DEFAULT_CODEX_MODEL_CHEAP_TIER);
      assertEquals(resolveCodexEffort(phase), "low");
    }

    assertEquals(resolveCodexModel("planning"), DEFAULT_CODEX_MODEL_TOP_TIER);
    assertEquals(resolveCodexEffort("planning"), "high");
    assert(
      (DEFAULT_CODEX_MODEL_CHEAP_TIER as string) !==
        (DEFAULT_CODEX_MODEL_TOP_TIER as string),
      "the cheap tier must not be the top tier",
    );
  });
});

// ---------------------------------------------------------------------------
// Explicit values still win
// ---------------------------------------------------------------------------

Deno.test("codex routing - an explicit model and effort beat the phase default", () => {
  withCleanRouting(() => {
    const args = codex.buildInvocation({
      prompt: "PROMPT",
      phase: "planning",
      model: "gpt-5-mini",
      effort: "minimal",
    });

    assertEquals(modelArg(args), "gpt-5-mini");
    assertEquals(effortArg(args), "minimal");
  });
});

// ---------------------------------------------------------------------------
// The six-step override chain, with Codex-named keys
// ---------------------------------------------------------------------------

Deno.test("codex routing - a phase-specific env var beats every other source", () => {
  withCleanRouting(() => {
    Deno.env.set("CODEX_MODEL_PLANNING", "gpt-env");
    Deno.env.set("CODEX_EFFORT_PLANNING", "minimal");
    Deno.env.set("CODEX_MODEL", "gpt-base");
    setCodexPhaseModelConfigOverrides({ planning: "gpt-global" });
    setActiveRepoCodexModelEffortOverrides({
      codexModel: "gpt-repo-base",
      codexPhaseModelOverrides: { planning: "gpt-repo-phase" },
      codexPhaseEffortOverrides: { planning: "medium" },
    });

    assertEquals(resolveCodexModel("planning"), "gpt-env");
    assertEquals(resolveCodexEffort("planning"), "minimal");
  });
});

Deno.test("codex routing - a per-repo phase override beats the per-repo base tier", () => {
  withCleanRouting(() => {
    setActiveRepoCodexModelEffortOverrides({
      codexModel: "gpt-repo-base",
      codexPhaseModelOverrides: { planning: "gpt-repo-phase" },
      codexPhaseEffortOverrides: { planning: "medium" },
    });

    assertEquals(resolveCodexModel("planning"), "gpt-repo-phase");
    assertEquals(resolveCodexEffort("planning"), "medium");
    // A phase the repo does not re-pin still takes the repo base tier.
    assertEquals(resolveCodexModel("health"), "gpt-repo-base");
  });
});

Deno.test("codex routing - the per-repo base tier beats the global config override", () => {
  withCleanRouting(() => {
    setCodexPhaseModelConfigOverrides({ planning: "gpt-global" });
    setActiveRepoCodexModelEffortOverrides({ codexModel: "gpt-repo-base" });

    assertEquals(resolveCodexModel("planning"), "gpt-repo-base");
  });
});

Deno.test("codex routing - a global config override beats the phase default", () => {
  withCleanRouting(() => {
    setCodexPhaseModelConfigOverrides({ planning: "gpt-global" });
    setCodexPhaseEffortConfigOverrides({ planning: "low" });

    assertEquals(resolveCodexModel("planning"), "gpt-global");
    assertEquals(resolveCodexEffort("planning"), "low");
  });
});

Deno.test("codex routing - per-repo overrides are replaced, never merged, on a repo switch", () => {
  withCleanRouting(() => {
    setActiveRepoCodexModelEffortOverrides({
      codexModel: "gpt-premium",
      codexPhaseModelOverrides: { planning: "gpt-premium-planning" },
    });
    assertEquals(resolveCodexModel("planning"), "gpt-premium-planning");

    // The next repo configures no Codex routing: the premium tier must not
    // leak into it.
    setActiveRepoCodexModelEffortOverrides({});
    assertEquals(resolveCodexModel("planning"), DEFAULT_CODEX_MODEL_TOP_TIER);
  });
});

Deno.test("codex routing - the base env var covers a phase with no table entry", () => {
  withCleanRouting(() => {
    Deno.env.set("CODEX_MODEL", "gpt-base");
    Deno.env.set("CODEX_EFFORT", "medium");

    const warnings = captureWarnings(() => {
      assertEquals(resolveCodexModel("totally_unknown_phase"), "gpt-base");
      assertEquals(resolveCodexEffort("totally_unknown_phase"), "medium");
    });
    assertEquals(
      warnings.length,
      0,
      "an explicitly configured base value is not a missing default",
    );
  });
});

// ---------------------------------------------------------------------------
// Fail loud: an unroutable phase warns rather than silently taking the default
// ---------------------------------------------------------------------------

Deno.test("codex routing - an unknown phase warns once per lever and adds no flags", () => {
  withCleanRouting(() => {
    let args: string[] = [];
    const warnings = captureWarnings(() => {
      args = codex.buildInvocation({
        prompt: "PROMPT",
        phase: "totally_unknown_phase",
      });
    });

    assertEquals(modelArg(args), undefined);
    assertEquals(effortArg(args), undefined);
    assertEquals(args.includes("-c"), false);

    // One warning for the model, one for the effort — each naming the phase.
    assertEquals(warnings.length, 2);
    for (const warning of warnings) {
      assertStringIncludes(warning, "totally_unknown_phase");
      assertStringIncludes(warning, "codex-executor");
    }
    assertStringIncludes(warnings.join("\n"), "--model");
    assertStringIncludes(warnings.join("\n"), "model_reasoning_effort");
  });
});

Deno.test("codex routing - a phase-less invocation resolves nothing and stays quiet", () => {
  withCleanRouting(() => {
    const warnings = captureWarnings(() => {
      assertEquals(resolveCodexModel(), undefined);
      assertEquals(resolveCodexEffort(), undefined);
    });
    assertEquals(warnings.length, 0);
  });
});

Deno.test("codex routing - the descriptor's resolvers are the Codex chain", () => {
  withCleanRouting(() => {
    for (const phase of [undefined, ...Object.keys(CODEX_PHASE_MODEL_DEFAULTS)]) {
      assertEquals(codex.resolveModel(phase), resolveCodexModel(phase));
      assertEquals(codex.resolveEffort(phase), resolveCodexEffort(phase));
    }
  });
});
