/**
 * The evaluator behind `provider-feasibility` (Issue #3647).
 *
 * For each provider × model × role of the manager–worker split it answers one
 * question: can this combination run on this host, and if not, which guard
 * says so? The answer is a verdict — `go`, `no-go`, or `unavailable` (the model
 * has never been live-verified on this host) — with every blocker collected,
 * not just the first one found.
 *
 * Fail-closed throughout: a missing probe, an unregistered provider, a metered
 * credential reaching the child, or a model nobody has validated all end in a
 * refusal rather than a guess. Every check reuses the module that owns it —
 * billing (`provider_billing.ts`), the CLI's own invocation (the provider's
 * `buildInvocation`), and pricing (`token_usage.ts`) — so nothing here restates
 * a rule that another module already enforces.
 *
 * No credential value is an input or an output of this module. Facts carry
 * variable NAMES and state labels only, and every blocker or caveat string is
 * built from those, so the report is safe to log.
 *
 * Australian English spelling throughout (behaviour, organisation, licence).
 */

import {
  type AgentInvocationRequest,
  agentProviderById,
  CLAUDE_PROVIDER_ID,
  CODEX_PROVIDER_ID,
} from "./agent_provider.ts";
import {
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CLAUDE_MODEL_ISSUE,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_MODEL_CHEAP_TIER,
  DEFAULT_CODEX_MODEL_TOP_TIER,
  PHASE_MODEL_DEFAULTS,
} from "./config_defaults.ts";
import {
  EXPLORER_MODEL,
  HAIKU_ISSUE_EXECUTOR_MODEL,
  ISSUE_EXECUTOR_MODEL,
  SPEC_REVIEWER_MODEL,
  STANDARDS_REVIEWER_MODEL,
} from "./issue_executor_agents.ts";
import {
  isFixedPriceSubscription,
  type ProviderBillingEvidence,
} from "./provider_billing.ts";
import { lookupModelPricing } from "./token_usage.ts";

/** The three roles a model can be asked to fill in the split. */
export type FeasibilityRole = "manager" | "executor" | "reviewer";

/** `go` runs; `no-go` is blocked by a guard; `unavailable` is unvalidated. */
export type FeasibilityVerdict = "go" | "no-go" | "unavailable";

/** A provider and model pair to evaluate. */
export interface FeasibilityModel {
  readonly provider: string;
  readonly model: string;
}

/**
 * The Codex CLI id for the consumer "Astra" label — the top Codex tier
 * (owner decision 2026-10-22), so one constant names it.
 *
 * Vendor's Codex models page (https://developers.openai.com/codex/models,
 * retrieved 2026-10-17) spells the consumer Astra / Sol labels as these CLI
 * ids.
 */
export const CODEX_ASTRA_MODEL = DEFAULT_CODEX_MODEL_TOP_TIER;

/** The Codex CLI id for the consumer "Sol" label — the base Codex tier. */
export const CODEX_SOL_MODEL = DEFAULT_CODEX_MODEL;

/**
 * The key a validated model is recorded under.
 *
 * @param provider - Provider id.
 * @param model - Model id.
 * @returns `provider:model`.
 */
export function modelKey(provider: string, model: string): string {
  return `${provider}:${model}`;
}

/**
 * The default candidate models, per provider, in a stable order.
 *
 * Claude's are the production tiers the fleet already routes to; Codex's are
 * the three tiers it maps them to (Astra, 6.1 Sol, Luna).
 */
const DEFAULT_CANDIDATES: ReadonlyMap<string, readonly string[]> = new Map([
  [
    CLAUDE_PROVIDER_ID,
    [
      DEFAULT_CLAUDE_MODEL,
      DEFAULT_CLAUDE_MODEL_ISSUE,
      HAIKU_ISSUE_EXECUTOR_MODEL,
    ],
  ],
  [
    CODEX_PROVIDER_ID,
    [
      DEFAULT_CODEX_MODEL_TOP_TIER,
      DEFAULT_CODEX_MODEL,
      DEFAULT_CODEX_MODEL_CHEAP_TIER,
    ],
  ],
]);

/** Deduplicate while keeping the first occurrence's position. */
export function uniqueInOrder<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/** The candidates the command evaluates when none are named. */
export const DEFAULT_FEASIBILITY_MODELS: readonly FeasibilityModel[] = [
  ...DEFAULT_CANDIDATES.entries(),
].flatMap(([provider, models]) =>
  uniqueInOrder(models).map((model) => ({ provider, model }))
);

