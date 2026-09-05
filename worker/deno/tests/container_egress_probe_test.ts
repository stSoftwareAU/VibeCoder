/**
 * Tests for the container egress probe (Issue #997).
 *
 * The three conditions the probe exists to tell apart each need a different
 * action — wait, fetch a human, or fix the build — so the classification, the
 * evidence it carries and the refusal to probe a *name* are all asserted here
 * against real functions rather than a runtime.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  baseImageFromContainerfile,
  classifyEgress,
  containerProbeArgs,
  type EgressProbeDeps,
  type EgressProbeReading,
  emptyRoutingEvidence,
  formatEgressEvidence,
  formatEgressTarget,
  isIpLiteral,
  parseEgressTarget,
  parseRoutingEvidence,
  probeContainerEgress,
} from "../lib/container_egress_probe.ts";
import type { RuntimeInvocation } from "../lib/container_image_prune.ts";

/** The routing table GRQ-23 showed while its containers were cut off (#991). */
const GRQ23_NETSTAT = `Routing tables

Internet:
Destination        Gateway            Flags        Netif Expire
default            192.168.1.1        UGScg           en0
default            link#22            UCSIg     bridge100       !
default            100.100.100.100    UGScIg        utun8
127                127.0.0.1          UCS             lo0
192.168.64         link#22            UC        bridge100
`;

