/**
 * Tests for the provider-agnostic model/effort resolution seam (Issue #362,
 * parent #357).
 *
 * Before the seam, phase routing was resolved *inside* the Claude descriptor,
 * so `request.phase` reached Codex and Gemini and was silently discarded. The
 * seam moves the decision onto every descriptor —
 * `resolveModel(phase)` / `resolveEffort(phase)` — with the explicit
 * `request.model` / `request.effort` still winning. Codex's tables landed in
 * #363 and Gemini's in #364, so all three providers now route a phase.
 *
 * This issue is a pure refactor, so these tests are argv-equality tests: for
 * every registered provider the built argv must match the golden list today's
 * code produces, for no model/effort, for an explicit model + effort, and for
 * every phase key in `PHASE_MODEL_DEFAULTS` / `PHASE_EFFORT_DEFAULTS`.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  agentProviderIds,
  CLAUDE_PROVIDER_ID,
  CODEX_PROVIDER_ID,
  GEMINI_PROVIDER_ID,
  resolveAgentProvider,
  resolveInvocationRouting,
} from "../lib/agent_provider.ts";
import {
  buildClaudeEffortArgs,
  buildClaudeModelArgs,
  resolveClaudeEffort,
  resolveClaudeModel,
} from "../lib/claude_executor.ts";
import {
  CODEX_PHASE_EFFORT_DEFAULTS,
  CODEX_PHASE_MODEL_DEFAULTS,
  GEMINI_PHASE_MODEL_DEFAULTS,
  PHASE_EFFORT_DEFAULTS,
  PHASE_MODEL_DEFAULTS,
} from "../lib/config_defaults.ts";
import { envLookup, NO_ENV } from "./support/env_lookup.ts";

/** Every phase either routing table names, in a stable order. */
const ROUTED_PHASES: string[] = [
  ...new Set([
    ...Object.keys(PHASE_MODEL_DEFAULTS),
    ...Object.keys(PHASE_EFFORT_DEFAULTS),
  ]),
].sort();

/** The Claude argv tail that follows the model/effort flags. */
const CLAUDE_TAIL = [
  "--dangerously-skip-permissions",
  "--verbose",
  "--output-format",
  "stream-json",
  "-p",
  "PROMPT",
];

// The routing env is injected rather than set on the process (Issue #957):
// `NO_ENV` is an environment where nothing is set, and `envLookup` states the
// variables one scenario declares. Clearing a base variable used to mean
// deleting it process-wide, which every test running beside this one saw.

// ---------------------------------------------------------------------------
// Every descriptor implements the seam
// ---------------------------------------------------------------------------

Deno.test("routing seam - every registered provider resolves model and effort", () => {
  for (const id of agentProviderIds()) {
    const provider = resolveAgentProvider(id);
    assertEquals(
      typeof provider.resolveModel,
      "function",
      `${id} must expose resolveModel`,
    );
    assertEquals(
      typeof provider.resolveEffort,
      "function",
      `${id} must expose resolveEffort`,
    );
    // A resolver never throws for a phase it does not know.
    provider.resolveModel("totally_unknown_phase");
    provider.resolveEffort("totally_unknown_phase");
  }
});

Deno.test("routing seam - Claude's resolvers are the existing precedence chain", () => {
  const claude = resolveAgentProvider(CLAUDE_PROVIDER_ID);

  for (const phase of [undefined, ...ROUTED_PHASES]) {
    assertEquals(
      claude.resolveModel(phase, NO_ENV),
      resolveClaudeModel(phase, NO_ENV),
      `Claude's model resolver must match the chain for phase ${phase}`,
    );
    assertEquals(
      claude.resolveEffort(phase, NO_ENV),
      resolveClaudeEffort(phase, NO_ENV),
      `Claude's effort resolver must match the chain for phase ${phase}`,
    );
  }
});

Deno.test("routing seam - Gemini resolves every routed phase through its own table (Issue #364)", () => {
  // Codex gained its own tables in Issue #363 and Gemini its model table in
  // #364; both are covered in depth by their own routing tests. Gemini has no
  // effort *flag*, so its effort resolver reports the effort the phase was
  // asked for — the value the descriptor then warns about rather than applies.
  const gemini = resolveAgentProvider(GEMINI_PROVIDER_ID);
  // A base env var is precedence step 6 and would mask the table, so the
  // injected environment holds none.
  for (const phase of ROUTED_PHASES) {
    assertEquals(
      gemini.resolveModel(phase, NO_ENV),
      GEMINI_PHASE_MODEL_DEFAULTS[phase],
      `gemini model for phase ${phase}`,
    );
    assertEquals(
      gemini.resolveEffort(phase, NO_ENV),
      PHASE_EFFORT_DEFAULTS[phase],
      `gemini requested effort for phase ${phase}`,
    );
  }

  // A phase-less invocation is deliberate: nothing routes, nothing warns.
  assertEquals(
    gemini.resolveModel(undefined, NO_ENV),
    undefined,
    "gemini model",
  );
  assertEquals(
    gemini.resolveEffort(undefined, NO_ENV),
    undefined,
    "gemini effort",
  );
});

