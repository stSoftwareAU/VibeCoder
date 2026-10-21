/**
 * Tests for the CONNECT egress proxy (Issue #4046).
 *
 * Real sockets on 127.0.0.1. The proxy listens on port 0, the upstream is a
 * local echo server, and DNS and dialling are injected, so no test touches the
 * network. Every test closes its proxy, upstream and client sockets.
 */

import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  type EgressProxy,
  type EgressRoute,
  parseEgressAllowlist,
  sanitiseEgressHost,
  startEgressProxy,
} from "../lib/egress_proxy.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const HEAD_END = encoder.encode("\r\n\r\n");
const PUBLIC_ADDRESS = "93.184.216.34";
const DENIAL_PREFIX = "[EGRESS_DENIED] ";

/** Index of the first occurrence of `needle` in `haystack`, or -1. */
function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    let matched = true;
    for (let j = 0; j < needle.length && matched; j++) {
      matched = haystack[i + j] === needle[j];
    }
    if (matched) return i;
  }
  return -1;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function closeQuietly(conn: Deno.Conn): void {
  try {
    conn.close();
  } catch {
    // Already closed; closing twice is harmless here.
  }
}

/** The value of a header in a response head, or "" when absent. */
function headerValue(head: string, name: string): string {
  const prefix = `${name.toLowerCase()}:`;
  for (const line of head.split("\r\n")) {
    if (line.toLowerCase().startsWith(prefix)) {
      return line.slice(prefix.length).trim();
    }
  }
  return "";
}

/**
 * A client socket that reads in order and keeps any bytes read past what the
 * caller asked for, so a response head and the tunnelled bytes can be read
 * back to back.
 */
class Wire {
  readonly conn: Deno.Conn;
  #pending = new Uint8Array(0);

  constructor(conn: Deno.Conn) {
    this.conn = conn;
  }

  async write(data: Uint8Array | string): Promise<void> {
    const bytes = typeof data === "string" ? encoder.encode(data) : data;
    let offset = 0;
    while (offset < bytes.length) {
      offset += await this.conn.write(bytes.subarray(offset));
    }
  }