/**
 * The Claude fleet's production baseline.
 *
 * Its default model, every phase default, and the sub-agent model constants.
 * These are the only models validated without an operator record; every other
 * provider's model must be live-verified on the host.
 *
 * @returns Model keys (see {@link modelKey}) for the Claude fleet baseline.
 */
export function fleetBaselineModels(): ReadonlySet<string> {
  const claudeModels = [
    DEFAULT_CLAUDE_MODEL,
    ...Object.values(PHASE_MODEL_DEFAULTS),
    ISSUE_EXECUTOR_MODEL,
    HAIKU_ISSUE_EXECUTOR_MODEL,
    SPEC_REVIEWER_MODEL,
    STANDARDS_REVIEWER_MODEL,
    EXPLORER_MODEL,
  ];
  return new Set(
    claudeModels.map((model) => modelKey(CLAUDE_PROVIDER_ID, model)),
  );
}

/** One row of the split: a role on a model, run by a manager's provider. */
export interface FeasibilityCombination {
  readonly role: FeasibilityRole;
  readonly provider: string;
  readonly model: string;
  /** Provider the manager runs on; equals `provider` on a manager row. */
  readonly managerProvider: string;
}

/** What one probe of the host found, for one provider. Never a credential value. */
export interface ProviderHostFacts {
  readonly provider: string;
  /** First line of `<binary> --version`, or null when the CLI did not run. */
  readonly cliVersion: string | null;
  /** Log-safe probe detail, e.g. "not on PATH" or "exit 2". */
  readonly cliDetail: string;
  readonly billing: ProviderBillingEvidence;
  /** NAMES of declared metered variables that reach the provider's child env. */
  readonly meteredVarsInChild: readonly string[];
  readonly quotaVisible: boolean;
  readonly quotaDetail: string;
}

/** What a provider's CLI invocation carries, as the provider itself builds it. */
export interface ProviderInvocationCapabilities {
  readonly carriesSubAgents: boolean;
  readonly carriesSettingsHook: boolean;
  readonly bypassesCliSandbox: boolean;
}

/** The Codex flag `lib/codex_executor.ts` STANDARD_FLAGS passes on every run. */
const CODEX_SANDBOX_BYPASS_FLAG = "--dangerously-bypass-approvals-and-sandbox";

/**
 * Ask a provider's own `buildInvocation` what its CLI carries.
 *
 * The descriptor is the owner of the argv, so this reads what the provider
 * really builds rather than a table of provider ids kept here.
 *
 * @param providerId - Provider id to probe.
 * @returns The capabilities, or undefined when no provider is registered.
 */
export function probeInvocationCapabilities(
  providerId: string,
): ProviderInvocationCapabilities | undefined {
  const descriptor = agentProviderById(providerId);
  if (!descriptor) return undefined;
  const request: AgentInvocationRequest = {
    prompt: "feasibility probe",
    model: "feasibility-probe",
    effort: "low",
    agents: {
      feasibility_probe: { description: "probe", prompt: "probe" },
    },
    // Probe with a valid empty hook set; Codex rejects malformed settings.
    settingsJson: JSON.stringify({ hooks: { PreToolUse: [] } }),
    env: () => undefined,
  };
  const args = descriptor.buildInvocation(request);
  return {
    carriesSubAgents: args.includes("--agents"),
    carriesSettingsHook: args.includes("--settings"),
    bypassesCliSandbox: args.includes(CODEX_SANDBOX_BYPASS_FLAG),
  };
}

/** A row of the report: a combination with its verdict and reasons. */
export interface FeasibilityRow extends FeasibilityCombination {
  readonly verdict: FeasibilityVerdict;
  readonly blockers: readonly string[];
  readonly caveats: readonly string[];
}

/** Everything {@link evaluateFeasibility} may consult. */
export interface FeasibilityContext {
  readonly facts: ReadonlyMap<string, ProviderHostFacts>;
  readonly validatedModels: ReadonlySet<string>;
  /** Seam for tests; defaults to probeInvocationCapabilities. */
  readonly capabilities?: (
    providerId: string,
  ) => ProviderInvocationCapabilities | undefined;
}

/**
 * Expand the models into the split's rows.
 *
 * One manager row per model; then, for each distinct provider (first-seen
 * order) acting as manager, one executor and one reviewer row per model.
 *
 * @param models - The provider/model pairs under evaluation.
 * @returns Every combination to evaluate.
 */
