/**
 * Tests for lib/provider_feasibility.ts — the evaluator behind
 * `provider-feasibility` (Issue #3647).
 *
 * Every verdict here is asserted exactly, against the real provider descriptors
 * and the real invocation builders, so a guard that stops firing turns a test
 * red rather than quietly reporting `go`.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildFeasibilityCombinations,
  DEFAULT_FEASIBILITY_MODELS,
  evaluateFeasibility,
  type FeasibilityCombination,
  type FeasibilityContext,
  type FeasibilityRow,
  fleetBaselineModels,
  formatFeasibilityReport,
  modelKey,
  probeInvocationCapabilities,
  type ProviderHostFacts,
} from "../lib/provider_feasibility.ts";

/** Host facts for a provider that would pass every check. */
function goodFacts(provider: string): ProviderHostFacts {
  return {
    provider,
    cliVersion: "x 1.0",
    cliDetail: "ok",
    billing: {
      provider,
      billingMode: "fixed-subscription",
      reason: "CLAUDE_CODE_OAUTH_TOKEN",
    },
    meteredVarsInChild: [],
    quotaVisible: true,
    quotaDetail: "100.0% remaining (rollout)",
  };
}

/** A context over the given facts, with the fleet baseline validated. */
function contextWith(
  facts: ProviderHostFacts[],
  extraValidated: string[] = [],
  capabilities?: FeasibilityContext["capabilities"],
): FeasibilityContext {
  return {
    facts: new Map(facts.map((entry) => [entry.provider, entry])),
    validatedModels: new Set([
      ...fleetBaselineModels(),
      ...extraValidated,
    ]),
    capabilities,
  };
}

/** Shorthand for a combination. */
function combo(
  role: FeasibilityCombination["role"],
  provider: string,
  model: string,
  managerProvider: string = provider,
): FeasibilityCombination {
  return { role, provider, model, managerProvider };
}

Deno.test("probeInvocationCapabilities reads what each provider builds", () => {
  assertEquals(probeInvocationCapabilities("claude"), {
    carriesSubAgents: true,
    carriesSettingsHook: true,
    bypassesCliSandbox: false,
  });
  assertEquals(probeInvocationCapabilities("codex"), {
    carriesSubAgents: false,
    carriesSettingsHook: false,
    bypassesCliSandbox: true,
  });
  assertEquals(probeInvocationCapabilities("nope"), undefined);
});

Deno.test("claude manager on a validated fleet model is go", () => {
  const row = evaluateFeasibility(
    combo("manager", "claude", "opus"),
    contextWith([goodFacts("claude")]),
  );
  assertEquals(row.verdict, "go");
  assertEquals(row.blockers, []);
});

Deno.test("codex manager on an unvalidated model is unavailable with every blocker", () => {
  const row = evaluateFeasibility(
    combo("manager", "codex", "gpt-6-astra"),
    contextWith([goodFacts("codex")]),
  );
  assertEquals(row.verdict, "unavailable");
  for (
    const blocker of [
      "no-sub-agent-definitions",
      "no-advisor-edit-guard",
      "model-not-validated-on-host",
    ]
  ) {
    assert(row.blockers.includes(blocker), `missing blocker ${blocker}`);
  }
  assert(row.caveats.includes("api-equivalent-price-missing"));
  assert(
    row.caveats.includes(
      "cli-sandbox-bypassed (the container is the only boundary)",
    ),
  );
});

Deno.test("codex executor under a claude manager is no-go on the cross-provider guard only", () => {
  const row = evaluateFeasibility(
    combo("executor", "codex", "gpt-6.1-sol", "claude"),
    contextWith(
      [goodFacts("claude"), goodFacts("codex")],
      [modelKey("codex", "gpt-6.1-sol")],
    ),
  );
  assertEquals(row.verdict, "no-go");
  assertEquals(row.blockers, [
    "cross-provider-dispatch-not-implemented (sub-agents run inside the claude manager's CLI process)",
  ]);
  assert(!row.blockers.includes("no-sub-agent-definitions"));
});

Deno.test("claude executor under a claude manager is go (same-provider path)", () => {
  const row = evaluateFeasibility(
    combo("executor", "claude", "sonnet"),
    contextWith([goodFacts("claude")]),
  );
  assertEquals(row.verdict, "go");
  assertEquals(row.blockers, []);
});

