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
import type { CommandResult, WorkerConfig } from "../types.ts";

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

Deno.test("egress-proxy - logs the bound address the proxy reports, not the requested port", async () => {
  // parseListen rejects port 0, so the request is for 4000; the fake start
  // stands in for the OS picking a free port and reports 41234 instead.
  const logged: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    await egressProxyCommand.execute(
      { allow: "crates.io", listen: "127.0.0.1:4000" },
      CONFIG,
      {
        start: (opts) =>
          Promise.resolve({
            addr: {
              transport: "tcp",
              hostname: opts.hostname ?? "",
              port: 41234,
            },
            close: () => Promise.resolve(),
          }),
        waitForStop: () => Promise.resolve(),
      },
    );
  } finally {
    console.error = originalError;
  }

  assertEquals(logged, [
    "[EGRESS_PROXY] listening on 127.0.0.1:41234 hosts=1",
  ]);
});

Deno.test("egress-proxy - execute with no allowlist fails with exit 2 and never starts the proxy", async () => {
  let started = 0;

  const result = await egressProxyCommand.execute(
    {},
    CONFIG,
    {
      env: {},
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

Deno.test("egress-proxy - execute takes the allowlist from env when --allow is absent", async () => {
  const started: Array<Parameters<typeof startEgressProxy>[0]> = [];

  const result = await egressProxyCommand.execute(
    { listen: "127.0.0.1:4001" },
    CONFIG,
    {
      env: { [EGRESS_ALLOW_HOSTS_ENV]: "api.github.com,crates.io" },
      start: (opts) => {
        started.push(opts);
        return Promise.resolve({
          addr: {
            transport: "tcp",
            hostname: opts.hostname ?? "",
            port: opts.port,
          },
          close: () => Promise.resolve(),
        });
      },
      waitForStop: () => Promise.resolve(),
    },
  );

  assertEquals(result.success, true);
  assertEquals(started.length, 1);
  assertEquals(started[0]!.allowlist, ["api.github.com", "crates.io"]);
  assertEquals(started[0]!.port, 4001);
});

Deno.test("egress-proxy - a proxy that fails to start returns exit 1 and names the cause", async () => {
  // The positive control (start succeeds, exit success) is the test above that
  // asserts result.success === true with the same valid allowlist.
  const logged: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  let result: CommandResult;
  try {
    result = await egressProxyCommand.execute(
      { allow: "api.github.com,crates.io", listen: "127.0.0.1:4002" },
      CONFIG,
      {
        start: () => Promise.reject(new Error("address already in use")),
        waitForStop: () => Promise.resolve(),
      },
    );
  } finally {
    console.error = originalError;
  }

  assertEquals(result.success, false);
  assertEquals(result.exitCode, 1);
  assertStringIncludes(result.message, "address already in use");
  assertEquals(logged.filter((line) => line.includes("listening")), []);
});

Deno.test("egress-proxy - is registered under the name egress-proxy", () => {
  assertEquals(egressProxyCommand.name, "egress-proxy");
});

Deno.test("egress-proxy - an --allow that is neither a string nor a string array is an error", () => {
  for (const allow of [5, true, { host: "crates.io" }, ["crates.io", 7]]) {
    assertThrows(
      () => parseEgressProxyArgs({ allow }, NO_ENV),
      Error,
      "--allow needs a comma-separated host list",
    );
  }
});

Deno.test("egress-proxy - a port that is not plain digits is an error even when it reads as a number", () => {
  // Number("+80"), Number("0x50") and Number("1e3") are all valid integers.
  for (const portText of ["+80", "0x50", "1e3", "-1"]) {
    assertThrows(
      () =>
        parseEgressProxyArgs(
          { allow: "crates.io", listen: `127.0.0.1:${portText}` },
          NO_ENV,
        ),
      Error,
      `has an invalid port "${portText}"`,
    );
  }
});

/** A start seam that reports the requested address and closes cleanly. */
const START_OK: NonNullable<
  Parameters<typeof egressProxyCommand.execute>[2]
>["start"] = (opts) =>
  Promise.resolve({
    addr: { transport: "tcp", hostname: opts.hostname ?? "", port: opts.port },
    close: () => Promise.resolve(),
  });

Deno.test("egress-proxy - a non-Error thrown while reading the arguments is reported as its text with exit 2", async () => {
  const args = {
    get allow(): string {
      throw "plain string failure";
    },
  };
  const result = await egressProxyCommand.execute(args, CONFIG, {
    start: START_OK,
    waitForStop: () => Promise.resolve(),
  });
  assertEquals(result, {
    success: false,
    exitCode: 2,
    message: "plain string failure",
  });
});

Deno.test("egress-proxy - an Error from the argument parser is reported as its bare message", async () => {
  const result = await egressProxyCommand.execute({}, CONFIG, {
    env: {},
    start: START_OK,
    waitForStop: () => Promise.resolve(),
  });
  assertEquals(
    result.message,
    `egress-proxy: no allowlist — pass --allow <hosts> or set ${EGRESS_ALLOW_HOSTS_ENV} (the allowlist is never read from a file)`,
  );
});

Deno.test("egress-proxy - a start failure reports the Error message or a plain rejection's text", async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    for (
      const [rejection, cause] of [
        [new Error("address already in use"), "address already in use"],
        ["socket gone", "socket gone"],
      ] as const
    ) {
      const result = await egressProxyCommand.execute(
        { allow: "crates.io", listen: "127.0.0.1:4003" },
        CONFIG,
        {
          start: () => Promise.reject(rejection),
          waitForStop: () => Promise.resolve(),
        },
      );
      assertEquals(
        result.message,
        `egress-proxy: could not start on 127.0.0.1:4003 — ${cause}`,
      );
    }
  } finally {
    console.error = originalError;
  }
});

type SignalHandler = () => void;

/**
 * Run the command with the default signal wait while `Deno.addSignalListener`
 * and `Deno.removeSignalListener` are replaced by recorders, then deliver
 * `deliver` by calling the handler the command registered for it. The delivery
 * happens in a microtask queued from the listening log line, which the command
 * writes immediately before it waits for the signal.
 */
async function runWithRecordedSignals(deliver: "SIGTERM" | "SIGINT"): Promise<{
  result: CommandResult;
  added: Array<[string, SignalHandler]>;
  removed: Array<[string, SignalHandler]>;
}> {
  const added: Array<[string, SignalHandler]> = [];
  const removed: Array<[string, SignalHandler]> = [];
  const denoAny = Deno as unknown as Record<string, unknown>;
  const originalAdd = denoAny["addSignalListener"];
  const originalRemove = denoAny["removeSignalListener"];
  const originalError = console.error;
  denoAny["addSignalListener"] = (signal: string, handler: SignalHandler) => {
    added.push([signal, handler]);
  };
  denoAny["removeSignalListener"] = (
    signal: string,
    handler: SignalHandler,
  ) => {
    removed.push([signal, handler]);
  };
  console.error = () => {
    queueMicrotask(() => {
      const target = added.find(([signal]) => signal === deliver) ?? added[0];
      target?.[1]();
    });
  };
  try {
    const result = await egressProxyCommand.execute(
      { allow: "crates.io", listen: "127.0.0.1:4004" },
      CONFIG,
      { start: START_OK },
    );
    return { result, added, removed };
  } finally {
    denoAny["addSignalListener"] = originalAdd;
    denoAny["removeSignalListener"] = originalRemove;
    console.error = originalError;
  }
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  Deno.test(`egress-proxy - the default wait stops on ${signal} and removes both signal listeners`, async () => {
    const { result, added, removed } = await runWithRecordedSignals(signal);
    assertEquals(added.map(([name]) => name), ["SIGTERM", "SIGINT"]);
    assertEquals(result.success, true);
    assertEquals(removed.map(([name]) => name), ["SIGTERM", "SIGINT"]);
    assertEquals(removed[0]![1], added[0]![1]);
    assertEquals(removed[1]![1], added[1]![1]);
  });
}
