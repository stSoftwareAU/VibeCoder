/**
 * Egress self-check classification (Issue #4048).
 *
 * Probe results are injected. Nothing here opens a socket.
 */

import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  checkEgressPolicy,
  classifyEgressProbes,
  decideEgressPolicy,
  describeProbeFailures,
  EGRESS_NOT_ENFORCED_MARKER,
  EGRESS_SELFCHECK_EXIT_STATUS,
  EGRESS_SELFCHECK_FAILURE_MARKER,
  type EgressProbeResults,
  type EgressVerdict,
  egressVerdictPassed,
  formatEgressPolicyRecord,
  probeProxyConnectDetailed,
  runEgressProbes,
  waitForProxyListener,
} from "../lib/egress_selfcheck.ts";

const DATE = "2026-10-26";

const enforcedProbes: EgressProbeResults = {
  directCloudflare: "refused",
  directGithub: "refused",
  proxyDenied: "denied",
  proxyAllowed: "succeeded",
};

function probes(over: Partial<EgressProbeResults>): EgressProbeResults {
  return { ...enforcedProbes, ...over };
}

Deno.test("classifyEgressProbes - the four-probe success is the only enforced verdict", () => {
  assertEquals(classifyEgressProbes(enforcedProbes), "enforced");
  assertEquals(egressVerdictPassed("enforced"), true);
  for (
    const verdict of [
      "unenforced",
      "proxy_unavailable",
      "not_checked",
      "not_enforced",
    ] as const
  ) {
    assertEquals(egressVerdictPassed(verdict), false);
  }
});

Deno.test("classifyEgressProbes - a direct or denied connection that got through is unenforced", () => {
  assertEquals(
    classifyEgressProbes(probes({ directCloudflare: "connected" })),
    "unenforced",
  );
  assertEquals(
    classifyEgressProbes(probes({ directGithub: "connected" })),
    "unenforced",
  );
  assertEquals(
    classifyEgressProbes(probes({ proxyDenied: "through" })),
    "unenforced",
  );
  // A hole beats a probe that could not run.
  assertEquals(
    classifyEgressProbes(probes({
      directCloudflare: "connected",
      proxyAllowed: "not_checked",
    })),
    "unenforced",
  );
});

Deno.test("classifyEgressProbes - an allowlisted CONNECT that failed is proxy_unavailable", () => {
  assertEquals(
    classifyEgressProbes(probes({ proxyAllowed: "failed" })),
    "proxy_unavailable",
  );
  assertEquals(egressVerdictPassed("proxy_unavailable"), false);
});

Deno.test("classifyEgressProbes - a probe that could not run is not_checked and never enforced", () => {
  for (
    const over of [
      { directCloudflare: "not_checked" as const },
      { directGithub: "not_checked" as const },
      { proxyDenied: "not_checked" as const },
      { proxyAllowed: "not_checked" as const },
    ]
  ) {
    const verdict = classifyEgressProbes(probes(over));
    assertEquals(verdict, "not_checked");
    assertEquals(egressVerdictPassed(verdict), false);
  }
});

Deno.test("decideEgressPolicy - an enforcing runtime exits on every verdict except enforced", () => {
  const cases: Array<{ probes: EgressProbeResults; verdict: EgressVerdict }> = [
    { probes: enforcedProbes, verdict: "enforced" },
    {
      probes: probes({ directCloudflare: "connected" }),
      verdict: "unenforced",
    },
    {
      probes: probes({ proxyAllowed: "failed" }),
      verdict: "proxy_unavailable",
    },
    {
      probes: probes({ proxyDenied: "not_checked" }),
      verdict: "not_checked",
    },
  ];
  for (const item of cases) {
    const decision = decideEgressPolicy({
      flag: "true",
      dialect: "docker",
      version: "27.1.1",
      date: DATE,
      probes: item.probes,
    });
    assertEquals(decision.verdict, item.verdict);
    assertEquals(decision.passed, item.verdict === "enforced");
    if (item.verdict === "enforced") {
      assertEquals(decision.exitCode, 0);
      assertEquals(decision.marker, undefined);
    } else {
      assertEquals(decision.exitCode, EGRESS_SELFCHECK_EXIT_STATUS);
      assert(
        decision.marker?.startsWith(EGRESS_SELFCHECK_FAILURE_MARKER),
        decision.marker,
      );
    }
    assertEquals(decision.record.includes("runtime=docker"), true);
    assertEquals(decision.record.includes("version=27.1.1"), true);
    assertEquals(decision.record.includes(`date=${DATE}`), true);
    assertEquals(
      decision.record.startsWith(`egress policy: ${item.verdict} `),
      true,
    );
  }
});

