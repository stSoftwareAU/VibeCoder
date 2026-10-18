/** Bounded, closed host session schema for trusted broker provisioning. */
import { CREDENTIAL_BROKER_UPSTREAMS } from "./credential_broker_policy.ts";
import type { CredentialBrokerOptions } from "./credential_broker.ts";

export const MAX_BROKER_SESSION_BYTES = 65_536;

interface BrokerSessionConfig {
  credentials: CredentialBrokerOptions["credentials"];
  repositories: string[];
  lifetimeMs: number;
  claudeAuthentication?: "api-key" | "bearer";
}

/** Parse only the static host contract; no executable options cross it. */
export function parseBrokerSessionConfig(text: string): BrokerSessionConfig {
  const invalid = () =>
    new Error("Invalid private broker session configuration");
  if (new TextEncoder().encode(text).length > MAX_BROKER_SESSION_BYTES) {
    throw invalid();
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw invalid();
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw invalid();
  }
  const value = data as Record<string, unknown>;
  if (
    Object.keys(value).some((key) =>
      !["credentials", "repositories", "lifetimeMs", "claudeAuthentication"]
        .includes(key)
    )
  ) throw invalid();
  if (
    typeof value.credentials !== "object" || value.credentials === null ||
    Array.isArray(value.credentials)
  ) throw invalid();
  for (const [service, credential] of Object.entries(value.credentials)) {
    if (
      !Object.hasOwn(CREDENTIAL_BROKER_UPSTREAMS, service) ||
      typeof credential !== "string" || !/^[\x21-\x7e]+$/.test(credential)
    ) throw invalid();
  }
  if (
    !Array.isArray(value.repositories) ||
    value.repositories.some((repo) =>
      typeof repo !== "string" ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ||
      repo.split("/").some((part) => part === "." || part === "..")
    )
  ) throw invalid();
  if (
    typeof value.lifetimeMs !== "number" ||
    !Number.isSafeInteger(value.lifetimeMs) || value.lifetimeMs < 1 ||
    value.lifetimeMs > 86_400_000
  ) throw invalid();
  if (
    value.claudeAuthentication !== undefined &&
    value.claudeAuthentication !== "api-key" &&
    value.claudeAuthentication !== "bearer"
  ) throw invalid();
  return value as unknown as BrokerSessionConfig;
}
