import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  appleControlFailures,
  appleControls,
  appleRawProbes,
  compareReachability,
} from "../lib/apple_egress_controls.ts";
import {
  appleCapabilities,
  appleChildOutput,
  appleLaunch,
  appleMode,
  appleProxyAddress,
  appleStateDirectory,
  appleWorkerArgs,
  retryAppleEgress,
  staleAppleOwnership,
} from "../lib/apple_egress_launch.ts";
import {
  buildEgressLaunch,
  parseContainerLaunchPlanText,
} from "../lib/container_launch.ts";
import { CONTAINER_RUNTIMES } from "../lib/container_runtime.ts";
import { directTcpFailure } from "../lib/egress_selfcheck.ts";
import { spawnCommandWithTimeout } from "../lib/subprocess_timeout.ts";
import {
  startEgressSidecar,
  stopEgressSidecar,
} from "../lib/egress_sidecar.ts";

const good = {
  directCloudflare: "refused",
  directGithub: "refused",
  proxyDenied: "denied",
  proxyAllowed: "succeeded",
} as const;
const open = {
  ipv4: "connected",
  ipv6: "not_checked",
  hostname: "connected",
  host: "connected",
  dns: "connected",
};
const isolated = {
  ipv4: "refused",
  ipv6: "refused",
  hostname: "not_checked",
  host: "connected",
  dns: "not_checked",
};

Deno.test("Apple control results require a reachable matching negative control", () => {
  assertEquals(
    directTcpFailure(new Error("too many open files")),
    "not_checked",
  );
  assertEquals(directTcpFailure(new Error("permission denied")), "not_checked");
  assertEquals(directTcpFailure(new Error("connection refused")), "refused");
  const controls = appleControls(good, isolated, open);
  assertEquals(controls, {
    proxyAllowlist: "enforced",
    directInternetV4: "blocked",
    directInternetV6: "unknown",
    directHostname: "unknown",
    hostLan: "reachable",
    dns: "unknown",
  });
  assertEquals(appleControlFailures("internal", controls), []);
  for (const observed of [undefined, "not_checked", "broken"]) {
    assertEquals(compareReachability(observed, "connected"), "unknown");
  }
  for (const negative of [undefined, "not_checked", "refused"]) {
    assertEquals(compareReachability("refused", negative), "unknown");
  }
  assertEquals(compareReachability("connected", undefined), "reachable");
});

Deno.test("Apple accepted gaps stay distinct from regression of selected promises", () => {
  const controls = appleControls(good, open, open);
  assert(
    appleControlFailures("internal", controls).includes(
      "directInternetV4=reachable",
    ),
  );
  assertEquals(appleControlFailures("advisory", controls), []);
  for (const proxyAllowed of ["failed", "not_checked"] as const) {
    const broken = appleControls({ ...good, proxyAllowed }, isolated, open);
    assert(appleControlFailures("advisory", broken).length);
    assert(appleControlFailures("internal", broken).length);
  }
});

Deno.test("Apple mode verifies measured version/help and never silently drops explicit internal mode", () => {
  const supported = appleCapabilities(
    "container CLI version 1.2.2",
    "27.0.1",
    "--internal",
    "--network",
  );
  assertEquals(appleMode(undefined, supported), "internal");
  const unsupported = appleCapabilities(
    "container CLI version 0.1.0",
    "15.0.1",
    "",
    "--network",
  );
  assertEquals(appleMode("auto", unsupported), "advisory");
  assertThrows(() => appleMode("internal", unsupported));
  assertThrows(() =>
    appleCapabilities("failed", "27.0.1", "--internal", "--network")
  );
  assertThrows(() => appleMode("typo", supported));
});

