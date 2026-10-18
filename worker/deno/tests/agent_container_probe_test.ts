/** Fail closed when a separate-container diagnostic lacks positive evidence. */
import { assertEquals, assertThrows } from "@std/assert";
import {
  type AgentContainerEvidence,
  assertSeparateContainerEvidence,
  type BrokerWitness,
  countSyntheticCredentialMatches,
} from "./support/agent_container_evidence.ts";
import {
  containerProbeNetworkArgs,
  containerProbeRuntime,
  containerProbeSecurityInfo,
  separateContainerPlan,
} from "./support/agent_container_plan.ts";
import {
  buildContainerLaunchPlan,
  containerTargetPaths,
  resolveContainerLaunchHostPaths,
} from "../lib/container_launch.ts";
import { CONTAINER_RUNTIMES } from "../lib/container_runtime.ts";
import { parseContainerManifest } from "../lib/container_manifest.ts";
import type { NamespaceEvidence } from "./support/agent_namespace_evidence.ts";

Deno.test("separate probe selects the exact production Docker or Podman dialect", () => {
  assertEquals(containerProbeRuntime().kind, "docker");
  for (const kind of ["docker", "podman"] as const) {
    const runtime = containerProbeRuntime(kind);
    assertEquals(runtime.kind, kind);
    assertEquals(runtime.executable, CONTAINER_RUNTIMES[kind].executable);
    assertEquals(runtime.dialect, CONTAINER_RUNTIMES[kind].dialect);
    assertEquals(runtime.platform, "linux");
  }
  for (const kind of ["container", "unknown", "", "sudo podman"]) {
    assertThrows(
      () => containerProbeRuntime(kind),
      Error,
      "Probe runtime must be docker or podman",
    );
  }
});

// Shapes follow podman-info(1)'s JSON example and Docker's SecurityOptions.
Deno.test("separate probe records Podman security and rejects missing or rootful evidence", () => {
  const podman = containerProbeRuntime("podman");
  const security = {
    rootless: true,
    seccompEnabled: true,
    apparmorEnabled: true,
  };
  assertEquals(
    containerProbeSecurityInfo(podman, { host: { security } }),
    security,
  );
  for (
    const info of [
      null,
      {},
      { host: {} },
      { host: { security: {} } },
      { host: { security: { rootless: false } } },
      { host: { security: { rootless: "true" } } },
      { SecurityOptions: ["name=rootless"] },
    ]
  ) {
    assertThrows(
      () => containerProbeSecurityInfo(podman, info),
      Error,
      "host.security.rootless must be true",
    );
  }
  const options = ["name=seccomp,profile=builtin", "name=apparmor"];
  assertEquals(
    containerProbeSecurityInfo(containerProbeRuntime(), {
      SecurityOptions: options,
    }),
    options,
  );
});

Deno.test("separate probe creates an internal bridge with explicit IPv4 and IPv6 subnets", () => {
  // podman-network-create(1): --ipv6 autoallocates both families only when no
  // subnets are supplied. An explicit ULA alone cannot establish an IPv4 control.
  assertEquals(containerProbeNetworkArgs("123456789abc"), [
    "network",
    "create",
    "--internal",
    "--ipv6",
    "--subnet",
    "10.18.52.0/24",
    "--subnet",
    "fd12:3456:789a::/64",
    "vibe-container-123456789abc",
  ]);
  for (const token of ["", "../../bad", "123456789abz", "123456789abc0"]) {
    assertThrows(
      () => containerProbeNetworkArgs(token),
      Error,
      "Invalid probe token",
    );
  }
});

Deno.test("credential fingerprint detects a planted file, environment value or descriptor without returning it", async () => {
  const secret = `synthetic-${crypto.randomUUID()}`;
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secret),
  );
  const hash = Array.from(
    new Uint8Array(bytes),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  assertEquals(await countSyntheticCredentialMatches(secret, hash), 1);
  assertEquals(
    await countSyntheticCredentialMatches(
      `PATH=/bin\0TOKEN=${secret}\0OTHER=${secret}`,
      hash,
    ),
    2,
  );
  assertEquals(
    await countSyntheticCredentialMatches(
      `synthetic-${crypto.randomUUID()}`,
      hash,
    ),
    0,
  );
  assertEquals(
    await countSyntheticCredentialMatches(
      "a source file without the planted value",
      hash,
    ),
    0,
  );
});

