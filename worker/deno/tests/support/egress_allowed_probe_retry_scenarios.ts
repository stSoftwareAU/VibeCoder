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

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  classifyEgressProbes,
  type DirectTcpResult,
  probeProxyAllowed,
  probeProxyAllowedDetailed,
  runEgressProbes,
} from "../../lib/egress_selfcheck.ts";

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

// -----------------------------------------------------------------------------
// Issue #4493: the listener wait, the attempt summary and the probe detail.
// These open loopback sockets, so they run under `--allow-net=127.0.0.1`.
// -----------------------------------------------------------------------------

const refused = async (): Promise<DirectTcpResult> => "refused";

/** A port nothing listens on: bind port 0, read it, release it. */
function freePort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const { port } = listener.addr as Deno.NetAddr;
  listener.close();
  return port;
}

const CONNECTED = "HTTP/1.1 200 Connection Established\r\n\r\n";

/**
 * A stub proxy on loopback. It counts only connections that sent a CONNECT.
 * The listener wait dials and closes at once with no bytes, so that
 * connection is read as empty and ignored, and no write is attempted on it.
 */
function startProxyStub(options: {
  port?: number;
  answer: (request: string) => string;
}) {
  const listener = Deno.listen({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
  });
  let connects = 0;
  const serving = (async () => {
    for await (const conn of listener) {
      try {
        const buf = new Uint8Array(2048);
        const n = await conn.read(buf);
        if (n === null) continue;
        const request = new TextDecoder().decode(buf.subarray(0, n));
        if (!request.startsWith("CONNECT ")) continue;
        connects++;
        await conn.write(new TextEncoder().encode(options.answer(request)));
      } catch {
        // A probe that left early: nothing to answer.
      } finally {
        conn.close();
      }
    }
  })().catch(() => {});
  const { port } = listener.addr as Deno.NetAddr;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    connects: () => connects,
    async close() {
      listener.close();
      await serving;
    },
  };
}

/** How late the proxy binds in the late-listener tests (Issue #4493). */
const PROXY_BINDS_LATE_MS = 2000;

/**
 * A fake clock for the listener wait: each injected sleep advances it by its
 * `ms`, and `bind` runs once, as soon as the clock reaches `bindAtMs`. The
 * listener budget is therefore measured in fake time, so a budget shorter than
 * `bindAtMs` gives up before the proxy binds.
 */
function lateBindingClock(bindAtMs: number, bind: () => void) {
  let clock = 0;
  let bound = false;
  return {
    now: () => clock,
    sleep: (ms: number): Promise<void> => {
      clock += ms;
      if (!bound && clock >= bindAtMs) {
        bound = true;
        bind();
      }
      return Promise.resolve();
    },
    elapsed: () => clock,
  };
}

Deno.test("an allowlisted CONNECT waits for a listener 2 s late and spends no attempts (Issue #4493)", async () => {
  const port = freePort();
  let stub: ReturnType<typeof startProxyStub> | undefined;
  const log: string[] = [];
  const time = lateBindingClock(PROXY_BINDS_LATE_MS, () => {
    stub = startProxyStub({ port, answer: () => CONNECTED });
  });
  try {
    // `listenTimeoutMs` is left at its default: the production budget.
    const outcome = await probeProxyAllowedDetailed(
      `http://127.0.0.1:${port}`,
      "api.github.com",
      {
        timeoutMs: 1000,
        delayMs: 0,
        log: (line) => log.push(line),
        now: time.now,
        sleep: time.sleep,
      },
    );
    assertEquals(outcome.result, "succeeded");
    assertEquals(outcome.observed, "connected");
    assert(
      time.elapsed() >= PROXY_BINDS_LATE_MS,
      `the proxy was not waited for: ${time.elapsed()}ms elapsed`,
    );
    assertEquals(log.filter((line) => line.includes("attempt")).length, 0);
    assertEquals(stub?.connects(), 1);
  } finally {
    await stub?.close();
  }
});

Deno.test("an allowlisted CONNECT with no listener ever is failed and spends no attempts (Issue #4493)", async () => {
  const port = freePort();
  let clock = 0;
  const log: string[] = [];
  const outcome = await probeProxyAllowedDetailed(
    `http://127.0.0.1:${port}`,
    "api.github.com",
    {
      listenTimeoutMs: 1000,
      delayMs: 0,
      log: (line) => log.push(line),
      now: () => clock,
      sleep: (ms) => {
        clock += ms;
        return Promise.resolve();
      },
    },
  );
  assertEquals(outcome.result, "failed");
  assert(
    outcome.observed.startsWith("no listener after 1000ms"),
    outcome.observed,
  );
  assertStringIncludes(
    log.join("\n"),
    "is not accepting connections after 1000ms",
  );
  assertEquals(log.some((line) => line.includes("attempt")), false);
});

