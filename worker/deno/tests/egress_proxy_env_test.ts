/**
 * Tests for the runtime-neutral proxy environment (Issue #4051).
 *
 * The six variables must all point at the proxy port, NO_PROXY must stay
 * loopback only, and a proxy host that is not an IPv4 literal or a plain DNS
 * name must be refused before any variable is built.
 */

import { assertEquals, assertThrows } from "@std/assert";
import {
  EGRESS_NO_PROXY,
  EGRESS_PROXY_ENV_NAMES,
  EGRESS_PROXY_PORT,
  egressProxyEnv,
} from "../lib/egress_proxy_env.ts";

Deno.test("egress proxy port is 3128", () => {
  assertEquals(EGRESS_PROXY_PORT, 3128);
});

Deno.test("egress proxy env names are the six variables, in order", () => {
  assertEquals(EGRESS_PROXY_ENV_NAMES, [
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "https_proxy",
    "http_proxy",
    "NO_PROXY",
    "no_proxy",
  ]);
});

Deno.test("NO_PROXY is loopback only", () => {
  assertEquals(EGRESS_NO_PROXY, "localhost,127.0.0.1,::1");
});

Deno.test("egressProxyEnv points all four proxy variables at the proxy", () => {
  assertEquals(egressProxyEnv("192.168.64.9"), {
    HTTPS_PROXY: "http://192.168.64.9:3128",
    HTTP_PROXY: "http://192.168.64.9:3128",
    https_proxy: "http://192.168.64.9:3128",
    http_proxy: "http://192.168.64.9:3128",
    NO_PROXY: "localhost,127.0.0.1,::1",
    no_proxy: "localhost,127.0.0.1,::1",
  });
});

Deno.test("egressProxyEnv accepts a plain DNS name", () => {
  const env = egressProxyEnv("vibe-egress-proxy.internal");
  assertEquals(env.HTTPS_PROXY, "http://vibe-egress-proxy.internal:3128");
  assertEquals(Object.keys(env).sort(), [...EGRESS_PROXY_ENV_NAMES].sort());
});

Deno.test("egressProxyEnv refuses hosts that are neither an IPv4 literal nor a DNS name", () => {
  const refused = [
    "",
    "1.2.3",
    "999.1.1.1",
    "fe80::1",
    "http://proxy.internal",
    "proxy.internal:3128",
    "bad_host.example",
    "-leading.example",
    "a..b",
    "has space.example",
    `${"a".repeat(64)}.example`,
    "x".repeat(254),
  ];
  for (const host of refused) {
    assertThrows(
      () => egressProxyEnv(host),
      Error,
      "egress proxy host must be an IPv4 address or a plain DNS name",
    );
  }
});
