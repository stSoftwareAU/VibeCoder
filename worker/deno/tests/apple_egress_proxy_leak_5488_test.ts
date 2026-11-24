/** Issue #5488: a failed Apple proxy start must not leak a stopped container. */
import { assertEquals, assertRejects } from "@std/assert";
import {
  appleLaunch,
  appleOwnedSidecar,
  type AppleOwnership,
  reapStaleAppleOwnership,
  recordAppleOwnership,
} from "../lib/apple_egress_launch.ts";
import {
  buildEgressLaunch,
  parseContainerLaunchPlanText,
} from "../lib/container_launch.ts";
import { CONTAINER_RUNTIMES } from "../lib/container_runtime.ts";
import {
  type EgressCommandRunner,
  startEgressSidecar,
  stopEgressSidecar,
} from "../lib/egress_sidecar.ts";

function fixture() {
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
  return appleLaunch(plan, "internal", 42, "a".repeat(32));
}

/** Stateful runtime: the proxy run creates the container, then fails. */
function fakeRuntime(opts: { deleteError?: string } = {}) {
  const containers = new Set<string>();
  const networks = new Set<string>();
  const calls: string[][] = [];
  const run: EgressCommandRunner = (args, stdin) => {
    calls.push([...args]);
    const ok = { code: 0, stdout: "", stderr: "" };
    const fail = (stderr: string) => ({ code: 1, stdout: "", stderr });
    if (args[0] === "network" && args[1] === "create") {
      networks.add(args.at(-1)!);
      return Promise.resolve(ok);
    }
    if (args[0] === "run" && stdin) {
      containers.add(args[args.indexOf("--name") + 1]!);
      return Promise.reject(
        new Error("proxy client stdin write timed out after 30000ms"),
      );
    }
    if (args[0] === "delete" && args[1] === "--force") {
      if (opts.deleteError) return Promise.resolve(fail(opts.deleteError));
      const name = args[2]!;
      return Promise.resolve(
        containers.delete(name) ? ok : fail(`container ${name} not found`),
      );
    }
    if (args[0] === "network" && args[1] === "delete") {
      const name = args[2]!;
      if ([...containers].some((c) => c === `${name}-proxy`)) {
        return Promise.resolve(fail(`network ${name} has active containers`));
      }
      return Promise.resolve(
        networks.delete(name) ? ok : fail(`network ${name} not found`),
      );
    }
    return Promise.resolve(ok);
  };
  return { run, containers, networks, calls };
}

const pack = () => Promise.resolve(new Uint8Array());

function ownership(
  launch: ReturnType<typeof fixture>,
  createdNetwork = false,
  createdProxy = false,
): AppleOwnership {
  return {
    owner: 42,
    manager: 43,
    network: launch.network,
    proxy: launch.proxy,
    createdNetwork,
    createdProxy,
  };
}

