/**
 * Tests for the per-control egress derivation (Issue #4051).
 *
 * Each derivation rule has a positive case and a negative twin. The point is
 * that a control is never called `blocked` without a negative control that
 * proved a connection can succeed, and that a failed or un-run probe never
 * reads as a pass.
 */

import {
  assert,
  assertEquals,
  assertFalse,
  assertMatch,
  assertStringIncludes,
} from "@std/assert";
import {
  buildEgressControlReport,
  deriveEgressControls,
  EGRESS_MODE_LABELS,
  type EgressControlReport,
  type EgressControls,
  type EgressMode,
  evaluateEgress,
  formatStartupReport,
  type ProbeObservation,
  type ProbeRun,
  summariseEgressControls,
  type TcpOutcome,
} from "../lib/egress_controls.ts";

const LEFTOVER_DEFAULT_DENY = /default-deny/g;

function run(overrides: Partial<ProbeRun> = {}): ProbeRun {
  return {
    label: "internal",
    executed: true,
    observations: [],
    hostSawNonce: false,
    ...overrides,
  };
}

/** A control run that proved every negative-control property. */
function provenControl(): ProbeRun {
  return run({
    label: "control",
    observations: [
      tcp("literal4", "ok", "1.1.1.1:443"),
      tcp("literal6", "ok", "[2606:4700::1111]:443"),
      dns("example.com", true),
    ],
    hostSawNonce: true,
  });
}

function tcp(
  family: "literal4" | "literal6" | "name4" | "host",
  outcome: TcpOutcome,
  target = "1.1.1.1:443",
): ProbeObservation {
  return { kind: "tcp", family, target, outcome };
}

function dns(name: string, ok: boolean): ProbeObservation {
  return { kind: "dns", name, ok };
}

function net(ipv6: boolean): ProbeObservation {
  return {
    kind: "net",
    address: "192.168.64.2",
    gateway: "192.168.64.1",
    ipv6,
  };
}

function connect(
  host: string,
  status: number | null,
  reason: string | null,
): ProbeObservation {
  return { kind: "connect", host, status, reason };
}

/** Internal observations that enforce the allowlist and block direct egress. */
function goodInternal(): ProbeRun {
  return run({
    observations: [
      net(false),
      tcp("literal4", "timeout", "1.1.1.1:443"),
      tcp("name4", "unreachable", "example.com:443"),
      tcp("literal6", "unreachable", "[2606:4700::1111]:443"),
      tcp("host", "timeout", "192.168.64.1:8080"),
      dns("example.com", false),
      connect("allowed.example", 200, null),
      connect("denied.example", 403, "not-allowlisted"),
      { kind: "tool", name: "npm", ok: true, detail: "http_200" },
    ],
  });
}

/** A fully good set of controls, to tweak one field at a time. */
function goodControls(): EgressControls {
  return {
    proxyAllowlist: { state: "enforced", detail: "good" },
    directInternetV4: { state: "blocked", detail: "good" },
    directInternetV6: { state: "unavailable", detail: "good" },
    hostAccess: { state: "blocked", detail: "good" },
    lanAccess: { state: "untested", detail: "good" },
    dns: { state: "blocked", detail: "good" },
    toolPaths: [{ name: "npm", state: "ok", detail: "http_200" }],
    negativeControl: {
      v4: true,
      v6: true,
      host: true,
      dns: true,
      executed: true,
      detail: "good",
    },
  };
}

function report(
  mode: EgressMode,
  controls: EgressControls,
  overrides: Partial<EgressControlReport> = {},
): EgressControlReport {
  const evaluation = evaluateEgress(mode, controls);
  return {
    schema: 1,
    recordedAt: "2026-10-26T00:00:00Z",
    launch: "launch-1",
    runtime: { executable: "container", version: "0.9.0", macos: "15.4" },
    selectedMode: mode,
    effectiveMode: mode,
    controls,
    regressions: evaluation.regressions,
    acceptedGaps: evaluation.acceptedGaps,
    ...overrides,
  };
}

