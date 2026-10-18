/**
 * Fixed trusted broker entrypoint (#3698, #3699).
 *
 * Host-only /run/broker-config/session.json supplies selected upstream values.
 * Only an opaque capability is written into the shared socket directory. No
 * worker command, credential path, grant or renewal request is accepted.
 * Normal worker startup cannot select this unfinished integration mode.
 */
import { createCredentialBrokerLease } from "./lib/credential_broker_lease.ts";
import { CREDENTIAL_BROKER_UPSTREAMS } from "./lib/credential_broker_policy.ts";
import type { CredentialBrokerOptions } from "./lib/credential_broker.ts";

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

const metadataPath = "/run/broker/session.json";
const socketPath = "/run/broker/broker.sock";

async function serve(): Promise<void> {
  const config = parseBrokerSessionConfig(
    await Deno.readTextFile("/run/broker-config/session.json"),
  );
  const lease = createCredentialBrokerLease(config);
  let server: Deno.HttpServer<Deno.UnixAddr> | undefined;
  let listeningForSignals = false;
  const stop = () => lease.close();
  try {
    // The volume is fresh and private to this host-owned session. Never
    // unlink a pre-existing socket or overwrite another session's metadata.
    server = Deno.serve({ path: socketPath, onListen() {} }, lease.handle);
    await Deno.chmod(socketPath, 0o600);
    await Deno.writeTextFile(
      metadataPath,
      JSON.stringify({ version: 1, capability: lease.capability }),
      { createNew: true, mode: 0o600 },
    );
    Deno.addSignalListener("SIGTERM", stop);
    Deno.addSignalListener("SIGINT", stop);
    listeningForSignals = true;
    await Promise.race([lease.closed, server.finished]);
  } finally {
    lease.close();
    if (listeningForSignals) {
      Deno.removeSignalListener("SIGTERM", stop);
      Deno.removeSignalListener("SIGINT", stop);
    }
    await server?.shutdown();
  }
}

async function probe(): Promise<boolean> {
  let metadata: { version?: unknown; capability?: unknown };
  try {
    metadata = JSON.parse(await Deno.readTextFile(metadataPath));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
  if (metadata.version !== 1 || typeof metadata.capability !== "string") {
    throw new Error("Invalid broker readiness metadata");
  }
  const client = Deno.createHttpClient({
    proxy: { transport: "unix", path: socketPath },
  });
  try {
    // A deliberately denied route proves that capability authentication and
    // the live lease both ran. No readiness call reaches an upstream service.
    const response = await fetch("http://broker.invalid/__readiness__", {
      headers: { authorization: `Bearer ${metadata.capability}` },
      client,
      signal: AbortSignal.timeout(2000),
    });
    const body = await response.text();
    return response.status === 403 && body === "Broker route denied\n";
  } finally {
    client.close();
  }
}

if (import.meta.main) {
  try {
    if (Deno.args.length !== 1) {
      throw new Error("Expected exactly one broker service role");
    }
    if (Deno.args[0] === "serve") await serve();
    else if (Deno.args[0] === "probe") Deno.exit(await probe() ? 0 : 1);
    else throw new Error("Unknown broker service role");
  } catch (error) {
    // Only a category is logged: JSON/parser/runtime errors can include data
    // from the private configuration and must never reach the worker console.
    console.error(
      `Broker service unavailable (${
        error instanceof Error ? error.name : "unknown failure"
      })`,
    );
    Deno.exit(2);
  }
}
