/**
 * Fixed trusted broker entrypoint (#3698, #3699).
 *
 * The private /run/broker-config/session.json volume supplies selected values.
 * Only an opaque capability is written into the shared socket directory. No
 * worker command, credential path, grant or renewal request is accepted.
 * Normal worker startup cannot select this unfinished integration mode.
 */
import { createCredentialBrokerLease } from "./lib/credential_broker_lease.ts";
import { parseBrokerSessionConfig } from "./lib/broker_session_config.ts";
import { provisionBrokerSession } from "./lib/broker_session_provision.ts";

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
    if (Deno.args[0] === "stage") {
      await provisionBrokerSession(Deno.stdin.readable, "/run/broker-config");
    } else if (Deno.args[0] === "serve") await serve();
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