function control(): NamespaceEvidence {
  return {
    namespaces: { user: "1", net: "2", pid: "3", mnt: "4" },
    capabilities: { effective: "0", permitted: "0", bounding: "0" },
    noNewPrivileges: 1,
    seccomp: 2,
    directTcp: { ipv4: true, ipv6: true },
    broker: "passed",
  };
}

function agent(): AgentContainerEvidence {
  return {
    ...control(),
    namespaces: { user: "1", net: "5", pid: "6", mnt: "7" },
    directTcp: { ipv4: false, ipv6: false },
    rootReadOnly: true,
    socketReadOnly: true,
    proxyVariablesPresent: false,
    visibility: {
      privatePathReadable: false,
      secretMatches: 0,
      processEnvironmentsRead: 1,
      regularDescriptorsRead: 1,
    },
  };
}

function witness(): BrokerWitness {
  return {
    fileMatches: true,
    environmentMatches: true,
    descriptorMatches: true,
    authenticatedRequests: 6,
  };
}

Deno.test("separate container evidence requires real controls and an inaccessible planted credential", () => {
  assertSeparateContainerEvidence(control(), agent(), control(), witness());
  for (const side of ["before", "after"] as const) {
    for (const family of ["ipv4", "ipv6"] as const) {
      const outside = control();
      outside.directTcp[family] = false;
      assertThrows(() =>
        assertSeparateContainerEvidence(
          side === "before" ? outside : control(),
          agent(),
          side === "after" ? outside : control(),
          witness(),
        )
      );
    }
    for (
      const mutate of [
        (s: NamespaceEvidence) => s.namespaces.net = "",
        (s: NamespaceEvidence) => s.capabilities.effective = "1",
        (s: NamespaceEvidence) => s.capabilities.permitted = "1",
        (s: NamespaceEvidence) => s.capabilities.bounding = "1",
        (s: NamespaceEvidence) => s.noNewPrivileges = 0,
        (s: NamespaceEvidence) => s.seccomp = 0,
        (s: NamespaceEvidence) => s.broker = "failed",
      ]
    ) {
      const outside = control();
      mutate(outside);
      assertThrows(() =>
        assertSeparateContainerEvidence(
          side === "before" ? outside : control(),
          agent(),
          side === "after" ? outside : control(),
          witness(),
        )
      );
    }
  }
  const mutations: Array<(sample: AgentContainerEvidence) => void> = [
    ...(["net", "pid", "mnt"] as const).flatMap((name) => [
      (sample: AgentContainerEvidence) => sample.namespaces[name] = "",
      (sample: AgentContainerEvidence) =>
        sample.namespaces[name] = control().namespaces[name],
    ]),
    (s) => s.directTcp.ipv4 = true,
    (s) => s.directTcp.ipv6 = true,
    (s) => s.capabilities.effective = "1",
    (s) => s.capabilities.permitted = "1",
    (s) => s.capabilities.bounding = "1",
    (s) => s.noNewPrivileges = 0,
    (s) => s.seccomp = 0,
    (s) => s.broker = "failed",
    (s) => s.rootReadOnly = false,
    (s) => s.socketReadOnly = false,
    (s) => s.proxyVariablesPresent = true,
    (s) => s.visibility.privatePathReadable = true,
    (s) => s.visibility.secretMatches = 1,
    (s) => s.visibility.processEnvironmentsRead = 0,
    (s) => s.visibility.regularDescriptorsRead = 0,
    (s) => s.visibility.processEnvironmentsRead = NaN,
    (s) => s.visibility.regularDescriptorsRead = NaN,
  ];
  for (const mutate of mutations) {
    const sample = agent();
    mutate(sample);
    assertThrows(() =>
      assertSeparateContainerEvidence(control(), sample, control(), witness())
    );
  }
  for (
    const key of [
      "fileMatches",
      "environmentMatches",
      "descriptorMatches",
    ] as const
  ) {
    const planted = witness();
    planted[key] = false;
    assertThrows(() =>
      assertSeparateContainerEvidence(control(), agent(), control(), planted)
    );
  }
  const planted = witness();
  planted.authenticatedRequests = 7;
  assertThrows(() =>
    assertSeparateContainerEvidence(control(), agent(), control(), planted)
  );
});

