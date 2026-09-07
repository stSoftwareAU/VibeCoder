/**
 * SSRF guard for outbound fetches of externally-supplied URLs (Issue #1387).
 *
 * `bounded_fetch.ts` bounds *how much* an outbound call may cost — a timeout
 * and a streamed size cap. It says nothing about *where* the call goes, so a
 * URL that arrived from a document, a manifest or an issue body could point
 * the worker at `http://169.254.169.254/`, at a service on `127.0.0.1`, or at
 * an RFC-1918 address inside the operator's network. This module is the other
 * half of the pair: it decides whether a URL may be dereferenced at all.
 *
 * Three things are checked, because any one of them alone is bypassable:
 *
 *  1. **Shape** — `https:` only, no `user:pass@` userinfo, no port other than
 *     443, and no intranet-style hostname (`localhost`, a single-label name,
 *     `.local` / `.internal` / `.home.arpa`).
 *  2. **Address** — an IP literal is rejected when it falls in a loopback,
 *     link-local, unique-local, RFC-1918, CGNAT, multicast or reserved range,
 *     and a hostname is resolved first so `evil.example.com A 10.0.0.5` is
 *     rejected too.
 *  3. **Every redirect hop** — redirects are followed manually and each hop is
 *     re-validated. `redirect: "follow"` re-validates nothing, so a public URL
 *     that 302s to `http://127.0.0.1:6379/` defeats checks 1 and 2 entirely.
 *
 * Fail loud: a URL that cannot be validated, a hostname that will not resolve,
 * or a redirect chain that runs past {@link MAX_REDIRECT_HOPS} is an error —
 * never a quietly skipped fetch reported as a clean one.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import type { Result } from "../types.ts";
import {
  DEFAULT_FETCH_TIMEOUT_MS,
  describeFetchFailure,
  discardBody,
  withRequestTimeout,
} from "./bounded_fetch.ts";

/** Redirect hops followed before the chain is refused. */
export const MAX_REDIRECT_HOPS = 5;

/** Hostname suffixes that name an intranet, never a public source. */
const INTRANET_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".home.arpa",
] as const;

/** Injectable I/O so the guard is testable without the network. */
export interface UrlGuardDeps {
  /** Performs one HTTP request. */
  fetchFn: (url: string, init: RequestInit) => Promise<Response>;
  /** Resolves a hostname to its IP addresses; throws when it cannot. */
  resolveHostFn: (hostname: string) => Promise<string[]>;
}

/** Dotted-quad IPv4, before any range test. */
const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Parse a dotted-quad into its four octets, or null when it is not one. */
function parseIpv4(address: string): number[] | null {
  const match = IPV4_PATTERN.exec(address);
  if (match === null) return null;
  const octets = match.slice(1).map((part) => Number.parseInt(part, 10));
  return octets.every((octet) => octet <= 255) ? octets : null;
}

/**
 * Parse an IPv6 literal into its 16 bytes, or null when it is not one.
 *
 * Handles the `::` run and a trailing dotted-quad (`::ffff:127.0.0.1`), both
 * of which appear in resolver output; the WHATWG URL parser normalises the
 * latter to hex, so both forms must map to the same bytes.
 */
