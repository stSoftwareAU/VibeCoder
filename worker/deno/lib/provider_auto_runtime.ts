/**
 * Runtime wiring for quota-aware automatic provider selection (Issue #1926).
 *
 * The policy lives in `provider_auto_selection.ts`; this module supplies the
 * current status of each enabled provider and moves the process-wide default
 * provider between work items. Explicit per-invocation provider selections do
 * not use that default and therefore remain absolute.
 *
 * Automatic mode is opt-in through `agent_provider_mode: "auto"`. The existing
 * `agent_provider` remains the preferred/tie-break provider and the existing
 * `agent_providers` array remains the explicit set whose binaries and
 * credentials are installed. `VIBE_AGENT_PROVIDER` is a hard environment pin
 * and disables automatic switching for that process.
 *
 * Only providers whose billing mode can be proved to be a fixed subscription
 * are eligible. Claude is proved by `CLAUDE_CODE_OAUTH_TOKEN`; Codex is proved
 * by ChatGPT auth in its persistent `CODEX_HOME`. API keys and every provider
 * without a fixed-subscription adapter are excluded rather than guessed.
 *
 * Australian English spelling throughout (behaviour, authorised).
 */

import {
  activeAgentProvider,
  AGENT_PROVIDER_ENV,
  setConfiguredAgentProviderId,
} from "./agent_provider.ts";
import { resolveAgentStateDir } from "./agent_state_dir.ts";
import { subscriptionStatusFromClaudeBudget } from "./claude_pool_budget.ts";
import { probeClaudeTokenBudget } from "./claude_token_budget.ts";
import { CodexBudgetAdapter } from "./codex_budget.ts";
import { subscriptionStatusFromCodexSnapshot } from "./codex_quota.ts";
import type { EnvLookup } from "./env_lookup.ts";
import { invalidateHealthCache } from "./health_check_cache.ts";
import {
  automaticProviderOutage,
  clearAutomaticProviderOutage,
  setAutomaticProviderRoutingActive,
} from "./provider_auto_state.ts";
import {
  formatAutomaticProviderSelection,
  selectAutomaticProvider,
  type AutomaticProviderSelection,
} from "./provider_auto_selection.ts";
import {
  ProviderSubscriptionStatusCache,
  type ProviderSubscriptionStatus,
} from "./provider_quota.ts";
import type { RateLimitSignalData } from "./rate_limit_signal.ts";

/** Dedicated selection-strategy key. Existing provider ids stay real ids. */
export const AGENT_PROVIDER_MODE_CONFIG_KEY = "agent_provider_mode";

/** Automatic routing is the only non-default strategy currently supported. */
export type AgentProviderMode = "pinned" | "auto";

/** Result of resolving the operator's provider mode and preference order. */
export interface AutomaticProviderConfig {
  readonly mode: AgentProviderMode;
  readonly preference: readonly string[];
  readonly reason: string;
}