Deno.test("routing seam - Codex resolves every routed phase through its own tables (Issue #363)", () => {
  const codex = resolveAgentProvider(CODEX_PROVIDER_ID);
  // The base env vars are precedence step 6 and would mask the tables, so the
  // injected environment holds neither.
  for (const phase of ROUTED_PHASES) {
    assertEquals(
      codex.resolveModel(phase, NO_ENV),
      CODEX_PHASE_MODEL_DEFAULTS[phase],
      `codex model for phase ${phase}`,
    );
    assertEquals(
      codex.resolveEffort(phase, NO_ENV),
      CODEX_PHASE_EFFORT_DEFAULTS[phase],
      `codex effort for phase ${phase}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Precedence: explicit request values win over the resolver
// ---------------------------------------------------------------------------

Deno.test("routing seam - an explicit model and effort beat the phase resolver", () => {
  const claude = resolveAgentProvider(CLAUDE_PROVIDER_ID);

  const routing = resolveInvocationRouting(claude, {
    prompt: "PROMPT",
    phase: "planning",
    model: "claude-opus-4-1",
    effort: "low",
    env: NO_ENV,
  });

  assertEquals(routing, { model: "claude-opus-4-1", effort: "low" });
});

Deno.test("routing seam - a blank explicit value falls through to the resolver", () => {
  const claude = resolveAgentProvider(CLAUDE_PROVIDER_ID);

  const routing = resolveInvocationRouting(claude, {
    prompt: "PROMPT",
    phase: "planning",
    model: "",
    effort: "",
    env: NO_ENV,
  });

  assertEquals(routing.model, resolveClaudeModel("planning", NO_ENV));
  assertEquals(routing.effort, resolveClaudeEffort("planning", NO_ENV));
});

Deno.test("routing seam - an explicit value beats a provider's own phase routing", () => {
  const gemini = resolveAgentProvider(GEMINI_PROVIDER_ID);

  const routing = resolveInvocationRouting(gemini, {
    prompt: "PROMPT",
    phase: "planning",
    model: "gemini-pinned",
    effort: "low",
    env: NO_ENV,
  });

  assertEquals(routing, { model: "gemini-pinned", effort: "low" });

  // With nothing explicit, Gemini's own table decides the model (Issue #364),
  // and a phase-less call still leaves the CLI on its own default.
  const routed = resolveInvocationRouting(gemini, {
    prompt: "PROMPT",
    phase: "planning",
    env: NO_ENV,
  });
  assertEquals(routed.model, GEMINI_PHASE_MODEL_DEFAULTS.planning);

  const unrouted = resolveInvocationRouting(gemini, {
    prompt: "PROMPT",
    env: NO_ENV,
  });
  assertEquals(unrouted, { model: undefined, effort: undefined });
});

// ---------------------------------------------------------------------------
// Golden argv: byte-identical to what the pre-seam builders produced
// ---------------------------------------------------------------------------

Deno.test("routing seam - Claude argv per phase is what the pre-seam builders produced", () => {
  const claude = resolveAgentProvider(CLAUDE_PROVIDER_ID);

  for (const phase of [undefined, ...ROUTED_PHASES]) {
    // (a) No model/effort: the phase routing decides, exactly as before.
    assertEquals(
      claude.buildInvocation({ prompt: "PROMPT", phase, env: NO_ENV }),
      [
        ...buildClaudeModelArgs(phase, NO_ENV),
        ...buildClaudeEffortArgs(phase, NO_ENV),
        ...CLAUDE_TAIL,
      ],
      `phase ${phase} must route through the unchanged model/effort builders`,
    );

    // (b) Explicit model + effort: the request wins at every phase.
    assertEquals(
      claude.buildInvocation({
        prompt: "PROMPT",
        phase,
        model: "claude-opus-4-1",
        effort: "max",
        env: NO_ENV,
      }),
      [
        "--model",
        "claude-opus-4-1",
        "--effort",
        "max",
        ...CLAUDE_TAIL,
      ],
      `phase ${phase} must not override an explicit model/effort`,
    );
  }
});

Deno.test("routing seam - Claude argv carries each phase's designed defaults", () => {
  const claude = resolveAgentProvider(CLAUDE_PROVIDER_ID);

  // A phase-specific env var is precedence step 1 for both model and effort,
  // so this pins the whole chain without disturbing config or repo overrides.
  assertEquals(
    claude.buildInvocation({
      prompt: "PROMPT",
      phase: "planning",
      env: envLookup({
        CLAUDE_MODEL_PLANNING: "opus",
        CLAUDE_EFFORT_PLANNING: "medium",
      }),
    }),
    ["--model", "opus", "--effort", "medium", ...CLAUDE_TAIL],
  );

  // The designed defaults still reach argv when no override is set: the
  // resolver and the built argv agree phase by phase.
  for (const phase of ROUTED_PHASES) {
    const args = claude.buildInvocation({
      prompt: "PROMPT",
      phase,
      env: NO_ENV,
    });
    const model = claude.resolveModel(phase, NO_ENV);
    if (model) {
      assertEquals(args[args.indexOf("--model") + 1], model);
    } else {
      assertEquals(args.includes("--model"), false);
    }
    assertEquals(
      args[args.indexOf("--effort") + 1],
      claude.resolveEffort(phase, NO_ENV),
    );
  }
});

Deno.test("routing seam - Codex argv carries each phase's designed defaults (Issue #363)", () => {
  const codex = resolveAgentProvider(CODEX_PROVIDER_ID);

  const base = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
  ];

  // Issue #363 replaced the pre-seam pass-through this test used to pin: a
  // phase now reaches argv as `--model` + `-c model_reasoning_effort`, and a
  // phase-less call is the only one that still adds no routing flags. The base
  // env vars are precedence step 6 and would mask the tables, so the injected
  // environment holds neither.
  assertEquals(
    codex.buildInvocation({ prompt: "PROMPT", env: NO_ENV }),
    [...base, "PROMPT"],
    "a phase-less invocation leaves Codex on its configured default",
  );

  for (const phase of [undefined, ...ROUTED_PHASES]) {
    if (phase) {
      assertEquals(
        codex.buildInvocation({ prompt: "PROMPT", phase, env: NO_ENV }),
        [
          ...base,
          "--model",
          CODEX_PHASE_MODEL_DEFAULTS[phase],
          "-c",
          `model_reasoning_effort="${CODEX_PHASE_EFFORT_DEFAULTS[phase]}"`,
          "PROMPT",
        ],
        `phase ${phase} must carry its designed Codex model and effort`,
      );
    }

    assertEquals(
      codex.buildInvocation({
        prompt: "PROMPT",
        phase,
        model: "gpt-5-codex",
        effort: "high",
        env: NO_ENV,
      }),
      [
        ...base,
        "--model",
        "gpt-5-codex",
        "-c",
        'model_reasoning_effort="high"',
        "PROMPT",
      ],
      `phase ${phase} must not disturb an explicit Codex model/effort`,
    );
  }
});

Deno.test("routing seam - Gemini argv carries each phase's designed model (Issue #364)", () => {
  const gemini = resolveAgentProvider(GEMINI_PROVIDER_ID);

  // The base env var is precedence step 6 and would mask the table, so the
  // injected environment holds none.
  assertEquals(
    gemini.buildInvocation({ prompt: "PROMPT", env: NO_ENV }).includes(
      "--model",
    ),
    false,
    "a phase-less invocation leaves Gemini on its configured default",
  );

  for (const phase of ROUTED_PHASES) {
    const routed = gemini.buildInvocation({
      prompt: "PROMPT",
      phase,
      env: NO_ENV,
    });
    assertEquals(
      routed[routed.indexOf("--model") + 1],
      GEMINI_PHASE_MODEL_DEFAULTS[phase],
      `phase ${phase} must carry its designed Gemini model`,
    );
    assert(
      !routed.some((arg) => arg.includes("effort")),
      "the Gemini CLI has no reasoning-effort option to carry",
    );

    const explicit = gemini.buildInvocation({
      prompt: "PROMPT",
      phase,
      model: "gemini-pinned",
      effort: "high",
      env: NO_ENV,
    });
    assertEquals(explicit[explicit.indexOf("--model") + 1], "gemini-pinned");
    assert(
      !explicit.includes("--effort"),
      "the Gemini CLI has no reasoning-effort option to carry",
    );
  }
});

// ---------------------------------------------------------------------------
// The injected environment lookup reaches every descriptor (Issue #957)
// ---------------------------------------------------------------------------

Deno.test("routing seam - every provider's resolvers and argv read the injected lookup (Issue #957)", () => {
  // One sentinel per provider, under that provider's own base variable. None
  // exists in a real process environment, so a descriptor that resolved through
  // `Deno.env.get` would fall through to its table (or to nothing) instead.
  const sentinels: Record<string, { envVar: string; value: string }> = {
    [CLAUDE_PROVIDER_ID]: {
      envVar: "CLAUDE_MODEL",
      value: "claude-957-sentinel",
    },
    [CODEX_PROVIDER_ID]: { envVar: "CODEX_MODEL", value: "gpt-957-sentinel" },
    [GEMINI_PROVIDER_ID]: {
      envVar: "GEMINI_MODEL",
      value: "gemini-957-sentinel",
    },
  };

  for (const [id, { envVar, value }] of Object.entries(sentinels)) {
    const provider = resolveAgentProvider(id);
    const env = envLookup({ [envVar]: value });
    // Step 6 (the base variable) covers a phase with no table entry.
    assertEquals(
      provider.resolveModel("totally_unknown_phase", env),
      value,
      `${id} must resolve the model through the injected lookup`,
    );
    // ...and `buildInvocation` forwards the same lookup to that resolver.
    const args = provider.buildInvocation({
      prompt: "PROMPT",
      phase: "totally_unknown_phase",
      env,
    });
    assertEquals(
      args[args.indexOf("--model") + 1],
      value,
      `${id} must carry the injected model into argv`,
    );
    assertEquals(Deno.env.get(envVar), undefined);
  }
});
