/**
 * Tests for container_runtime.ts and the container-runtime-detect command —
 * per-platform container-runtime detection and validation (Issue #4063).
 *
 * Every test injects a fake probe and a platform, so all branches run without
 * Docker, Podman or Apple `container` installed. The three ways detection
 * silently breaks are covered: a platform resolving the wrong runtime, a
 * present-but-unhealthy runtime being selected anyway, and a silent
 * "run natively instead" outcome creeping back in.
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  buildMountArguments,
  candidatesForPlatform,
  CONTAINER_RUNTIME_KINDS,
  type ContainerRuntimeCandidate,
  type ContainerRuntimeKind,
  type ContainerRuntimeProbe,
  ContainerRuntimeUnavailableError,
  detectContainerRuntime,
  type HostPlatform,
  normaliseHostPlatform,
  SUPPORTED_HOST_PLATFORMS,
  UnsupportedHostPlatformError,
} from "../lib/container_runtime.ts";
import {
  containerRuntimeDetectCommand,
  detectContainerRuntimeForCommand,
} from "../commands/container_runtime_detect.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";

/**
 * A probe that reports the named runtimes healthy and every other runtime
 * unavailable, recording the order candidates were probed in.
 */
function fakeProbe(
  healthy: ContainerRuntimeKind[],
  calls: ContainerRuntimeKind[] = [],
): ContainerRuntimeProbe {
  return (candidate: ContainerRuntimeCandidate) => {
    calls.push(candidate.kind);
    return Promise.resolve(
      healthy.includes(candidate.kind)
        ? { available: true, path: `/usr/local/bin/${candidate.executable}` }
        : { available: false, reason: "not found on PATH" },
    );
  };
}

/** A probe that finds every runtime present but reports it unhealthy. */
const unhealthyProbe: ContainerRuntimeProbe = (candidate) =>
  Promise.resolve({
    available: false,
    path: `/usr/local/bin/${candidate.executable}`,
    reason: "daemon unreachable (exit 1)",
  });

// ---------------------------------------------------------------------------
// Platform normalisation
// ---------------------------------------------------------------------------

Deno.test("normaliseHostPlatform - maps the supported host platforms", () => {
  assertEquals(normaliseHostPlatform("darwin"), "darwin");
  assertEquals(normaliseHostPlatform("linux"), "linux");
  assertEquals(normaliseHostPlatform("windows"), "windows");
  assertEquals(normaliseHostPlatform("Darwin"), "darwin");
  assertEquals(normaliseHostPlatform("  macos "), "darwin");
  assertEquals(normaliseHostPlatform("win32"), "windows");
});

Deno.test("normaliseHostPlatform - an unsupported platform fails loud", () => {
  let message = "";
  try {
    normaliseHostPlatform("freebsd");
  } catch (error) {
    assert(error instanceof UnsupportedHostPlatformError);
    message = error.message;
  }

  assert(message !== "", "an unsupported platform did not throw");
  assertStringIncludes(message, "freebsd");
  for (const platform of SUPPORTED_HOST_PLATFORMS) {
    assertStringIncludes(message, platform);
  }
});

// ---------------------------------------------------------------------------
// Per-platform resolution
// ---------------------------------------------------------------------------

Deno.test("detectContainerRuntime - macOS resolves Apple container", async () => {
  const calls: ContainerRuntimeKind[] = [];
  const descriptor = await detectContainerRuntime({
    platform: "darwin",
    probe: fakeProbe(["apple-container", "docker", "podman"], calls),
  });

  assertEquals(descriptor.kind, "apple-container");
  assertEquals(descriptor.platform, "darwin");
  assertEquals(descriptor.executable, "/usr/local/bin/container");
  assertEquals(descriptor.probed, ["apple-container"]);
  // Docker and Podman are never even probed on macOS.
  assertEquals(calls, ["apple-container"]);
});

Deno.test("detectContainerRuntime - Linux prefers Docker, then Podman", async () => {
  const bothCalls: ContainerRuntimeKind[] = [];
  const both = await detectContainerRuntime({
    platform: "linux",
    probe: fakeProbe(["docker", "podman"], bothCalls),
  });
  assertEquals(both.kind, "docker");
  assertEquals(bothCalls, ["docker"]);

  const podmanCalls: ContainerRuntimeKind[] = [];
  const podmanOnly = await detectContainerRuntime({
    platform: "linux",
    probe: fakeProbe(["podman"], podmanCalls),
  });
  assertEquals(podmanOnly.kind, "podman");
  assertEquals(podmanOnly.executable, "/usr/local/bin/podman");
  assertEquals(podmanCalls, ["docker", "podman"]);
  assertEquals(podmanOnly.probed, ["docker", "podman"]);
});

