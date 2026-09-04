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
import type { EnvLookup } from "../lib/env_lookup.ts";
import { envFrom } from "./support/env_lookup.ts";

/** The Codex descriptor under test. */
const codex = resolveAgentProvider(CODEX_PROVIDER_ID);

/**
 * Run `fn` with the Codex routing state reset — no config overrides, no
 * per-repo overrides — and an environment holding exactly `vars`.
 *
 * The environment is a lookup handed to the resolvers (Issue #957), never the
 * process: nothing here can race a test running beside it, and a `CODEX_*`
 * variable the worker container exports cannot reach the chain either.
 *
 * @param vars - The Codex routing variables this test declares as set.
 * @param fn - The test body, given the lookup to inject.
 */
function withCleanRouting(
  vars: Record<string, string>,
  fn: (env: EnvLookup) => void,
): void {
  setCodexPhaseModelConfigOverrides({});
  setCodexPhaseEffortConfigOverrides({});
  setActiveRepoCodexModelEffortOverrides(undefined);
  try {
    fn(envFrom(vars));
  } finally {
    setCodexPhaseModelConfigOverrides({});
    setCodexPhaseEffortConfigOverrides({});
    setActiveRepoCodexModelEffortOverrides(undefined);
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
  withCleanRouting({}, (env) => {
    const args = codex.buildInvocation({
      prompt: "PROMPT",
      phase: "planning",
      env,
    });

    assertEquals(modelArg(args), DEFAULT_CODEX_MODEL_TOP_TIER);
    assertEquals(effortArg(args), "high");
    assertEquals(args.at(-1), "PROMPT", "the prompt stays last");
  });
});