// ----- directInternetV4 -----

Deno.test("directInternetV4 is blocked only with a negative control proof", () => {
  const internal = run({
    observations: [
      tcp("literal4", "timeout"),
      tcp("name4", "unreachable", "example.com:443"),
    ],
  });
  assertEquals(
    deriveEgressControls(internal, provenControl()).directInternetV4.state,
    "blocked",
  );
  // Twin: the same failures with no proof from the negative control.
  const unproven = deriveEgressControls(
    internal,
    run({ label: "control", observations: [tcp("literal4", "timeout")] }),
  );
  assertEquals(unproven.directInternetV4.state, "untested");
  assertMatch(unproven.directInternetV4.detail, /negative control/);
});

Deno.test("directInternetV4 has no negative control when none was run", () => {
  const internal = run({ observations: [tcp("literal4", "timeout")] });
  assertEquals(
    deriveEgressControls(internal, null).directInternetV4.state,
    "untested",
  );
});

Deno.test("directInternetV4 is never blocked by a probe that did not run", () => {
  const internal = run({
    executed: false,
    error: "container runtime refused",
    observations: [],
  });
  const controls = deriveEgressControls(internal, provenControl());
  assertEquals(controls.directInternetV4.state, "untested");
  assertStringIncludes(
    controls.directInternetV4.detail,
    "container runtime refused",
  );
});

Deno.test("directInternetV4 with an error attempt is untested, never blocked", () => {
  const internal = run({
    observations: [
      tcp("literal4", "timeout"),
      tcp("literal4", "error", "8.8.8.8:443"),
    ],
  });
  const controls = deriveEgressControls(internal, provenControl());
  assertEquals(controls.directInternetV4.state, "untested");
  assertMatch(controls.directInternetV4.detail, /errored/);
});

Deno.test("directInternetV4 with no attempts is untested, never blocked", () => {
  const controls = deriveEgressControls(run(), provenControl());
  assertEquals(controls.directInternetV4.state, "untested");
  assertMatch(
    controls.directInternetV4.detail,
    /no IPv4 direct egress attempt/,
  );
});

Deno.test("directInternetV4 is reachable on any successful attempt", () => {
  const internal = run({
    observations: [
      tcp("literal4", "timeout"),
      tcp("literal4", "ok", "9.9.9.9:443"),
    ],
  });
  const controls = deriveEgressControls(internal, provenControl());
  assertEquals(controls.directInternetV4.state, "reachable");
  assertStringIncludes(controls.directInternetV4.detail, "9.9.9.9:443");
});

Deno.test("directInternetV4 treats refusals as blocked when the control is proven", () => {
  const internal = run({
    observations: [
      tcp("literal4", "refused"),
      tcp("literal4", "timeout", "9.9.9.9:443"),
    ],
  });
  assertEquals(
    deriveEgressControls(internal, provenControl()).directInternetV4.state,
    "blocked",
  );
});

// ----- directInternetV6 -----

Deno.test("directInternetV6 is unavailable when the host has no IPv6 route", () => {
  const internal = run({
    observations: [
      net(false),
      tcp("literal6", "unreachable", "[2606:4700::1111]:443"),
    ],
  });
  const controls = deriveEgressControls(
    internal,
    run({
      label: "control",
      observations: [net(false), tcp("literal4", "ok")],
      hostSawNonce: true,
    }),
  );
  assertEquals(controls.directInternetV6.state, "unavailable");
  assertEquals(
    controls.directInternetV6.detail,
    "no IPv6 route on this host, so IPv6 egress could not be exercised",
  );
});

Deno.test("directInternetV6 is not unavailable when the control reports IPv6", () => {
  // Twin: both runs say IPv6 exists, so the attempts must speak for themselves.
  const internal = run({
    observations: [
      net(true),
      tcp("literal6", "timeout", "[2606:4700::1111]:443"),
    ],
  });
  const controls = deriveEgressControls(
    internal,
    run({
      label: "control",
      observations: [net(true), tcp("literal4", "ok")],
      hostSawNonce: true,
    }),
  );
  assertEquals(controls.directInternetV6.state, "untested");
  assertFalse(controls.directInternetV6.state === "unavailable");
});

