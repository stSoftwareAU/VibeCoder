/**
 * Socket scenarios for the CONNECT egress proxy (Issue #4046).
 *
 * `deno task test:unit` grants no `--allow-net`, so
 * worker/deno/tests/egress_proxy_test.ts runs this script in a child process
 * granted `--allow-net=127.0.0.1` only.
 * Each scenario binds real sockets on 127.0.0.1: the proxy listens on port 0,
 * the upstream is a local echo server, and DNS and dialling are injected.
 *
 * The child prints one JSON line on stdout, either
 * `{"scenario":"<name>","ok":true}` or
 * `{"scenario":"<name>","ok":false,"error":"<why>"}`, and exits 0 or 1.
 *
 * Usage: deno run --no-config --no-lock --allow-net=127.0.0.1 \
 *   <this file> <scenario>
 *
 * Imports are local only; nothing is fetched from a remote registry.
 */

import {
  type EgressProxy,
  type EgressRoute,
  startEgressProxy,
} from "../../lib/egress_proxy.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const HEAD_END = encoder.encode("\r\n\r\n");
const PUBLIC_ADDRESS = "93.184.216.34";
const DENIAL_PREFIX = "[EGRESS_DENIED] ";

/** A failed expectation; the message is reported to the parent test. */
class ScenarioFailure extends Error {}

function expect(condition: boolean, message: string): void {
  if (!condition) throw new ScenarioFailure(message);
}

function expectEqual(actual: unknown, expected: unknown, label: string): void {
  const got = JSON.stringify(actual);
  const want = JSON.stringify(expected);
  if (got !== want) {
    throw new ScenarioFailure(`${label}: expected ${want}, got ${got}`);
  }
}

function expectIncludes(haystack: string, needle: string, label: string): void {
  expect(
    haystack.includes(needle),
    `${label}: expected ${JSON.stringify(needle)} in ${
      JSON.stringify(haystack)
    }`,
  );
}

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
  /** Resolves once every connection accepted so far has ended. */
  ended(): Promise<void>;
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
    // The peer or the scenario closed the socket; there is nothing to echo.
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
    async ended() {
      await Promise.all(handlers);
    },
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
  /** Hosts whose resolution throws, as a failing DNS lookup would. */
  resolveFailsFor?: string[];
  /** Makes every dial throw, as a refused upstream connection would. */
  connectFails?: boolean;
  /** Holds every resolver answer until this resolves, so the scenario decides when. */
  resolveGate?: Promise<void>;
}

interface Harness {
  readonly proxy: EgressProxy;
  /** Every deny line the proxy logged, in order. */
  readonly lines: string[];
  /** Every host the resolver was asked about. */
  readonly resolved: string[];
  /** Every address the connector was asked to dial. */
  readonly dialled: string[];
  /** Resolves once the resolver has been asked at least `count` times. */
  resolvedAtLeast(count: number): Promise<void>;
  /** Resolves once the upstream end of every dialled connection has closed. */
  upstreamEnded(): Promise<void>;
  open(): Promise<Wire>;
  close(): Promise<void>;
}

/** A promise with its resolver exposed, so a scenario can release it. */
interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let release: () => void = () => {};
  const promise = new Promise<void>((done) => {
    release = done;
  });
  return { promise, resolve: () => release() };
}

