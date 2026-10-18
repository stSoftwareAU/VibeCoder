/** Trusted controller selection; never expose this API as an agent RPC. */
import { resolveAgentProvider } from "./agent_provider.ts";
import type { ClaudeCredentialPool } from "./claude_credential_pool.ts";
import { subscriptionStatusFromClaudeBudget } from "./claude_pool_budget.ts";
import type { ClaudeTokenBudget } from "./claude_token_budget.ts";
import {
  providerPoolCandidates,
  type ProviderTokenFile,
} from "./credential_preflight.ts";
import { classifyProviderBilling } from "./provider_billing.ts";
import type { ProviderSubscriptionStatus } from "./provider_quota.ts";

type Provider = "claude" | "gemini";
type Authentication = "subscription" | "api-key";
type PublicQuota = Readonly<
  Pick<ProviderSubscriptionStatus, "availability" | "confidence" | "windows">
>;

interface PublicSelection {
  readonly provider: Provider;
  readonly authentication: Authentication;
  readonly billingMode: "fixed-subscription" | "metered";
  readonly credentialLabel: string | null;
  readonly quota: PublicQuota;
}

interface SelectedCredential {
  readonly status: "selected";
  /** Private provisioning payload: send only to the trusted broker. */
  readonly trusted: {
    readonly credentials: Readonly<Partial<Record<Provider, string>>>;
    readonly claudeAuthentication?: "api-key" | "bearer";
  };
  /** Safe controller/worker status; never contains paths or credential values. */
  readonly public: PublicSelection;
}

function validLabel(label: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(label);
}

function publicQuota(
  quota: ClaudeTokenBudget | undefined,
  label: string,
): PublicQuota {
  if (quota && quota.label !== label) {
    throw new Error("Trusted quota belongs to another credential");
  }
  if (!quota?.known) {
    return Object.freeze({
      availability: "unknown",
      confidence: "unknown",
      windows: Object.freeze([]),
    });
  }
  if (
    quota.windows.length === 0 ||
    quota.windows.some((window) =>
      !["five_hour", "seven_day"].includes(window.window) ||
      !Number.isFinite(window.remainingFraction) ||
      window.remainingFraction < 0 ||
      window.remainingFraction > 1 || !Number.isSafeInteger(window.resetAt) ||
      window.resetAt < 0
    )
  ) throw new Error("Invalid trusted quota snapshot");
  // Reuse the canonical status calculation. The pool does not expose snapshot
  // observation times here, so no synthetic freshness timestamp is published.
  const status = subscriptionStatusFromClaudeBudget(quota, 0);
  return Object.freeze({
    availability: status.availability,
    confidence: status.confidence,
    windows: Object.freeze(status.windows.map((window) =>
      Object.freeze({
        id: window.id,
        remainingPercent: window.remainingPercent,
        resetsAt: window.resetsAt,
      })
    )),
  });
}

/**
 * Project one already-discovered host credential into a fixed broker lease.
 * Selection and mode are trusted controller inputs, never worker request fields.
 * No default mode, ambient environment, filesystem lookup or auth fallback.
 */
export function selectTrustedBrokerCredential(options: {
  provider: Provider;
  authentication: Authentication;
  credential: ProviderTokenFile;
  quota?: ClaudeTokenBudget;
}): SelectedCredential {
  const { provider, authentication, credential } = options;
  if (
    !["claude", "gemini"].includes(provider) ||
    !["subscription", "api-key"].includes(authentication) ||
    (provider === "gemini" && authentication !== "api-key")
  ) throw new Error("Unsupported trusted provider authentication");
  if (
    !validLabel(credential.label) || !credential.name || !credential.value ||
    !/^[\x21-\x7e]{1,65536}$/.test(credential.value) ||
    credential.entries.length !== 1 ||
    credential.entries[0]!.name !== credential.name ||
    credential.entries[0]!.value !== credential.value
  ) throw new Error("Invalid selected trusted provider credential");

  const billing = classifyProviderBilling(provider, {
    workDir: "",
    env: (name) => name === credential.name ? credential.value! : undefined,
  });
  const expected = authentication === "subscription"
    ? "fixed-subscription"
    : "metered";
  if (billing.billingMode !== expected) {
    throw new Error("Selected credential does not match trusted billing mode");
  }
  if (
    options.quota &&
    (provider !== "claude" || authentication !== "subscription")
  ) {
    throw new Error("Subscription quota cannot describe metered credentials");
  }
  return Object.freeze({
    status: "selected",
    trusted: Object.freeze({
      credentials: Object.freeze({ [provider]: credential.value }),
      ...(provider === "claude"
        ? {
          claudeAuthentication: authentication === "subscription"
            ? "bearer" as const
            : "api-key" as const,
        }
        : {}),
    }),
    public: Object.freeze({
      provider,
      authentication,
      billingMode: expected,
      credentialLabel: credential.label,
      quota: publicQuota(options.quota, credential.label),
    }),
  });
}

/**
 * Preserve existing startup ranking and exhausted-token rotation in host code.
 * A selected credential is a lease snapshot, not permission to bypass quota
 * gates: unknown quota remains unknown, even when startup chooses a credential.
 */
export async function selectTrustedClaudePoolLease(options: {
  pool: ClaudeCredentialPool;
  candidates: readonly ProviderTokenFile[];
  selection: { kind: "startup" } | { kind: "rotation"; excludeLabel: string };
}): Promise<
  SelectedCredential | {
    readonly status: "unavailable";
    readonly public: PublicSelection;
  }
> {
  const { pool } = options;
  const selection = { ...options.selection };
  if (
    !["startup", "rotation"].includes(selection.kind) ||
    (selection.kind === "rotation" && !validLabel(selection.excludeLabel))
  ) throw new Error("Invalid trusted pool selection");
  // Snapshot caller-owned records before awaiting quota probes or pool ranking.
  const candidates = providerPoolCandidates(options.candidates).map((
    token,
  ) => ({
    ...token,
    entries: token.entries.map((entry) => ({ ...entry })),
  }));
  for (const credential of candidates) {
    selectTrustedBrokerCredential({
      provider: "claude",
      authentication: "subscription",
      credential,
    });
  }
  let selected: ProviderTokenFile | null;
  let budgets: readonly ClaudeTokenBudget[] | null;
  try {
    selected = candidates.length === 0
      ? null
      : selection.kind === "startup"
      ? await pool.selectToken(candidates, resolveAgentProvider("claude"))
      : await pool.selectAvailable({ exclude: selection.excludeLabel });
    budgets = selected ? await pool.readPoolBudgets() : null;
  } catch {
    throw new Error("Trusted Claude pool selection failed");
  }
  if (!selected) {
    return Object.freeze({
      status: "unavailable",
      public: Object.freeze({
        provider: "claude",
        authentication: "subscription",
        billingMode: "fixed-subscription",
        credentialLabel: null,
        quota: Object.freeze({
          availability: "unavailable",
          confidence: "unknown",
          windows: Object.freeze([]),
        }),
      }),
    });
  }
  const captured = candidates.find((token) =>
    token.label === selected.label && token.name === selected.name &&
    token.value === selected.value
  );
  if (
    !captured ||
    (selection.kind === "rotation" && captured.label === selection.excludeLabel)
  ) {
    throw new Error("Trusted pool returned an unselected credential");
  }
  return selectTrustedBrokerCredential({
    provider: "claude",
    authentication: "subscription",
    credential: captured,
    quota: budgets?.find((budget) => budget.label === captured.label),
  });
}
