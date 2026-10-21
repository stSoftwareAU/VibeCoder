/**
 * Egress proxy (Issue #4046): the one outbound proxy for the agent container.
 *
 * It accepts HTTP `CONNECT` requests, refuses any host that is not on the
 * egress allowlist, resolves the host itself, refuses any answer that touches
 * a private, loopback, link-local or otherwise reserved range, and dials
 * exactly the first address it checked. Allowed tunnels are piped byte for
 * byte; the payload is never logged.
 *
 * #3699's credential broker extends this module through the per-host route
 * seam ({@link EgressRoute}). It adds no second outbound proxy: a route claims
 * an allowlisted host and receives the client connection instead of an
 * upstream dial. The container is not routed through this proxy yet (#4047).
 *
 * Imports are local only; nothing is fetched from a remote registry.
 * Australian English spelling used throughout (behaviour, sanitise).
 */

import { validateEgressHost } from "./egress_allowlist.ts";
import { isPrivateAddress } from "./public_url_guard.ts";

/** Why a connection was refused. Each refusal logs one line with this class. */
export type EgressDenyReason =
  | "method"
  | "not-allowlisted"
  | "ip-literal"
  | "private-address"
  | "bad-request"
  | "header-too-large"
  | "idle-timeout"
  | "resolve-failed"
  | "bad-port"
  | "connect-failed"
  | "capacity";

/** Resolves a hostname to every address it currently answers with. */
export type EgressResolver = (host: string) => Promise<string[]>;

/** Opens the upstream connection to one already-checked address. */
export type EgressConnector = (
  address: string,
  port: number,
) => Promise<Deno.Conn>;

/**
 * Takes over an allowlisted tunnel (the #3699 seam). The proxy replies
 * `200 Connection Established` first; the route then owns the client
 * connection, including its idle policy. The proxy dials nothing for a route.
 */
export type EgressRoute = (
  client: Deno.Conn,
  target: { host: string; port: number },
) => Promise<void>;

/** Options for {@link startEgressProxy}. */
export interface EgressProxyOptions {
  /** Listen address; defaults to 127.0.0.1. */
  hostname?: string;
  /** Listen port; 0 picks a free port (tests). */
  port: number;
  /** Exact hosts or `*.suffix` entries. Validated when the proxy starts. */
  allowlist: readonly string[];
  /** Default: `Deno.resolveDns` for A and AAAA, combined. */
  resolve?: EgressResolver;
  /** Default: `Deno.connect` to the given address. */
  connect?: EgressConnector;
  /** Routes keyed by an allowlisted host or `*.suffix`. */
  routes?: ReadonlyMap<string, EgressRoute>;
  /** Live client connections allowed at once; default 256. */
  maxConnections?: number;
  /** Idle time before a connection is cut off; default 60 000 ms. */
  idleTimeoutMs?: number;
  /** Request head size limit in bytes; default 8192. */
  maxHeaderBytes?: number;
  /** Receives one line per refusal; default `console.error`. */
  logDenied?: (line: string) => void;
}

/** A running proxy. */
export interface EgressProxy {
  readonly addr: Deno.NetAddr;
  /** Stops the listener, closes every live connection and awaits handlers. */
  close(): Promise<void>;
}

const DEFAULT_MAX_CONNECTIONS = 256;
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_HEADER_BYTES = 8192;
const MIN_HEADER_BYTES = 16;
const READ_CHUNK_BYTES = 4096;
const PIPE_CHUNK_BYTES = 16_384;
const ALLOWED_PORT = 443;
const MAX_LOGGED_HOST_CHARS = 64;
const MAX_LOGGED_DETAIL_CHARS = 160;
const CONNECTION_ESTABLISHED = "HTTP/1.1 200 Connection Established\r\n\r\n";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const IPV4_PATTERN = /^\d{1,3}(\.\d{1,3}){3}$/;
const HTTP_VERSION_PATTERN = /^HTTP\/1\.[01]$/;
const DIGITS_PATTERN = /^\d+$/;
const WHITESPACE_OR_CONTROL = /[\s\p{Cc}]/u;
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/gu;

/** Result of reading and parsing a request head. */
type HeadVerdict =
  | { ok: true; host: string; port: number }
  | { ok: false; host: string; port: number; reason: EgressDenyReason };

