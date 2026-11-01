/** Real proxy scenarios, run with only loopback network permission. */
import { startEgressProxy } from "../../lib/egress_proxy.ts";
import { probeProxyConnectDetailed } from "../../lib/egress_selfcheck.ts";

const external = await Deno.permissions.query({
  name: "net",
  host: "example.com:443",
});
if (external.state === "granted") {
  throw new Error("external network permission must not be granted");
}

async function runScenario() {
  if (Deno.args[0] === "denied") {
    const proxy = await startEgressProxy({
      port: 0,
      allowlist: ["api.github.com"],
      logDenied: () => {},
    });
    try {
      return await probeProxyConnectDetailed(
        `http://127.0.0.1:${proxy.addr.port}`,
        "example.com",
        5000,
      );
    } finally {
      await proxy.close();
    }
  }
  if (Deno.args[0] === "allowed") {
    // The proxy rejects private resolutions; the connect seam uses a local listener.
    const upstream = Deno.listen({ hostname: "127.0.0.1", port: 0 });
    const accepted = upstream.accept().then((conn) => conn.close());
    const proxy = await startEgressProxy({
      port: 0,
      allowlist: ["api.github.com"],
      logDenied: () => {},
      resolve: () => Promise.resolve(["93.184.216.34"]),
      connect: () =>
        Deno.connect({ hostname: "127.0.0.1", port: upstream.addr.port }),
    });
    try {
      return await probeProxyConnectDetailed(
        `http://127.0.0.1:${proxy.addr.port}`,
        "api.github.com",
        5000,
      );
    } finally {
      await proxy.close();
      upstream.close();
      await accepted;
    }
  }
  throw new Error(`unknown scenario: ${Deno.args[0]}`);
}

const outcome = await runScenario();
await Deno.stdout.write(
  new TextEncoder().encode(JSON.stringify(outcome) + "\n"),
);
Deno.exit(0);
