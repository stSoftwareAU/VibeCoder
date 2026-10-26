/**
 * Readiness marker contract for the `egress-proxy` command (Issue #4051).
 *
 * The Apple launcher (lib/apple_egress.ts) waits for EGRESS_PROXY_READY_MARKER
 * in the proxy container's logs and refuses to launch if it never appears. This
 * test pins the command's start-up line to that marker.
 *
 * The marker is read through a namespace import so this file still type-checks
 * and fails by assertion against an older lib/egress_proxy.ts that lacks the
 * export.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { egressProxyCommand } from "../commands/egress_proxy.ts";
import * as proxyLib from "../lib/egress_proxy.ts";
import type { WorkerConfig } from "../types.ts";

const CONFIG = {} as WorkerConfig;

Deno.test("the egress-proxy command's start-up line opens with the readiness marker the Apple launcher waits for", async () => {
  const marker = (proxyLib as Record<string, unknown>)[
    "EGRESS_PROXY_READY_MARKER"
  ];
  assert(
    typeof marker === "string" && marker.length > 0,
    "lib/egress_proxy.ts must export a non-empty string EGRESS_PROXY_READY_MARKER",
  );

  const logged: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    await egressProxyCommand.execute(
      { allow: "api.github.com", listen: "127.0.0.1:3128" },
      CONFIG,
      {
        start: (opts) =>
          Promise.resolve({
            addr: {
              transport: "tcp",
              hostname: opts.hostname ?? "",
              port: 3128,
            },
            close: () => Promise.resolve(),
          }),
        waitForStop: () => Promise.resolve(),
        env: {},
      },
    );
  } finally {
    console.error = originalError;
  }

  assertEquals(logged.length, 1, "expected exactly one start-up line");
  const line = logged[0]!;
  assert(
    line.startsWith(marker),
    `start-up line must open with ${marker}, got: ${line}`,
  );
  assertStringIncludes(line, "127.0.0.1:3128");
  assertStringIncludes(line, "hosts=1");
});