/** Result of reading a request head off the socket. */
type HeadRead =
  | { kind: "head"; head: string; rest: Uint8Array }
  | { kind: "too-large" }
  | { kind: "closed" };

/** Shared, read-only settings plus the registry of live connections. */
interface ProxyContext {
  readonly allowlist: readonly string[];
  readonly routes: ReadonlyMap<string, EgressRoute>;
  readonly resolve: EgressResolver;
  readonly connect: EgressConnector;
  readonly maxHeaderBytes: number;
  readonly idleTimeoutMs: number;
  readonly logDenied: (line: string) => void;
  readonly registry: Registry;
}

/** Live connections, so {@link EgressProxy.close} can reach every one. */
interface Registry {
  closing: boolean;
  readonly clients: Set<Deno.Conn>;
  readonly upstreams: Set<Deno.Conn>;
}

/**
 * Make a logged host safe for one log line: strip control and format
 * characters (so no CR, LF or escape can split or forge a line) and cap the
 * length by code point.
 *
 * @param raw - The host as the client sent it
 * @returns The host, safe to log, at most 64 code points
 */
export function sanitiseEgressHost(raw: string): string {
  return sanitiseLogText(raw, MAX_LOGGED_HOST_CHARS);
}

/** Strip control and format characters, then cap by code point. */
function sanitiseLogText(raw: string, maxCodePoints: number): string {
  const stripped = raw.replace(CONTROL_OR_FORMAT, "");
  return Array.from(stripped).slice(0, maxCodePoints).join("");
}

/**
 * The single line logged for one refusal. A detail, such as the resolver or
 * connector error, is appended only to this log line; the 403 body never
 * carries it.
 *
 * @param host - The requested host; sanitised before use
 * @param port - The requested port, or 0 when unknown
 * @param reason - Why the connection was refused
 * @param detail - Optional error text, sanitised and capped at 160 characters
 * @returns `[EGRESS_DENIED] host=<h> port=<n> reason=<class>`, plus
 *   ` detail=<text>` when a detail is given
 */
export function formatEgressDenial(
  host: string,
  port: number,
  reason: EgressDenyReason,
  detail?: string,
): string {
  const line = `[EGRESS_DENIED] host=${
    sanitiseEgressHost(host)
  } port=${port} reason=${reason}`;
  if (detail === undefined) return line;
  return `${line} detail=${sanitiseLogText(detail, MAX_LOGGED_DETAIL_CHARS)}`;
}

/**
 * Parse the operator's allowlist, from a comma-separated string or an array.
 *
 * @param raw - Comma-separated hosts, or one entry per array element
 * @returns The validated, lower-cased entries
 * @throws Error naming the bad entry, or when no entries remain
 */
export function parseEgressAllowlist(
  raw: string | readonly string[],
): string[] {
  const pieces: readonly unknown[] = typeof raw === "string"
    ? raw.split(",")
    : raw;
  const hosts: string[] = [];
  for (const piece of pieces) {
    const trimmed = typeof piece === "string" ? piece.trim() : piece;
    if (trimmed === "") continue;
    hosts.push(validateEgressHost(trimmed));
  }
  if (hosts.length === 0) throw new Error("egress allowlist is empty");
  return hosts;
}

/**
 * Start the proxy listening.
 *
 * @param opts - Listen address, allowlist, seams and limits
 * @returns The bound address and a `close` that drains every connection
 * @throws Error when an allowlist entry or route key is invalid, or a limit is
 *   out of range
 */
