/**
 * Tests for the `egress-proxy` command (Issue #4046).
 *
 * The argument parser and `execute` are exercised directly; the proxy start and
 * the wait for a stop signal are injected so no socket is bound and no signal
 * is raised.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  EGRESS_ALLOW_HOSTS_ENV,
  egressProxyCommand,
  parseEgressProxyArgs,
} from "../commands/egress_proxy.ts";
import { startEgressProxy } from "../lib/egress_proxy.ts";
import type { WorkerConfig } from "../types.ts";

const CONFIG = {} as WorkerConfig;

const NO_ENV: Record<string, string | undefined> = {};

Deno.test("egress-proxy - parses a comma-separated --allow and defaults --listen", () => {
  const parsed = parseEgressProxyArgs(
    { allow: "api.github.com,registry.npmjs.org" },
    NO_ENV,
  );
  assertEquals(parsed, {
    hostname: "127.0.0.1",
    port: 3128,
    allowlist: ["api.github.com", "registry.npmjs.org"],
  });
});

Deno.test("egress-proxy - accepts an array --allow, as mod.ts parseArgs yields for a JSON array", () => {
  const parsed = parseEgressProxyArgs(
    {
      allow: ["api.github.com", "registry.npmjs.org"],
      listen: "127.0.0.1:4000",
    },
    NO_ENV,
  );
  assertEquals(parsed.allowlist, ["api.github.com", "registry.npmjs.org"]);
  assertEquals(parsed.port, 4000);
});

Deno.test("egress-proxy - reads VIBE_EGRESS_ALLOW_HOSTS when --allow is absent", () => {
  const parsed = parseEgressProxyArgs(
    {},
    { [EGRESS_ALLOW_HOSTS_ENV]: "api.github.com,crates.io" },
  );
  assertEquals(parsed.allowlist, ["api.github.com", "crates.io"]);
});

Deno.test("egress-proxy - --allow beats VIBE_EGRESS_ALLOW_HOSTS", () => {
  const parsed = parseEgressProxyArgs(
    { allow: "pypi.org" },
    { [EGRESS_ALLOW_HOSTS_ENV]: "api.github.com" },
  );
  assertEquals(parsed.allowlist, ["pypi.org"]);
});

Deno.test("egress-proxy - a missing allowlist is an error naming both sources", () => {
  assertThrows(
    () => parseEgressProxyArgs({}, NO_ENV),
    Error,
    `no allowlist — pass --allow <hosts> or set ${EGRESS_ALLOW_HOSTS_ENV}`,
  );
});

Deno.test("egress-proxy - an empty VIBE_EGRESS_ALLOW_HOSTS counts as missing", () => {
  assertThrows(
    () => parseEgressProxyArgs({}, { [EGRESS_ALLOW_HOSTS_ENV]: "   " }),
    Error,
    "no allowlist",
  );
});

Deno.test("egress-proxy - a port outside 1-65535 is an error", () => {
  for (const listen of ["127.0.0.1:0", "127.0.0.1:65536", "127.0.0.1:http"]) {
    assertThrows(
      () => parseEgressProxyArgs({ allow: "crates.io", listen }, NO_ENV),
      Error,
      `has an invalid port`,
    );
  }
});

Deno.test("egress-proxy - a --listen without a host is an error", () => {
  assertThrows(
    () => parseEgressProxyArgs({ allow: "crates.io", listen: ":3128" }, NO_ENV),
    Error,
    `has no host (expected host:port)`,
  );
});

Deno.test("egress-proxy - a literal IP in the allowlist is rejected by name", () => {
  assertThrows(
    () => parseEgressProxyArgs({ allow: "api.github.com,203.0.113.7" }, NO_ENV),
    Error,
    "203.0.113.7",
  );
});

Deno.test("egress-proxy - execute starts the proxy, waits, closes it and succeeds", async () => {
  const started: Array<Parameters<typeof startEgressProxy>[0]> = [];
  let closed = 0;
  let waited = 0;

  const result = await egressProxyCommand.execute(
    { allow: "api.github.com,crates.io", listen: "127.0.0.1:4000" },
    CONFIG,
    {
      start: (opts) => {
        started.push(opts);
        return Promise.resolve({
          addr: {
            transport: "tcp",
            hostname: opts.hostname ?? "",
            port: opts.port,
          },
          close: () => {
            closed++;
            return Promise.resolve();
          },
        });
      },
      waitForStop: () => {
        waited++;
        return Promise.resolve();
      },
    },
  );

  assertEquals(started.length, 1);
  assertEquals(started[0]!.hostname, "127.0.0.1");
  assertEquals(started[0]!.port, 4000);
  assertEquals(started[0]!.allowlist, ["api.github.com", "crates.io"]);
  assertEquals(waited, 1);
  assertEquals(closed, 1);
  assertEquals(result.success, true);
});

Deno.test("egress-proxy - execute with no allowlist fails with exit 2 and never starts the proxy", async () => {
  let started = 0;

  const result = await egressProxyCommand.execute(
    {},
    CONFIG,
    {
      start: () => {
        started++;
        return Promise.reject(new Error("must not start"));
      },
      waitForStop: () => Promise.resolve(),
    },
  );

  assertEquals(started, 0);
  assertEquals(result.success, false);
  assertEquals(result.exitCode, 2);
  assertStringIncludes(result.message, "no allowlist");
});