Deno.test("directInternetV6 is not unavailable without an executed control", () => {
  const internal = run({ observations: [net(false)] });
  const controls = deriveEgressControls(internal, null);
  assertEquals(controls.directInternetV6.state, "untested");
});

Deno.test("directInternetV6 is blocked with a proven control and failed attempts", () => {
  const internal = run({
    observations: [
      net(true),
      tcp("literal6", "timeout", "[2606:4700::1111]:443"),
    ],
  });
  assertEquals(
    deriveEgressControls(internal, provenControl()).directInternetV6.state,
    "blocked",
  );
});

Deno.test("directInternetV6 is reachable on any successful literal6 attempt", () => {
  const internal = run({
    observations: [tcp("literal6", "ok", "[2606:4700::1111]:443")],
  });
  assertEquals(
    deriveEgressControls(internal, provenControl()).directInternetV6.state,
    "reachable",
  );
});

// ----- hostAccess -----

Deno.test("hostAccess is reachable when the host received the nonce, despite timeouts", () => {
  const internal = run({
    hostSawNonce: true,
    observations: [tcp("host", "timeout", "192.168.64.1:8080")],
  });
  assertEquals(
    deriveEgressControls(internal, provenControl()).hostAccess.state,
    "reachable",
  );
});

Deno.test("hostAccess is blocked on timeouts with a proven nonce path", () => {
  const internal = run({
    observations: [tcp("host", "timeout", "192.168.64.1:8080")],
  });
  assertEquals(
    deriveEgressControls(internal, provenControl()).hostAccess.state,
    "blocked",
  );
});

Deno.test("host refused is untested, never blocked, even with a proven control", () => {
  // A refusal means the host stack answered, so it is not evidence of a firewall.
  const internal = run({
    observations: [tcp("host", "refused", "192.168.64.1:8080")],
  });
  const controls = deriveEgressControls(internal, provenControl());
  assertEquals(controls.hostAccess.state, "untested");
  assertMatch(controls.hostAccess.detail, /not evidence of a firewall/);
});

Deno.test("host access is untested on an errored attempt", () => {
  const internal = run({
    observations: [tcp("host", "error", "192.168.64.1:8080")],
  });
  assertEquals(
    deriveEgressControls(internal, provenControl()).hostAccess.state,
    "untested",
  );
});

Deno.test("host access is untested when the control's nonce did not arrive", () => {
  const internal = run({
    observations: [tcp("host", "timeout", "192.168.64.1:8080")],
  });
  const controls = deriveEgressControls(
    internal,
    run({
      label: "control",
      observations: [tcp("literal4", "ok")],
      hostSawNonce: false,
    }),
  );
  assertEquals(controls.hostAccess.state, "untested");
});

Deno.test("host access is untested when the internal probe did not run", () => {
  const controls = deriveEgressControls(
    run({ executed: false, error: "no image", observations: [] }),
    provenControl(),
  );
  assertEquals(controls.hostAccess.state, "untested");
  assertStringIncludes(controls.hostAccess.detail, "no image");
});

// ----- lanAccess -----

Deno.test("lanAccess is always untested, whatever the probes measured", () => {
  const controls = deriveEgressControls(goodInternal(), provenControl());
  assertEquals(controls.lanAccess.state, "untested");
  assertStringIncludes(controls.lanAccess.detail, "no controlled endpoint");
});

// ----- dns -----

Deno.test("dns is reachable when any internal lookup resolves", () => {
  const internal = run({
    observations: [dns("example.com", false), dns("github.com", true)],
  });
  assertEquals(
    deriveEgressControls(internal, provenControl()).dns.state,
    "reachable",
  );
});

