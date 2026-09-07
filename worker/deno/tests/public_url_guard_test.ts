/**
 * Tests for the SSRF guard on externally-supplied URLs (Issue #1387).
 *
 * Every test calls the real guard with real data: a URL shape, an address, or
 * a redirect chain served by an injected fetch. Nothing here touches the
 * network — the resolver is injected too.
 *
 * Uses Australian English throughout (behaviour, organisation, colour).
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  assertPublicHost,
  assertPublicHttpsUrl,
  fetchPublicUrl,
  isPrivateAddress,
  MAX_REDIRECT_HOPS,
  type UrlGuardDeps,
} from "../lib/public_url_guard.ts";

/** Guard deps that fail loud unless the test supplies what it expects. */
function deps(overrides: Partial<UrlGuardDeps> = {}): UrlGuardDeps {
  return {
    fetchFn: (url) => {
      throw new Error(`unexpected fetch: ${url}`);
    },
    resolveHostFn: (host) => {
      throw new Error(`unexpected resolve: ${host}`);
    },
    ...overrides,
  };
}

/** A resolver answering every hostname with one fixed address. */
function resolvesTo(...addresses: string[]): UrlGuardDeps["resolveHostFn"] {
  return () => Promise.resolve(addresses);
}

/** Reason text of a refused URL, or "" when it was accepted. */
function refusal(rawUrl: string): string {
  const result = assertPublicHttpsUrl(rawUrl);
  return result.ok ? "" : result.error;
}

// ---------------------------------------------------------------------------
// Address classification
// ---------------------------------------------------------------------------

Deno.test("isPrivateAddress flags every private and reserved IPv4 range", () => {
  for (
    const address of [
      "0.0.0.0",
      "10.1.2.3",
      "127.0.0.1",
      "100.100.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "172.31.255.254",
      "192.168.1.1",
      "192.0.0.1",
      "198.18.0.1",
      "224.0.0.1",
      "255.255.255.255",
    ]
  ) {
    assertEquals(isPrivateAddress(address), true, address);
  }
});

Deno.test("isPrivateAddress clears publicly routable IPv4 addresses", () => {
  for (const address of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "9.9.9.9"]) {
    assertEquals(isPrivateAddress(address), false, address);
  }
});

Deno.test("isPrivateAddress flags loopback, unique-local and mapped IPv6", () => {
  for (
    const address of [
      "::1",
      "[::1]",
      "::",
      "fd00::1",
      "fc00::1",
      "fe80::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "ff02::1",
    ]
  ) {
    assertEquals(isPrivateAddress(address), true, address);
  }
});

Deno.test("isPrivateAddress clears a public IPv6 address", () => {
  assertEquals(isPrivateAddress("2606:2800:220:1:248:1893:25c8:1946"), false);
});

Deno.test("isPrivateAddress refuses an address form it cannot parse", () => {
  // An unrecognised form is not one the guard can clear.
  assertEquals(isPrivateAddress("not-an-address"), true);
  assertEquals(isPrivateAddress("999.1.1.1"), true);
});

// ---------------------------------------------------------------------------
// URL shape
// ---------------------------------------------------------------------------

Deno.test("assertPublicHttpsUrl accepts an ordinary https source URL", () => {
  const result = assertPublicHttpsUrl("https://semver.org/spec/v2.0.0.html");
  assert(result.ok);
  assertEquals(result.value.hostname, "semver.org");
});

Deno.test("assertPublicHttpsUrl refuses a non-HTTPS scheme", () => {
  assert(refusal("http://example.com/").includes("non-HTTPS"));
  assert(refusal("file:///etc/passwd").includes("non-HTTPS"));
});

Deno.test("assertPublicHttpsUrl refuses embedded credentials", () => {
  assert(refusal("https://user:pw@example.com/").includes("credentials"));
});

Deno.test("assertPublicHttpsUrl refuses an explicit non-443 port", () => {
  assert(refusal("https://example.com:6379/").includes("port 6379"));
  assertEquals(refusal("https://example.com:443/"), "");
});

Deno.test("assertPublicHttpsUrl refuses loopback and metadata literals", () => {
  for (
    const url of [
      "https://127.0.0.1/",
      "https://169.254.169.254/latest/meta-data/",
      "https://10.0.0.5/admin",
      "https://[::1]/",
      "https://[::ffff:127.0.0.1]/",
    ]
  ) {
    assert(refusal(url).includes("private address"), url);
  }
});

Deno.test("assertPublicHttpsUrl refuses obfuscated loopback forms", () => {
  // The URL parser normalises these to 127.0.0.1 before the range test.
  assert(refusal("https://2130706433/").includes("private address"));
  assert(refusal("https://0177.0.0.1/").includes("private address"));
});

Deno.test("assertPublicHttpsUrl refuses intranet hostnames", () => {
  for (
    const url of [
      "https://localhost/",
      "https://metadata/",
      "https://printer.local/",
      "https://vault.internal/",
      "https://box.home.arpa/",
    ]
  ) {
    assert(refusal(url).includes("intranet host"), url);
  }
});