async function withDir(body: (dir: string) => Promise<void>) {
  const dir = await Deno.makeTempDir();
  try {
    await body(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

async function exists(path: string) {
  try {
    await Deno.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

Deno.test("a proxy start that throws after the container exists still records proxy ownership", async () => {
  const launch = fixture();
  const fake = fakeRuntime();
  const created: string[] = [];
  await assertRejects(
    () =>
      startEgressSidecar(launch.sidecar, {
        apple: true,
        run: fake.run,
        pack,
        created: (r) => {
          created.push(r);
          return Promise.resolve();
        },
      }),
    Error,
    "stdin write timed out",
  );
  assertEquals(created, ["network", "proxy"]);
  assertEquals([...fake.containers], [launch.proxy]);
});

Deno.test("the failed attempt's own cleanup removes its proxy before its network", async () => {
  await withDir(async (dir) => {
    const launch = fixture();
    const fake = fakeRuntime();
    const owned = ownership(launch);
    const journal = `${dir}/${launch.network}.json`;
    await assertRejects(() =>
      startEgressSidecar(launch.sidecar, {
        apple: true,
        run: fake.run,
        pack,
        created: (r) => recordAppleOwnership(journal, owned, r),
      })
    );
    const saved = JSON.parse(await Deno.readTextFile(journal));
    assertEquals(saved.createdProxy, true);
    assertEquals(saved.createdNetwork, true);

    fake.calls.length = 0;
    const problems = await stopEgressSidecar(
      appleOwnedSidecar(launch.sidecar, owned),
      { apple: true, run: fake.run },
    );
    assertEquals(problems, []);
    assertEquals([...fake.containers], []);
    assertEquals([...fake.networks], []);
    const verbs = fake.calls.map((c) => c.slice(0, 2).join(" "));
    assertEquals(
      verbs.indexOf("delete --force") < verbs.indexOf("network delete"),
      true,
    );
    assertEquals(verbs.includes("delete --force"), true);
  });
});

for (
  const [label, createdProxy] of [
    ["pre-fix journal (createdProxy false)", false],
    ["new journal (createdProxy true)", true],
  ] as const
) {
  Deno.test(`stale cleanup removes the leaked proxy, then the network, then the journal: ${label}`, async () => {
    await withDir(async (dir) => {
      const launch = fixture();
      const fake = fakeRuntime();
      fake.containers.add(launch.proxy);
      fake.networks.add(launch.network);
      const journal = `${dir}/${launch.network}.json`;
      await Deno.writeTextFile(
        journal,
        JSON.stringify(ownership(launch, true, createdProxy)),
      );
      await Deno.writeTextFile(`${dir}/other.json`, "{}");
      const lines: string[] = [];
      await reapStaleAppleOwnership(
        dir,
        fake.run,
        () => false,
        (l) => lines.push(l),
      );
      assertEquals([...fake.containers], []);
      assertEquals([...fake.networks], []);
      assertEquals(await exists(journal), false);
      assertEquals(await exists(`${dir}/other.json`), true);
      assertEquals(lines, []);
      assertEquals(fake.calls, [
        ["delete", "--force", launch.proxy],
        ["network", "delete", launch.network],
      ]);
    });
  });
}

for (const networkPresent of [true, false]) {
  Deno.test(`stale cleanup clears a missing proxy's journal (network present: ${networkPresent})`, async () => {
    await withDir(async (dir) => {
      const launch = fixture();
      const fake = fakeRuntime();
      if (networkPresent) fake.networks.add(launch.network);
      const journal = `${dir}/${launch.network}.json`;
      await Deno.writeTextFile(
        journal,
        JSON.stringify(ownership(launch, true, false)),
      );
      const lines: string[] = [];
      await reapStaleAppleOwnership(
        dir,
        fake.run,
        () => false,
        (line) => lines.push(line),
      );
      assertEquals([...fake.networks], []);
      assertEquals(await exists(journal), false);
      assertEquals(lines, []);
    });
  });
}

for (const livePid of [42, 43]) {
  Deno.test(`stale cleanup never touches resources of a live pid ${livePid}`, async () => {
    await withDir(async (dir) => {
      const launch = fixture();
      const fake = fakeRuntime();
      fake.containers.add(launch.proxy);
      fake.networks.add(launch.network);
      const journal = `${dir}/${launch.network}.json`;
      await Deno.writeTextFile(
        journal,
        JSON.stringify(ownership(launch, true, true)),
      );
      await reapStaleAppleOwnership(
        dir,
        fake.run,
        (pid) => pid === livePid,
        () => {},
      );
      assertEquals(fake.calls, []);
      assertEquals([...fake.containers], [launch.proxy]);
      assertEquals([...fake.networks], [launch.network]);
      assertEquals(await exists(journal), true);
    });
  });
}

Deno.test("stale cleanup retains the journal and logs when the runtime errors", async () => {
  await withDir(async (dir) => {
    const launch = fixture();
    const fake = fakeRuntime({ deleteError: "XPC connection error" });
    fake.containers.add(launch.proxy);
    fake.networks.add(launch.network);
    const journal = `${dir}/${launch.network}.json`;
    await Deno.writeTextFile(
      journal,
      JSON.stringify(ownership(launch, true, false)),
    );
    const lines: string[] = [];
    await reapStaleAppleOwnership(
      dir,
      fake.run,
      () => false,
      (l) => lines.push(l),
    );
    assertEquals(await exists(journal), true);
    assertEquals([...fake.networks], [launch.network]);
    assertEquals(lines.length, 1);
    assertEquals(lines[0]!.includes("stale cleanup retained"), true);
    assertEquals(lines[0]!.includes("XPC connection error"), true);
  });
});