export async function startEgressProxy(
  opts: EgressProxyOptions,
): Promise<EgressProxy> {
  const allowlist = opts.allowlist.map((entry) => validateEgressHost(entry));
  const routes = normaliseRoutes(opts.routes, allowlist);
  const maxConnections = opts.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const maxHeaderBytes = opts.maxHeaderBytes ?? DEFAULT_MAX_HEADER_BYTES;
  assertPositiveInteger("maxConnections", maxConnections);
  assertPositiveInteger("idleTimeoutMs", idleTimeoutMs);
  if (!Number.isInteger(maxHeaderBytes) || maxHeaderBytes < MIN_HEADER_BYTES) {
    throw new RangeError(
      `maxHeaderBytes must be an integer of at least ${MIN_HEADER_BYTES}`,
    );
  }

  const listener = Deno.listen({
    hostname: opts.hostname ?? "127.0.0.1",
    port: opts.port,
  });
  const registry: Registry = {
    closing: false,
    clients: new Set(),
    upstreams: new Set(),
  };
  const logDenied = opts.logDenied ?? ((line: string) => console.error(line));
  const ctx: ProxyContext = {
    allowlist,
    routes,
    resolve: opts.resolve ?? resolveHostAddresses,
    connect: opts.connect ?? connectUpstream,
    maxHeaderBytes,
    idleTimeoutMs,
    logDenied,
    registry,
  };

  const handlers = new Set<Promise<void>>();
  const track = (promise: Promise<void>): void => {
    handlers.add(promise);
    void promise.then(() => {
      handlers.delete(promise);
    });
  };

  const acceptLoop = (async () => {
    try {
      for await (const conn of listener) {
        if (registry.closing) {
          closeQuietly(conn);
          break;
        }
        if (registry.clients.size >= maxConnections) {
          track(refuseAtCapacity(conn, logDenied));
          continue;
        }
        registry.clients.add(conn);
        track(
          serveClient(conn, ctx).catch((error: unknown) => {
            console.error(`egress proxy connection failed: ${describe(error)}`);
          }),
        );
      }
    } catch (error) {
      // Accept errors after close() are the listener shutting down; any other
      // accept failure is logged loudly and stops the loop.
      if (!registry.closing) {
        console.error(`egress proxy accept failed: ${describe(error)}`);
      }
    }
  })();

  let closed: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closed ??= (async () => {
      registry.closing = true;
      try {
        listener.close();
      } catch {
        // Already closed; closing twice is harmless here.
      }
      for (const conn of [...registry.clients, ...registry.upstreams]) {
        closeQuietly(conn);
      }
      await acceptLoop;
      await Promise.all(handlers);
    })();
    return closed;
  };

  return { addr: listener.addr as Deno.NetAddr, close };
}

/** Handle one accepted client from request head through to tunnel end. */
async function serveClient(
  client: Deno.Conn,
  ctx: ProxyContext,
): Promise<void> {
  // The idle line is written until the upstream is dialled (head read,
  // resolve, connect); an established tunnel idling out gets no denial line.
  let phase: "head" | "tunnel" = "head";
  let upstream: Deno.Conn | undefined;
  // The host and port once the head has parsed, so an idle line can name them.
  let target: { host: string; port: number } | undefined;
  // One denial line per connection: the idle timer and a refusal can race.
  let logged = false;
  let cutOff = false;
  const logOnce = (line: string): void => {
    if (logged) return;
    logged = true;
    ctx.logDenied(line);
  };
  const guard = idleGuard(ctx.idleTimeoutMs, () => {
    cutOff = true;
    if (phase === "head") {
      logOnce(
        formatEgressDenial(
          target?.host ?? "-",
          target?.port ?? 0,
          "idle-timeout",
        ),
      );
    }
    closeQuietly(client);
    if (upstream !== undefined) closeQuietly(upstream);
  });

  try {
    guard.touch();
    const read = await readHead(client, ctx.maxHeaderBytes, guard.touch);
    // A client that left before sending a request is not a refusal; an idle
    // client was already logged by the idle callback.
    if (read.kind === "closed") return;
    if (read.kind === "too-large") {
      return await refuse(client, "-", 0, "header-too-large", logOnce);
    }

    const verdict = parseRequestHead(read.head);
    target = { host: verdict.host, port: verdict.port };
    if (!verdict.ok) {
      return await refuse(
        client,
        verdict.host,
        verdict.port,
        verdict.reason,
        logOnce,
      );
    }
    const { host, port } = verdict;
    if (!isAllowlisted(host, ctx.allowlist)) {
      return await refuse(client, host, port, "not-allowlisted", logOnce);
    }
    const route = findRoute(host, ctx.routes);
    if (route !== undefined) {
      // A route owns the client connection, so the proxy's idle policy ends
      // here. Pipelined bytes are refused rather than dropped, because the
      // route is not handed them.
      guard.stop();
      if (read.rest.length > 0) {
        return await refuse(client, host, port, "bad-request", logOnce);
      }
      if (!await replyEstablished(client, undefined, read.rest)) return;
      try {
        await route(client, { host, port });
      } catch (error) {
        console.error(
          `egress route for ${sanitiseEgressHost(host)} failed: ${
            describe(error)
          }`,
        );
      }
      return;
    }

    // Resolve, check every address, then dial only the first one checked.
    let addresses: string[];
    let resolveDetail: string | undefined;
    try {
      addresses = await ctx.resolve(host);
    } catch (error) {
      addresses = [];
      resolveDetail = describe(error);
    }
    const [address] = addresses;
    if (address === undefined) {
      return await refuse(
        client,
        host,
        port,
        "resolve-failed",
        logOnce,
        resolveDetail,
      );
    }
    if (addresses.some((candidate) => isPrivateAddress(candidate))) {
      return await refuse(client, host, port, "private-address", logOnce);
    }
    // The idle timer closed the client while the resolver was running, so do
    // not dial an upstream for a connection nobody is waiting on.
    if (cutOff) return;

    let dialled: Deno.Conn;
    try {
      dialled = await ctx.connect(address, port);
    } catch (error) {
      return await refuse(
        client,
        host,
        port,
        "connect-failed",
        logOnce,
        describe(error),
      );
    }
    if (ctx.registry.closing) {
      closeQuietly(dialled);
      return;
    }
    upstream = dialled;
    ctx.registry.upstreams.add(dialled);
    phase = "tunnel";

    if (!await replyEstablished(client, dialled, read.rest)) return;
    await Promise.all([
      pipe(client, dialled, guard.touch),
      pipe(dialled, client, guard.touch),
    ]);
  } finally {
    guard.stop();
    ctx.registry.clients.delete(client);
    closeQuietly(client);
    if (upstream !== undefined) {
      ctx.registry.upstreams.delete(upstream);
      closeQuietly(upstream);
    }
  }
}