Deno.test("detectContainerRuntime - Windows prefers Docker, then Podman", async () => {
  const docker = await detectContainerRuntime({
    platform: "windows",
    probe: fakeProbe(["docker", "podman"]),
  });
  assertEquals(docker.kind, "docker");

  const podman = await detectContainerRuntime({
    platform: "windows",
    probe: fakeProbe(["podman"]),
  });
  assertEquals(podman.kind, "podman");
});

Deno.test("detectContainerRuntime - Apple container is never selected off macOS", async () => {
  for (const platform of ["linux", "windows"] as HostPlatform[]) {
    const calls: ContainerRuntimeKind[] = [];
    let thrown: unknown;
    try {
      await detectContainerRuntime({
        platform,
        probe: fakeProbe(["apple-container"], calls),
      });
    } catch (error) {
      thrown = error;
    }

    assert(
      thrown instanceof ContainerRuntimeUnavailableError,
      `${platform} resolved a runtime it does not support`,
    );
    assertEquals(calls, ["docker", "podman"]);
  }
});

// ---------------------------------------------------------------------------
// Present but unhealthy
// ---------------------------------------------------------------------------

Deno.test("detectContainerRuntime - a present-but-unhealthy runtime is not selected", async () => {
  const calls: ContainerRuntimeKind[] = [];
  const probe: ContainerRuntimeProbe = (candidate) => {
    calls.push(candidate.kind);
    if (candidate.kind === "docker") {
      return Promise.resolve({
        available: false,
        path: "/usr/bin/docker",
        reason: "Cannot connect to the Docker daemon (exit 1)",
      });
    }
    return Promise.resolve({ available: true, path: "/usr/bin/podman" });
  };

  const descriptor = await detectContainerRuntime({ platform: "linux", probe });

  assertEquals(descriptor.kind, "podman");
  assertEquals(calls, ["docker", "podman"]);
});

Deno.test("detectContainerRuntime - an unhealthy sole runtime fails, naming the reason", async () => {
  let error: ContainerRuntimeUnavailableError | undefined;
  try {
    await detectContainerRuntime({
      platform: "darwin",
      probe: unhealthyProbe,
    });
  } catch (caught) {
    error = caught as ContainerRuntimeUnavailableError;
  }

  assert(
    error instanceof ContainerRuntimeUnavailableError,
    "an unhealthy runtime was selected instead of rejected",
  );
  assertEquals(error.platform, "darwin");
  assertEquals(error.failures.map((failure) => failure.kind), [
    "apple-container",
  ]);
  assertStringIncludes(error.message, "daemon unreachable");
  assertStringIncludes(error.message, "container");
});

// ---------------------------------------------------------------------------
// No supported runtime
// ---------------------------------------------------------------------------

Deno.test("detectContainerRuntime - no runtime names the platform, the probes and the install hints", async () => {
  for (const platform of SUPPORTED_HOST_PLATFORMS) {
    let error: ContainerRuntimeUnavailableError | undefined;
    try {
      await detectContainerRuntime({ platform, probe: fakeProbe([]) });
    } catch (caught) {
      error = caught as ContainerRuntimeUnavailableError;
    }

    assert(
      error instanceof ContainerRuntimeUnavailableError,
      `${platform} did not fail with no runtime available`,
    );
    assertEquals(error.platform, platform);
    assertStringIncludes(error.message, platform);

    const candidates = candidatesForPlatform(platform);
    assertEquals(
      error.failures.map((failure) => failure.kind),
      candidates.map((candidate) => candidate.kind),
    );
    for (const candidate of candidates) {
      assertStringIncludes(error.message, candidate.displayName);
      assertStringIncludes(error.message, candidate.installHint);
    }
  }
});

// ---------------------------------------------------------------------------
// No native fallback
// ---------------------------------------------------------------------------

