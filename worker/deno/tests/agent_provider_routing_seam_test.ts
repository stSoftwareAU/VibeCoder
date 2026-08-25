/**
 * Tests for the provider-agnostic model/effort resolution seam (Issue #362,
 * parent #357).
 *
 * Before the seam, phase routing was resolved *inside* the Claude descriptor,
 * so `request.phase` reached Codex and Gemini and was silently discarded. The
 * seam moves the decision onto every descriptor —
 * `resolveModel(phase)` / `resolveEffort(phase)` — with the explicit
 * `request.model` / `request.effort` still winning, and Codex/Gemini returning
 * nothing until their own tables land (#363, #364).
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
  PHASE_EFFORT_DEFAULTS,
  PHASE_MODEL_DEFAULTS,
} from "../lib/config_defaults.ts";

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

/** Run `fn` with `name` set to `value` (or deleted), then restore it. */
function withEnv(
  name: string,
  value: string | undefined,
  fn: () => void,
): void {
  const original = Deno.env.get(name);
  if (value === undefined) Deno.env.delete(name);
  else Deno.env.set(name, value);
  try {
    fn();
  } finally {
    if (original === undefined) Deno.env.delete(name);
    else Deno.env.set(name, original);
  }
}

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
      claude.resolveModel(phase),
      resolveClaudeModel(phase),
      `Claude's model resolver must match the chain for phase ${phase}`,
    );
    assertEquals(
      claude.resolveEffort(phase),
      resolveClaudeEffort(phase),
      `Claude's effort resolver must match the chain for phase ${phase}`,
    );
  }
});

Deno.test("routing seam - Gemini resolves nothing, leaving today's pass-through", () => {
  // Codex gained its own tables in Issue #363 and is covered by
  // `codex_phase_routing_test.ts`; Gemini keeps the pass-through until #364.
  const gemini = resolveAgentProvider(GEMINI_PROVIDER_ID);
  for (const phase of [undefined, ...ROUTED_PHASES]) {
    assertEquals(gemini.resolveModel(phase), undefined, "gemini model");
    assertEquals(gemini.resolveEffort(phase), undefined, "gemini effort");
  }
});

Deno.test("routing seam - Codex resolves every routed phase through its own tables (Issue #363)", () => {
  const codex = resolveAgentProvider(CODEX_PROVIDER_ID);
  // A base env var is precedence step 6 and would mask the tables, so clear it.
  withEnv("CODEX_MODEL", undefined, () => {
    withEnv("CODEX_EFFORT", undefined, () => {
      for (const phase of ROUTED_PHASES) {
        assertEquals(
          codex.resolveModel(phase),
          CODEX_PHASE_MODEL_DEFAULTS[phase],
          `codex model for phase ${phase}`,
        );
        assertEquals(
          codex.resolveEffort(phase),
          CODEX_PHASE_EFFORT_DEFAULTS[phase],
          `codex effort for phase ${phase}`,
        );
      }
    });
  });
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
  });

  assertEquals(routing.model, resolveClaudeModel("planning"));
  assertEquals(routing.effort, resolveClaudeEffort("planning"));
});

Deno.test("routing seam - a provider that resolves nothing keeps the explicit values", () => {
  const gemini = resolveAgentProvider(GEMINI_PROVIDER_ID);

  const routing = resolveInvocationRouting(gemini, {
    prompt: "PROMPT",
    phase: "planning",
    model: "gemini-2.5-pro",
    effort: "high",
  });

  assertEquals(routing, { model: "gemini-2.5-pro", effort: "high" });

  const unrouted = resolveInvocationRouting(gemini, {
    prompt: "PROMPT",
    phase: "planning",
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
      claude.buildInvocation({ prompt: "PROMPT", phase }),
      [
        ...buildClaudeModelArgs(phase),
        ...buildClaudeEffortArgs(phase),
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
  withEnv("CLAUDE_MODEL_PLANNING", "opus", () => {
    withEnv("CLAUDE_EFFORT_PLANNING", "medium", () => {
      assertEquals(
        claude.buildInvocation({ prompt: "PROMPT", phase: "planning" }),
        ["--model", "opus", "--effort", "medium", ...CLAUDE_TAIL],
      );
    });
  });

  // The designed defaults still reach argv when no override is set: the
  // resolver and the built argv agree phase by phase.
  for (const phase of ROUTED_PHASES) {
    const args = claude.buildInvocation({ prompt: "PROMPT", phase });
    const model = claude.resolveModel(phase);
    if (model) {
      assertEquals(args[args.indexOf("--model") + 1], model);
    } else {
      assertEquals(args.includes("--model"), false);
    }
    assertEquals(
      args[args.indexOf("--effort") + 1],
      claude.resolveEffort(phase),
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
  // env vars are precedence step 6 and would mask the tables, so clear them.
  withEnv("CODEX_MODEL", undefined, () => {
    withEnv("CODEX_EFFORT", undefined, () => {
      assertEquals(
        codex.buildInvocation({ prompt: "PROMPT" }),
        [...base, "PROMPT"],
        "a phase-less invocation leaves Codex on its configured default",
      );

      for (const phase of [undefined, ...ROUTED_PHASES]) {
        if (phase) {
          assertEquals(
            codex.buildInvocation({ prompt: "PROMPT", phase }),
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
  });
});

Deno.test("routing seam - Gemini argv ignores the phase, as it did before the seam", () => {
  const gemini = resolveAgentProvider(GEMINI_PROVIDER_ID);

  for (const phase of [undefined, ...ROUTED_PHASES]) {
    const unrouted = gemini.buildInvocation({ prompt: "PROMPT", phase });
    assertEquals(
      unrouted.includes("--model"),
      false,
      `phase ${phase} must add no Gemini --model yet (Issue #364)`,
    );

    const explicit = gemini.buildInvocation({
      prompt: "PROMPT",
      phase,
      model: "gemini-2.5-pro",
      effort: "high",
    });
    assertEquals(explicit[explicit.indexOf("--model") + 1], "gemini-2.5-pro");
    assert(
      !explicit.includes("--effort"),
      "the Gemini CLI has no reasoning-effort option to carry",
    );
  }
});