/** Inputs accepted by the pure configuration resolver. */
export interface AutomaticProviderConfigInput {
  readonly configuredMode?: unknown;
  readonly configuredProvider?: unknown;
  readonly configuredProviders?: unknown;
  readonly environmentProvider?: string;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * Resolve automatic routing without reading files or process state.
 *
 * An environment provider is an explicit emergency/operator pin and wins over
 * automatic mode. When auto is selected, `agent_provider` is a preference
 * only because the operator explicitly changed the strategy from pinned to
 * auto; it is followed by `agent_providers` in their configured order.
 */
export function resolveAutomaticProviderConfig(
  input: AutomaticProviderConfigInput,
): AutomaticProviderConfig {
  const environmentProvider = input.environmentProvider?.trim();
  if (environmentProvider) {
    return {
      mode: "pinned",
      preference: [environmentProvider],
      reason: `${AGENT_PROVIDER_ENV}-explicit-pin`,
    };
  }

  if (
    input.configuredMode !== undefined &&
    input.configuredMode !== "pinned" && input.configuredMode !== "auto"
  ) {
    throw new Error(
      `${AGENT_PROVIDER_MODE_CONFIG_KEY} must be "pinned" or "auto", got ` +
        `${JSON.stringify(input.configuredMode)}`,
    );
  }
  const mode: AgentProviderMode = input.configuredMode === "auto"
    ? "auto"
    : "pinned";
  const provider = typeof input.configuredProvider === "string"
    ? input.configuredProvider.trim()
    : "";
  const enabled = stringArray(input.configuredProviders);
  const preference = [provider, ...enabled]
    .filter((value) => value.length > 0)
    .filter((value, index, all) => all.indexOf(value) === index);

  return {
    mode,
    preference,
    reason: mode === "auto" ? "configured-auto" : "default-pinned",
  };
}

/** File-backed config subset used only for the new routing strategy. */
interface RawProviderModeConfig {
  agent_provider_mode?: unknown;
  agent_provider?: unknown;
  agent_providers?: unknown;
}

async function readModeConfig(
  env: EnvLookup,
  readTextFile: (path: string) => Promise<string>,
): Promise<AutomaticProviderConfig> {
  const environmentProvider = env(AGENT_PROVIDER_ENV)?.trim();
  if (environmentProvider) {
    return resolveAutomaticProviderConfig({ environmentProvider });
  }
  const path = env("CONFIG_PATH")?.trim() || ".config.json";
  let raw: RawProviderModeConfig = {};
  try {
    const parsed = JSON.parse(await readTextFile(path));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      raw = parsed as RawProviderModeConfig;
    }
  } catch (error) {
    // The canonical config loader has already validated the file before the
    // main loop. If it becomes unreadable afterwards, fail closed here rather
    // than silently enabling a strategy that could select a billed provider.
    throw new Error(
      `cannot read ${AGENT_PROVIDER_MODE_CONFIG_KEY} from ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return resolveAutomaticProviderConfig({
    configuredMode: raw.agent_provider_mode,
    configuredProvider: raw.agent_provider,
    configuredProviders: raw.agent_providers,
  });
}

/** Status-resolver seam; tests never need real provider credentials/network. */
export type AutomaticProviderStatusResolver = (
  providerId: string,
  context: { workDir: string; env: EnvLookup; now: number },
) => ProviderSubscriptionStatus | Promise<ProviderSubscriptionStatus>;

const statusCache = new ProviderSubscriptionStatusCache();
const codexAdapters = new Map<string, CodexBudgetAdapter>();

function unavailableStatus(
  provider: string,
  now: number,
  billingMode: ProviderSubscriptionStatus["billingMode"],
  reason: string,
): ProviderSubscriptionStatus {
  return {
    provider,
    credentialLabel: "active",
    billingMode,
    availability: "unavailable",
    windows: [],
    observedAt: now,
    confidence: "authoritative",
    reason,
  };
}

async function claudeStatus(
  env: EnvLookup,
  now: number,
): Promise<ProviderSubscriptionStatus> {
  const oauth = env("CLAUDE_CODE_OAUTH_TOKEN")?.trim();
  if (oauth) {
    return await statusCache.get("claude", "active", async () => {
      const budget = await probeClaudeTokenBudget(oauth, { label: "active" });
      const status = subscriptionStatusFromClaudeBudget(budget, Date.now());
      // The budget endpoint itself authenticates the OAuth credential. A
      // 401/403 is stronger evidence than an unknown quota and must not become
      // the last-resort provider that gets hammered again.
      if (!budget.known && (budget.reason === "http-401" || budget.reason === "http-403")) {
        return {
          ...status,
          availability: "unavailable",
          confidence: "authoritative",
          reason: "authentication-rejected",
        };
      }
      if (status.availability === "available") clearAutomaticProviderOutage("claude");
      return status;
    });
  }
  if (env("ANTHROPIC_API_KEY")?.trim()) {
    return unavailableStatus("claude", now, "metered", "api-key-account");
  }
  if (env("ANTHROPIC_AUTH_TOKEN")?.trim()) {
    return unavailableStatus(
      "claude",
      now,
      "unknown",
      "non-subscription-bearer",
    );
  }
  return unavailableStatus(
    "claude",
    now,
    "unknown",
    "subscription-credential-missing",
  );
}

function codexHome(workDir: string, env: EnvLookup): string {
  const explicit = env("CODEX_HOME")?.trim();
  if (explicit) return explicit;
  const root = resolveAgentStateDir(workDir);
  return root ? `${root}/codex` : "";
}

async function codexStatus(
  workDir: string,
  env: EnvLookup,
  now: number,
): Promise<ProviderSubscriptionStatus> {
  const home = codexHome(workDir, env);
  if (!home) {
    return unavailableStatus(
      "codex",
      now,
      env("OPENAI_API_KEY")?.trim() || env("CODEX_API_KEY")?.trim()
        ? "metered"
        : "unknown",
      "codex-home-missing",
    );
  }
  return await statusCache.get("codex", "active", async () => {
    let adapter = codexAdapters.get(home);
    if (!adapter) {
      adapter = new CodexBudgetAdapter({ codexHome: home, env });
      codexAdapters.set(home, adapter);
    }
    const snapshot = await adapter.refresh();
    const status = subscriptionStatusFromCodexSnapshot("active", snapshot);
    if (snapshot.source === "auth-rejection") {
      return {
        ...status,
        availability: "unavailable",
        confidence: "authoritative",
        reason: "authentication-rejected",
      };
    }
    return status;
  });
}

/** Production provider → generic status adapter. */
export async function resolveAutomaticProviderStatus(
  providerId: string,
  context: { workDir: string; env: EnvLookup; now: number },
): Promise<ProviderSubscriptionStatus> {
  const outage = automaticProviderOutage(providerId);
  if (outage?.category === "authentication") {
    return unavailableStatus(
      providerId,
      context.now,
      "fixed-subscription",
      "observed-authentication-failure",
    );
  }
  if (outage?.category === "quota-exhausted") {
    return {
      provider: providerId,
      credentialLabel: "active",
      billingMode: "fixed-subscription",
      availability: "exhausted",
      windows: [],
      observedAt: outage.observedAt,
      confidence: "authoritative",
      reason: "observed-quota-exhaustion",
    };
  }

  switch (providerId) {
    case "claude":
      return await claudeStatus(context.env, context.now);
    case "codex":
      return await codexStatus(context.workDir, context.env, context.now);
    default:
      return unavailableStatus(
        providerId,
        context.now,
        "unknown",
        "fixed-subscription-status-not-supported",
      );
  }
}

function signalScopedStatus(
  status: ProviderSubscriptionStatus,
  signal: RateLimitSignalData | undefined,
  now: number,
): ProviderSubscriptionStatus {
  if (!signal || signal.kind !== "usage") return status;
  const provider = signal.provider?.trim() || "claude";
  if (provider !== status.provider) return status;
  const reset = signal.resetEpochMs ??
    (signal.timestamp + signal.waitSeconds) * 1000;
  return {
    ...status,
    billingMode: status.billingMode === "unknown"
      ? "fixed-subscription"
      : status.billingMode,
    availability: "exhausted",
    windows: Number.isFinite(reset) && reset > now
      ? [{ id: "observed-exhaustion", remainingPercent: 0, resetsAt: reset }]
      : [],
    observedAt: now,
    confidence: "authoritative",
    reason: "provider-scoped-usage-signal",
  };
}

/** Result returned to the host-level quota gate. */
export interface AutomaticProviderRuntimeResult {
  readonly automatic: boolean;
  readonly shouldPause: boolean;
  readonly selection: AutomaticProviderSelection | null;
}

let lastDecision = "";

/**
 * Refresh the auto-routing choice before the host claims more work.
 *
 * A concrete winner updates only the process-wide default provider. A caller
 * that supplied `agentProvider` explicitly continues to bypass that default.
 * When no fixed-price subscription is eligible, `shouldPause` is true so the
 * existing host quota gate leaves work pending rather than trying a metered
 * credential.
 */
export async function refreshAutomaticProviderRouting(options: {
  workDir: string;
  enabledProviderIds: readonly string[];
  signal?: RateLimitSignalData;
  env?: EnvLookup;
  now?: number;
  readTextFile?: (path: string) => Promise<string>;
  resolveStatus?: AutomaticProviderStatusResolver;
  log?: (message: string) => void;
}): Promise<AutomaticProviderRuntimeResult> {
  const env = options.env ?? ((name: string) => Deno.env.get(name));
  const now = options.now ?? Date.now();
  const readTextFile = options.readTextFile ?? ((path) => Deno.readTextFile(path));
  const log = options.log ?? ((message: string) => console.error(message));
  const config = await readModeConfig(env, readTextFile);

  if (config.mode !== "auto") {
    setAutomaticProviderRoutingActive(false);
    return { automatic: false, shouldPause: false, selection: null };
  }
  setAutomaticProviderRoutingActive(true);

  const enabled = options.enabledProviderIds
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  const preference = [
    ...config.preference.filter((id) => enabled.includes(id)),
    ...enabled,
  ].filter((id, index, all) => all.indexOf(id) === index);
  const resolver = options.resolveStatus ?? resolveAutomaticProviderStatus;
  const statuses = await Promise.all(enabled.map(async (providerId) => {
    try {
      const status = await resolver(providerId, {
        workDir: options.workDir,
        env,
        now,
      });
      return signalScopedStatus(status, options.signal, now);
    } catch {
      // A provider-status fault cannot make metered billing eligible. We know
      // nothing authoritative about billing in this branch, so fail closed.
      return unavailableStatus(
        providerId,
        now,
        "unknown",
        "status-resolution-failed",
      );
    }
  }));

  const selection = selectAutomaticProvider(statuses, { now, preference });
  const decision = formatAutomaticProviderSelection(selection);
  if (decision !== lastDecision) {
    log(decision);
    lastDecision = decision;
  }

  if (selection.winner === null) {
    return { automatic: true, shouldPause: true, selection };
  }

  const previous = activeAgentProvider().id;
  const selected = selection.winner.provider;
  if (previous !== selected) {
    setConfiguredAgentProviderId(selected);
    // Production's historical health cache is named "claude" even though the
    // checker is provider-aware. A switch must invalidate it or a warm Claude
    // result could be reused for Codex (and vice versa).
    const invalidated = invalidateHealthCache(options.workDir, "claude");
    if (!invalidated.ok) {
      log(
        `[quota] automatic provider switched ${previous}->${selected}; ` +
          `health-cache invalidation failed: ${invalidated.error.message}`,
      );
    } else {
      log(`[quota] automatic provider switched ${previous}->${selected}`);
    }
  }
  return { automatic: true, shouldPause: false, selection };
}