Deno.test("dns is blocked when every lookup fails and the control resolves", () => {
  const internal = run({ observations: [dns("example.com", false)] });
  assertEquals(
    deriveEgressControls(internal, provenControl()).dns.state,
    "blocked",
  );
});

Deno.test("dns is untested without a control that resolved a name", () => {
  const internal = run({ observations: [dns("example.com", false)] });
  const controls = deriveEgressControls(
    internal,
    run({ label: "control", observations: [tcp("literal4", "ok")] }),
  );
  assertEquals(controls.dns.state, "untested");
});

Deno.test("dns is untested when no lookup was recorded", () => {
  assertEquals(
    deriveEgressControls(run(), provenControl()).dns.state,
    "untested",
  );
});

// ----- proxyAllowlist -----

Deno.test("proxyAllowlist is enforced on a 200 and a different host's not-allowlisted 403", () => {
  const controls = deriveEgressControls(goodInternal(), provenControl());
  assertEquals(controls.proxyAllowlist.state, "enforced");
});

Deno.test("proxyAllowlist requires the 403 to carry reason not-allowlisted", () => {
  const internal = run({
    observations: [
      connect("allowed.example", 200, null),
      connect("denied.example", 403, "resolve-failed"),
    ],
  });
  const controls = deriveEgressControls(internal, provenControl());
  assertEquals(controls.proxyAllowlist.state, "untested");
  assertStringIncludes(controls.proxyAllowlist.detail, "resolve-failed");
});

Deno.test("proxyAllowlist is not-enforced when two distinct hosts both tunnel", () => {
  const internal = run({
    observations: [
      connect("allowed.example", 200, null),
      connect("denied.example", 200, null),
    ],
  });
  assertEquals(
    deriveEgressControls(internal, provenControl()).proxyAllowlist.state,
    "not-enforced",
  );
});

Deno.test("proxyAllowlist is untested on a 502 for the second host", () => {
  const internal = run({
    observations: [
      connect("allowed.example", 200, null),
      connect("denied.example", 502, null),
    ],
  });
  const controls = deriveEgressControls(internal, provenControl());
  assertEquals(controls.proxyAllowlist.state, "untested");
  assertStringIncludes(controls.proxyAllowlist.detail, "502");
});

Deno.test("proxyAllowlist is untested when the 403 is for the same host as the 200", () => {
  const internal = run({
    observations: [
      connect("allowed.example", 200, null),
      connect("allowed.example", 403, "not-allowlisted"),
    ],
  });
  assertEquals(
    deriveEgressControls(internal, provenControl()).proxyAllowlist.state,
    "untested",
  );
});

Deno.test("proxyAllowlist is untested when no CONNECT was answered 200", () => {
  const internal = run({
    observations: [connect("allowed.example", null, null)],
  });
  const controls = deriveEgressControls(internal, provenControl());
  assertEquals(controls.proxyAllowlist.state, "untested");
  assertStringIncludes(
    controls.proxyAllowlist.detail,
    "allowed reading is missing",
  );
});

Deno.test("proxyAllowlist is untested when the internal probe did not run", () => {
  const controls = deriveEgressControls(
    run({ executed: false, error: "no network" }),
    provenControl(),
  );
  assertEquals(controls.proxyAllowlist.state, "untested");
});

// ----- proxyAllowlist judged by host identity (proxyCheck) -----

const PROXY_CHECK = {
  allowedHost: "allowed.example",
  deniedHost: "denied.example",
};

/** The swapped answers: the allowed host refused, the denied host tunnelled. */
function swappedAnswers(): ProbeObservation[] {
  return [
    connect("allowed.example", 403, "not-allowlisted"),
    connect("denied.example", 200, null),
  ];
}

Deno.test("proxyCheck: swapped answers are not-enforced, judged by identity", () => {
  const internal = run({
    observations: swappedAnswers(),
    proxyCheck: PROXY_CHECK,
  });
  const proxy = deriveEgressControls(internal, provenControl()).proxyAllowlist;
  assertEquals(proxy.state, "not-enforced");
  assertStringIncludes(proxy.detail, "denied.example");
});