/**
 * Parse the request line and decide the cheap, local refusals: method, shape,
 * port and IP literals. The allowlist and DNS checks follow in the caller.
 *
 * @param head - The request head, without its terminating blank line
 * @returns The target when it passes, or the refusal reason
 */
function parseRequestHead(head: string): HeadVerdict {
  const lineEnd = head.indexOf("\r\n");
  const requestLine = lineEnd === -1 ? head : head.slice(0, lineEnd);
  const parts = requestLine.split(" ");
  const [method = "", target = ""] = parts;
  if (parts.length !== 3 || !HTTP_VERSION_PATTERN.test(parts[2] ?? "")) {
    return denied("-", 0, "bad-request");
  }
  if (method !== "CONNECT") {
    const { host, port } = hostOfAbsoluteTarget(target);
    return denied(host, port, "method");
  }

  const authority = splitAuthority(target);
  if (authority === undefined || !DIGITS_PATTERN.test(authority.portText)) {
    return denied("-", 0, "bad-request");
  }
  const port = Number(authority.portText);
  const host = authority.host.toLowerCase();
  const loggedHost = host === "" ? "-" : host;
  if (host === "" || WHITESPACE_OR_CONTROL.test(host)) {
    return denied(loggedHost, port, "bad-request");
  }
  if (port !== ALLOWED_PORT) return denied(host, port, "bad-port");
  if (isIpLiteral(host)) return denied(host, port, "ip-literal");
  return { ok: true, host, port };
}

/** A refused request, with the host and port to log. */
function denied(
  host: string,
  port: number,
  reason: EgressDenyReason,
): HeadVerdict {
  return { ok: false, host, port, reason };
}

/**
 * Split a CONNECT authority into host and port text. Bracketed IPv6 is
 * accepted; an unbracketed IPv6 form is malformed.
 *
 * @param target - The authority, for example `example.com:443` or `[::1]:443`
 * @returns The host and port text, or undefined when the shape is wrong
 */
function splitAuthority(
  target: string,
): { host: string; portText: string } | undefined {
  if (target.startsWith("[")) {
    const close = target.indexOf("]");
    if (close === -1 || target.charAt(close + 1) !== ":") return undefined;
    return { host: target.slice(1, close), portText: target.slice(close + 2) };
  }
  const colon = target.lastIndexOf(":");
  if (colon === -1) return undefined;
  const host = target.slice(0, colon);
  if (host.includes(":")) return undefined;
  return { host, portText: target.slice(colon + 1) };
}