function fixture(mode: "internal" | "advisory" = "internal") {
  const candidate = CONTAINER_RUNTIMES["apple-container"];
  const pieces = buildEgressLaunch({
    descriptor: {
      platform: "darwin",
      kind: "apple-container",
      executable: "container",
      displayName: candidate.displayName,
      dialect: candidate.dialect,
      probed: ["apple-container"],
    },
    containerName: "vibe-coder-42",
    image: "vibe:test",
    repoRoot: "/repo",
    runtimeVersion: "1.2.2",
    providers: [],
    egressAllowHosts: ["api.github.com"],
  });
  const plan = parseContainerLaunchPlanText(
    "runtime=container\0image=vibe:test\0",
  );
  Object.assign(plan, {
    proxyName: pieces.proxyName,
    proxyRun: pieces.proxyRunArgs,
    proxyStop: pieces.proxyStopArgs,
    proxyBundle: "/repo",
    networkCreate: pieces.networkCreateArgs,
    networkRemove: pieces.networkRemoveArgs,
    run: [
      "run",
      "--network",
      pieces.workerNetwork!,
      "--env",
      "HTTPS_PROXY=http://VIBE_EGRESS_PROXY_ADDRESS:3128",
      "vibe:test",
    ],
  });
  return appleLaunch(plan, mode, 42, "a".repeat(32));
}

Deno.test("Apple attaches networks at creation and resolves the selected interface", () => {
  const launch = fixture();
  assertEquals(launch.sidecar.networkConnectArgs, []);
  assertEquals(
    launch.sidecar.proxyRunArgs.filter((arg) => arg === "--network").length,
    2,
  );
  assert(launch.sidecar.proxyRunArgs.includes(launch.network));
  assertEquals(launch.sidecar.proxyRunArgs.includes("--publish"), false);
  assertEquals(launch.sidecar.proxyRunArgs.includes("--volume"), false);
  const address = appleProxyAddress(
    JSON.stringify([{
      status: {
        networks: [{
          network: "default",
          ipv4Address: "192.168.64.2/24",
          ipv4Gateway: "192.168.64.1",
        }, {
          network: launch.network,
          ipv4Address: "192.168.128.2/24",
          ipv4Gateway: "192.168.128.1",
        }],
      },
    }]),
    launch.network,
  );
  assertEquals(address.address, "192.168.128.2");
  assertThrows(() => appleProxyAddress("[]", launch.network));
  const worker = appleWorkerArgs(launch.run, {
    HTTPS_PROXY: `http://${address.address}:3128`,
    VIBE_APPLE_EGRESS_MODE: "internal",
  });
  assert(worker.includes("HTTPS_PROXY=http://192.168.128.2:3128"));
  assertEquals(
    worker.some((arg) => arg.includes("VIBE_EGRESS_PROXY_ADDRESS")),
    false,
  );
  const advisory = fixture("advisory");
  assertEquals(advisory.sidecar.networkCreateArgs, []);
  assertEquals(advisory.run.includes("--network"), false);
  assertEquals(
    advisory.sidecar.proxyRunArgs.filter((arg) => arg === "--network").length,
    1,
  );
});

Deno.test("Apple internal mode gives the worker a resolver that fails at once, so a proxied fetch is not held up", () => {
  // The internal network has no reachable DNS. Deno's fetch resolves the
  // target before it uses HTTPS_PROXY, so each new host waited ~10s for that
  // lookup to time out, and every Claude budget probe (10s limit) timed out.
  const launch = fixture();
  const at = launch.run.indexOf("--dns");
  assert(at > 0, "internal mode sets --dns");
  assertEquals(launch.run[at + 1], "127.0.0.1");
  assert(at < launch.run.indexOf("vibe:test"), "--dns precedes the image");
  // Advisory mode keeps the default network and its DNS.
  assertEquals(fixture("advisory").run.includes("--dns"), false);
});

/** Fake the network: record each lookup and dial, answer from `answers`. */
async function withFakeNetwork<T>(
  answers: string[] | Error,
  body: (
    lookups: { host: string; options?: Deno.ResolveDnsOptions }[],
    dials: string[],
  ) => Promise<T>,
): Promise<T> {
  const lookups: { host: string; options?: Deno.ResolveDnsOptions }[] = [];
  const dials: string[] = [];
  const resolveDns = Deno.resolveDns;
  const connect = Deno.connect;
  Object.assign(Deno, {
    resolveDns: (
      host: string,
      _type: string,
      options?: Deno.ResolveDnsOptions,
    ) => {
      lookups.push({ host, options });
      return answers instanceof Error
        ? Promise.reject(answers)
        : Promise.resolve(answers);
    },
    connect: (options: { hostname?: string }) => {
      dials.push(options.hostname ?? "");
      return Promise.resolve({ close() {} });
    },
  });
  try {
    return await body(lookups, dials);
  } finally {
    Object.assign(Deno, { resolveDns, connect });
  }
}