Deno.test("without proxyCheck, the same swapped answers keep the old order-based reading", () => {
  // The old reading takes the first 200 as the allowed host, so it reads enforced.
  // This is the weakness proxyCheck closes; keeping it here pins the fallback.
  const internal = run({ observations: swappedAnswers() });
  assertEquals(
    deriveEgressControls(internal, provenControl()).proxyAllowlist.state,
    "enforced",
  );
});

Deno.test("proxyCheck: allowed 200 and denied 403 not-allowlisted is enforced", () => {
  const internal = run({
    observations: [
      connect("allowed.example", 200, null),
      connect("denied.example", 403, "not-allowlisted"),
    ],
    proxyCheck: PROXY_CHECK,
  });
  assertEquals(
    deriveEgressControls(internal, provenControl()).proxyAllowlist.state,
    "enforced",
  );
});

Deno.test("proxyCheck: a denied host refused for another reason is untested, naming it", () => {
  const internal = run({
    observations: [
      connect("allowed.example", 200, null),
      connect("denied.example", 403, "resolve-failed"),
    ],
    proxyCheck: PROXY_CHECK,
  });
  const proxy = deriveEgressControls(internal, provenControl()).proxyAllowlist;
  assertEquals(proxy.state, "untested");
  assertStringIncludes(proxy.detail, "denied.example");
  assertStringIncludes(proxy.detail, "resolve-failed");
});

Deno.test("proxyCheck: a 403 not-allowlisted for the allowed host is untested, naming it", () => {
  const internal = run({
    observations: [
      connect("allowed.example", 403, "not-allowlisted"),
      connect("denied.example", 403, "not-allowlisted"),
    ],
    proxyCheck: PROXY_CHECK,
  });
  const proxy = deriveEgressControls(internal, provenControl()).proxyAllowlist;
  assertEquals(proxy.state, "untested");
  assertStringIncludes(proxy.detail, "allowed host allowed.example");
});

Deno.test("proxyCheck: a missing denied answer is untested, naming the missing reading", () => {
  const internal = run({
    observations: [connect("allowed.example", 200, null)],
    proxyCheck: PROXY_CHECK,
  });
  const proxy = deriveEgressControls(internal, provenControl()).proxyAllowlist;
  assertEquals(proxy.state, "untested");
  assertStringIncludes(
    proxy.detail,
    "no CONNECT answer for the denied host denied.example",
  );
});

Deno.test("proxyCheck: both hosts tunnelled is not-enforced", () => {
  const internal = run({
    observations: [
      connect("allowed.example", 200, null),
      connect("denied.example", 200, null),
    ],
    proxyCheck: PROXY_CHECK,
  });
  assertEquals(
    deriveEgressControls(internal, provenControl()).proxyAllowlist.state,
    "not-enforced",
  );
});

// ----- toolPaths -----

Deno.test("toolPaths maps each tool observation to ok or failed", () => {
  const internal = run({
    observations: [
      { kind: "tool", name: "npm", ok: true, detail: "http_200" },
      {
        kind: "tool",
        name: "git",
        ok: false,
        detail: "could_not_resolve_host",
      },
    ],
  });
  assertEquals(deriveEgressControls(internal, provenControl()).toolPaths, [
    { name: "npm", state: "ok", detail: "http_200" },
    { name: "git", state: "failed", detail: "could_not_resolve_host" },
  ]);
});

Deno.test("toolPaths is empty when the internal probe did not run", () => {
  const internal = run({
    executed: false,
    observations: [{ kind: "tool", name: "npm", ok: true, detail: "http_200" }],
  });
  assertEquals(deriveEgressControls(internal, provenControl()).toolPaths, []);
});

// ----- negativeControl -----

