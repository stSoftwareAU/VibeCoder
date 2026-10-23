/** Per-host and per-repository role settings (Issue #3643). */
import type { RoleSelection } from "./types.ts";
import {
  DEFAULT_CLAUDE_MODEL_ISSUE,
  DEFAULT_CLAUDE_MODEL_TOP_TIER,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_MODEL_CHEAP_TIER,
  DEFAULT_CODEX_MODEL_TOP_TIER,
} from "../config_defaults.ts";
import {
  HAIKU_ISSUE_EXECUTOR_EFFORT,
  HAIKU_ISSUE_EXECUTOR_MODEL,
} from "../issue_executor_agents.ts";
import type {
  ExternalOrchestrationRoleSettings,
  ExternalOrchestrationSettings,
  WorkerConfig,
} from "../../types.ts";

/** Providers the external orchestrator can dispatch to (Issue #3642). */
const EXTERNAL_ORCHESTRATION_PROVIDERS: readonly string[] = [
  "claude",
  "codex",
  "gemini",
  "deepseek",
];

/** Reasoning efforts accepted per role (Issue #3642). */
const EXTERNAL_ORCHESTRATION_EFFORTS: readonly string[] = [
  "low",
  "medium",
  "high",
];

/**
 * Validate `external_orchestration_settings` at load time (Issue #3642).
 *
 * An absent value yields `{}`, so the role defaults apply. Any unknown key,
 * wrong type or out-of-range bound throws with the offending key named, so a
 * typo fails loudly instead of silently changing which provider runs.
 */
export function parseOrchestrationSettings(
  raw: unknown,
): ExternalOrchestrationSettings {
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(
      `external_orchestration_settings must be an object, got ` +
        `${JSON.stringify(raw)}`,
    );
  }
  const aliases: Record<string, string> = {
    maxRetries: "max_retries",
    maxConcurrency: "max_concurrency",
    maxInvocations: "max_invocations",
    maxCostUsd: "max_cost_usd",
  };
  const input = Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).map((
      [key, value],
    ) => [aliases[key] ?? key, value]),
  );
  const allowedKeys = [
    "manager",
    "executor",
    "reviewer",
    "max_retries",
    "max_concurrency",
    "max_invocations",
    "max_cost_usd",
  ];
  for (const key of Object.keys(input)) {
    if (!allowedKeys.includes(key)) {
      throw new Error(
        `external_orchestration_settings.${key} is not a recognised key. ` +
          `Allowed keys: ${allowedKeys.join(", ")}.`,
      );
    }
  }

  const settings: ExternalOrchestrationSettings = {};
  for (const role of ["manager", "executor", "reviewer"] as const) {
    const value = input[role];
    if (value === undefined) continue;
    settings[role] = resolveExternalOrchestrationRole(role, value);
  }

  const maxRetries = input.max_retries;
  if (maxRetries !== undefined) {
    if (!Number.isInteger(maxRetries) || (maxRetries as number) < 0) {
      throw new Error(
        `external_orchestration_settings.max_retries must be a non-negative ` +
          `integer, got ${JSON.stringify(maxRetries)}`,
      );
    }
    settings.maxRetries = maxRetries as number;
  }
  const maxConcurrency = input.max_concurrency;
  if (maxConcurrency !== undefined) {
    if (!Number.isInteger(maxConcurrency) || (maxConcurrency as number) < 1) {
      throw new Error(
        `external_orchestration_settings.max_concurrency must be a positive ` +
          `integer, got ${JSON.stringify(maxConcurrency)}`,
      );
    }
    settings.maxConcurrency = maxConcurrency as number;
  }
  const maxInvocations = input.max_invocations;
  if (maxInvocations !== undefined) {
    if (!Number.isInteger(maxInvocations) || (maxInvocations as number) < 1) {
      throw new Error(
        `external_orchestration_settings.max_invocations must be a positive ` +
          `integer, got ${JSON.stringify(maxInvocations)}`,
      );
    }
    settings.maxInvocations = maxInvocations as number;
  }
  const maxCostUsd = input.max_cost_usd;
  if (maxCostUsd !== undefined) {
    if (
      typeof maxCostUsd !== "number" ||
      !Number.isFinite(maxCostUsd) ||
      maxCostUsd <= 0
    ) {
      throw new Error(
        `external_orchestration_settings.max_cost_usd must be a positive ` +
          `finite number, got ${JSON.stringify(maxCostUsd)}`,
      );
    }
    settings.maxCostUsd = maxCostUsd;
  }
  return settings;
}