function parseIpv6(address: string): number[] | null {
  if (!address.includes(":")) return null;
  const runs = address.split("::");
  if (runs.length > 2) return null;

  const expand = (run: string): number[] | null => {
    if (run === "") return [];
    const bytes: number[] = [];
    const groups = run.split(":");
    for (const [index, group] of groups.entries()) {
      const quad = parseIpv4(group);
      if (quad !== null) {
        // A dotted-quad tail is only legal as the final group.
        if (index !== groups.length - 1) return null;
        bytes.push(...quad);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      const value = Number.parseInt(group, 16);
      bytes.push((value >> 8) & 0xff, value & 0xff);
    }
    return bytes;
  };

  const head = expand(runs[0] ?? "");
  const tail = runs.length === 2 ? expand(runs[1] ?? "") : [];
  if (head === null || tail === null) return null;
  const gap = 16 - head.length - tail.length;
  if (runs.length === 2 ? gap < 0 : gap !== 0) return null;
  return [...head, ...new Array(gap).fill(0), ...tail];
}

/** True when a dotted-quad falls outside the publicly routable space. */
function isPrivateIpv4(octets: readonly number[]): boolean {
  const [a = 0, b = 0, c = 0] = octets;
  if (a === 0) return true; // "this network", 0.0.0.0
  if (a === 10) return true; // RFC 1918
  if (a === 127) return true; // loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 169 && b === 254) return true; // link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918
  if (a === 192 && b === 0 && c === 0) return true; // protocol assignments
  if (a === 192 && b === 168) return true; // RFC 1918
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

/** True when 16 IPv6 bytes fall outside the publicly routable space. */
function isPrivateIpv6(bytes: readonly number[]): boolean {
  const [b0 = 0, b1 = 0] = bytes;
  if (bytes.every((byte) => byte === 0)) return true; // ::
  if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) {
    return true; // ::1 loopback
  }
  if ((b0 & 0xfe) === 0xfc) return true; // unique-local fc00::/7
  if (b0 === 0xfe && (b1 & 0xc0) === 0x80) return true; // link-local fe80::/10
  if (b0 === 0xff) return true; // multicast
  const mapped = bytes.slice(0, 10).every((byte) => byte === 0) &&
    bytes[10] === 0xff && bytes[11] === 0xff;
  if (mapped) return isPrivateIpv4(bytes.slice(12)); // ::ffff:a.b.c.d
  return false;
}

/**
 * Report whether an IP address is one the worker must never dereference.
 *
 * A string that is neither a v4 nor a v6 literal is treated as private: an
 * address form this guard does not understand is not one it can clear.
 *
 * @param address - An IP literal, with or without IPv6 brackets
 * @returns True when the address is loopback, link-local, private or reserved
 */
export function isPrivateAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const v4 = parseIpv4(bare);
  if (v4 !== null) return isPrivateIpv4(v4);
  const v6 = parseIpv6(bare);
  if (v6 !== null) return isPrivateIpv6(v6);
  return true;
}

/** True when a hostname names an intranet rather than a public host. */
function isIntranetHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost") return true;
  if (!host.includes(".")) return true; // single-label intranet name
  return INTRANET_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * Validate the *shape* of an externally-supplied URL.
 *
 * Accepts only `https://` URLs with no embedded credentials, no port other
 * than 443, a hostname that is not an intranet name, and — when the host is
 * an IP literal — an address outside every private range. Hostnames still
 * need {@link assertPublicHost} to clear what they resolve to.
 *
 * @param rawUrl - The candidate URL, verbatim from untrusted input
 * @returns The parsed URL, or the reason it was refused
 */
export function assertPublicHttpsUrl(rawUrl: string): Result<URL, string> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, error: `unparseable URL ${rawUrl}` };
  }
  if (url.protocol !== "https:") {
    return {
      ok: false,
      error: `refusing non-HTTPS URL ${rawUrl} (scheme ${url.protocol})`,
    };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, error: "refusing URL with embedded credentials" };
  }
  if (url.port !== "" && url.port !== "443") {
    return { ok: false, error: `refusing URL with explicit port ${url.port}` };
  }
  const hostname = url.hostname;
  if (hostname === "") {
    return { ok: false, error: `refusing URL with no host: ${rawUrl}` };
  }
  if (hostname.startsWith("[") || parseIpv4(hostname) !== null) {
    return isPrivateAddress(hostname)
      ? {
        ok: false,
        error: `refusing URL pointing at the private address ${hostname}`,
      }
      : { ok: true, value: url };
  }
  if (isIntranetHostname(hostname)) {
    return {
      ok: false,
      error: `refusing URL pointing at the intranet host ${hostname}`,
    };
  }
  return { ok: true, value: url };
}