Deno.test("negativeControl reports what the control proved", () => {
  const proven =
    deriveEgressControls(goodInternal(), provenControl()).negativeControl;
  assertEquals(
    {
      v4: proven.v4,
      v6: proven.v6,
      host: proven.host,
      dns: proven.dns,
      executed: proven.executed,
    },
    { v4: true, v6: true, host: true, dns: true, executed: true },
  );
});

Deno.test("negativeControl proves nothing from a control that did not run", () => {
  const control = run({
    label: "control",
    executed: false,
    error: "image missing",
    observations: [tcp("literal4", "ok"), dns("example.com", true)],
    hostSawNonce: true,
  });
  const negative =
    deriveEgressControls(goodInternal(), control).negativeControl;
  assertEquals(
    {
      v4: negative.v4,
      v6: negative.v6,
      host: negative.host,
      dns: negative.dns,
      executed: negative.executed,
    },
    { v4: false, v6: false, host: false, dns: false, executed: false },
  );
  assertStringIncludes(negative.detail, "image missing");
});

Deno.test("negativeControl is empty when no control was run", () => {
  const negative = deriveEgressControls(goodInternal(), null).negativeControl;
  assertFalse(negative.executed);
  assertFalse(negative.v4);
});

// ----- evaluateEgress -----

Deno.test("internal-network with every promise kept has no regressions", () => {
  const evaluation = evaluateEgress("internal-network", goodControls());
  assertEquals(evaluation.regressions, []);
});

Deno.test("internal-network regresses when direct IPv4 is not blocked", () => {
  const evaluation = evaluateEgress("internal-network", {
    ...goodControls(),
    directInternetV4: { state: "untested", detail: "no control proof" },
  });
  assertEquals(evaluation.regressions.length, 1);
  assertStringIncludes(
    evaluation.regressions[0]!,
    "directInternetV4 is untested",
  );
  assertStringIncludes(evaluation.regressions[0]!, "no control proof");
});

Deno.test("internal-network regresses on untested IPv6, but not on unavailable IPv6", () => {
  const untested = evaluateEgress("internal-network", {
    ...goodControls(),
    directInternetV6: { state: "untested", detail: "x" },
  });
  assertEquals(untested.regressions.length, 1);
  assertStringIncludes(
    untested.regressions[0]!,
    "directInternetV6 is untested",
  );
  const unavailable = evaluateEgress("internal-network", {
    ...goodControls(),
    directInternetV6: { state: "unavailable", detail: "no route" },
  });
  assertEquals(unavailable.regressions, []);
});

Deno.test("internal-network regresses when IPv6 is reachable", () => {
  const evaluation = evaluateEgress("internal-network", {
    ...goodControls(),
    directInternetV6: { state: "reachable", detail: "connected" },
  });
  assertEquals(evaluation.regressions.length, 1);
});

Deno.test("both modes regress on an unenforced or untested proxy allowlist", () => {
  for (const mode of ["internal-network", "advisory-proxy"] as const) {
    const notEnforced = evaluateEgress(mode, {
      ...goodControls(),
      proxyAllowlist: { state: "not-enforced", detail: "both tunnelled" },
    });
    assertEquals(notEnforced.regressions.length, 1, mode);
    assertStringIncludes(notEnforced.regressions[0]!, "not-enforced");
    const untested = evaluateEgress(mode, {
      ...goodControls(),
      proxyAllowlist: { state: "untested", detail: "no answer" },
    });
    assertEquals(untested.regressions.length, 1, mode);
  }
});

Deno.test("both modes regress on a failed tool path", () => {
  const controls = {
    ...goodControls(),
    toolPaths: [{ name: "git", state: "failed" as const, detail: "timed_out" }],
  };
  for (const mode of ["internal-network", "advisory-proxy"] as const) {
    const evaluation = evaluateEgress(mode, controls);
    assertEquals(evaluation.regressions.length, 1, mode);
    assertStringIncludes(evaluation.regressions[0]!, "tool path git failed");
  }
});