function reading(
  overrides: Partial<EgressProbeReading> = {},
): EgressProbeReading {
  return {
    target: "1.1.1.1:443",
    container: { from: "container", target: "1.1.1.1:443", result: "fail" },
    host: { from: "host", target: "1.1.1.1:443", result: "ok" },
    routes: emptyRoutingEvidence(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The target: an address, never a name (Issue #997)
// ---------------------------------------------------------------------------

Deno.test("parseEgressTarget - accepts an IPv4 literal and a port", () => {
  assertEquals(parseEgressTarget("1.1.1.1:443"), {
    host: "1.1.1.1",
    port: 443,
  });
});

Deno.test("parseEgressTarget - accepts a bracketed IPv6 literal", () => {
  assertEquals(parseEgressTarget("[2606:4700:4700::1111]:443"), {
    host: "2606:4700:4700::1111",
    port: 443,
  });
  assertEquals(
    formatEgressTarget({ host: "2606:4700:4700::1111", port: 443 }),
    "[2606:4700:4700::1111]:443",
  );
});

Deno.test("parseEgressTarget - refuses a hostname, because DNS is not the probe", () => {
  const error = assertThrows(
    () => parseEgressTarget("github.com:443"),
    Error,
  );
  assertStringIncludes(error.message, "IP literal");
  // The reason matters as much as the refusal: the host bridge IS a resolver.
  assertStringIncludes(error.message, "gateway");
});

Deno.test("parseEgressTarget - refuses a malformed target or port", () => {
  assertThrows(() => parseEgressTarget("1.1.1.1"), Error);
  assertThrows(() => parseEgressTarget("1.1.1.1:0"), Error);
  assertThrows(() => parseEgressTarget("1.1.1.1:70000"), Error);
  assertThrows(() => parseEgressTarget(""), Error);
});

Deno.test("isIpLiteral - octets outside 0-255 are not addresses", () => {
  assert(isIpLiteral("192.168.64.1"));
  assert(!isIpLiteral("999.1.1.1"));
  assert(!isIpLiteral("api.github.com"));
});

// ---------------------------------------------------------------------------
// The three conditions (Issue #997)
// ---------------------------------------------------------------------------

Deno.test("classifyEgress - a container that gets out is reachable", () => {
  assertEquals(
    classifyEgress(
      reading({
        container: { from: "container", target: "1.1.1.1:443", result: "ok" },
      }),
    ),
    "reachable",
  );
});

Deno.test("classifyEgress - container blocked while the host is fine is a host fault", () => {
  assertEquals(classifyEgress(reading()), "egress_blocked");
});

Deno.test("classifyEgress - both blocked is the network, and it is waited out", () => {
  assertEquals(
    classifyEgress(
      reading({
        host: { from: "host", target: "1.1.1.1:443", result: "fail" },
      }),
    ),
    "network_down",
  );
});

Deno.test("classifyEgress - a probe that never ran claims nothing", () => {
  assertEquals(
    classifyEgress(
      reading({
        container: {
          from: "container",
          target: "1.1.1.1:443",
          result: "not-run",
        },
      }),
    ),
    "inconclusive",
  );
  // Container blocked but the host never measured: nothing to attribute to.
  assertEquals(
    classifyEgress(
      reading({
        host: { from: "host", target: "1.1.1.1:443", result: "not-run" },
      }),
    ),
    "inconclusive",
  );
});

// ---------------------------------------------------------------------------
// The evidence (Issue #997)
// ---------------------------------------------------------------------------

Deno.test("parseRoutingEvidence - finds the reject route and the tunnel default", () => {
  const evidence = parseRoutingEvidence(GRQ23_NETSTAT, "netstat -rn");
  assertEquals(evidence.rejectRoutes.length, 1);
  assertStringIncludes(evidence.rejectRoutes[0]!, "bridge100");
  assertEquals(evidence.tunnelDefaultRoutes.length, 1);
  assertStringIncludes(evidence.tunnelDefaultRoutes[0]!, "utun8");
});

Deno.test("parseRoutingEvidence - reads the Linux dialect too", () => {
  const evidence = parseRoutingEvidence(
    [
      "default via 192.168.1.1 dev eth0 proto dhcp",
      "unreachable default dev docker0",
      "default dev wg0 scope link",
      "172.17.0.0/16 dev docker0 proto kernel scope link",
    ].join("\n"),
    "ip route show",
  );
  assertEquals(evidence.rejectRoutes.length, 1);
  assertStringIncludes(evidence.rejectRoutes[0]!, "unreachable");
  assertEquals(evidence.tunnelDefaultRoutes.length, 1);
  assertStringIncludes(evidence.tunnelDefaultRoutes[0]!, "wg0");
});

Deno.test("parseRoutingEvidence - a healthy table yields nothing to report", () => {
  const evidence = parseRoutingEvidence(
    "default            192.168.1.1        UGScg           en0",
    "netstat -rn",
  );
  assertEquals(evidence.rejectRoutes, []);
  assertEquals(evidence.tunnelDefaultRoutes, []);
});

Deno.test("formatEgressEvidence - carries the hop table and the routing cause", () => {
  const text = formatEgressEvidence(
    reading({
      image: "vibe-coder:abc123",
      routes: parseRoutingEvidence(GRQ23_NETSTAT, "netstat -rn"),
    }),
    "egress_blocked",
  );

  assertStringIncludes(text, "| container → 1.1.1.1:443 | FAIL");
  assertStringIncludes(text, "| host → 1.1.1.1:443 | OK");
  assertStringIncludes(text, "reject route(s)");
  assertStringIncludes(text, "bridge100");
  assertStringIncludes(text, "utun8");
  assertStringIncludes(text, "vibe-coder:abc123");
});

Deno.test("formatEgressEvidence - says so when no routing table could be read", () => {
  const text = formatEgressEvidence(reading(), "egress_blocked");
  assertStringIncludes(text, "could not be read");
});

// ---------------------------------------------------------------------------
// The probe container
// ---------------------------------------------------------------------------

Deno.test("containerProbeArgs - a throwaway container reaching a literal address", () => {
  const args = containerProbeArgs(
    "vibe-coder:abc",
    { host: "1.1.1.1", port: 443 },
    "vibe-egress-1",
  );
  assertEquals(args[0], "run");
  assert(args.includes("--rm"));
  assert(args.includes("vibe-coder:abc"));
  assertStringIncludes(args[args.length - 1]!, "/dev/tcp/1.1.1.1/443");
  // No name to resolve anywhere in the probe (Issue #997).
  assert(!args.join(" ").includes("github.com"));
});

Deno.test("baseImageFromContainerfile - reads the pinned base image", () => {
  assertEquals(
    baseImageFromContainerfile(
      [
        'ARG DENO_IMAGE="docker.io/denoland/deno:bin-2.9.6"',
        'ARG BASE_IMAGE="docker.io/library/ruby:3.4-trixie@sha256:abc"',
        "FROM ${DENO_IMAGE} AS deno",
        "FROM ${BASE_IMAGE}",
      ].join("\n"),
    ),
    "docker.io/library/ruby:3.4-trixie@sha256:abc",
  );
});

Deno.test("baseImageFromContainerfile - falls back to a literal FROM", () => {
  assertEquals(
    baseImageFromContainerfile("FROM debian:trixie\nRUN true\n"),
    "debian:trixie",
  );
  assertEquals(baseImageFromContainerfile("RUN true\n"), null);
});

// ---------------------------------------------------------------------------
// The orchestration
// ---------------------------------------------------------------------------

interface StubOptions {
  present?: string[];
  runCode?: number;
  runStderr?: string;
  hostOk?: boolean;
  routes?: string;
  routesThrow?: boolean;
}

function stubDeps(options: StubOptions = {}): {
  deps: EgressProbeDeps;
  calls: { runs: string[][]; hostConnects: number; routeReads: number };
} {
  const calls = { runs: [] as string[][], hostConnects: 0, routeReads: 0 };
  const deps: EgressProbeDeps = {
    log: () => {},
    imagePresent: (image) =>
      Promise.resolve((options.present ?? []).includes(image)),
    runRuntime: (args): Promise<RuntimeInvocation> => {
      calls.runs.push([...args]);
      return Promise.resolve({
        code: options.runCode ?? 0,
        stdout: "",
        stderr: options.runStderr ?? "",
      });
    },
    connectFromHost: () => {
      calls.hostConnects++;
      return Promise.resolve(
        options.hostOk === false
          ? { ok: false, detail: "connection timed out" }
          : { ok: true },
      );
    },
    readRoutes: () => {
      calls.routeReads++;
      if (options.routesThrow) throw new Error("netstat is missing");
      return Promise.resolve({
        source: "netstat -rn",
        text: options.routes ?? GRQ23_NETSTAT,
      });
    },
  };
  return { deps, calls };
}

Deno.test("probeContainerEgress - a reachable container costs one run and nothing else", async () => {
  const { deps, calls } = stubDeps({ present: ["vibe:1"], runCode: 0 });
  const result = await probeContainerEgress(deps, {
    target: { host: "1.1.1.1", port: 443 },
    images: ["vibe:1", "base:1"],
    containerName: "vibe-egress",
  });

  assertEquals(result.verdict, "reachable");
  assertEquals(calls.runs.length, 1);
  // The fast path must not pay for evidence nobody will read.
  assertEquals(calls.hostConnects, 0);
  assertEquals(calls.routeReads, 0);
});

Deno.test("probeContainerEgress - a blocked container with a healthy host is attributed to the host", async () => {
  const { deps, calls } = stubDeps({
    present: ["vibe:1"],
    runCode: 1,
    runStderr: "connect: no route to host",
    hostOk: true,
  });
  const result = await probeContainerEgress(deps, {
    target: { host: "1.1.1.1", port: 443 },
    images: ["vibe:1"],
    containerName: "vibe-egress",
  });

  assertEquals(result.verdict, "egress_blocked");
  assertEquals(calls.hostConnects, 1);
  assertStringIncludes(result.evidence, "no route to host");
  assertStringIncludes(result.evidence, "bridge100");
  assertStringIncludes(result.reading.container.detail ?? "", "no route");
});

Deno.test("probeContainerEgress - both hops blocked is the network, not the host", async () => {
  const { deps } = stubDeps({
    present: ["vibe:1"],
    runCode: 1,
    hostOk: false,
  });
  const result = await probeContainerEgress(deps, {
    target: { host: "1.1.1.1", port: 443 },
    images: ["vibe:1"],
    containerName: "vibe-egress",
  });

  assertEquals(result.verdict, "network_down");
  assertStringIncludes(result.evidence, "| host → 1.1.1.1:443 | FAIL");
});

Deno.test("probeContainerEgress - falls back to the base image when the build is due", async () => {
  const { deps, calls } = stubDeps({ present: ["base:1"], runCode: 0 });
  const result = await probeContainerEgress(deps, {
    target: { host: "1.1.1.1", port: 443 },
    images: ["vibe:absent", "base:1"],
    containerName: "vibe-egress",
  });

  assertEquals(result.verdict, "reachable");
  assertEquals(result.reading.image, "base:1");
  assert(calls.runs[0]!.includes("base:1"));
});

Deno.test("probeContainerEgress - no image to probe with never blocks a launch", async () => {
  const { deps, calls } = stubDeps({ present: [] });
  const result = await probeContainerEgress(deps, {
    target: { host: "1.1.1.1", port: 443 },
    images: ["vibe:absent", "base:absent"],
    containerName: "vibe-egress",
  });

  assertEquals(result.verdict, "inconclusive");
  assertEquals(calls.runs.length, 0);
  assertStringIncludes(result.evidence, "no image in the local store");
});

Deno.test("probeContainerEgress - an unreadable routing table loses the evidence, not the verdict", async () => {
  const { deps } = stubDeps({
    present: ["vibe:1"],
    runCode: 1,
    hostOk: true,
    routesThrow: true,
  });
  const result = await probeContainerEgress(deps, {
    target: { host: "1.1.1.1", port: 443 },
    images: ["vibe:1"],
    containerName: "vibe-egress",
  });

  assertEquals(result.verdict, "egress_blocked");
  assertStringIncludes(result.evidence, "could not be read");
});