Deno.test("metered billing is no-go with the variable named", () => {
  const facts: ProviderHostFacts = {
    ...goodFacts("codex"),
    billing: {
      provider: "codex",
      billingMode: "metered",
      reason: "OPENAI_API_KEY",
    },
  };
  const row = evaluateFeasibility(
    combo("manager", "codex", "gpt-5"),
    contextWith([facts], [modelKey("codex", "gpt-5")]),
  );
  assertEquals(row.verdict, "no-go");
  assert(row.blockers.includes("billing-metered (OPENAI_API_KEY)"));
});

Deno.test("unknown billing is no-go with the reason named", () => {
  const facts: ProviderHostFacts = {
    ...goodFacts("claude"),
    billing: {
      provider: "claude",
      billingMode: "unknown",
      reason: "subscription-credential-missing",
    },
  };
  const row = evaluateFeasibility(
    combo("manager", "claude", "opus"),
    contextWith([facts]),
  );
  assertEquals(row.verdict, "no-go");
  assertEquals(row.blockers, [
    "billing-unknown (subscription-credential-missing)",
  ]);
});

Deno.test("a missing CLI is no-go with the probe detail named", () => {
  const facts: ProviderHostFacts = {
    ...goodFacts("claude"),
    cliVersion: null,
    cliDetail: "not on PATH",
  };
  const row = evaluateFeasibility(
    combo("manager", "claude", "opus"),
    contextWith([facts]),
  );
  assertEquals(row.verdict, "no-go");
  assertEquals(row.blockers, ["cli-not-installed (not on PATH)"]);
});

Deno.test("a metered variable reaching the child is no-go with its name", () => {
  const facts: ProviderHostFacts = {
    ...goodFacts("claude"),
    meteredVarsInChild: ["OPENAI_API_KEY"],
  };
  const row = evaluateFeasibility(
    combo("manager", "claude", "opus"),
    contextWith([facts]),
  );
  assertEquals(row.verdict, "no-go");
  assertEquals(row.blockers, [
    "metered-credential-reaches-child (OPENAI_API_KEY)",
  ]);
});

Deno.test("an invisible quota is a caveat only and the verdict stays go", () => {
  const facts: ProviderHostFacts = {
    ...goodFacts("claude"),
    quotaVisible: false,
    quotaDetail: "no free quota probe for this provider",
  };
  const row = evaluateFeasibility(
    combo("manager", "claude", "opus"),
    contextWith([facts]),
  );
  assertEquals(row.verdict, "go");
  assertEquals(row.blockers, []);
  assert(
    row.caveats.includes(
      "quota-unknown (no free quota probe for this provider)",
    ),
  );
});

Deno.test("missing host facts are no-go with host-not-probed", () => {
  const row = evaluateFeasibility(
    combo("manager", "claude", "opus"),
    contextWith([]),
  );
  assertEquals(row.verdict, "no-go");
  assertEquals(row.blockers, ["host-not-probed"]);
});

Deno.test("an unregistered provider is no-go and stops at once", () => {
  const row = evaluateFeasibility(
    combo("manager", "nope", "x"),
    contextWith([]),
  );
  assertEquals(row.verdict, "no-go");
  assertEquals(row.blockers, ["provider-not-registered"]);
  assertEquals(row.caveats, []);
});

Deno.test("an unregistered manager provider is no-go and stops at once", () => {
  const row = evaluateFeasibility(
    combo("executor", "claude", "sonnet", "nope"),
    contextWith([goodFacts("claude")]),
  );
  assertEquals(row.verdict, "no-go");
  assertEquals(row.blockers, ["manager-provider-not-registered"]);
  assertEquals(row.caveats, []);
});

Deno.test("a provider carrying agents and a settings hook has no role blockers", () => {
  // Positive control for the role checks: the seam reports a provider that
  // carries both, so only the evaluator's own guards can produce a blocker.
  const capable = () => ({
    carriesSubAgents: true,
    carriesSettingsHook: true,
    bypassesCliSandbox: false,
  });
  const context = contextWith(
    [goodFacts("codex")],
    [modelKey("codex", "gpt-5")],
    capable,
  );
  const manager = evaluateFeasibility(
    combo("manager", "codex", "gpt-5"),
    context,
  );
  const executor = evaluateFeasibility(
    combo("executor", "codex", "gpt-5"),
    context,
  );
  assertEquals(manager.verdict, "go");
  assertEquals(manager.blockers, []);
  assertEquals(executor.verdict, "go");
  assertEquals(executor.blockers, []);
});