/** Validate one `manager` or `executor` entry (Issue #3642). */
function resolveExternalOrchestrationRole(
  role: "manager" | "executor" | "reviewer",
  raw: unknown,
): ExternalOrchestrationRoleSettings {
  const prefix = `external_orchestration_settings.${role}`;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(
      `${prefix} must be an object with provider, model and effort keys, ` +
        `got ${JSON.stringify(raw)}`,
    );
  }
  const input = raw as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (
      !["provider", "model", "effort", "cli_adapter", "cliAdapter"].includes(
        key,
      )
    ) {
      throw new Error(
        `${prefix}.${key} is not a recognised key. Allowed keys: ` +
          `provider, model, effort.`,
      );
    }
  }
  const entry: ExternalOrchestrationRoleSettings = {};
  if (input.provider !== undefined) {
    if (
      typeof input.provider !== "string" ||
      !EXTERNAL_ORCHESTRATION_PROVIDERS.includes(input.provider)
    ) {
      throw new Error(
        `${prefix}.provider must be one of ` +
          `${EXTERNAL_ORCHESTRATION_PROVIDERS.join(", ")}, got ` +
          `${JSON.stringify(input.provider)}`,
      );
    }
    entry.provider = input.provider;
  }
  if (input.model !== undefined) {
    if (typeof input.model !== "string" || !/^[^\s]+$/.test(input.model)) {
      throw new Error(
        `${prefix}.model must be a non-empty model id without whitespace, ` +
          `got ${JSON.stringify(input.model)}`,
      );
    }
    entry.model = input.model;
  }
  if (input.effort !== undefined) {
    if (
      typeof input.effort !== "string" ||
      !EXTERNAL_ORCHESTRATION_EFFORTS.includes(input.effort)
    ) {
      throw new Error(
        `${prefix}.effort must be one of ` +
          `${EXTERNAL_ORCHESTRATION_EFFORTS.join(", ")}, got ` +
          `${JSON.stringify(input.effort)}`,
      );
    }
    entry.effort = input.effort;
  }
  const adapter = input.cli_adapter ?? input.cliAdapter;
  if (adapter !== undefined) {
    if (
      typeof adapter !== "string" ||
      !EXTERNAL_ORCHESTRATION_PROVIDERS.includes(adapter)
    ) {
      throw new Error(
        `${prefix}.cli_adapter must name a registered CLI adapter`,
      );
    }
    entry.cliAdapter = adapter;
  }
  return entry;
}

/** Resolve repository overrides without leaking another provider's model or effort. */
export function resolveOrchestrationSettings(
  host: ExternalOrchestrationSettings,
  rawRepo?: unknown,
): ExternalOrchestrationSettings {
  const repo = parseOrchestrationSettings(rawRepo);
  const result = { ...host, ...repo };
  for (const role of ["manager", "executor", "reviewer"] as const) {
    if (!repo[role]) continue;
    const base = host[role];
    const override = repo[role]!;
    result[role] = override.provider && override.provider !== base?.provider
      ? { ...override }
      : { ...base, ...override };
  }
  return result;
}

