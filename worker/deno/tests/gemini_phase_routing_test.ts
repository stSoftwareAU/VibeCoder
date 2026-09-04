/**
 * Tests for Gemini per-phase model routing and the unhonourable-effort warning
 * (Issue #364, parent #357).
 *
 * Before this, `GEMINI_PROVIDER.buildInvocation()` discarded `request.phase`
 * entirely — every Gemini phase, the cheapest `summarise` and the most
 * expensive `planning` alike, ran on whatever the CLI was configured with — and
 * `request.effort` was dropped without a word. These tests pin the phase table,
 * the six-step override chain with Gemini-named keys, and the one warning a
 * requested-but-unhonourable effort emits while adding no argv element.
 *
 * Every test calls the real resolvers and the real descriptor with real data.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  GEMINI_PROVIDER_ID,
  resolveAgentProvider,
} from "../lib/agent_provider.ts";
import {
  clearGeminiEffortWarnings,
  resolveGeminiEffort,
  resolveGeminiModel,
  setActiveRepoGeminiModelOverrides,
  setGeminiPhaseModelConfigOverrides,
} from "../lib/gemini_executor.ts";
import {
  DEFAULT_GEMINI_MODEL_CHEAP_TIER,
  DEFAULT_GEMINI_MODEL_TOP_TIER,
  GEMINI_PHASE_MODEL_DEFAULTS,
  PHASE_EFFORT_DEFAULTS,
  PHASE_MODEL_DEFAULTS,
} from "../lib/config_defaults.ts";
import type { EnvLookup } from "../lib/env_lookup.ts";
import { envFrom } from "./support/env_lookup.ts";

/** The Gemini descriptor under test. */
const gemini = resolveAgentProvider(GEMINI_PROVIDER_ID);

/**
 * Run `fn` with the Gemini routing state reset — no config overrides, no
 * per-repo overrides, no recorded effort warnings — and an environment holding
 * exactly `vars`.
 *
 * The environment is a lookup handed to the resolvers (Issue #957), never the
 * process: nothing here can race a test running beside it, and a `GEMINI_*`
 * variable the worker container exports cannot reach the chain either.
 *
 * @param vars - The Gemini routing variables this test declares as set.
 * @param fn - The test body, given the lookup to inject.
 */
