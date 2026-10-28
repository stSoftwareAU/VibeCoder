/**
 * The allowlisted CONNECT probe survives one slow upstream dial.
 *
 * On the Apple runtime the proxy is a container started seconds before the
 * worker. Its first CONNECT to api.github.com has to resolve and dial the host
 * from a cold container, and one attempt that missed the 2 s budget failed
 * the egress self-check, so the whole hourly launch claimed nothing
 * (`proxyAllowlist=failed`). The allowed probe now retries before it
 * concludes, and still fails closed when the proxy never lets the host
 * through.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { probeProxyAllowed } from "../lib/egress_selfcheck.ts";

/**
 * A fake proxy that stays silent for the first `silentFor` connections, then
 * answers every CONNECT with `200`.
 */
function fakeProxy(silentFor: number) {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const held: Deno.Conn[] = [];
  let seen = 0;
  const serving = (async () => {
    for await (const conn of listener) {
      seen++;
      if (seen <= silentFor) {
        held.push(conn);
        continue;
      }
      await conn.read(new Uint8Array(2048));
      await conn.write(
        new TextEncoder().encode("HTTP/1.1 200 Connection established\r\n\r\n"),
      );
      conn.close();
    }
  })().catch(() => {});
  const { port } = listener.addr as Deno.NetAddr;
  return {
    url: `http://127.0.0.1:${port}`,
    connections: () => seen,
    async close() {
      listener.close();
      for (const conn of held) {
        try {
          conn.close();
        } catch {
          // Already closed by the probe's timeout.
        }
      }
      await serving;
    },
  };
}

Deno.test("an allowlisted CONNECT that times out once and then connects is enforced, not failed", async () => {
  const proxy = fakeProxy(1);
  const log: string[] = [];
  try {
    const result = await probeProxyAllowed(proxy.url, "api.github.com", {
      timeoutMs: 200,
      attempts: 3,
      delayMs: 0,
      log: (line) => log.push(line),
    });
    assertEquals(result, "succeeded");
    assertEquals(proxy.connections(), 2);
    // The slow attempt is said out loud.
    assertStringIncludes(log.join("\n"), "attempt 1 of 3");
  } finally {
    await proxy.close();
  }
});

Deno.test("an allowlisted CONNECT the proxy never answers still fails after every attempt", async () => {
  const proxy = fakeProxy(Number.POSITIVE_INFINITY);
  try {
    const result = await probeProxyAllowed(proxy.url, "api.github.com", {
      timeoutMs: 100,
      attempts: 3,
      delayMs: 0,
      log: () => {},
    });
    assertEquals(result, "failed");
    assertEquals(proxy.connections(), 3);
  } finally {
    await proxy.close();
  }
});