Deno.test("codex routing - every phase key reaches argv with its designed default", () => {
  withCleanRouting({}, (env) => {
    for (const phase of Object.keys(CODEX_PHASE_MODEL_DEFAULTS)) {
      const args = codex.buildInvocation({ prompt: "PROMPT", phase, env });
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
  withCleanRouting({}, (env) => {
    for (const phase of ["spelling_fix", "summarise", "health"]) {
      assertEquals(
        resolveCodexModel(phase, env),
        DEFAULT_CODEX_MODEL_CHEAP_TIER,
      );
      assertEquals(resolveCodexEffort(phase, env), "low");
    }

    assertEquals(
      resolveCodexModel("planning", env),
      DEFAULT_CODEX_MODEL_TOP_TIER,
    );
    assertEquals(resolveCodexEffort("planning", env), "high");
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
  withCleanRouting({}, (env) => {
    const args = codex.buildInvocation({
      prompt: "PROMPT",
      phase: "planning",
      model: "gpt-5-mini",
      effort: "minimal",
      env,
    });

    assertEquals(modelArg(args), "gpt-5-mini");
    assertEquals(effortArg(args), "minimal");
  });
});

// ---------------------------------------------------------------------------
// The six-step override chain, with Codex-named keys
// ---------------------------------------------------------------------------

Deno.test("codex routing - a phase-specific env var beats every other source", () => {
  withCleanRouting({
    CODEX_MODEL_PLANNING: "gpt-env",
    CODEX_EFFORT_PLANNING: "minimal",
    CODEX_MODEL: "gpt-base",
  }, (env) => {
    setCodexPhaseModelConfigOverrides({ planning: "gpt-global" });
    setActiveRepoCodexModelEffortOverrides({
      codexModel: "gpt-repo-base",
      codexPhaseModelOverrides: { planning: "gpt-repo-phase" },
      codexPhaseEffortOverrides: { planning: "medium" },
    });

    assertEquals(resolveCodexModel("planning", env), "gpt-env");
    assertEquals(resolveCodexEffort("planning", env), "minimal");
  });
});

Deno.test("codex routing - a per-repo phase override beats the per-repo base tier", () => {
  withCleanRouting({}, (env) => {
    setActiveRepoCodexModelEffortOverrides({
      codexModel: "gpt-repo-base",
      codexPhaseModelOverrides: { planning: "gpt-repo-phase" },
      codexPhaseEffortOverrides: { planning: "medium" },
    });

    assertEquals(resolveCodexModel("planning", env), "gpt-repo-phase");
    assertEquals(resolveCodexEffort("planning", env), "medium");
    // A phase the repo does not re-pin still takes the repo base tier.
    assertEquals(resolveCodexModel("health", env), "gpt-repo-base");
  });
});

Deno.test("codex routing - the per-repo base tier beats the global config override", () => {
  withCleanRouting({}, (env) => {
    setCodexPhaseModelConfigOverrides({ planning: "gpt-global" });
    setActiveRepoCodexModelEffortOverrides({ codexModel: "gpt-repo-base" });

    assertEquals(resolveCodexModel("planning", env), "gpt-repo-base");
  });
});

Deno.test("codex routing - a global config override beats the phase default", () => {
  withCleanRouting({}, (env) => {
    setCodexPhaseModelConfigOverrides({ planning: "gpt-global" });
    setCodexPhaseEffortConfigOverrides({ planning: "low" });

    assertEquals(resolveCodexModel("planning", env), "gpt-global");
    assertEquals(resolveCodexEffort("planning", env), "low");
  });
});

Deno.test("codex routing - per-repo overrides are replaced, never merged, on a repo switch", () => {
  withCleanRouting({}, (env) => {
    setActiveRepoCodexModelEffortOverrides({
      codexModel: "gpt-premium",
      codexPhaseModelOverrides: { planning: "gpt-premium-planning" },
    });
    assertEquals(resolveCodexModel("planning", env), "gpt-premium-planning");

    // The next repo configures no Codex routing: the premium tier must not
    // leak into it.
    setActiveRepoCodexModelEffortOverrides({});
    assertEquals(
      resolveCodexModel("planning", env),
      DEFAULT_CODEX_MODEL_TOP_TIER,
    );
  });
});

Deno.test("codex routing - the base env var covers a phase with no table entry", () => {
  withCleanRouting({
    CODEX_MODEL: "gpt-base",
    CODEX_EFFORT: "medium",
  }, (env) => {
    const warnings = captureWarnings(() => {
      assertEquals(resolveCodexModel("totally_unknown_phase", env), "gpt-base");
      assertEquals(resolveCodexEffort("totally_unknown_phase", env), "medium");
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
  withCleanRouting({}, (env) => {
    let args: string[] = [];
    const warnings = captureWarnings(() => {
      args = codex.buildInvocation({
        prompt: "PROMPT",
        phase: "totally_unknown_phase",
        env,
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
  withCleanRouting({}, (env) => {
    const warnings = captureWarnings(() => {
      assertEquals(resolveCodexModel(undefined, env), undefined);
      assertEquals(resolveCodexEffort(undefined, env), undefined);
    });
    assertEquals(warnings.length, 0);
  });
});

Deno.test("codex routing - the descriptor's resolvers are the Codex chain", () => {
  withCleanRouting({}, (env) => {
    for (
      const phase of [undefined, ...Object.keys(CODEX_PHASE_MODEL_DEFAULTS)]
    ) {
      assertEquals(
        codex.resolveModel(phase, env),
        resolveCodexModel(phase, env),
      );
      assertEquals(
        codex.resolveEffort(phase, env),
        resolveCodexEffort(phase, env),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The documented routing matches the code
// ---------------------------------------------------------------------------

Deno.test("codex routing - docs/MODEL-AND-CACHING.md states the routing the code applies", async () => {
  const doc = await Deno.readTextFile(
    new URL("../../../docs/MODEL-AND-CACHING.md", import.meta.url),
  );
  // Only the Codex section counts — the Claude tables above it use the same
  // phase keys with Claude tiers.
  const start = doc.indexOf("### 🤖 Codex per-phase routing");
  assert(start !== -1, "the Codex routing section is missing from the doc");
  const end = doc.indexOf("\n### ", start + 1);
  const section = doc.slice(start, end === -1 ? undefined : end);
  const rows = section.split("\n").filter((line) =>
    line.trimStart().startsWith("|")
  );

  for (const [phase, model] of Object.entries(CODEX_PHASE_MODEL_DEFAULTS)) {
    const row = rows.find((line) => line.includes(`\`${phase}\``));
    assert(row, `no Codex routing row documents phase ${phase}`);
    assertStringIncludes(row, `\`${model}\``);
    assertStringIncludes(row, `\`${CODEX_PHASE_EFFORT_DEFAULTS[phase]}\``);
  }
});

// ---------------------------------------------------------------------------
// The injected environment lookup (Issue #957)
// ---------------------------------------------------------------------------

Deno.test("codex routing - both env reads go through the injected lookup, never the process (Issue #957)", () => {
  // The sentinel exists in no process environment, so a resolver that fell
  // back to `Deno.env.get` would return the table default instead of it.
  const sentinel = "gpt-957-sentinel";
  withCleanRouting({}, () => {
    const asked: string[] = [];
    // An unknown phase misses steps 2-5, so one call covers step 1 (the
    // phase-specific variable) and step 6 (the base variable).
    const model = resolveCodexModel("totally_unknown_phase", (name) => {
      asked.push(name);
      return name === "CODEX_MODEL" ? sentinel : undefined;
    });

    assertEquals(model, sentinel);
    assertEquals(asked, ["CODEX_MODEL_TOTALLY_UNKNOWN_PHASE", "CODEX_MODEL"]);
    assertEquals(Deno.env.get("CODEX_MODEL"), undefined);
  });

  withCleanRouting({ CODEX_EFFORT_PLANNING: "minimal" }, (env) => {
    // Step 1 beats the designed "high" for planning: the value came from the
    // lookup, not from the table and not from the process.
    assertEquals(resolveCodexEffort("planning", env), "minimal");
  });
});