Deno.test("an allowlisted CONNECT answered 502 every time fails and counts what it saw (Issue #4493)", async () => {
  const stub = startProxyStub({
    answer: () => "HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n",
  });
  try {
    const outcome = await probeProxyAllowedDetailed(
      stub.url,
      "api.github.com",
      { timeoutMs: 1000, attempts: 3, delayMs: 0, log: () => {} },
    );
    assertEquals(outcome.result, "failed");
    assertEquals(outcome.observed, "HTTP/1.1 502 Bad Gateway ×3");
    assertEquals(stub.connects(), 3);
  } finally {
    await stub.close();
  }
});

Deno.test("an allowlisted CONNECT refused three times says so (Issue #4493)", async () => {
  const port = freePort();
  const outcome = await probeProxyAllowedDetailed(
    `http://127.0.0.1:${port}`,
    "api.github.com",
    {
      timeoutMs: 1000,
      attempts: 3,
      delayMs: 0,
      waitForListener: false,
      log: () => {},
    },
  );
  assertEquals(outcome.result, "failed");
  assertEquals(outcome.observed, "refused ×3");
});

Deno.test("runEgressProbes with a live proxy fills the four-probe enforced set (Issue #4493)", async () => {
  const stub = startProxyStub({
    answer: (request) =>
      request.startsWith("CONNECT example.com:")
        ? "HTTP/1.1 403 Forbidden\r\nContent-Length: 40\r\n\r\n[EGRESS_DENIED] host=example.com reason=not-allowlisted\n"
        : CONNECTED,
  });
  try {
    const result = await runEgressProbes(
      (name) => (name === "HTTPS_PROXY" ? stub.url : undefined),
      1000,
      { directTcp: refused },
    );
    assertEquals(classifyEgressProbes(result), "enforced");
    assertEquals(result.proxyDenied, "denied");
    assertEquals(result.proxyAllowed, "succeeded");
    assertEquals(result.observed, {
      proxyDenied: "denied",
      proxyAllowed: "connected",
    });
    assertEquals(result.diagnostics, undefined);
  } finally {
    await stub.close();
  }
});

Deno.test("runEgressProbes with a proxy that never listens fails the allowed probe without attempts (Issue #4493)", async () => {
  const port = freePort();
  let clock = 0;
  // The listener budget (1500) differs from the probe budget (1000), so the
  // message only reads 1500 when the listener wait uses `listenTimeoutMs`.
  const result = await runEgressProbes(
    (name) => (name === "HTTPS_PROXY" ? `http://127.0.0.1:${port}` : undefined),
    1000,
    {
      directTcp: refused,
      listenTimeoutMs: 1500,
      now: () => clock,
      sleep: (ms) => {
        clock += ms;
        return Promise.resolve();
      },
    },
  );
  assertEquals(result.proxyDenied, "not_checked");
  assertEquals(result.proxyAllowed, "failed");
  assert(
    result.observed?.proxyAllowed?.startsWith("no listener after 1500ms"),
    String(result.observed?.proxyAllowed),
  );
  assertEquals(result.diagnostics?.length, 1);
  assertStringIncludes(
    result.diagnostics?.[0] ?? "",
    "is not accepting connections after 1500ms",
  );
});

Deno.test("runEgressProbes with a proxy that starts listening 2 s late still passes (Issue #4493)", async () => {
  const port = freePort();
  let stub: ReturnType<typeof startProxyStub> | undefined;
  const time = lateBindingClock(PROXY_BINDS_LATE_MS, () => {
    stub = startProxyStub({
      port,
      answer: (request) =>
        request.startsWith("CONNECT example.com:")
          ? "HTTP/1.1 403 Forbidden\r\nContent-Length: 40\r\n\r\n[EGRESS_DENIED] host=example.com reason=not-allowlisted\n"
          : CONNECTED,
    });
  });
  try {
    // `listenTimeoutMs` is left at its default: the production budget. The
    // probe budget (1000) is shorter than the 2 s the proxy takes to bind.
    const result = await runEgressProbes(
      (name) => name === "HTTPS_PROXY" ? `http://127.0.0.1:${port}` : undefined,
      1000,
      { directTcp: refused, now: time.now, sleep: time.sleep },
    );
    assert(
      time.elapsed() >= PROXY_BINDS_LATE_MS,
      `the proxy was not waited for: ${time.elapsed()}ms elapsed`,
    );
    assertEquals(result.proxyAllowed, "succeeded");
    assertEquals(result.proxyDenied, "denied");
    assertEquals(classifyEgressProbes(result), "enforced");
    assertEquals(result.diagnostics, undefined);
  } finally {
    await stub?.close();
  }
});