Deno.test("advisory-proxy does not regress on direct egress it never promised", () => {
  const evaluation = evaluateEgress("advisory-proxy", {
    ...goodControls(),
    directInternetV4: { state: "reachable", detail: "connected" },
    directInternetV6: { state: "untested", detail: "x" },
  });
  assertEquals(evaluation.regressions, []);
});

Deno.test("advisory-proxy always lists the direct-egress gap, even when measured blocked", () => {
  const blocked = evaluateEgress("advisory-proxy", goodControls());
  const advisory = blocked.acceptedGaps.find((gap) =>
    gap.startsWith(
      "direct egress is not blocked: proxy variables are advisory routing",
    )
  );
  assert(advisory !== undefined, "advisory gap sentence is missing");
  assertStringIncludes(advisory, "measured IPv4 direct egress blocked");
  assertStringIncludes(advisory, "does not promise");
});

Deno.test("advisory-proxy lists the direct-egress gap when direct egress is untested", () => {
  const evaluation = evaluateEgress("advisory-proxy", {
    ...goodControls(),
    directInternetV4: { state: "untested", detail: "no proof" },
  });
  assert(
    evaluation.acceptedGaps.some((gap) =>
      gap.startsWith(
        "direct egress is not blocked: proxy variables are advisory routing",
      )
    ),
  );
});

Deno.test("host reachable is an accepted gap naming apple/container#1320", () => {
  const evaluation = evaluateEgress("internal-network", {
    ...goodControls(),
    hostAccess: { state: "reachable", detail: "nonce arrived" },
  });
  assertEquals(evaluation.regressions, []);
  assert(
    evaluation.acceptedGaps.some((gap) =>
      gap.includes(
        "host services on the internal network's gateway are reachable — apple/container#1320",
      )
    ),
  );
});

Deno.test("blocked host access is not listed as a gap", () => {
  const evaluation = evaluateEgress("internal-network", goodControls());
  assertFalse(
    evaluation.acceptedGaps.some((gap) => gap.includes("apple/container#1320")),
  );
  assertFalse(
    evaluation.acceptedGaps.some((gap) => gap.startsWith("host access")),
  );
});

Deno.test("dns reachable is an accepted gap about tunnelling", () => {
  const evaluation = evaluateEgress("internal-network", {
    ...goodControls(),
    dns: { state: "reachable", detail: "resolved" },
  });
  assert(
    evaluation.acceptedGaps.some((gap) =>
      gap.startsWith(
        "DNS lookups leave the container, a residual tunnelling channel",
      )
    ),
  );
});

Deno.test("blocked dns is not listed as a gap", () => {
  const evaluation = evaluateEgress("internal-network", goodControls());
  assertFalse(
    evaluation.acceptedGaps.some((gap) => gap.includes("DNS lookups")),
  );
});

Deno.test("LAN access is always an accepted gap", () => {
  for (const mode of ["internal-network", "advisory-proxy"] as const) {
    const evaluation = evaluateEgress(mode, goodControls());
    assert(
      evaluation.acceptedGaps.some((gap) =>
        gap.startsWith("LAN access is untested")
      ),
      mode,
    );
  }
});

Deno.test("an invalid negative control is an accepted gap", () => {
  const evaluation = evaluateEgress("internal-network", {
    ...goodControls(),
    negativeControl: {
      v4: false,
      v6: false,
      host: false,
      dns: false,
      executed: false,
      detail: "the negative control did not run (image missing)",
    },
  });
  assert(
    evaluation.acceptedGaps.some((gap) =>
      gap ===
        "negative control invalid: the negative control did not run (image missing)"
    ),
  );
});

// ----- formatting and the run-log summary -----

Deno.test("mode labels never claim a whole-mode enforcement, default-deny or completeness", () => {
  for (const label of Object.values(EGRESS_MODE_LABELS)) {
    assertFalse(label.includes("enforced"), label);
    assertFalse(label.includes("complete"), label);
    assertEquals(label.match(LEFTOVER_DEFAULT_DENY), null, label);
  }
});