function withCleanRouting(
  vars: Record<string, string>,
  fn: (env: EnvLookup) => void,
): void {
  setGeminiPhaseModelConfigOverrides({});
  setActiveRepoGeminiModelOverrides(undefined);
  clearGeminiEffortWarnings();
  try {
    fn(envFrom(vars));
  } finally {
    setGeminiPhaseModelConfigOverrides({});
    setActiveRepoGeminiModelOverrides(undefined);
    clearGeminiEffortWarnings();
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

/** Build argv while swallowing any warning it emits, returning the argv. */
function argsQuietly(fn: () => string[]): string[] {
  let args: string[] = [];
  captureWarnings(() => {
    args = fn();
  });
  return args;
}

/** The value the argv's `--model` flag carries. */
function modelArg(args: string[]): string | undefined {
  const index = args.indexOf("--model");
  return index === -1 ? undefined : args[index + 1];
}

// ---------------------------------------------------------------------------
// The phase table reaches argv
// ---------------------------------------------------------------------------

Deno.test("gemini routing - planning runs on the top tier", () => {
  withCleanRouting({}, (env) => {
    const args = gemini.buildInvocation({
      prompt: "PROMPT",
      phase: "planning",
      env,
    });

    assertEquals(modelArg(args), DEFAULT_GEMINI_MODEL_TOP_TIER);
    assertEquals(args.at(-1), "PROMPT", "the prompt stays last");
  });
});

Deno.test("gemini routing - every phase key reaches argv with its designed model", () => {
  withCleanRouting({}, (env) => {
    for (const phase of Object.keys(GEMINI_PHASE_MODEL_DEFAULTS)) {
      const args = gemini.buildInvocation({ prompt: "PROMPT", phase, env });
      assertEquals(
        modelArg(args),
        GEMINI_PHASE_MODEL_DEFAULTS[phase],
        `phase ${phase} must carry its designed model`,
      );
    }
  });
});

Deno.test("gemini routing - the table covers the same phase keys as the Claude table", () => {
  assertEquals(
    Object.keys(GEMINI_PHASE_MODEL_DEFAULTS).sort(),
    Object.keys(PHASE_MODEL_DEFAULTS).sort(),
  );
});

Deno.test("gemini routing - a cheap phase is cheaper than planning", () => {
  withCleanRouting({}, (env) => {
    for (const phase of ["spelling_fix", "summarise", "health"]) {
      assertEquals(
        resolveGeminiModel(phase, env),
        DEFAULT_GEMINI_MODEL_CHEAP_TIER,
      );
    }

    assertEquals(
      resolveGeminiModel("planning", env),
      DEFAULT_GEMINI_MODEL_TOP_TIER,
    );
    assert(
      (DEFAULT_GEMINI_MODEL_CHEAP_TIER as string) !==
        (DEFAULT_GEMINI_MODEL_TOP_TIER as string),
      "the cheap tier must not be the top tier",
    );
  });
});

Deno.test("gemini routing - an explicit model beats the phase default", () => {
  withCleanRouting({}, (env) => {
    const args = gemini.buildInvocation({
      prompt: "PROMPT",
      phase: "planning",
      model: "gemini-2.5-flash",
      env,
    });

    assertEquals(modelArg(args), "gemini-2.5-flash");
  });
});

Deno.test("gemini routing - a phase-less invocation leaves the CLI on its default", () => {
  withCleanRouting({}, (env) => {
    const warnings = captureWarnings(() => {
      assertEquals(resolveGeminiModel(undefined, env), undefined);
      assertEquals(resolveGeminiEffort(), undefined);
    });
    assertEquals(warnings.length, 0, "a phase-less call is deliberate");

    assertEquals(
      gemini.buildInvocation({ prompt: "PROMPT", env }).includes("--model"),
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// The six-step override chain, with Gemini-named keys
// ---------------------------------------------------------------------------

Deno.test("gemini routing - a phase-specific env var beats every other source", () => {
  withCleanRouting({
    GEMINI_MODEL_PLANNING: "gemini-env",
    GEMINI_MODEL: "gemini-base",
  }, (env) => {
    setGeminiPhaseModelConfigOverrides({ planning: "gemini-global" });
    setActiveRepoGeminiModelOverrides({
      geminiModel: "gemini-repo-base",
      geminiPhaseModelOverrides: { planning: "gemini-repo-phase" },
    });

    assertEquals(resolveGeminiModel("planning", env), "gemini-env");
  });
});

Deno.test("gemini routing - a per-repo phase override beats the per-repo base tier", () => {
  withCleanRouting({}, (env) => {
    setActiveRepoGeminiModelOverrides({
      geminiModel: "gemini-repo-base",
      geminiPhaseModelOverrides: { planning: "gemini-repo-phase" },
    });

    assertEquals(resolveGeminiModel("planning", env), "gemini-repo-phase");
    // A phase the repo does not re-pin still takes the repo base tier.
    assertEquals(resolveGeminiModel("health", env), "gemini-repo-base");
  });
});

Deno.test("gemini routing - the per-repo base tier beats the global config override", () => {
  withCleanRouting({}, (env) => {
    setGeminiPhaseModelConfigOverrides({ planning: "gemini-global" });
    setActiveRepoGeminiModelOverrides({ geminiModel: "gemini-repo-base" });

    assertEquals(resolveGeminiModel("planning", env), "gemini-repo-base");
  });
});

Deno.test("gemini routing - a global config override beats the phase default", () => {
  withCleanRouting({}, (env) => {
    setGeminiPhaseModelConfigOverrides({ planning: "gemini-global" });

    assertEquals(resolveGeminiModel("planning", env), "gemini-global");
  });
});

Deno.test("gemini routing - per-repo overrides are replaced, never merged, on a repo switch", () => {
  withCleanRouting({}, (env) => {
    setActiveRepoGeminiModelOverrides({
      geminiModel: "gemini-premium",
      geminiPhaseModelOverrides: { planning: "gemini-premium-planning" },
    });
    assertEquals(
      resolveGeminiModel("planning", env),
      "gemini-premium-planning",
    );

    // The next repo configures no Gemini routing: the premium tier must not
    // leak into it.
    setActiveRepoGeminiModelOverrides({});
    assertEquals(
      resolveGeminiModel("planning", env),
      DEFAULT_GEMINI_MODEL_TOP_TIER,
    );
  });
});

Deno.test("gemini routing - the base env var covers a phase with no table entry", () => {
  withCleanRouting({ GEMINI_MODEL: "gemini-base" }, (env) => {
    const warnings = captureWarnings(() => {
      assertEquals(
        resolveGeminiModel("totally_unknown_phase", env),
        "gemini-base",
      );
    });
    assertEquals(
      warnings.length,
      0,
      "an explicitly configured base value is not a missing default",
    );
  });
});

Deno.test("gemini routing - a phase with no model anywhere warns and adds no flag", () => {
  withCleanRouting({}, (env) => {
    let args: string[] = [];
    const warnings = captureWarnings(() => {
      args = gemini.buildInvocation({
        prompt: "PROMPT",
        phase: "totally_unknown_phase",
        env,
      });
    });

    assertEquals(modelArg(args), undefined);
    assertEquals(warnings.length, 1);
    assertStringIncludes(warnings[0]!, "totally_unknown_phase");
    assertStringIncludes(warnings[0]!, "gemini-executor");
    assertStringIncludes(warnings[0]!, "--model");
  });
});

Deno.test("gemini routing - the descriptor's model resolver is the Gemini chain", () => {
  withCleanRouting({}, (env) => {
    for (
      const phase of [undefined, ...Object.keys(GEMINI_PHASE_MODEL_DEFAULTS)]
    ) {
      assertEquals(
        gemini.resolveModel(phase, env),
        resolveGeminiModel(phase, env),
      );
      assertEquals(gemini.resolveEffort(phase), resolveGeminiEffort(phase));
    }
  });
});

// ---------------------------------------------------------------------------
// Fail loud: an effort the CLI cannot honour is reported, never silently lost
// ---------------------------------------------------------------------------

Deno.test("gemini effort - an explicit effort warns exactly once and adds no argv element", () => {
  withCleanRouting({}, (env) => {
    let withEffort: string[] = [];
    const warnings = captureWarnings(() => {
      withEffort = gemini.buildInvocation({
        prompt: "PROMPT",
        phase: "planning",
        effort: "high",
        env,
      });
    });

    const withoutEffort = argsQuietly(() =>
      gemini.buildInvocation({ prompt: "PROMPT", phase: "planning", env })
    );
    assertEquals(
      withEffort,
      withoutEffort,
      "an effort must not change the argument list",
    );

    assertEquals(warnings.length, 1);
    assertStringIncludes(warnings[0]!, "gemini");
    assertStringIncludes(warnings[0]!, "planning");
    assertStringIncludes(warnings[0]!, "high");
  });
});

Deno.test("gemini effort - a phase with an effort default warns without an explicit effort", () => {
  withCleanRouting({}, (env) => {
    // `planning` has a designed effort in the shared phase table; Gemini cannot
    // honour it, so the operator relying on that default is told so.
    const designed = PHASE_EFFORT_DEFAULTS.planning!;
    assertEquals(resolveGeminiEffort("planning"), designed);

    const warnings = captureWarnings(() => {
      gemini.buildInvocation({ prompt: "PROMPT", phase: "planning", env });
    });

    assertEquals(warnings.length, 1);
    assertStringIncludes(warnings[0]!, designed);
    assertStringIncludes(warnings[0]!, "planning");
  });
});

Deno.test("gemini effort - the warning is emitted once per phase, not once per invocation", () => {
  withCleanRouting({}, (env) => {
    const warnings = captureWarnings(() => {
      for (let i = 0; i < 3; i++) {
        gemini.buildInvocation({
          prompt: "PROMPT",
          phase: "planning",
          effort: "high",
          env,
        });
      }
      // A different phase is a different gap, so it states its own case.
      gemini.buildInvocation({
        prompt: "PROMPT",
        phase: "ci_fix",
        effort: "medium",
        env,
      });
    });

    assertEquals(warnings.length, 2);
    assertStringIncludes(warnings[0]!, "planning");
    assertStringIncludes(warnings[1]!, "ci_fix");
  });
});

Deno.test("gemini effort - no effort anywhere produces no warning", () => {
  // A phase with no designed effort and no explicit one: nothing to report.
  withCleanRouting({
    GEMINI_MODEL_TOTALLY_UNKNOWN_PHASE: "gemini-pinned",
  }, (env) => {
    const warnings = captureWarnings(() => {
      gemini.buildInvocation({
        prompt: "PROMPT",
        phase: "totally_unknown_phase",
        env,
      });
      gemini.buildInvocation({ prompt: "PROMPT", env });
    });

    assertEquals(warnings, []);
  });
});

Deno.test("gemini effort - the run is not failed by an effort it cannot honour", () => {
  withCleanRouting({}, (env) => {
    let args: string[] = [];
    captureWarnings(() => {
      args = gemini.buildInvocation({
        prompt: "PROMPT",
        phase: "planning",
        effort: "max",
        env,
      });
    });

    // The warning is the fix: a valid invocation is still produced, and it
    // carries no invented effort flag the CLI would reject.
    assertEquals(args.at(-1), "PROMPT");
    assertEquals(args.some((arg) => arg.includes("effort")), false);
  });
});

// ---------------------------------------------------------------------------
// The documented routing matches the code
// ---------------------------------------------------------------------------

Deno.test("gemini routing - docs/MODEL-AND-CACHING.md states the routing the code applies", async () => {
  const doc = await Deno.readTextFile(
    new URL("../../../docs/MODEL-AND-CACHING.md", import.meta.url),
  );
  const start = doc.indexOf("### ✨ Gemini per-phase routing");
  assert(start !== -1, "the Gemini routing section is missing from the doc");
  const end = doc.indexOf("\n### ", start + 1);
  const section = doc.slice(start, end === -1 ? undefined : end);
  const rows = section.split("\n").filter((line) =>
    line.trimStart().startsWith("|")
  );

  for (const [phase, model] of Object.entries(GEMINI_PHASE_MODEL_DEFAULTS)) {
    const row = rows.find((line) => line.includes(`\`${phase}\``));
    assert(row, `no Gemini routing row documents phase ${phase}`);
    assertStringIncludes(row, `\`${model}\``);
  }
});

// ---------------------------------------------------------------------------
// The injected environment lookup (Issue #957)
// ---------------------------------------------------------------------------

Deno.test("gemini routing - both env reads go through the injected lookup, never the process (Issue #957)", () => {
  // The sentinel exists in no process environment, so a resolver that fell
  // back to `Deno.env.get` would return undefined instead of it.
  const sentinel = "gemini-957-sentinel";
  withCleanRouting({}, () => {
    const asked: string[] = [];
    // An unknown phase misses steps 2-5, so one call covers step 1 (the
    // phase-specific variable) and step 6 (the base variable).
    const model = resolveGeminiModel("totally_unknown_phase", (name) => {
      asked.push(name);
      return name === "GEMINI_MODEL" ? sentinel : undefined;
    });

    assertEquals(model, sentinel);
    assertEquals(asked, ["GEMINI_MODEL_TOTALLY_UNKNOWN_PHASE", "GEMINI_MODEL"]);
    assertEquals(Deno.env.get("GEMINI_MODEL"), undefined);
  });

  withCleanRouting({ GEMINI_MODEL_PLANNING: sentinel }, (env) => {
    // Step 1 beats the designed top tier, and reaches argv through the
    // descriptor — so `buildInvocation` forwards the lookup too.
    assertEquals(resolveGeminiModel("planning", env), sentinel);
    const args = argsQuietly(() =>
      gemini.buildInvocation({ prompt: "PROMPT", phase: "planning", env })
    );
    assertEquals(modelArg(args), sentinel);
  });
});