Deno.test("Apple internal self-check asks the internal network's gateway resolver, not the loopback system one", async () => {
  // `--dns 127.0.0.1` makes the system resolver fail at once; the probes must
  // still see whether the gateway resolver answers, or DNS and hostname
  // escapes read as unknown on every launch.
  const env = (name: string) =>
    name === "VIBE_EGRESS_DNS_SERVER" ? "192.168.128.1" : undefined;
  const observed = await withFakeNetwork(
    ["203.0.113.7"],
    async (lookups, dials) => {
      const result = await appleRawProbes(env, 50);
      assertEquals(lookups.map((lookup) => lookup.host), [
        "api.github.com",
        "api.github.com",
      ]);
      for (const lookup of lookups) {
        assertEquals(lookup.options?.nameServer, {
          ipAddr: "192.168.128.1",
          port: 53,
        });
      }
      // The hostname probe dials what that resolver answered.
      assert(dials.includes("203.0.113.7"), `dials: ${dials.join(",")}`);
      return result;
    },
  );
  assertEquals(observed.dns, "connected");
  assertEquals(observed.hostname, "connected");
  assertEquals(
    appleControlFailures(
      "internal",
      appleControls(good, observed, open),
    ).includes("directHostname=reachable"),
    true,
  );
});

Deno.test("Apple self-check without a named resolver uses the system one, and a refusing resolver stays unknown", async () => {
  await withFakeNetwork(new Error("connection refused"), async (lookups) => {
    const observed = await appleRawProbes(() => undefined, 50);
    assertEquals(lookups.length, 2);
    assertEquals(lookups.every((lookup) => !lookup.options?.nameServer), true);
    assertEquals(observed.dns, "not_checked");
    assertEquals(observed.hostname, "not_checked");
  });
});

Deno.test("Apple self-check refuses a malformed resolver address rather than measuring the wrong one", async () => {
  await assertRejects(
    () =>
      appleRawProbes(
        (name) => name === "VIBE_EGRESS_DNS_SERVER" ? "gateway" : undefined,
        50,
      ),
    Error,
    "VIBE_EGRESS_DNS_SERVER must be an IPv4 address",
  );
});

Deno.test("Apple lifecycle never deletes resources before creating its own and skips Docker connect", async () => {
  const launch = fixture();
  const calls: string[][] = [];
  const created: string[] = [];
  const run = async (args: readonly string[]) => {
    calls.push([...args]);
    return {
      code: 0,
      stdout: args[0] === "logs"
        ? "[EGRESS_PROXY] listening"
        : args[0] === "inspect"
        ? JSON.stringify([{
          status: {
            networks: [{
              network: launch.network,
              ipv4Address: "192.168.128.2/24",
              ipv4Gateway: "192.168.128.1",
            }],
          },
        }])
        : "",
      stderr: "",
    };
  };
  await startEgressSidecar(launch.sidecar, {
    apple: true,
    run,
    pack: async () => new Uint8Array(),
    created: async (resource) => {
      created.push(resource);
    },
  });
  assertEquals(created, ["network", "proxy"]);
  assertEquals(calls[0], launch.sidecar.networkCreateArgs);
  assertEquals(
    calls.some((args) => args.includes("delete") || args.includes("connect")),
    false,
  );
  const problems = await stopEgressSidecar(launch.sidecar, {
    apple: true,
    run,
  });
  assertEquals(problems, []);
  assertEquals(calls.at(-2), launch.sidecar.proxyStopArgs);
  assertEquals(calls.at(-1), launch.sidecar.networkRemoveArgs);
  const failedCleanup: string[][] = [];
  const failures = await stopEgressSidecar(launch.sidecar, {
    apple: true,
    run: (args) => {
      failedCleanup.push([...args]);
      throw new Error("runtime unavailable");
    },
  });
  assert(failures.length >= 3);
  assertEquals(failedCleanup.at(-1), launch.sidecar.networkRemoveArgs);
});