  /** Read one response head, returning its text without the blank line. */
  async readHead(): Promise<string> {
    for (;;) {
      const end = indexOfBytes(this.#pending, HEAD_END);
      if (end !== -1) {
        const head = decoder.decode(this.#pending.subarray(0, end));
        this.#pending = this.#pending.slice(end + HEAD_END.length);
        return head;
      }
      if (!await this.#fill()) {
        throw new Error("connection closed before the response head ended");
      }
    }
  }

  /** Read exactly `count` bytes, or fewer if the peer closes first. */
  async readExact(count: number): Promise<Uint8Array> {
    while (this.#pending.length < count) {
      if (!await this.#fill()) break;
    }
    const out = this.#pending.slice(0, count);
    this.#pending = this.#pending.slice(out.length);
    return out;
  }

  /** Read whatever arrives next; null once the peer has closed. */
  async readSome(): Promise<Uint8Array | null> {
    if (this.#pending.length > 0) {
      const out = this.#pending;
      this.#pending = new Uint8Array(0);
      return out;
    }
    return await this.#readChunk();
  }

  async #fill(): Promise<boolean> {
    const chunk = await this.#readChunk();
    if (chunk === null) return false;
    this.#pending = concatBytes(this.#pending, chunk);
    return true;
  }

  async #readChunk(): Promise<Uint8Array | null> {
    const buffer = new Uint8Array(4096);
    let count: number | null;
    try {
      count = await this.conn.read(buffer);
    } catch {
      return null;
    }
    return count === null ? null : buffer.slice(0, count);
  }
}

/** A refusal read off the wire: status line, head and body. */
interface Denial {
  readonly status: string;
  readonly head: string;
  readonly body: string;
}

async function readDenial(wire: Wire): Promise<Denial> {
  const head = await wire.readHead();
  const length = Number(headerValue(head, "Content-Length"));
  const body = decoder.decode(await wire.readExact(length));
  return { status: head.split("\r\n")[0] ?? "", head, body };
}

/** A local upstream that echoes every byte it receives. */
interface EchoServer {
  readonly port: number;
  close(): Promise<void>;
}

async function echo(conn: Deno.Conn): Promise<void> {
  const buffer = new Uint8Array(1024);
  try {
    for (;;) {
      const count = await conn.read(buffer);
      if (count === null) return;
      await conn.write(buffer.subarray(0, count));
    }
  } catch {
    // The peer or the test closed the socket; there is nothing to echo.
  } finally {
    closeQuietly(conn);
  }
}

function startEchoServer(): EchoServer {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const accepted: Deno.Conn[] = [];
  const handlers: Promise<void>[] = [];
  const acceptLoop = (async () => {
    try {
      for await (const conn of listener) {
        accepted.push(conn);
        handlers.push(echo(conn));
      }
    } catch {
      // The listener was closed by close(), which ends the loop.
    }
  })();
  return {
    port: (listener.addr as Deno.NetAddr).port,
    async close() {
      listener.close();
      await acceptLoop;
      for (const conn of accepted) closeQuietly(conn);
      await Promise.all(handlers);
    },
  };
}

interface HarnessOptions {
  allowlist: string[];
  /** Resolver answers per host; unlisted hosts resolve to a public address. */
  addresses?: Record<string, string[]>;
  routes?: ReadonlyMap<string, EgressRoute>;
  maxConnections?: number;
  idleTimeoutMs?: number;
  maxHeaderBytes?: number;
}

interface Harness {
  readonly proxy: EgressProxy;
  /** Every deny line the proxy logged, in order. */
  readonly lines: string[];
  /** Every host the resolver was asked about. */
  readonly resolved: string[];
  /** Every address the connector was asked to dial. */
  readonly dialled: string[];
  open(): Promise<Wire>;
  close(): Promise<void>;
}

async function startHarness(opts: HarnessOptions): Promise<Harness> {
  const echoServer = startEchoServer();
  const lines: string[] = [];
  const resolved: string[] = [];
  const dialled: string[] = [];
  const wires: Wire[] = [];
  const proxy = await startEgressProxy({
    hostname: "127.0.0.1",
    port: 0,
    allowlist: opts.allowlist,
    routes: opts.routes,
    maxConnections: opts.maxConnections,
    idleTimeoutMs: opts.idleTimeoutMs,
    maxHeaderBytes: opts.maxHeaderBytes,
    resolve: (host) => {
      resolved.push(host);
      return Promise.resolve(opts.addresses?.[host] ?? [PUBLIC_ADDRESS]);
    },
    connect: (address) => {
      dialled.push(address);
      return Deno.connect({ hostname: "127.0.0.1", port: echoServer.port });
    },
    logDenied: (line) => {
      lines.push(line);
    },
  });
  return {
    proxy,
    lines,
    resolved,
    dialled,
    async open() {
      const conn = await Deno.connect({
        hostname: "127.0.0.1",
        port: proxy.addr.port,
      });
      const wire = new Wire(conn);
      wires.push(wire);
      return wire;
    },
    async close() {
      for (const wire of wires) closeQuietly(wire.conn);
      await proxy.close();
      await echoServer.close();
    },
  };
}

Deno.test("egress proxy tunnels an allowlisted CONNECT byte-for-byte", async () => {
  const h = await startHarness({ allowlist: ["allowed.example"] });
  try {
    const wire = await h.open();
    await wire.write(
      "CONNECT allowed.example:443 HTTP/1.1\r\nHost: allowed.example:443\r\n\r\n",
    );
    assertEquals(await wire.readHead(), "HTTP/1.1 200 Connection Established");

    const payload = new Uint8Array([0, 1, 2, 13, 10, 255, 128, 65, 66]);
    await wire.write(payload);
    assertEquals(await wire.readExact(payload.length), payload);

    assertEquals(h.resolved, ["allowed.example"]);
    assertEquals(h.dialled, [PUBLIC_ADDRESS]);
    assertEquals(h.lines, []);
  } finally {
    await h.close();
  }
});

Deno.test("egress proxy refuses a non-allowlisted host with 403 and opens no upstream connection", async () => {
  const h = await startHarness({ allowlist: ["allowed.example"] });
  try {
    const wire = await h.open();
    await wire.write(
      "CONNECT evil.example:443 HTTP/1.1\r\nHost: evil.example:443\r\n\r\n",
    );
    const denial = await readDenial(wire);

    assertEquals(denial.status, "HTTP/1.1 403 Forbidden");
    assertStringIncludes(denial.head, "Content-Type: text/plain");
    assertStringIncludes(denial.head, "Connection: close");
    assertEquals(
      denial.body,
      "[EGRESS_DENIED] host=evil.example reason=not-allowlisted\n",
    );
    assertEquals(h.resolved, []);
    assertEquals(h.dialled, []);
    assertEquals(h.lines, [
      "[EGRESS_DENIED] host=evil.example port=443 reason=not-allowlisted",
    ]);
  } finally {
    await h.close();
  }
});

Deno.test("egress proxy refuses an IP-literal target", async () => {
  const h = await startHarness({ allowlist: ["allowed.example"] });
  try {
    for (const target of ["93.184.216.34:443", "[2001:db8::1]:443"]) {
      const wire = await h.open();
      await wire.write(`CONNECT ${target} HTTP/1.1\r\n\r\n`);
      const denial = await readDenial(wire);
      assertEquals(denial.status, "HTTP/1.1 403 Forbidden");
      assertStringIncludes(denial.body, "reason=ip-literal");
    }
    assertEquals(h.resolved, []);
    assertEquals(h.dialled, []);
    assertEquals(h.lines.length, 2);
  } finally {
    await h.close();
  }
});

Deno.test("egress proxy refuses allowlisted names resolving to private addresses", async () => {
  const h = await startHarness({
    allowlist: ["mixed.example", "loopback.example"],
    addresses: {
      "mixed.example": [PUBLIC_ADDRESS, "10.0.0.5"],
      "loopback.example": ["127.0.0.1"],
    },
  });
  try {
    for (const host of ["mixed.example", "loopback.example"]) {
      const wire = await h.open();
      await wire.write(`CONNECT ${host}:443 HTTP/1.1\r\n\r\n`);
      const denial = await readDenial(wire);
      assertEquals(denial.status, "HTTP/1.1 403 Forbidden");
      assertStringIncludes(denial.body, "reason=private-address");
    }
    assertEquals(h.dialled, []);
    assertEquals(h.lines.length, 2);
  } finally {
    await h.close();
  }
});

Deno.test("egress proxy refuses a non-CONNECT request", async () => {
  const h = await startHarness({ allowlist: ["allowed.example"] });
  try {
    const wire = await h.open();
    await wire.write(
      "GET http://allowed.example/ HTTP/1.1\r\nHost: allowed.example\r\n\r\n",
    );
    const denial = await readDenial(wire);
    assertEquals(denial.status, "HTTP/1.1 403 Forbidden");
    assertStringIncludes(denial.body, "reason=method");
    assertEquals(h.dialled, []);
    assertEquals(h.lines, [
      "[EGRESS_DENIED] host=allowed.example port=0 reason=method",
    ]);
  } finally {
    await h.close();
  }
});

Deno.test("egress proxy writes exactly one denial line per refusal", async () => {
  const h = await startHarness({ allowlist: ["allowed.example"] });
  try {
    const refusals = [
      "CONNECT evil.example:443 HTTP/1.1\r\n\r\n",
      "CONNECT 10.1.2.3:443 HTTP/1.1\r\n\r\n",
      "GET http://allowed.example/ HTTP/1.1\r\n\r\n",
    ];
    for (const request of refusals) {
      const wire = await h.open();
      await wire.write(request);
      await readDenial(wire);
    }
    assertEquals(h.lines.length, refusals.length);

    // An allowed tunnel is not a refusal and must add no line.
    const tunnel = await h.open();
    await tunnel.write("CONNECT allowed.example:443 HTTP/1.1\r\n\r\n");
    assertEquals(
      await tunnel.readHead(),
      "HTTP/1.1 200 Connection Established",
    );
    assertEquals(h.lines.length, refusals.length);

    for (const line of h.lines) {
      assert(line.startsWith(DENIAL_PREFIX), `unexpected line: ${line}`);
    }
  } finally {
    await h.close();
  }
});

Deno.test("egress proxy refuses and sanitises a hostname carrying control characters", async () => {
  const h = await startHarness({ allowlist: ["evil.example"] });
  try {
    const wire = await h.open();
    await wire.write("CONNECT evil\u0001\u0007.example:443 HTTP/1.1\r\n\r\n");
    const denial = await readDenial(wire);

    assertEquals(denial.status, "HTTP/1.1 403 Forbidden");
    assertEquals(
      denial.body,
      "[EGRESS_DENIED] host=evil.example reason=bad-request\n",
    );
    assertEquals(h.lines, [
      "[EGRESS_DENIED] host=evil.example port=443 reason=bad-request",
    ]);
    assert(!/\p{Cc}/u.test(h.lines[0] ?? ""), "log line kept a control char");
    assertEquals(h.dialled, []);
  } finally {
    await h.close();
  }
});

Deno.test("egress proxy cuts off an over-long request header", async () => {
  const h = await startHarness({
    allowlist: ["allowed.example"],
    maxHeaderBytes: 256,
  });
  try {
    const wire = await h.open();
    await wire.write(
      "CONNECT allowed.example:443 HTTP/1.1\r\nX-Pad: " +
        "a".repeat(400) +
        "\r\n\r\n",
    );
    const denial = await readDenial(wire);

    assertEquals(denial.status, "HTTP/1.1 403 Forbidden");
    assertEquals(
      denial.body,
      "[EGRESS_DENIED] host=- reason=header-too-large\n",
    );
    assertEquals(h.lines, [
      "[EGRESS_DENIED] host=- port=0 reason=header-too-large",
    ]);
    assertEquals(h.dialled, []);
  } finally {
    await h.close();
  }
});

Deno.test("egress proxy cuts off an idle client", async () => {
  const h = await startHarness({
    allowlist: ["allowed.example"],
    idleTimeoutMs: 50,
  });
  try {
    // Send nothing. The proxy closes the socket, so the read ends with null.
    const wire = await h.open();
    assertEquals(await wire.readSome(), null);
    assertEquals(h.lines, [
      "[EGRESS_DENIED] host=- port=0 reason=idle-timeout",
    ]);
    assertEquals(h.dialled, []);
  } finally {
    await h.close();
  }
});

Deno.test("egress proxy refuses a non-443 port", async () => {
  const h = await startHarness({ allowlist: ["allowed.example"] });
  try {
    const wire = await h.open();
    await wire.write("CONNECT allowed.example:8443 HTTP/1.1\r\n\r\n");
    const denial = await readDenial(wire);
    assertEquals(denial.status, "HTTP/1.1 403 Forbidden");
    assertStringIncludes(denial.body, "reason=bad-port");
    assertEquals(h.resolved, []);
    assertEquals(h.dialled, []);
    assertEquals(h.lines, [
      "[EGRESS_DENIED] host=allowed.example port=8443 reason=bad-port",
    ]);
  } finally {
    await h.close();
  }
});

Deno.test("egress proxy refuses at the connection cap", async () => {
  const h = await startHarness({
    allowlist: ["allowed.example"],
    maxConnections: 1,
  });
  try {
    // The first socket takes the only slot and sends nothing.
    const holder = await h.open();
    const wire = await h.open();
    const denial = await readDenial(wire);
    assertEquals(denial.status, "HTTP/1.1 403 Forbidden");
    assertEquals(
      denial.body,
      "[EGRESS_DENIED] host=- reason=capacity\n",
    );
    assertEquals(h.lines, [
      "[EGRESS_DENIED] host=- port=0 reason=capacity",
    ]);
    assertEquals(h.dialled, []);
    closeQuietly(holder.conn);
  } finally {
    await h.close();
  }
});

Deno.test("egress proxy hands an allowlisted host with a route to the route, not upstream", async () => {
  const targets: Array<{ host: string; port: number }> = [];
  const route: EgressRoute = async (client, target) => {
    targets.push(target);
    await client.write(encoder.encode("ROUTED"));
  };
  const h = await startHarness({
    allowlist: ["routed.example"],
    routes: new Map([["routed.example", route]]),
  });
  try {
    const wire = await h.open();
    await wire.write("CONNECT routed.example:443 HTTP/1.1\r\n\r\n");
    assertEquals(await wire.readHead(), "HTTP/1.1 200 Connection Established");
    assertEquals(decoder.decode(await wire.readExact(6)), "ROUTED");

    assertEquals(targets, [{ host: "routed.example", port: 443 }]);
    assertEquals(h.resolved, []);
    assertEquals(h.dialled, []);
    assertEquals(h.lines, []);
  } finally {
    await h.close();
  }
});

Deno.test("parseEgressAllowlist splits a comma-separated string", () => {
  assertEquals(
    parseEgressAllowlist(" Api.Example , *.Cdn.example,, "),
    ["api.example", "*.cdn.example"],
  );
});

Deno.test("parseEgressAllowlist accepts an array", () => {
  assertEquals(
    parseEgressAllowlist(["api.example", "*.cdn.example"]),
    ["api.example", "*.cdn.example"],
  );
});

Deno.test("parseEgressAllowlist rejects an IP literal", () => {
  assertThrows(
    () => parseEgressAllowlist("api.example,10.0.0.1"),
    Error,
    "10.0.0.1",
  );
});

Deno.test("parseEgressAllowlist rejects an empty list", () => {
  assertThrows(() => parseEgressAllowlist(" , "), Error, "empty");
  assertThrows(() => parseEgressAllowlist([]), Error, "empty");
});

Deno.test("sanitiseEgressHost caps the host at 64 characters", () => {
  assertEquals(sanitiseEgressHost("a".repeat(100)), "a".repeat(64));
  assertEquals(sanitiseEgressHost("ok\u0000\r\n.example"), "ok.example");
});