async function startHarness(opts: HarnessOptions): Promise<Harness> {
  const echoServer = startEchoServer();
  const lines: string[] = [];
  const resolved: string[] = [];
  const dialled: string[] = [];
  const wires: Wire[] = [];
  // Each waiter re-checks the count whenever the resolver is asked again.
  const resolveWaiters: Array<() => void> = [];
  const proxy = await startEgressProxy({
    hostname: "127.0.0.1",
    port: 0,
    allowlist: opts.allowlist,
    routes: opts.routes,
    maxConnections: opts.maxConnections,
    idleTimeoutMs: opts.idleTimeoutMs,
    maxHeaderBytes: opts.maxHeaderBytes,
    resolve: async (host) => {
      resolved.push(host);
      for (const recheck of resolveWaiters.splice(0)) recheck();
      if (opts.resolveGate !== undefined) await opts.resolveGate;
      if (opts.resolveFailsFor?.includes(host)) {
        throw new Error("resolver exploded");
      }
      return opts.addresses?.[host] ?? [PUBLIC_ADDRESS];
    },
    connect: (address) => {
      dialled.push(address);
      if (opts.connectFails) {
        return Promise.reject(new Error("connector refused"));
      }
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
    resolvedAtLeast(count) {
      return new Promise<void>((wake) => {
        const check = (): void => {
          if (resolved.length >= count) wake();
          else resolveWaiters.push(check);
        };
        check();
      });
    },
    upstreamEnded() {
      return echoServer.ended();
    },
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

async function tunnelsByteForByte(): Promise<void> {
  const h = await startHarness({ allowlist: ["allowed.example"] });
  try {
    const wire = await h.open();
    await wire.write(
      "CONNECT allowed.example:443 HTTP/1.1\r\nHost: allowed.example:443\r\n\r\n",
    );
    expectEqual(
      await wire.readHead(),
      "HTTP/1.1 200 Connection Established",
      "tunnel status",
    );

    const payload = new Uint8Array([0, 1, 2, 13, 10, 255, 128, 65, 66]);
    await wire.write(payload);
    expectEqual(
      Array.from(await wire.readExact(payload.length)),
      Array.from(payload),
      "tunnelled bytes",
    );

    expectEqual(h.resolved, ["allowed.example"], "resolved hosts");
    expectEqual(h.dialled, [PUBLIC_ADDRESS], "dialled addresses");
    expectEqual(h.lines, [], "denial lines");
  } finally {
    await h.close();
  }
}

async function refusesNonAllowlisted(): Promise<void> {
  const h = await startHarness({ allowlist: ["allowed.example"] });
  try {
    const wire = await h.open();
    await wire.write(
      "CONNECT evil.example:443 HTTP/1.1\r\nHost: evil.example:443\r\n\r\n",
    );
    const denial = await readDenial(wire);

    expectEqual(denial.status, "HTTP/1.1 403 Forbidden", "status");
    expectIncludes(denial.head, "Content-Type: text/plain", "denial head");
    expectIncludes(denial.head, "Connection: close", "denial head");
    expectEqual(
      denial.body,
      "[EGRESS_DENIED] host=evil.example reason=not-allowlisted\n",
      "denial body",
    );
    expectEqual(h.resolved, [], "resolved hosts");
    expectEqual(h.dialled, [], "dialled addresses");
    expectEqual(h.lines, [
      "[EGRESS_DENIED] host=evil.example port=443 reason=not-allowlisted",
    ], "denial lines");
  } finally {
    await h.close();
  }
}

async function refusesIpLiteral(): Promise<void> {
  const h = await startHarness({ allowlist: ["allowed.example"] });
  try {
    for (const target of ["93.184.216.34:443", "[2001:db8::1]:443"]) {
      const wire = await h.open();
      await wire.write(`CONNECT ${target} HTTP/1.1\r\n\r\n`);
      const denial = await readDenial(wire);
      expectEqual(denial.status, "HTTP/1.1 403 Forbidden", target);
      expectIncludes(denial.body, "reason=ip-literal", target);
    }
    expectEqual(h.resolved, [], "resolved hosts");
    expectEqual(h.dialled, [], "dialled addresses");
    expectEqual(h.lines.length, 2, "denial line count");
  } finally {
    await h.close();
  }
}

async function refusesPrivateResolution(): Promise<void> {
  const hosts = [
    "mixed.example",
    "loopback.example",
    "ten.example",
    "metadata.example",
  ];
  const h = await startHarness({
    allowlist: hosts,
    addresses: {
      "mixed.example": [PUBLIC_ADDRESS, "10.0.0.5"],
      "loopback.example": ["127.0.0.1"],
      "ten.example": ["10.0.0.1"],
      "metadata.example": ["169.254.169.254"],
    },
  });
  try {
    for (const host of hosts) {
      const wire = await h.open();
      await wire.write(`CONNECT ${host}:443 HTTP/1.1\r\n\r\n`);
      const denial = await readDenial(wire);
      expectEqual(denial.status, "HTTP/1.1 403 Forbidden", host);
      expectIncludes(denial.body, "reason=private-address", host);
    }
    expectEqual(h.dialled, [], "dialled addresses");
    expectEqual(h.lines.length, hosts.length, "denial line count");
  } finally {
    await h.close();
  }
}

async function refusesNonConnect(): Promise<void> {
  const h = await startHarness({ allowlist: ["allowed.example"] });
  try {
    const wire = await h.open();
    await wire.write(
      "GET http://allowed.example/ HTTP/1.1\r\nHost: allowed.example\r\n\r\n",
    );
    const denial = await readDenial(wire);
    expectEqual(denial.status, "HTTP/1.1 403 Forbidden", "status");
    expectIncludes(denial.body, "reason=method", "denial body");
    expectEqual(h.dialled, [], "dialled addresses");
    expectEqual(h.lines, [
      "[EGRESS_DENIED] host=allowed.example port=0 reason=method",
    ], "denial lines");
  } finally {
    await h.close();
  }
}

async function oneDenialLinePerRefusal(): Promise<void> {
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
    expectEqual(h.lines.length, refusals.length, "denial line count");

    // An allowed tunnel is not a refusal and must add no line.
    const tunnel = await h.open();
    await tunnel.write("CONNECT allowed.example:443 HTTP/1.1\r\n\r\n");
    expectEqual(
      await tunnel.readHead(),
      "HTTP/1.1 200 Connection Established",
      "tunnel status",
    );
    expectEqual(h.lines.length, refusals.length, "denial line count");

    for (const line of h.lines) {
      expect(line.startsWith(DENIAL_PREFIX), `unexpected line: ${line}`);
    }
  } finally {
    await h.close();
  }
}

async function sanitisesControlCharacters(): Promise<void> {
  const h = await startHarness({ allowlist: ["evil.example"] });
  try {
    const wire = await h.open();
    await wire.write("CONNECT evil\u0001\u0007.example:443 HTTP/1.1\r\n\r\n");
    const denial = await readDenial(wire);

    expectEqual(denial.status, "HTTP/1.1 403 Forbidden", "status");
    expectEqual(
      denial.body,
      "[EGRESS_DENIED] host=evil.example reason=bad-request\n",
      "denial body",
    );
    expectEqual(h.lines, [
      "[EGRESS_DENIED] host=evil.example port=443 reason=bad-request",
    ], "denial lines");
    expect(
      !/\p{Cc}/u.test(h.lines[0] ?? ""),
      "log line kept a control char",
    );
    expectEqual(h.dialled, [], "dialled addresses");
  } finally {
    await h.close();
  }
}

async function cutsOffOverLongHeader(): Promise<void> {
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

    expectEqual(denial.status, "HTTP/1.1 403 Forbidden", "status");
    expectEqual(
      denial.body,
      "[EGRESS_DENIED] host=- reason=header-too-large\n",
      "denial body",
    );
    expectEqual(h.lines, [
      "[EGRESS_DENIED] host=- port=0 reason=header-too-large",
    ], "denial lines");
    expectEqual(h.dialled, [], "dialled addresses");
  } finally {
    await h.close();
  }
}

/**
 * Yield to the event loop `turns` times, so bytes already written by the
 * client are read by the proxy before the scenario writes again. This orders
 * two writes; it is not a wait for a duration, and the scenario's assertions
 * hold whether or not the proxy has read the first write by then.
 */
async function yieldTurns(turns: number): Promise<void> {
  for (let turn = 0; turn < turns; turn++) {
    await new Promise<void>((next) => setTimeout(next, 0));
  }
}

async function cutsOffHeadSplitAcrossReads(): Promise<void> {
  const h = await startHarness({
    allowlist: ["allowed.example"],
    maxHeaderBytes: 256,
  });
  try {
    const wire = await h.open();
    // The first write is under the cap and carries no blank line, so the proxy
    // keeps reading. The second write ends the head after byte 256: the blank
    // line arrives only past the cap.
    const first = "CONNECT allowed.example:443 HTTP/1.1\r\nX-Pad: " +
      "a".repeat(180);
    await wire.write(first);
    await yieldTurns(25);
    await wire.write("a".repeat(100) + "\r\n\r\n");
    const denial = await readDenial(wire);

    expectEqual(denial.status, "HTTP/1.1 403 Forbidden", "status");
    expectEqual(
      denial.body,
      "[EGRESS_DENIED] host=- reason=header-too-large\n",
      "denial body",
    );
    expectEqual(h.lines, [
      "[EGRESS_DENIED] host=- port=0 reason=header-too-large",
    ], "denial lines");
    expectEqual(h.dialled, [], "dialled addresses");
  } finally {
    await h.close();
  }
}

async function tunnelsBytesPipelinedAfterTheHead(): Promise<void> {
  const h = await startHarness({ allowlist: ["allowed.example"] });
  try {
    const wire = await h.open();
    // The client does not wait for the 200: the payload follows the blank line
    // in the same write, so the proxy reads it together with the head.
    const payload = new Uint8Array([22, 3, 1, 0, 13, 10, 255, 7]);
    await wire.write(concatBytes(
      encoder.encode(
        "CONNECT allowed.example:443 HTTP/1.1\r\nHost: allowed.example:443\r\n\r\n",
      ),
      payload,
    ));
    expectEqual(
      await wire.readHead(),
      "HTTP/1.1 200 Connection Established",
      "tunnel status",
    );
    expectEqual(
      Array.from(await wire.readExact(payload.length)),
      Array.from(payload),
      "pipelined bytes echoed by the upstream",
    );
    expectEqual(h.dialled, [PUBLIC_ADDRESS], "dialled addresses");
    expectEqual(h.lines, [], "denial lines");
  } finally {
    await h.close();
  }
}

async function refusesBytesPipelinedToARoute(): Promise<void> {
  const targets: Array<{ host: string; port: number }> = [];
  const route: EgressRoute = (_client, target) => {
    targets.push(target);
    return Promise.resolve();
  };
  const h = await startHarness({
    allowlist: ["routed.example"],
    routes: new Map([["routed.example", route]]),
  });
  try {
    const wire = await h.open();
    await wire.write("CONNECT routed.example:443 HTTP/1.1\r\n\r\nEXTRA");
    const denial = await readDenial(wire);

    expectEqual(denial.status, "HTTP/1.1 403 Forbidden", "status");
    expectEqual(
      denial.body,
      "[EGRESS_DENIED] host=routed.example reason=bad-request\n",
      "denial body",
    );
    expectEqual(h.lines, [
      "[EGRESS_DENIED] host=routed.example port=443 reason=bad-request",
    ], "denial lines");
    expectEqual(targets, [], "route targets");
    expectEqual(h.dialled, [], "dialled addresses");
  } finally {
    await h.close();
  }
}

async function cutsOffIdleClient(): Promise<void> {
  const h = await startHarness({
    allowlist: ["allowed.example"],
    idleTimeoutMs: 50,
  });
  try {
    // Send nothing. The proxy closes the socket, so the read ends with null.
    const wire = await h.open();
    expectEqual(await wire.readSome(), null, "idle read");
    expectEqual(h.lines, [
      "[EGRESS_DENIED] host=- port=0 reason=idle-timeout",
    ], "denial lines");
    expectEqual(h.dialled, [], "dialled addresses");
  } finally {
    await h.close();
  }
}

async function cutsOffIdleTunnel(): Promise<void> {
  const h = await startHarness({
    allowlist: ["allowed.example"],
    idleTimeoutMs: 50,
  });
  try {
    const wire = await h.open();
    await wire.write(
      "CONNECT allowed.example:443 HTTP/1.1\r\nHost: allowed.example:443\r\n\r\n",
    );
    expectEqual(
      await wire.readHead(),
      "HTTP/1.1 200 Connection Established",
      "tunnel status",
    );

    // Positive control: the tunnel is up, so bytes sent now reach the upstream
    // and come back through it.
    const ping = "ping\n";
    await wire.write(ping);
    expectEqual(
      decoder.decode(await wire.readExact(ping.length)),
      ping,
      "tunnelled bytes before idling",
    );

    // Send nothing more. The idle timer closes both ends of the tunnel: the
    // client read ends with null, and the upstream sees its end close too.
    expectEqual(await wire.readSome(), null, "idle tunnel read");
    await h.upstreamEnded();

    // An established tunnel that idles out is not a refusal, so no line.
    expectEqual(h.lines, [], "denial lines");
    expectEqual(h.resolved, ["allowed.example"], "resolved hosts");
    expectEqual(h.dialled, [PUBLIC_ADDRESS], "dialled addresses");
  } finally {
    await h.close();
  }
}

async function refusesNon443Port(): Promise<void> {
  const h = await startHarness({ allowlist: ["allowed.example"] });
  try {
    const wire = await h.open();
    await wire.write("CONNECT allowed.example:8443 HTTP/1.1\r\n\r\n");
    const denial = await readDenial(wire);
    expectEqual(denial.status, "HTTP/1.1 403 Forbidden", "status");
    expectIncludes(denial.body, "reason=bad-port", "denial body");
    expectEqual(h.resolved, [], "resolved hosts");
    expectEqual(h.dialled, [], "dialled addresses");
    expectEqual(h.lines, [
      "[EGRESS_DENIED] host=allowed.example port=8443 reason=bad-port",
    ], "denial lines");
  } finally {
    await h.close();
  }
}

async function refusesAtConnectionCap(): Promise<void> {
  const h = await startHarness({
    allowlist: ["allowed.example"],
    maxConnections: 1,
  });
  try {
    // The first socket takes the only slot and sends nothing.
    const holder = await h.open();
    const wire = await h.open();
    const denial = await readDenial(wire);
    expectEqual(denial.status, "HTTP/1.1 403 Forbidden", "status");
    expectEqual(
      denial.body,
      "[EGRESS_DENIED] host=- reason=capacity\n",
      "denial body",
    );
    expectEqual(h.lines, [
      "[EGRESS_DENIED] host=- port=0 reason=capacity",
    ], "denial lines");
    expectEqual(h.dialled, [], "dialled addresses");
    closeQuietly(holder.conn);
  } finally {
    await h.close();
  }
}

async function handsOffToRoute(): Promise<void> {
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
    expectEqual(
      await wire.readHead(),
      "HTTP/1.1 200 Connection Established",
      "route status",
    );
    expectEqual(
      decoder.decode(await wire.readExact(6)),
      "ROUTED",
      "route bytes",
    );

    expectEqual(
      targets,
      [{ host: "routed.example", port: 443 }],
      "route targets",
    );
    expectEqual(h.resolved, [], "resolved hosts");
    expectEqual(h.dialled, [], "dialled addresses");
    expectEqual(h.lines, [], "denial lines");
  } finally {
    await h.close();
  }
}

async function refusesResolverError(): Promise<void> {
  const h = await startHarness({
    allowlist: ["allowed.example"],
    resolveFailsFor: ["allowed.example"],
  });
  try {
    const wire = await h.open();
    await wire.write("CONNECT allowed.example:443 HTTP/1.1\r\n\r\n");
    const denial = await readDenial(wire);
    expectEqual(denial.status, "HTTP/1.1 403 Forbidden", "status");
    // The detail stays on the stderr line; the 403 body never carries it.
    expectEqual(
      denial.body,
      "[EGRESS_DENIED] host=allowed.example reason=resolve-failed\n",
      "denial body",
    );
    expectEqual(h.lines, [
      "[EGRESS_DENIED] host=allowed.example port=443 reason=resolve-failed detail=resolver exploded",
    ], "denial lines");
    expectEqual(h.dialled, [], "dialled addresses");
  } finally {
    await h.close();
  }
}

async function refusesConnectorError(): Promise<void> {
  const h = await startHarness({
    allowlist: ["allowed.example"],
    connectFails: true,
  });
  try {
    const wire = await h.open();
    await wire.write("CONNECT allowed.example:443 HTTP/1.1\r\n\r\n");
    const denial = await readDenial(wire);
    expectEqual(denial.status, "HTTP/1.1 403 Forbidden", "status");
    expectEqual(
      denial.body,
      "[EGRESS_DENIED] host=allowed.example reason=connect-failed\n",
      "denial body",
    );
    expectEqual(h.lines, [
      "[EGRESS_DENIED] host=allowed.example port=443 reason=connect-failed detail=connector refused",
    ], "denial lines");
    expectEqual(h.dialled, [PUBLIC_ADDRESS], "dialled addresses");
  } finally {
    await h.close();
  }
}

async function refusesLoneCarriageReturn(): Promise<void> {
  const h = await startHarness({ allowlist: ["evil.example"] });
  try {
    // A lone CR is not a CRLF, so it stays inside the host and must not split
    // the log line.
    const wire = await h.open();
    await wire.write("CONNECT evil\r.example:443 HTTP/1.1\r\n\r\n");
    const denial = await readDenial(wire);
    expectEqual(denial.status, "HTTP/1.1 403 Forbidden", "status");
    expectEqual(
      denial.body,
      "[EGRESS_DENIED] host=evil.example reason=bad-request\n",
      "denial body",
    );
    expectEqual(h.lines, [
      "[EGRESS_DENIED] host=evil.example port=443 reason=bad-request",
    ], "denial lines");
    expect(!/[\r\n]/.test(h.lines[0] ?? ""), "log line kept a CR or LF");
    expectEqual(h.dialled, [], "dialled addresses");
  } finally {
    await h.close();
  }
}

async function refusesTrailingDotHost(): Promise<void> {
  const h = await startHarness({ allowlist: ["allowed.example"] });
  try {
    // The trailing-dot form is a different name to the allowlist, so it is
    // refused as not-allowlisted without any DNS lookup or dial.
    const wire = await h.open();
    await wire.write("CONNECT allowed.example.:443 HTTP/1.1\r\n\r\n");
    const denial = await readDenial(wire);
    expectEqual(denial.status, "HTTP/1.1 403 Forbidden", "status");
    expectEqual(
      denial.body,
      "[EGRESS_DENIED] host=allowed.example. reason=not-allowlisted\n",
      "denial body",
    );
    expectEqual(h.lines, [
      "[EGRESS_DENIED] host=allowed.example. port=443 reason=not-allowlisted",
    ], "denial lines");
    expectEqual(h.resolved, [], "resolved hosts");
    expectEqual(h.dialled, [], "dialled addresses");
  } finally {
    await h.close();
  }
}

async function idleRaceWithDelayedResolver(): Promise<void> {
  // Each resolver is held on a gate until both clients have been cut off by the
  // idle timer, so every resolver answers after the cut-off. The first fails,
  // the second succeeds; neither may add a second line or dial.
  const gate = deferred();
  const h = await startHarness({
    allowlist: ["allowed.example", "other.example"],
    resolveFailsFor: ["allowed.example"],
    idleTimeoutMs: 50,
    resolveGate: gate.promise,
  });
  try {
    const first = await h.open();
    await first.write("CONNECT allowed.example:443 HTTP/1.1\r\n\r\n");
    const second = await h.open();
    await second.write("CONNECT other.example:443 HTTP/1.1\r\n\r\n");
    // Both heads are read and both resolvers are parked on the gate before the
    // cut-offs are awaited, so each idle line names its host.
    await h.resolvedAtLeast(2);
    expectEqual(await first.readSome(), null, "first idle read");
    expectEqual(await second.readSome(), null, "second idle read");
    // Release the resolvers only now, after both cut-offs have been observed.
    gate.resolve();
    // close() awaits every connection handler, so both resolvers have returned
    // and any dial they would make has happened (or not) before the asserts.
    await h.proxy.close();

    expectEqual(
      [...h.lines].sort(),
      [
        "[EGRESS_DENIED] host=allowed.example port=443 reason=idle-timeout",
        "[EGRESS_DENIED] host=other.example port=443 reason=idle-timeout",
      ],
      "denial lines",
    );
    expectEqual(h.dialled, [], "dialled addresses");
  } finally {
    await h.close();
  }
}

async function redactsTokenInHostname(): Promise<void> {
  const token = `ghp_${"a".repeat(36)}`;
  const h = await startHarness({ allowlist: ["allowed.example"] });
  try {
    // A token in the client-supplied host is refused, and must not reach the log.
    const wire = await h.open();
    await wire.write(`CONNECT ${token}.example.com:443 HTTP/1.1\r\n\r\n`);
    const denial = await readDenial(wire);
    expectEqual(denial.status, "HTTP/1.1 403 Forbidden", "status");
    expectEqual(h.lines.length, 1, "denial line count");
    const line = h.lines[0];
    if (line === undefined) {
      throw new Error("expected one denial line, got none");
    }
    expectIncludes(line, "reason=not-allowlisted", "denial line");
    expect(!line.includes(token), "token leaked into the denial line");

    // Positive control: an un-tokened host is logged, so the token line was
    // redacted rather than dropped.
    const plain = await h.open();
    await plain.write("CONNECT plain.example.com:443 HTTP/1.1\r\n\r\n");
    await readDenial(plain);
    expectEqual(h.lines.length, 2, "denial line count");
    expectEqual(
      h.lines[1],
      "[EGRESS_DENIED] host=plain.example.com port=443 reason=not-allowlisted",
      "plain host denial line",
    );
    expectEqual(h.resolved, [], "resolved hosts");
    expectEqual(h.dialled, [], "dialled addresses");
  } finally {
    await h.close();
  }
}

const SCENARIOS: Readonly<Record<string, () => Promise<void>>> = {
  "tunnel-byte-for-byte": tunnelsByteForByte,
  "refuse-non-allowlisted": refusesNonAllowlisted,
  "refuse-ip-literal": refusesIpLiteral,
  "refuse-private-resolution": refusesPrivateResolution,
  "refuse-non-connect": refusesNonConnect,
  "one-denial-line-per-refusal": oneDenialLinePerRefusal,
  "sanitise-control-characters": sanitisesControlCharacters,
  "cut-off-over-long-header": cutsOffOverLongHeader,
  "cut-off-head-split-across-reads": cutsOffHeadSplitAcrossReads,
  "tunnel-bytes-pipelined-after-head": tunnelsBytesPipelinedAfterTheHead,
  "refuse-bytes-pipelined-to-route": refusesBytesPipelinedToARoute,
  "cut-off-idle-client": cutsOffIdleClient,
  "cut-off-idle-tunnel": cutsOffIdleTunnel,
  "refuse-non-443-port": refusesNon443Port,
  "refuse-at-connection-cap": refusesAtConnectionCap,
  "hand-off-to-route": handsOffToRoute,
  "refuse-resolver-error": refusesResolverError,
  "refuse-connector-error": refusesConnectorError,
  "refuse-lone-carriage-return": refusesLoneCarriageReturn,
  "refuse-trailing-dot-host": refusesTrailingDotHost,
  "idle-race-delayed-resolver": idleRaceWithDelayedResolver,
  "redact-token-in-hostname": redactsTokenInHostname,
};

/** Write the one-line JSON result the parent test asserts on. */
async function report(
  scenario: string,
  ok: boolean,
  error = "",
): Promise<void> {
  const line = ok ? { scenario, ok } : { scenario, ok, error };
  await Deno.stdout.write(encoder.encode(`${JSON.stringify(line)}\n`));
}

async function main(): Promise<number> {
  const name = Deno.args[0] ?? "";
  const scenario = Object.hasOwn(SCENARIOS, name) ? SCENARIOS[name] : undefined;
  if (scenario === undefined) {
    await report(name, false, `unknown scenario ${JSON.stringify(name)}`);
    return 1;
  }
  try {
    await scenario();
    await report(name, true);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await report(name, false, message);
    return 1;
  }
}

// Exit explicitly so a leaked handle can never keep the child alive.
Deno.exit(await main());