Deno.test("detectContainerRuntime - every outcome is a container runtime or a failure", async () => {
  const kinds = [...CONTAINER_RUNTIME_KINDS];
  // Exhaustive over which runtimes are healthy: 2^3 combinations per platform.
  for (const platform of SUPPORTED_HOST_PLATFORMS) {
    for (let mask = 0; mask < 1 << kinds.length; mask++) {
      const healthy = kinds.filter((_, index) => (mask & (1 << index)) !== 0);

      let descriptor;
      let thrown: unknown;
      try {
        descriptor = await detectContainerRuntime({
          platform,
          probe: fakeProbe(healthy),
        });
      } catch (error) {
        thrown = error;
      }

      if (descriptor) {
        assert(
          CONTAINER_RUNTIME_KINDS.includes(descriptor.kind),
          `${platform}/${
            healthy.join("+")
          } resolved a non-container outcome: ` +
            `${descriptor.kind}`,
        );
        assert(
          healthy.includes(descriptor.kind),
          `${platform}/${healthy.join("+")} selected an unavailable runtime`,
        );
      } else {
        assert(
          thrown instanceof ContainerRuntimeUnavailableError,
          `${platform}/${healthy.join("+")} neither resolved nor failed loud`,
        );
      }
    }
  }
});

Deno.test("container runtimes - the kinds are exactly the supported container runtimes", () => {
  assertEquals([...CONTAINER_RUNTIME_KINDS].sort(), [
    "apple-container",
    "docker",
    "podman",
  ]);
});

// ---------------------------------------------------------------------------
// Dialect
// ---------------------------------------------------------------------------

Deno.test("candidatesForPlatform - dialects record the flags each runtime supports", () => {
  const apple = candidatesForPlatform("darwin")[0]!;
  assertEquals(apple.kind, "apple-container");
  assertEquals(apple.dialect.mountFlag, "--volume");
  // Apple `container` has no --userns / --security-opt (apple/container docs).
  assertEquals(apple.dialect.supportsUserns, false);
  assertEquals(apple.dialect.supportsSecurityOpt, false);

  for (const candidate of candidatesForPlatform("linux")) {
    assertEquals(candidate.dialect.supportsUserns, true);
    assertEquals(candidate.dialect.supportsSecurityOpt, true);
  }
});

Deno.test("buildMountArguments - renders a mount in the runtime's dialect", async () => {
  const descriptor = await detectContainerRuntime({
    platform: "linux",
    probe: fakeProbe(["docker"]),
  });

  assertEquals(
    buildMountArguments(descriptor, {
      source: "/home/vibe/auto-issue-work",
      target: "/workspace",
    }),
    ["--volume", "/home/vibe/auto-issue-work:/workspace"],
  );
  assertEquals(
    buildMountArguments(descriptor, {
      source: "/home/vibe/.config.json",
      target: "/config/.config.json",
      readOnly: true,
    }),
    ["--volume", "/home/vibe/.config.json:/config/.config.json:ro"],
  );
});

Deno.test("buildMountArguments - rejects an empty or relative mount", async () => {
  const descriptor = await detectContainerRuntime({
    platform: "darwin",
    probe: fakeProbe(["apple-container"]),
  });

  for (
    const mount of [
      { source: "", target: "/workspace" },
      { source: "/host", target: "" },
      { source: "/host", target: "workspace" },
    ]
  ) {
    let message = "";
    try {
      buildMountArguments(descriptor, mount);
    } catch (error) {
      message = (error as Error).message;
    }
    assert(
      message !== "",
      `mount ${JSON.stringify(mount)} was accepted silently`,
    );
  }
});

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

Deno.test("container-runtime-detect - reports the resolved runtime as data", async () => {
  const result = await detectContainerRuntimeForCommand({
    platform: "linux",
    probe: fakeProbe(["podman"]),
  });

  assertEquals(result.success, true);
  assertEquals(result.message, "/usr/local/bin/podman");
  assertEquals(result.data?.kind, "podman");
  assertEquals(result.data?.platform, "linux");
  assertEquals(result.data?.executable, "/usr/local/bin/podman");
  assertEquals(result.data?.dialect.mountFlag, "--volume");
  assertEquals(result.data?.probed, ["docker", "podman"]);
});

Deno.test("container-runtime-detect - exits non-zero naming the probed runtimes", async () => {
  const result = await detectContainerRuntimeForCommand({
    platform: "windows",
    probe: fakeProbe([]),
  });

  assertEquals(result.success, false);
  assertEquals(result.data, undefined);
  assertStringIncludes(result.message, "windows");
  assertStringIncludes(result.message, "Docker");
  assertStringIncludes(result.message, "Podman");
});

Deno.test("container-runtime-detect - an unsupported platform fails the command", async () => {
  const result = await containerRuntimeDetectCommand.execute(
    { platform: "freebsd" },
    buildDefaultWorkerConfig(),
  );

  assertEquals(result.success, false);
  assertStringIncludes(result.message, "freebsd");
});