for (const kind of ["docker", "podman"] as const) {
  Deno.test(`separate ${kind} probe removes credential mounts while preserving the production hardening`, async () => {
    const manifest = parseContainerManifest(
      await Deno.readTextFile(
        new URL("../../../container/tools.json", import.meta.url),
      ),
    );
    const descriptor = containerProbeRuntime(kind);
    const base = buildContainerLaunchPlan({
      descriptor,
      manifest,
      image: "fixture:local",
      containerName: "fixture-agent",
      watchdogSeconds: 60,
      buildCommit: "unknown",
      hostPaths: resolveContainerLaunchHostPaths(
        "/tmp/fixture/checkout",
        (name) => name === "HOME" ? "/tmp/fixture/home" : undefined,
      ),
    });
    const targets = containerTargetPaths(manifest);
    const plan = separateContainerPlan(
      base,
      descriptor,
      targets.credentials,
      "fixture-socket",
      "none",
      true,
    );
    assertEquals(
      plan.mounts.filter((mount) =>
        mount.target.startsWith(targets.credentials)
      ),
      [],
    );
    assertEquals(plan.mounts.at(-1), {
      source: "fixture-socket",
      target: "/run/broker",
      volume: true,
      readOnly: true,
    });
    assertEquals(plan.runArgs[plan.runArgs.indexOf("--network") + 1], "none");
    for (const flag of ["--cap-drop", "--security-opt", "--read-only"]) {
      const index = base.runArgs.indexOf(flag);
      const changed = plan.runArgs.indexOf(flag);
      assertEquals(changed >= 0, true);
      if (flag !== "--read-only") {
        assertEquals(plan.runArgs[changed + 1], base.runArgs[index + 1]);
      }
    }
    for (
      const mount of base.mounts.filter((mount) =>
        mount.target.startsWith(targets.credentials)
      )
    ) {
      assertEquals(
        plan.runArgs.some((arg) => arg.includes(mount.source)),
        false,
      );
    }
    assertEquals(
      base.mounts.some((mount) => mount.target.startsWith(targets.credentials)),
      true,
    );
    const broker = separateContainerPlan(
      base,
      descriptor,
      targets.credentials,
      "fixture-socket",
      "vibe-container-deadbeef",
      false,
    );
    assertEquals(broker.mounts.at(-1)?.readOnly, false);
    assertEquals(broker.initArgs.at(-1), "/run/broker");
    assertEquals(broker.initArgs.includes("fixture-socket:/run/broker"), true);
    assertEquals(base.initArgs.includes("fixture-socket:/run/broker"), false);
    assertEquals(
      broker.runArgs[broker.runArgs.indexOf("--network") + 1],
      "vibe-container-deadbeef",
    );
    const scratch = plan.runArgs.filter((_, index) =>
      plan.runArgs[index - 1] === "--tmpfs"
    );
    assertEquals(scratch.length > 0, true);
    assertEquals(
      scratch,
      base.runArgs.filter((_, index) => base.runArgs[index - 1] === "--tmpfs"),
    );
    if (kind === "podman") {
      assertEquals(scratch.some((arg) => /[:,]U(?:,|$)/.test(arg)), true);
      assertEquals(scratch.some((arg) => /[:,](?:uid|gid)=/.test(arg)), false);
    }
    assertThrows(() =>
      separateContainerPlan(
        base,
        descriptor,
        targets.credentials,
        "../socket",
        "none",
        true,
      )
    );
    assertThrows(() =>
      separateContainerPlan(
        base,
        descriptor,
        targets.credentials,
        "fixture-socket",
        "host",
        true,
      )
    );
  });
}