Deno.test("decideEgressPolicy - a non-enforcing dialect warns and continues", () => {
  const decision = decideEgressPolicy({
    flag: "false",
    dialect: "apple-container",
    version: "unknown",
    date: DATE,
  });
  assertEquals(decision.verdict, "not_enforced");
  assertEquals(decision.passed, false);
  assertEquals(decision.exitCode, 0);
  assertEquals(decision.marker, undefined);
  assertEquals(
    decision.warning,
    `${EGRESS_NOT_ENFORCED_MARKER} dialect=apple-container`,
  );
  assertEquals(
    decision.record,
    "egress policy: not_enforced runtime=apple-container version=unknown date=2026-10-26",
  );
});

Deno.test("decideEgressPolicy - an absent flag records not_enforced and does not warn", () => {
  const decision = decideEgressPolicy({
    flag: "absent",
    dialect: "unspecified",
    version: "unknown",
    date: DATE,
  });
  assertEquals(decision.verdict, "not_enforced");
  assertEquals(decision.exitCode, 0);
  assertEquals(decision.warning, undefined);
  assertEquals(decision.passed, false);
});

Deno.test("checkEgressPolicy - injected probes do not require a flag-true runner", async () => {
  const decision = await checkEgressPolicy({
    env: (name) =>
      ({
        VIBE_EGRESS_ENFORCED: "true",
        VIBE_RUNTIME_KIND: "podman",
        VIBE_RUNTIME_VERSION: "5.2",
      })[name],
    probes: probes({ proxyAllowed: "failed" }),
    date: DATE,
    probe: () => {
      throw new Error("injected probes must not call the runner");
    },
  });
  assertEquals(decision.verdict, "proxy_unavailable");
  assertEquals(decision.exitCode, EGRESS_SELFCHECK_EXIT_STATUS);
});

Deno.test("checkEgressPolicy - a false flag does not run probes", async () => {
  const decision = await checkEgressPolicy({
    env: (name) =>
      ({
        VIBE_EGRESS_ENFORCED: "false",
        VIBE_RUNTIME_KIND: "apple-container",
      })[name],
    date: DATE,
    probe: () => {
      throw new Error("a non-enforcing dialect must not probe");
    },
  });
  assertEquals(decision.verdict, "not_enforced");
  assertEquals(decision.exitCode, 0);
  assert(decision.warning?.includes("apple-container"));
});

Deno.test("formatEgressPolicyRecord - refuses a field that is not one token", () => {
  assertThrows(() =>
    formatEgressPolicyRecord({
      verdict: "enforced",
      runtime: "docker",
      version: "has space",
      date: DATE,
    })
  );
  assertThrows(() =>
    formatEgressPolicyRecord({
      verdict: "enforced",
      runtime: "docker",
      version: "27",
      date: "26 Oct 2026",
    })
  );
});

Deno.test("decideEgressPolicy - a failed allowlisted CONNECT names what it saw (Issue #4493)", () => {
  const decision = decideEgressPolicy({
    flag: "true",
    dialect: "docker",
    version: "27.1.1",
    date: DATE,
    probes: probes({
      proxyAllowed: "failed",
      observed: { proxyAllowed: "refused ×3" },
    }),
  });
  assertEquals(
    decision.marker,
    `${EGRESS_SELFCHECK_FAILURE_MARKER} proxy_unavailable proxyAllowed=failed (refused ×3)`,
  );
  assertEquals(decision.exitCode, EGRESS_SELFCHECK_EXIT_STATUS);
});

Deno.test("decideEgressPolicy - probes without detail keep the old marker (Issue #4493)", () => {
  const decision = decideEgressPolicy({
    flag: "true",
    dialect: "docker",
    version: "27.1.1",
    date: DATE,
    probes: probes({ proxyAllowed: "failed" }),
  });
  assertEquals(
    decision.marker,
    `${EGRESS_SELFCHECK_FAILURE_MARKER} proxy_unavailable`,
  );
});