/**
 * The host and explicit port of an absolute-form target, for a refusal log.
 *
 * @param target - A request target such as `http://allowed.example/`
 * @returns The host and port, with `-` and 0 when unknown
 */
function hostOfAbsoluteTarget(target: string): { host: string; port: number } {
  try {
    const url = new URL(target);
    const host = url.hostname.toLowerCase();
    return {
      host: host === "" ? "-" : host,
      port: url.port === "" ? 0 : Number(url.port),
    };
  } catch {
    // Not a parseable URL: the refusal is still logged, with an unknown host.
    return { host: "-", port: 0 };
  }
}

/** True for an IPv4 dotted quad or any IPv6 form. */
function isIpLiteral(host: string): boolean {
  return host.includes(":") || IPV4_PATTERN.test(host);
}

/** Exact host, or `*.suffix` matching a strict subdomain only. */
function hostMatchesEntry(host: string, entry: string): boolean {
  if (!entry.startsWith("*.")) return host === entry;
  const suffix = entry.slice(1);
  return host.length > suffix.length && host.endsWith(suffix);
}

function isAllowlisted(host: string, allowlist: readonly string[]): boolean {
  return allowlist.some((entry) => hostMatchesEntry(host, entry));
}

/** The route for a host: an exact key first, then a wildcard key. */
function findRoute(
  host: string,
  routes: ReadonlyMap<string, EgressRoute>,
): EgressRoute | undefined {
  const exact = routes.get(host);
  if (exact !== undefined) return exact;
  for (const [key, route] of routes) {
    if (hostMatchesEntry(host, key)) return route;
  }
  return undefined;
}

/** Validate route keys; each must be an entry already on the allowlist. */
function normaliseRoutes(
  routes: ReadonlyMap<string, EgressRoute> | undefined,
  allowlist: readonly string[],
): Map<string, EgressRoute> {
  const normalised = new Map<string, EgressRoute>();
  for (const [key, route] of routes ?? new Map<string, EgressRoute>()) {
    const host = validateEgressHost(key);
    if (!allowlist.includes(host)) {
      throw new Error(
        `egress route ${JSON.stringify(key)} is not on the egress allowlist`,
      );
    }
    normalised.set(host, route);
  }
  return normalised;
}

/**
 * Read the request head byte by byte-chunk until the blank line, enforcing the
 * size cap. Any bytes after the blank line are returned, not dropped.
 *
 * @param conn - The client connection
 * @param maxBytes - The head size cap, including the blank line
 * @param touch - Called on every read so the idle timer restarts
 * @returns The head, the rest, or why no head was read
 */
async function readHead(
  conn: Deno.Conn,
  maxBytes: number,
  touch: () => void,
): Promise<HeadRead> {
  let buffered = new Uint8Array(0);
  const chunk = new Uint8Array(Math.min(READ_CHUNK_BYTES, maxBytes));
  for (;;) {
    let count: number | null;
    try {
      count = await conn.read(chunk);
    } catch {
      // Peer reset or idle close: no request arrived, so nothing to refuse.
      return { kind: "closed" };
    }
    if (count === null) return { kind: "closed" };
    touch();
    buffered = concatBytes(buffered, chunk.subarray(0, count));
    const end = indexOfHeadEnd(buffered);
    if (end !== -1) {
      if (end + 4 > maxBytes) return { kind: "too-large" };
      return {
        kind: "head",
        head: decoder.decode(buffered.subarray(0, end)),
        rest: buffered.subarray(end + 4),
      };
    }
    if (buffered.length >= maxBytes) return { kind: "too-large" };
  }
}

