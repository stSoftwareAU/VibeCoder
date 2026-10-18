/** Trusted host selection for one broker lease; never an agent RPC. */
import {
  selectTrustedBrokerCredential,
  selectTrustedClaudePoolLease,
} from "./broker_provider_selection.ts";
import { createCodexSubscriptionPersistence } from "./codex_subscription_persistence.ts";
import type { ProviderTokenFile } from "./credential_preflight.ts";
import type {
  CodexSubscriptionPersist,
  CodexSubscriptionTransaction,
} from "./codex_subscription_transport.ts";

/** These choices come from trusted bootstrap/routing, never job argv or env. */
export type TrustedBrokerProviderSource =
  | (
    & { kind: "claude-pool" }
    & Parameters<typeof selectTrustedClaudePoolLease>[0]
  )
  | (
    & { kind: "credential" }
    & Parameters<typeof selectTrustedBrokerCredential>[0]
  )
  | { kind: "codex-api-key"; credential: ProviderTokenFile }
  | {
    kind: "codex-chatgpt";
    /** The explicitly selected host account directory, never a default home. */
    codexHome: string;
    accountId: string;
    credentialLabel: string;
  };

type PublicProjection = ReturnType<
  typeof selectTrustedBrokerCredential
>["public"];

interface PreparedProvider {
  readonly status: "selected";
  /** Private broker options, not serialisable controller-job settings. */
  readonly trusted: {
    readonly credentials: Readonly<
      Partial<Record<"claude" | "gemini" | "openai", string>>
    >;
    readonly claudeAuthentication?: "api-key" | "bearer";
    readonly codexSubscription?: {
      readonly authJson: string;
      readonly accountId: string;
      readonly persist: CodexSubscriptionPersist;
      readonly transaction: CodexSubscriptionTransaction;
    };
  };
  readonly public: PublicProjection | {
    readonly provider: "codex";
    readonly authentication: "api-key" | "chatgpt";
    readonly billingMode: "metered" | "fixed-subscription";
    readonly credentialLabel: string;
    readonly quota: PublicProjection["quota"];
  };
}

type UnavailableProvider = Extract<
  Awaited<ReturnType<typeof selectTrustedClaudePoolLease>>,
  { status: "unavailable" }
>;

/**
 * Prepare private broker material before registering the host's job lease.
 *
 * The controller keeps the existing Claude pool and primes its usage signals
 * before calling this seam. Rotation passes the held lease's label; it never
 * rewrites an earlier lease. The caller has already chosen Codex's account home
 * and billing mode. No default home, ambient environment or metered fallback is
 * consulted here. Repository scope and lifetime remain separate host policy.
 */
export async function prepareTrustedBrokerProvider(
  source: TrustedBrokerProviderSource,
  options: { signal: AbortSignal },
): Promise<PreparedProvider | UnavailableProvider> {
  const signal = options.signal;
  const checkCancelled = () => {
    if (signal.aborted) throw new Error("Trusted provider bootstrap cancelled");
  };
  const codexPublic = (
    credentialLabel: string,
    authentication: "api-key" | "chatgpt",
  ) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(credentialLabel)) {
      throw new Error("Invalid trusted credential label");
    }
    return Object.freeze({
      provider: "codex" as const,
      authentication,
      billingMode: authentication === "chatgpt"
        ? "fixed-subscription" as const
        : "metered" as const,
      credentialLabel,
      // The existing routing/budget adapter owns quota readings. A loaded
      // credential alone proves neither headroom nor the time of observation.
      quota: Object.freeze({
        availability: "unknown" as const,
        confidence: "unknown" as const,
        windows: Object.freeze([]),
      }),
    });
  };
  try {
    checkCancelled();
    switch (source.kind) {
      case "credential":
        return selectTrustedBrokerCredential(source);
      case "claude-pool": {
        const selected = await selectTrustedClaudePoolLease(source);
        checkCancelled();
        return selected;
      }
      case "codex-api-key": {
        const { credential } = source;
        if (
          !credential.name ||
          !["OPENAI_API_KEY", "CODEX_API_KEY"].includes(credential.name) ||
          !credential.value ||
          !/^[\x21-\x7e]{1,65536}$/.test(credential.value) ||
          credential.entries.length !== 1 ||
          credential.entries[0]!.name !== credential.name ||
          credential.entries[0]!.value !== credential.value
        ) throw new Error("Invalid selected Codex API credential");
        return Object.freeze({
          status: "selected",
          trusted: Object.freeze({
            credentials: Object.freeze({ openai: credential.value }),
          }),
          public: codexPublic(credential.label, "api-key"),
        });
      }
      case "codex-chatgpt": {
        // Capture caller-owned selection before the first asynchronous read.
        const { codexHome, accountId, credentialLabel } = source;
        const publicSelection = codexPublic(credentialLabel, "chatgpt");
        if (!codexHome || codexHome !== codexHome.trim()) {
          throw new Error("Missing selected Codex account home");
        }
        const store = createCodexSubscriptionPersistence({
          authFile: `${codexHome.replace(/\/+$/, "")}/auth.json`,
          accountId,
        });
        // The existing store verifies canonical private files and the exact
        // selected account while holding the same lock used by token refresh.
        const authJson = await store.transaction({
          signal,
          run: (current) => Promise.resolve(current),
        });
        checkCancelled();
        const persist: CodexSubscriptionPersist = (replacement) =>
          store.persist({
            ...replacement,
            signal: AbortSignal.any([signal, replacement.signal]),
          });
        const transaction: CodexSubscriptionTransaction = (request) =>
          store.transaction({
            ...request,
            signal: AbortSignal.any([signal, request.signal]),
          });
        return Object.freeze({
          status: "selected",
          trusted: Object.freeze({
            credentials: Object.freeze({}),
            codexSubscription: Object.freeze({
              authJson,
              accountId,
              persist,
              transaction,
            }),
          }),
          public: publicSelection,
        });
      }
      default:
        throw new Error("Unsupported trusted provider source");
    }
  } catch {
    checkCancelled();
    // Filesystem/pool errors can contain paths or private provider output.
    throw new Error("Trusted provider bootstrap failed");
  }
}