Deno.test("describeProbeFailures - names each CONNECT probe that did not pass, with its detail (Issue #4493)", () => {
  assertEquals(
    describeProbeFailures(probes({
      proxyAllowed: "failed",
      observed: { proxyAllowed: "timeout ×1, HTTP/1.1 502 Bad Gateway ×2" },
    })),
    ["proxyAllowed=failed (timeout ×1, HTTP/1.1 502 Bad Gateway ×2)"],
  );
  assertEquals(
    describeProbeFailures(probes({
      proxyDenied: "through",
      observed: { proxyDenied: "connected" },
    })),
    ["proxyDenied=through (connected)"],
  );
  // A probe that passed adds nothing, even with detail present.
  assertEquals(
    describeProbeFailures(probes({
      observed: { proxyDenied: "denied", proxyAllowed: "connected" },
    })),
    [],
  );
  // No detail, no entry.
  assertEquals(describeProbeFailures(probes({ proxyAllowed: "failed" })), []);
  // A failed denied probe with no denied detail adds nothing, whatever else is observed.
  assertEquals(
    describeProbeFailures(probes({
      proxyDenied: "through",
      observed: { proxyAllowed: "connected" },
    })),
    [],
  );
});

Deno.test("decideEgressPolicy - diagnostics are carried onto the decision (Issue #4493)", () => {
  const lines = [
    "[egress-selfcheck] allowlisted CONNECT to api.github.com refused (attempt 1 of 3)",
  ];
  const withLines = decideEgressPolicy({
    flag: "true",
    dialect: "docker",
    version: "27.1.1",
    date: DATE,
    probes: probes({ proxyAllowed: "failed", diagnostics: lines }),
  });
  assertEquals(withLines.diagnostics, lines);
  const without = decideEgressPolicy({
    flag: "true",
    dialect: "docker",
    version: "27.1.1",
    date: DATE,
    probes: probes({ proxyAllowed: "failed" }),
  });
  assertEquals(without.diagnostics, undefined);
});

Deno.test("checkEgressPolicy - the Apple marker names the refused allowlisted CONNECT (Issue #4493)", async () => {
  const lines = [
    "[egress-selfcheck] proxy for api.github.com is not accepting connections after 30000ms (refused)",
  ];
  const decision = await checkEgressPolicy({
    env: (name) =>
      ({
        VIBE_EGRESS_ENFORCED: "false",
        VIBE_RUNTIME_KIND: "apple-container",
        VIBE_APPLE_EGRESS_MODE: "advisory",
      })[name],
    probes: probes({
      proxyDenied: "denied",
      proxyAllowed: "failed",
      observed: { proxyDenied: "denied", proxyAllowed: "refused ×3" },
      diagnostics: lines,
    }),
    appleObserved: {},
    date: DATE,
  });
  assertEquals(decision.exitCode, EGRESS_SELFCHECK_EXIT_STATUS);
  assertStringIncludes(
    decision.marker ?? "",
    "proxyAllowlist=failed proxyAllowed=failed (refused ×3)",
  );
  assertEquals(decision.diagnostics, lines);
});

Deno.test("probeProxyConnectDetailed - an unusable proxy URL is not checked and opens no socket (Issue #4493)", async () => {
  const outcome = await probeProxyConnectDetailed(
    "not a url",
    "example.com",
    100,
  );
  assertEquals(outcome, { result: "not_checked", observed: "not checked" });
  const zeroPort = await probeProxyConnectDetailed(
    "http://127.0.0.1:0",
    "example.com",
    100,
  );
  assertEquals(zeroPort, { result: "not_checked", observed: "not checked" });
});

Deno.test("waitForProxyListener - an unusable proxy URL reports listening so the probe says not_checked (Issue #4493)", async () => {
  assertEquals(await waitForProxyListener("not a url"), { listening: true });
  assertEquals(
    await waitForProxyListener("http://127.0.0.1:0"),
    { listening: true },
  );
});

Deno.test("runEgressProbes - no proxy URL reports not_checked with no detail (Issue #4493)", async () => {
  const result = await runEgressProbes(() => undefined, 100, {
    directTcp: async () => "refused",
  });
  assertEquals(result.directCloudflare, "refused");
  assertEquals(result.directGithub, "refused");
  assertEquals(result.proxyDenied, "not_checked");
  assertEquals(result.proxyAllowed, "not_checked");
  assertEquals(result.observed, undefined);
  assertEquals(result.diagnostics, undefined);
});

Deno.test("runEgressProbes - an unusable proxy URL is not checked and opens no socket (Issue #4493)", async () => {
  const result = await runEgressProbes(
    (name) => (name === "HTTPS_PROXY" ? "not a url" : undefined),
    100,
    { directTcp: async () => "refused" },
  );
  assertEquals(result.proxyDenied, "not_checked");
  assertEquals(result.proxyAllowed, "not_checked");
  assertEquals(result.observed, {
    proxyDenied: "not checked",
    proxyAllowed: "not checked",
  });
  assertEquals(result.diagnostics, undefined);
});