Deno.test("fleetBaselineModels holds the Claude baseline and no Codex model", () => {
  const baseline = fleetBaselineModels();
  assert(baseline.has("claude:opus"));
  assert(baseline.has("claude:sonnet"));
  assert(baseline.has("claude:haiku"));
  assertEquals(baseline.has("codex:gpt-5"), false);
});

Deno.test("DEFAULT_FEASIBILITY_MODELS names the Codex consumer labels", () => {
  const keys = DEFAULT_FEASIBILITY_MODELS.map((entry) =>
    modelKey(entry.provider, entry.model)
  );
  assert(keys.includes("codex:gpt-6-astra"));
  assert(keys.includes("codex:gpt-6.1-sol"));
});

Deno.test("buildFeasibilityCombinations yields 40 rows with the expected role counts", () => {
  const combinations = buildFeasibilityCombinations(DEFAULT_FEASIBILITY_MODELS);
  assertEquals(combinations.length, 40);
  const count = (role: string) =>
    combinations.filter((entry) => entry.role === role).length;
  assertEquals(count("manager"), 8);
  assertEquals(count("executor"), 16);
  assertEquals(count("reviewer"), 16);
});

Deno.test("formatFeasibilityReport writes the header counts and one line per row", () => {
  const rows: FeasibilityRow[] = [
    {
      role: "manager",
      provider: "claude",
      model: "opus",
      managerProvider: "claude",
      verdict: "go",
      blockers: [],
      caveats: ["quota-unknown (x)"],
    },
    {
      role: "executor",
      provider: "codex",
      model: "gpt-6.1-sol",
      managerProvider: "claude",
      verdict: "no-go",
      blockers: ["a", "b"],
      caveats: [],
    },
    {
      role: "reviewer",
      provider: "codex",
      model: "gpt-6-astra",
      managerProvider: "codex",
      verdict: "unavailable",
      blockers: ["model-not-validated-on-host"],
      caveats: [],
    },
  ];
  const report = formatFeasibilityReport(rows);
  const lines = report.split("\n");
  assertEquals(
    lines[0],
    "[feasibility] rows=3 go=1 no-go=1 unavailable=1",
  );
  assertEquals(
    lines[1],
    "[feasibility] go role=manager manager=claude provider=claude model=opus blockers=none caveats=quota-unknown (x)",
  );
  assertStringIncludes(lines[2]!, "blockers=a; b caveats=none");
  assertEquals(lines.length, 4);
});

Deno.test("a reviewer on codex under a claude manager is no-go on the cross-provider guard only", () => {
  const row = evaluateFeasibility(
    combo("reviewer", "codex", "gpt-6.1-sol", "claude"),
    contextWith(
      [goodFacts("claude"), goodFacts("codex")],
      [modelKey("codex", "gpt-6.1-sol")],
    ),
  );
  assertEquals(row.verdict, "no-go");
  assertEquals(row.blockers, [
    "cross-provider-dispatch-not-implemented (sub-agents run inside the claude manager's CLI process)",
  ]);
  assert(!row.blockers.includes("no-sub-agent-definitions"));
});

Deno.test("a reviewer with an unregistered manager provider is no-go and stops at once", () => {
  const row = evaluateFeasibility(
    combo("reviewer", "claude", "sonnet", "nope"),
    contextWith([goodFacts("claude")]),
  );
  assertEquals(row.verdict, "no-go");
  assertEquals(row.blockers, ["manager-provider-not-registered"]);
  assertEquals(row.caveats, []);
});

Deno.test("a validated model with host and role blockers is no-go, not unavailable", () => {
  // Only the claude host is probed, so codex's host blocker and the
  // cross-provider blocker both apply; the model is validated, so the verdict
  // is no-go rather than unavailable.
  const row = evaluateFeasibility(
    combo("executor", "codex", "gpt-6.1-sol", "claude"),
    contextWith([goodFacts("claude")], [modelKey("codex", "gpt-6.1-sol")]),
  );
  assertEquals(row.verdict, "no-go");
  assertEquals(row.blockers, [
    "host-not-probed",
    "cross-provider-dispatch-not-implemented (sub-agents run inside the claude manager's CLI process)",
  ]);
});