export function buildFeasibilityCombinations(
  models: readonly FeasibilityModel[],
): FeasibilityCombination[] {
  const combinations: FeasibilityCombination[] = models.map((entry) => ({
    role: "manager",
    provider: entry.provider,
    model: entry.model,
    managerProvider: entry.provider,
  }));
  const managers = uniqueInOrder(models.map((entry) => entry.provider));
  for (const managerProvider of managers) {
    for (const entry of models) {
      for (const role of ["executor", "reviewer"] as const) {
        combinations.push({
          role,
          provider: entry.provider,
          model: entry.model,
          managerProvider,
        });
      }
    }
  }
  return combinations;
}

/**
 * Evaluate one combination and collect every blocker and caveat that applies.
 *
 * @param combination - The row to evaluate.
 * @param context - The host facts, validated models, and optional seam.
 * @returns The row with its verdict and reasons.
 */
export function evaluateFeasibility(
  combination: FeasibilityCombination,
  context: FeasibilityContext,
): FeasibilityRow {
  const { role, provider, model, managerProvider } = combination;
  const capabilities = context.capabilities ?? probeInvocationCapabilities;
  const blockers: string[] = [];
  const caveats: string[] = [];
  const finish = (verdict: FeasibilityVerdict): FeasibilityRow => ({
    ...combination,
    verdict,
    blockers,
    caveats,
  });

  // 1. Registration. An unregistered provider cannot be probed at all.
  const caps = capabilities(provider);
  if (!caps) {
    blockers.push("provider-not-registered");
    return finish("no-go");
  }
  if (
    (role === "executor" || role === "reviewer") &&
    capabilities(managerProvider) === undefined
  ) {
    blockers.push("manager-provider-not-registered");
    return finish("no-go");
  }

  // 2. Host facts for the provider's own CLI.
  const facts = context.facts.get(provider);
  if (!facts) {
    blockers.push("host-not-probed");
  } else {
    if (facts.cliVersion === null) {
      blockers.push(`cli-not-runnable (${facts.cliDetail})`);
    }
    if (!isFixedPriceSubscription(facts.billing)) {
      blockers.push(
        `billing-${facts.billing.billingMode} (${facts.billing.reason})`,
      );
    }
    if (facts.meteredVarsInChild.length > 0) {
      blockers.push(
        `metered-credential-reaches-child (${
          facts.meteredVarsInChild.join(",")
        })`,
      );
    }
    if (!facts.quotaVisible) {
      caveats.push(`quota-unknown (${facts.quotaDetail})`);
    }
  }

  // 3. Role. A sub-agent runs inside its manager's CLI process, so a worker on
  //    another provider cannot be dispatched by this manager.
  if (
    (role === "executor" || role === "reviewer") &&
    managerProvider !== provider
  ) {
    blockers.push(
      `cross-provider-dispatch-not-implemented (sub-agents run inside the ${managerProvider} manager's CLI process)`,
    );
  } else {
    if (!caps.carriesSubAgents) blockers.push("no-sub-agent-definitions");
    if (!caps.carriesSettingsHook) blockers.push("no-advisor-edit-guard");
  }

  // 4. Sandbox. The container is the only boundary when the CLI's is bypassed.
  if (caps.bypassesCliSandbox) {
    caveats.push("cli-sandbox-bypassed (the container is the only boundary)");
  }

  // 5. Price. Without a list price the API-equivalent cost cannot be stated.
  if (lookupModelPricing(model) === null) {
    caveats.push("api-equivalent-price-missing");
  }

  // 6. Verdict. An unvalidated model is `unavailable` whatever else is true.
  if (!context.validatedModels.has(modelKey(provider, model))) {
    blockers.push("model-not-validated-on-host");
    return finish("unavailable");
  }
  return finish(blockers.length > 0 ? "no-go" : "go");
}

/**
 * Render rows as the command's report: a header, then one line per row.
 *
 * @param rows - The evaluated rows.
 * @returns Multi-line text carrying no credential value.
 */
export function formatFeasibilityReport(
  rows: readonly FeasibilityRow[],
): string {
  const count = (verdict: FeasibilityVerdict) =>
    rows.filter((row) => row.verdict === verdict).length;
  const lines = [
    `[feasibility] rows=${rows.length} go=${count("go")} no-go=${
      count("no-go")
    } unavailable=${count("unavailable")}`,
  ];
  for (const row of rows) {
    const blockers = row.blockers.length > 0 ? row.blockers.join("; ") : "none";
    const caveats = row.caveats.length > 0 ? row.caveats.join("; ") : "none";
    lines.push(
      `[feasibility] ${row.verdict} role=${row.role} manager=${row.managerProvider} provider=${row.provider} model=${row.model} blockers=${blockers} caveats=${caveats}`,
    );
  }
  return lines.join("\n");
}