/** A connection that answers one read with `answer`, or with EOF when null. */
function fakeConn(answer: string | null): Deno.Conn {
  return {
    write: (data: Uint8Array) => Promise.resolve(data.length),
    read: (buf: Uint8Array) => {
      if (answer === null) return Promise.resolve(null);
      const bytes = new TextEncoder().encode(answer);
      buf.set(bytes);
      return Promise.resolve(bytes.length);
    },
    close: () => {},
  } as unknown as Deno.Conn;
}

/** Run `body` with `Deno.connect` replaced; returns the options it was given. */
async function withConnect<T>(
  connect: (options: Deno.ConnectOptions) => Promise<Deno.Conn>,
  body: () => Promise<T>,
): Promise<T> {
  const original = Deno.connect;
  (Deno as { connect: unknown }).connect = connect;
  try {
    return await body();
  } finally {
    (Deno as { connect: unknown }).connect = original;
  }
}

Deno.test("probeProxyConnectDetailed - dials the proxy URL's host and port (Issue #4493)", async () => {
  const dialled: Deno.ConnectOptions[] = [];
  const outcome = await withConnect(
    (options) => {
      dialled.push(options);
      return Promise.resolve(fakeConn("HTTP/1.1 200 OK\r\n\r\n"));
    },
    () =>
      probeProxyConnectDetailed("http://proxy.test:3128", "example.com", 100),
  );
  assertEquals(outcome, { result: "succeeded", observed: "connected" });
  assertEquals(dialled.length, 1);
  assertEquals(dialled[0]?.hostname, "proxy.test");
  assertEquals(dialled[0]?.port, 3128);
});

Deno.test("probeProxyConnectDetailed - an unexpected answer is kept as its first line, printable and capped at 80 characters (Issue #4493)", async () => {
  const connectWith = (answer: string | null) =>
    withConnect(
      () => Promise.resolve(fakeConn(answer)),
      () =>
        probeProxyConnectDetailed("http://proxy.test:3128", "example.com", 100),
    );
  assertEquals(await connectWith("HTTP/1.1 502 Bad Gateway\r\nX: y\r\n\r\n"), {
    result: "through",
    observed: "HTTP/1.1 502 Bad Gateway",
  });
  assertEquals(
    (await connectWith("  HT\u0007TP/1.1 500 \u001b[31mx\n")).observed,
    "HTTP/1.1 500 [31mx",
  );
  const long = await connectWith("A".repeat(200));
  assertEquals(long.observed, "A".repeat(80));
  assertEquals(await connectWith(null), {
    result: "failed",
    observed: "closed without an answer",
  });
});

Deno.test("probeProxyConnectDetailed - a dial error is a timeout only when it is named TimeoutError (Issue #4493)", async () => {
  const fail = (thrown: unknown) =>
    withConnect(
      () => Promise.reject(thrown),
      () =>
        probeProxyConnectDetailed("http://proxy.test:3128", "example.com", 100),
    );
  assertEquals(await fail(new DOMException("slow", "TimeoutError")), {
    result: "failed",
    observed: "timeout",
  });
  assertEquals(await fail(new DOMException("odd", "SyntaxError")), {
    result: "failed",
    observed: "error: odd",
  });
  assertEquals(await fail({ name: "Other", message: "x" }), {
    result: "failed",
    observed: "error: [object Object]",
  });
  assertEquals(await fail(null), { result: "failed", observed: "error: null" });
  assertEquals(await fail(undefined), {
    result: "failed",
    observed: "error: undefined",
  });
  assertEquals(await fail("boom"), {
    result: "failed",
    observed: "error: boom",
  });
  assertEquals(await fail(new Deno.errors.ConnectionRefused("no")), {
    result: "failed",
    observed: "refused",
  });
});

Deno.test("waitForProxyListener - a dial error named TimeoutError is retried, others end the wait (Issue #4493)", async () => {
  const wait = (thrown: unknown) =>
    withConnect(
      () => Promise.reject(thrown),
      () =>
        waitForProxyListener("http://proxy.test:3128", {
          timeoutMs: 0,
          sleep: () => Promise.resolve(),
          now: () => 0,
        }),
    );
  assertEquals(await wait(new DOMException("slow", "TimeoutError")), {
    listening: false,
    observed: "timeout",
  });
  assertEquals(await wait(new Deno.errors.ConnectionRefused("no")), {
    listening: false,
    observed: "refused",
  });
  assertEquals(await wait(new DOMException("odd", "SyntaxError")), {
    listening: true,
  });
  assertEquals(await wait(null), { listening: true });
  assertEquals(await wait(undefined), { listening: true });
});