Deno.test("container-runtime-detect - is registered in the worker command registry", async () => {
  const { createDefaultRegistry } = await import("../mod.ts");
  const registry = createDefaultRegistry();
  assert(
    registry.has("container-runtime-detect"),
    "container-runtime-detect is not registered in mod.ts",
  );
});

// ---------------------------------------------------------------------------
// Launcher self-heal of a stopped service (Issue #4253)
// ---------------------------------------------------------------------------

/**
 * A probe whose apple-container answers fail until `healAfterCalls` probes
 * have happened — the "apiserver is not running" shape that kept host-25
 * dark ~5 hours: binary present, service stopped.
 */
function stoppedServiceProbe(
  healAfterCalls: number,
  calls: { count: number } = { count: 0 },
): ContainerRuntimeProbe {
  return (candidate: ContainerRuntimeCandidate) => {
    calls.count++;
    if (candidate.kind !== "apple-container") {
      return Promise.resolve({
        available: false,
        reason: "not found on PATH",
      });
    }
    if (calls.count > healAfterCalls) {
      return Promise.resolve({
        available: true,
        path: "/usr/local/bin/container",
      });
    }
    return Promise.resolve({
      available: false,
      path: "/usr/local/bin/container",
      reason:
        "`container system status` exited 1: apiserver is not running and not registered with launchd",
    });
  };
}

Deno.test("detectContainerRuntime - self-heals a stopped apple-container service (Issue #4253)", async () => {
  const started: { executable: string; args: readonly string[] }[] = [];
  const events: string[] = [];
  const logs: string[] = [];

  const descriptor = await detectContainerRuntime({
    platform: "darwin",
    probe: stoppedServiceProbe(1),
    selfHeal: true,
    serviceStarter: (executable, args) => {
      started.push({ executable, args });
      return Promise.resolve({ ok: true });
    },
    log: (m) => logs.push(m),
    emitSelfHealEvent: (event) => {
      events.push(`${event.action}:${event.result}`);
      return Promise.resolve(true);
    },
  });

  assertEquals(descriptor.kind, "apple-container");
  assertEquals(started.length, 1, "the service must be started exactly once");
  assertEquals(started[0]!.args, [
    "system",
    "start",
    "--enable-kernel-install",
  ]);
  assertEquals(events, ["container_service_restart:ok"]);
  assertEquals(
    logs.some((m) => m.includes("Issue #4253")),
    true,
    "the self-heal attempt must be logged",
  );
});

Deno.test("detectContainerRuntime - a failed service start still fails detection, with a failed event (Issue #4253)", async () => {
  const events: string[] = [];

  await assertRejects(
    () =>
      detectContainerRuntime({
        platform: "darwin",
        probe: stoppedServiceProbe(Infinity),
        selfHeal: true,
        serviceStarter: () =>
          Promise.resolve({ ok: false, detail: "launchd rejected the job" }),
        emitSelfHealEvent: (event) => {
          events.push(`${event.action}:${event.result}`);
          return Promise.resolve(true);
        },
      }),
    ContainerRuntimeUnavailableError,
  );
  assertEquals(events, ["container_service_restart:failed"]);
});

Deno.test("detectContainerRuntime - no self-heal without the opt-in (Issue #4253)", async () => {
  const started: string[] = [];
  await assertRejects(
    () =>
      detectContainerRuntime({
        platform: "darwin",
        probe: stoppedServiceProbe(Infinity),
        serviceStarter: (executable) => {
          started.push(executable);
          return Promise.resolve({ ok: true });
        },
      }),
    ContainerRuntimeUnavailableError,
  );
  assertEquals(
    started.length,
    0,
    "setup and probe paths must keep their read-only behaviour",
  );
});

Deno.test("detectContainerRuntime - self-heal never fires when the binary is absent (Issue #4253)", async () => {
  const started: string[] = [];
  await assertRejects(
    () =>
      detectContainerRuntime({
        platform: "darwin",
        probe: (candidate) => {
          void candidate;
          return Promise.resolve({
            available: false,
            reason: "not found on PATH",
          });
        },
        selfHeal: true,
        serviceStarter: (executable) => {
          started.push(executable);
          return Promise.resolve({ ok: true });
        },
      }),
    ContainerRuntimeUnavailableError,
  );
  assertEquals(
    started.length,
    0,
    "an absent install is not a stopped service — nothing to start",
  );
});