/** All named providers must be provisioned on this host, even before opt-in. */
export function validateRoleProviders(config: WorkerConfig): void {
  const entries = [
    config.externalOrchestrationSettings,
    ...Object.values(config.repoConfig ?? {}).map((repo) =>
      resolveOrchestrationSettings(
        config.externalOrchestrationSettings,
        repo.externalOrchestrationSettings,
      )
    ),
  ];
  for (const settings of entries) {
    for (const role of ["manager", "executor", "reviewer"] as const) {
      const selection = settings[role];
      if (!selection) continue;
      const provider = selection.provider ?? "claude";
      if (!config.enabledAgentProviders.includes(provider)) {
        throw new Error(
          `external orchestration ${role}: ${provider} is not enabled in agent_providers`,
        );
      }
      if (
        selection.cliAdapter !== undefined && selection.cliAdapter !== provider
      ) {
        throw new Error(
          `external orchestration ${role}: cli_adapter must match provider ${provider}`,
        );
      }
    }
  }
  const activeScopes = [
    ...(config.externalOrchestration
      ? [config.externalOrchestrationSettings]
      : []),
    ...Object.values(config.repoConfig ?? {}).filter((repo) =>
      repo.externalOrchestration ?? config.externalOrchestration
    ).map((repo) =>
      resolveOrchestrationSettings(
        config.externalOrchestrationSettings,
        repo.externalOrchestrationSettings,
      )
    ),
  ];
  for (const settings of activeScopes) {
    for (
      const [role, selection] of Object.entries(
        effectiveRoleSelections(settings),
      )
    ) {
      if (!config.enabledAgentProviders.includes(selection.provider)) {
        throw new Error(
          `external orchestration ${role}: default provider ${selection.provider} is not enabled in agent_providers`,
        );
      }
    }
  }
}

/** The three roles an orchestrated issue run dispatches. */
type OrchestrationRole = "manager" | "executor" | "reviewer";

/**
 * Each role's default model, per provider (owner decision 2026-10-22): Opus
 * does the code reviews, Sonnet manages, Haiku executes, and on Codex each
 * role takes the similar OpenAI tier — Astra reviews, 6.1 Sol manages, Luna
 * executes. A provider with no row here leaves the model to the CLI.
 */
const ROLE_DEFAULTS: Readonly<
  Record<string, Readonly<Record<OrchestrationRole, RoleSelection>>>
> = {
  claude: {
    manager: {
      provider: "claude",
      model: DEFAULT_CLAUDE_MODEL_ISSUE,
      effort: "high",
    },
    executor: {
      provider: "claude",
      model: HAIKU_ISSUE_EXECUTOR_MODEL,
      effort: HAIKU_ISSUE_EXECUTOR_EFFORT,
    },
    reviewer: {
      provider: "claude",
      model: DEFAULT_CLAUDE_MODEL_TOP_TIER,
      effort: "high",
    },
  },
  codex: {
    manager: { provider: "codex", model: DEFAULT_CODEX_MODEL, effort: "high" },
    executor: {
      provider: "codex",
      model: DEFAULT_CODEX_MODEL_CHEAP_TIER,
      effort: "high",
    },
    reviewer: {
      provider: "codex",
      model: DEFAULT_CODEX_MODEL_TOP_TIER,
      effort: "high",
    },
  },
};

/** The selections recorded and invoked for this issue, with provider-local inheritance. */
export function effectiveRoleSelections(
  settings: ExternalOrchestrationSettings,
): Record<OrchestrationRole, RoleSelection> {
  // A role keeps its own default on its own provider; moved to another
  // provider it takes that provider's default for the role rather than none.
  const select = (role: OrchestrationRole): RoleSelection => {
    const override = settings[role];
    const provider = (override?.provider ?? "claude") as RoleSelection[
      "provider"
    ];
    const base = ROLE_DEFAULTS[provider]?.[role] ?? { provider };
    return { ...base, ...override, provider };
  };
  return {
    manager: select("manager"),
    executor: select("executor"),
    reviewer: select("reviewer"),
  };
}