/**
 * Resolve a URL's hostname and refuse it when any address is private.
 *
 * An IP literal has already been range-checked by
 * {@link assertPublicHttpsUrl} and is passed through. A hostname that
 * resolves to nothing at all is refused rather than fetched hopefully.
 *
 * @param url - A URL already cleared by {@link assertPublicHttpsUrl}
 * @param resolveHostFn - Hostname resolver
 * @returns The URL, or the reason it was refused
 */
export async function assertPublicHost(
  url: URL,
  resolveHostFn: UrlGuardDeps["resolveHostFn"],
): Promise<Result<URL, string>> {
  const hostname = url.hostname;
  if (hostname.startsWith("[") || parseIpv4(hostname) !== null) {
    return { ok: true, value: url };
  }
  let addresses: string[];
  try {
    addresses = await resolveHostFn(hostname);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `could not resolve ${hostname}: ${detail}` };
  }
  if (addresses.length === 0) {
    return { ok: false, error: `could not resolve ${hostname} to any address` };
  }
  const priv = addresses.find((address) => isPrivateAddress(address));
  if (priv !== undefined) {
    return {
      ok: false,
      error: `refusing ${hostname}: it resolves to the private address ${priv}`,
    };
  }
  return { ok: true, value: url };
}

/** True for a status that carries a `Location` the client must follow. */
function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 ||
    status === 307 || status === 308;
}

/**
 * Fetch an externally-supplied URL, validating it and every redirect hop.
 *
 * The request carries one shared abort signal for the whole chain, so the
 * total elapsed time is bounded however many hops are followed. The caller
 * still owes the response a bounded read (`readTextBounded`).
 *
 * @param rawUrl - The candidate URL, verbatim from untrusted input
 * @param init - Request init; `redirect` is overridden to `manual`
 * @param deps - Injectable fetch and resolver
 * @param timeoutMs - Budget for the whole redirect chain
 * @returns The first non-redirect response
 * @throws Error when any hop fails validation, the chain is too long, or the
 *   request itself fails
 */
export async function fetchPublicUrl(
  rawUrl: string,
  init: RequestInit = {},
  deps: UrlGuardDeps = createDefaultUrlGuardDeps(),
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  // One signal for the whole chain, so hops cannot multiply the budget.
  const bounded = withRequestTimeout(
    { ...init, redirect: "manual" },
    timeoutMs,
  );
  let target = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    const shape = assertPublicHttpsUrl(target);
    if (!shape.ok) throw new Error(shape.error);
    const host = await assertPublicHost(shape.value, deps.resolveHostFn);
    if (!host.ok) throw new Error(host.error);

    let response: Response;
    try {
      response = await deps.fetchFn(host.value.href, bounded);
    } catch (error) {
      throw new Error(
        `could not fetch ${host.value.href}: ` +
          describeFetchFailure(error, timeoutMs),
      );
    }
    if (!isRedirect(response.status)) return response;

    const location = response.headers.get("location");
    await discardBody(response);
    if (location === null || location.trim() === "") {
      throw new Error(
        `${host.value.href} returned HTTP ${response.status} with no Location`,
      );
    }
    try {
      target = new URL(location, host.value).href;
    } catch {
      throw new Error(`unparseable redirect target ${location}`);
    }
  }
  throw new Error(
    `refusing ${rawUrl}: more than ${MAX_REDIRECT_HOPS} redirect hops`,
  );
}

/**
 * Resolve a hostname to its A and AAAA addresses.
 *
 * A record type with no answer contributes nothing; a hostname with no answer
 * of either type throws, so an unresolvable host is loud rather than silently
 * fetched.
 */
async function resolveHostAddresses(hostname: string): Promise<string[]> {
  const found: string[] = [];
  const failures: string[] = [];
  for (const kind of ["A", "AAAA"] as const) {
    try {
      found.push(...await Deno.resolveDns(hostname, kind));
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (found.length === 0 && failures.length > 0) {
    throw new Error(failures.join("; "));
  }
  return found;
}

/** Production dependencies — the real `fetch` and the system resolver. */
export function createDefaultUrlGuardDeps(): UrlGuardDeps {
  return {
    fetchFn: (url, requestInit) => fetch(url, requestInit),
    resolveHostFn: resolveHostAddresses,
  };
}