Deno.test("startup report names the scope of each mode", () => {
  const internalLines = formatStartupReport(
    report("internal-network", goodControls()),
  );
  assert(
    internalLines.some((line) =>
      line.includes("partial containment, not default-deny")
    ),
  );
  const advisoryLines = formatStartupReport(
    report("advisory-proxy", goodControls()),
  );
  assert(advisoryLines.some((line) => line.includes("advisory only")));
});

Deno.test("startup report prefixes every line and prints runtime versions", () => {
  const lines = formatStartupReport(report("internal-network", goodControls()));
  for (const line of lines) assert(line.startsWith("[egress] "), line);
  assert(lines.some((line) => line.includes("version 0.9.0, macOS 15.4")));
});

Deno.test("startup report prints unknown for missing runtime versions", () => {
  const lines = formatStartupReport(
    report("internal-network", goodControls(), {
      runtime: { executable: "container", version: null, macos: null },
    }),
  );
  assert(lines.some((line) => line.includes("version unknown, macOS unknown")));
});

Deno.test("startup report prints residual gaps and REGRESSION lines distinctly", () => {
  const lines = formatStartupReport(
    report("internal-network", {
      ...goodControls(),
      directInternetV4: { state: "untested", detail: "no proof" },
    }),
  );
  assert(
    lines.some((line) =>
      line.startsWith("[egress] REGRESSION: internal-network promises")
    ),
  );
  assert(
    lines.some((line) =>
      line.startsWith("[egress] residual gap: LAN access is untested")
    ),
  );
});

Deno.test("startup report says enforced only for the proxyAllowlist state", () => {
  const lines = formatStartupReport(
    report("internal-network", {
      ...goodControls(),
      proxyAllowlist: { state: "not-enforced", detail: "both tunnelled" },
    }),
  );
  for (const line of lines) {
    const stripped = line.replace(/not-enforced|enforced/g, "");
    if (!stripped.includes("enforced")) continue;
    assert(false, `unexpected "enforced" outside the proxy state: ${line}`);
  }
  assert(
    lines.some((line) =>
      line.startsWith("[egress] control proxy-allowlist: not-enforced")
    ),
  );
});

Deno.test("startup report never says complete or makes a default-deny claim", () => {
  const lines = formatStartupReport(report("internal-network", goodControls()));
  for (const line of lines) {
    assertFalse(line.includes("complete"), line);
    for (const match of line.matchAll(LEFTOVER_DEFAULT_DENY)) {
      const before = line.slice(0, match.index ?? 0);
      assertMatch(before, /not $/, line);
    }
  }
});

Deno.test("summary is one line in the agreed shape", () => {
  const summary = summariseEgressControls(
    report("internal-network", {
      ...goodControls(),
      dns: { state: "reachable", detail: "resolved" },
    }),
  );
  assertFalse(summary.includes("\n"));
  assertEquals(
    summary,
    "egress-containment: mode=internal-network proxy=enforced direct-v4=blocked " +
      "direct-v6=unavailable host=blocked lan=untested dns=reachable " +
      `regressions=0 gaps=${
        report("internal-network", {
          ...goodControls(),
          dns: { state: "reachable", detail: "resolved" },
        }).acceptedGaps.length
      }`,
  );
});

Deno.test("buildEgressControlReport fills the schema and evaluates the effective mode", () => {
  const built = buildEgressControlReport({
    recordedAt: "2026-10-26T00:00:00Z",
    launch: "launch-2",
    runtime: { executable: "container", version: null, macos: null },
    selectedMode: "internal-network",
    effectiveMode: "advisory-proxy",
    controls: {
      ...goodControls(),
      directInternetV4: { state: "untested", detail: "no proof" },
    },
  });
  assertEquals(built.schema, 1);
  assertEquals(built.regressions, []);
  assert(built.acceptedGaps[0]?.startsWith("direct egress is not blocked"));
});