/** Index of the first CRLFCRLF, or -1. */
function indexOfHeadEnd(bytes: Uint8Array): number {
  for (let i = 0; i + 3 < bytes.length; i++) {
    if (
      bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 &&
      bytes[i + 3] === 10
    ) {
      return i;
    }
  }
  return -1;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * Refuse a connection: log exactly one line, then write a 403 whose body opens
 * with `[EGRESS_DENIED]`. The caller closes the connection.
 *
 * @param client - The client connection
 * @param host - The requested host, sanitised for the log and body
 * @param port - The requested port, or 0 when unknown
 * @param reason - Why the connection was refused
 * @param logDenied - Receives the single denial line
 * @param detail - Optional error text for the log line only, never the body
 */
async function refuse(
  client: Deno.Conn,
  host: string,
  port: number,
  reason: EgressDenyReason,
  logDenied: (line: string) => void,
  detail?: string,
): Promise<void> {
  logDenied(formatEgressDenial(host, port, reason, detail));
  const body = encoder.encode(
    `[EGRESS_DENIED] host=${sanitiseEgressHost(host)} reason=${reason}\n`,
  );
  const head = "HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n" +
    "Connection: close\r\n" +
    `Content-Length: ${body.byteLength}\r\n\r\n`;
  try {
    await writeAll(client, encoder.encode(head));
    await writeAll(client, body);
  } catch {
    // The client closed before it read the refusal. The denial is already
    // logged, so nothing is lost by not delivering the body.
  }
}

/** Refuse a connection that arrived over the cap, then close it. */
async function refuseAtCapacity(
  conn: Deno.Conn,
  logDenied: (line: string) => void,
): Promise<void> {
  try {
    await refuse(conn, "-", 0, "capacity", logDenied);
  } finally {
    closeQuietly(conn);
  }
}

/**
 * Reply `200 Connection Established` and forward any bytes already read past
 * the request head to the upstream side.
 *
 * @returns False when the client or upstream went away during the handshake
 */
async function replyEstablished(
  client: Deno.Conn,
  upstream: Deno.Conn | undefined,
  rest: Uint8Array,
): Promise<boolean> {
  try {
    await writeAll(client, encoder.encode(CONNECTION_ESTABLISHED));
    if (upstream !== undefined && rest.length > 0) {
      await writeAll(upstream, rest);
    }
    return true;
  } catch {
    // The client closed before the tunnel opened; the tunnel is abandoned and
    // the caller's finally block closes both sides.
    return false;
  }
}

/**
 * Copy one direction of a tunnel byte for byte. A clean EOF half-closes the
 * far side; an error closes both sides so the opposite pipe ends too.
 */
async function pipe(
  from: Deno.Conn,
  to: Deno.Conn,
  touch: () => void,
): Promise<void> {
  const buffer = new Uint8Array(PIPE_CHUNK_BYTES);
  try {
    for (;;) {
      const count = await from.read(buffer);
      if (count === null) {
        try {
          await to.closeWrite();
        } catch {
          // The far side is already closed, so there is nothing to half-close.
        }
        return;
      }
      touch();
      await writeAll(to, buffer.subarray(0, count));
    }
  } catch {
    // One side went away or the idle timer closed it. Close both so the
    // opposite pipe ends as well; the payload is never logged.
    closeQuietly(from);
    closeQuietly(to);
  }
}

/**
 * The default resolver: A and AAAA combined. It throws only when both fail
 * and nothing was found.
 */
async function resolveHostAddresses(host: string): Promise<string[]> {
  const found: string[] = [];
  const failures: string[] = [];
  for (const kind of ["A", "AAAA"] as const) {
    try {
      found.push(...await Deno.resolveDns(host, kind));
    } catch (error) {
      failures.push(describe(error));
    }
  }
  if (found.length === 0 && failures.length > 0) {
    throw new Error(failures.join("; "));
  }
  return found;
}

/** The default connector: a plain TCP dial to the checked address. */
function connectUpstream(address: string, port: number): Promise<Deno.Conn> {
  return Deno.connect({ hostname: address, port });
}

/**
 * Restartable idle timer for one connection.
 *
 * @param ms - Milliseconds without activity before `onIdle` runs
 * @param onIdle - Runs once when the timer fires
 * @returns `touch` to restart the timer and `stop` to cancel it for good
 */
function idleGuard(
  ms: number,
  onIdle: () => void,
): { touch: () => void; stop: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active = true;
  const touch = (): void => {
    if (!active) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      onIdle();
    }, ms);
  };
  const stop = (): void => {
    active = false;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  return { touch, stop };
}

async function writeAll(conn: Deno.Conn, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    offset += await conn.write(bytes.subarray(offset));
  }
}

function closeQuietly(conn: Deno.Conn): void {
  try {
    conn.close();
  } catch {
    // Already closed; closing twice is harmless here.
  }
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer, got ${value}`);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