Deno.test("assertPublicHttpsUrl refuses an unparseable URL", () => {
  assert(refusal("not a url").includes("unparseable"));
});

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

Deno.test("assertPublicHost refuses a hostname that resolves privately", async () => {
  const url = new URL("https://rebind.example.com/");
  const result = await assertPublicHost(url, resolvesTo("10.0.0.5"));
  assert(!result.ok);
  assert(result.error.includes("10.0.0.5"), result.error);
});

Deno.test("assertPublicHost accepts a hostname that resolves publicly", async () => {
  const url = new URL("https://semver.org/");
  const result = await assertPublicHost(url, resolvesTo("93.184.216.34"));
  assert(result.ok);
});

Deno.test("assertPublicHost fails loud when a hostname resolves to nothing", async () => {
  const url = new URL("https://gone.example.com/");
  const result = await assertPublicHost(url, resolvesTo());
  assert(!result.ok);
  assert(result.error.includes("could not resolve"), result.error);
});

Deno.test("assertPublicHost reports a resolver failure rather than fetching", async () => {
  const url = new URL("https://gone.example.com/");
  const result = await assertPublicHost(url, () => {
    throw new Error("SERVFAIL");
  });
  assert(!result.ok);
  assert(result.error.includes("SERVFAIL"), result.error);
});

// ---------------------------------------------------------------------------
// Fetching, including redirects
// ---------------------------------------------------------------------------

Deno.test("fetchPublicUrl returns the response for a cleared URL", async () => {
  const response = await fetchPublicUrl(
    "https://semver.org/",
    {},
    deps({
      fetchFn: () => Promise.resolve(new Response("hello")),
      resolveHostFn: resolvesTo("93.184.216.34"),
    }),
  );
  assertEquals(await response.text(), "hello");
});

Deno.test("fetchPublicUrl re-validates each redirect hop", async () => {
  const seen: string[] = [];
  const error = await assertRejects(() =>
    fetchPublicUrl(
      "https://semver.org/",
      {},
      deps({
        fetchFn: (url) => {
          seen.push(url);
          return Promise.resolve(
            new Response(null, {
              status: 302,
              headers: { location: "http://169.254.169.254/latest/" },
            }),
          );
        },
        resolveHostFn: resolvesTo("93.184.216.34"),
      }),
    ), Error);
  // The hop was refused before it was ever requested.
  assertEquals(seen, ["https://semver.org/"]);
  assert(error.message.includes("non-HTTPS"), error.message);
});

Deno.test("fetchPublicUrl refuses a redirect to a private address", async () => {
  const error = await assertRejects(() =>
    fetchPublicUrl(
      "https://semver.org/",
      {},
      deps({
        fetchFn: () =>
          Promise.resolve(
            new Response(null, {
              status: 301,
              headers: { location: "https://10.0.0.5/admin" },
            }),
          ),
        resolveHostFn: resolvesTo("93.184.216.34"),
      }),
    ), Error);
  assert(error.message.includes("private address"), error.message);
});

Deno.test("fetchPublicUrl follows a public redirect and returns the body", async () => {
  const response = await fetchPublicUrl(
    "https://semver.org/",
    {},
    deps({
      fetchFn: (url) =>
        Promise.resolve(
          url === "https://semver.org/"
            ? new Response(null, {
              status: 308,
              headers: { location: "https://semver.org/spec/v2.0.0.html" },
            })
            : new Response("the spec"),
        ),
      resolveHostFn: resolvesTo("93.184.216.34"),
    }),
  );
  assertEquals(await response.text(), "the spec");
});

Deno.test("fetchPublicUrl refuses a redirect chain past the hop cap", async () => {
  let hops = 0;
  const error = await assertRejects(() =>
    fetchPublicUrl(
      "https://semver.org/0",
      {},
      deps({
        fetchFn: () => {
          hops++;
          return Promise.resolve(
            new Response(null, {
              status: 302,
              headers: { location: `https://semver.org/${hops}` },
            }),
          );
        },
        resolveHostFn: resolvesTo("93.184.216.34"),
      }),
    ), Error);
  assertEquals(hops, MAX_REDIRECT_HOPS + 1);
  assert(error.message.includes("redirect hops"), error.message);
});

Deno.test("fetchPublicUrl fails loud on a redirect with no Location", async () => {
  const error = await assertRejects(() =>
    fetchPublicUrl(
      "https://semver.org/",
      {},
      deps({
        fetchFn: () => Promise.resolve(new Response(null, { status: 302 })),
        resolveHostFn: resolvesTo("93.184.216.34"),
      }),
    ), Error);
  assert(error.message.includes("no Location"), error.message);
});

Deno.test("fetchPublicUrl names the failure when the request itself throws", async () => {
  const error = await assertRejects(() =>
    fetchPublicUrl(
      "https://semver.org/",
      {},
      deps({
        fetchFn: () => Promise.reject(new TypeError("connection refused")),
        resolveHostFn: resolvesTo("93.184.216.34"),
      }),
    ), Error);
  assert(error.message.includes("connection refused"), error.message);
});