Deno.test("Apple cleanup authority stays outside worker mounts and refuses symlinks", async () => {
  const home = await Deno.makeTempDir();
  try {
    const uid = (await Deno.stat(home)).uid;
    const directory = (args: string[]) =>
      appleStateDirectory(home, args, () => uid);
    const logs = `${home}/logs`;
    await Deno.mkdir(logs);
    const state = await directory([
      "run",
      "--volume",
      `${logs}:/logs`,
    ]);
    assert(!state.startsWith(`${logs}/`));
    await assertRejects(
      () => appleStateDirectory(home, [], () => -1),
      Error,
      "private",
    );
    await assertRejects(
      () => directory(["run", "--volume", "/:/host"]),
      Error,
      "overlaps",
    );
    await assertRejects(
      () =>
        directory([
          "run",
          "--volume",
          `${home}:/host`,
        ]),
      Error,
      "overlaps",
    );
    const alias = `${home}/alias`;
    await Deno.symlink(state, alias);
    await assertRejects(
      () =>
        directory([
          "run",
          "--volume",
          `${alias}:/logs`,
        ]),
      Error,
      "overlaps",
    );
    await Deno.remove(state);
    await Deno.symlink(logs, state);
    await assertRejects(() => directory([]), Error, "private");
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("Apple deadline kills a CLI that ignores SIGTERM while stdin is blocked", async () => {
  const child = spawnCommandWithTimeout(Deno.execPath(), {
    args: [
      "eval",
      "Deno.addSignalListener('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)",
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    timeoutMs: 10000,
  });
  const reader = child.stdout.getReader();
  await reader.read();
  reader.releaseLock();
  await assertRejects(
    () => appleChildOutput(child, new Uint8Array(8 * 1024 * 1024), 100, 100),
    Error,
    "bounded deadline",
  );
  assertEquals((await child.status).success, false);
});

Deno.test("Apple deadline closes pipes retained by an exited CLI's descendant", async () => {
  const child = spawnCommandWithTimeout("/bin/sh", {
    args: ["-c", "sleep 3 & exit 0"],
    stdout: "piped",
    stderr: "piped",
    timeoutMs: 10000,
  });
  await assertRejects(
    () => appleChildOutput(child, undefined, 100, 100),
    Error,
    "bounded deadline",
  );
  // Deno's resource/operation sanitiser catches readers surviving this test.
  assertEquals((await child.status).success, true);
});

Deno.test("Apple stale cleanup requires exact owned journal names and two dead processes", () => {
  const network = `vibe-egress-owned-42-${"a".repeat(24)}`;
  const owned = {
    owner: 42,
    manager: 43,
    network,
    proxy: `${network}-proxy`,
    createdNetwork: true,
    createdProxy: true,
  };
  const filename = `${network}.json`;
  assertEquals(
    staleAppleOwnership(JSON.stringify(owned), filename, () => false),
    owned,
  );
  for (
    const alive of [(pid: number) => pid === 42, (pid: number) => pid === 43]
  ) {
    assertEquals(
      staleAppleOwnership(JSON.stringify(owned), filename, alive),
      undefined,
    );
  }
  for (
    const changed of [{ network: "default" }, { proxy: "live-worker" }, {
      owner: 1,
    }, { createdProxy: undefined }]
  ) {
    assertEquals(
      staleAppleOwnership(
        JSON.stringify({ ...owned, ...changed }),
        filename,
        () => false,
      ),
      undefined,
    );
  }
  assertEquals(
    staleAppleOwnership(JSON.stringify(owned), "other.json", () => false),
    undefined,
  );
});

Deno.test("Apple setup retries are bounded and never change the selected mode", async () => {
  const attempts: number[] = [];
  const modes: string[] = [];
  await assertRejects(
    () =>
      retryAppleEgress(async (attempt) => {
        attempts.push(attempt);
        modes.push(fixture().mode);
        throw new Error("proxy refused");
      }, { cancelled: () => false, failed: () => {}, pause: async () => {} }),
    Error,
    "proxy refused",
  );
  assertEquals(attempts, [1, 2, 3]);
  assertEquals(modes, ["internal", "internal", "internal"]);
  let count = 0;
  assertEquals(
    await retryAppleEgress(async () => {
      if (++count === 1) throw new Error("transient");
      return "ready";
    }, { cancelled: () => false, failed: () => {}, pause: async () => {} }),
    "ready",
  );
  assertEquals(count, 2);
});
