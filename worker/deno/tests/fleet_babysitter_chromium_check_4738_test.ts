import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import type { ContainerLaunchPlan } from "../lib/container_launch.ts";
import {
  BABYSITTER_CHROMIUM_CHECK_COMMAND,
  type BabysitterContainerDeps,
  type BabysitterSpawnResult,
  buildBabysitterChromiumCheckArgs,
  checkBabysitterContainerChromium,
} from "../lib/fleet_babysitter_container.ts";
import { main as setupMain } from "../commands/fleet_pr_babysitter_setup.ts";

const HTML = "<!doctype html><html><head></head><body></body></html>";

function plan(
  overrides: Partial<ContainerLaunchPlan> = {},
): ContainerLaunchPlan {
  const image = "vibe-coder:test";
  return {
    runtime: "podman",
    image,
    keepImages: [image],
    containerName: "plan-name",
    watchdogSeconds: 60,
    mounts: [],
    ensureDirectories: [],
    volumes: ["vibe-work"],
    resettableVolumes: [],
    initArgs: [],
    volumeRemoveArgs: [],
    imageRemoveArgs: [],
    claimFloorGb: 1,
    claimFloorPercent: 10,
    claimFloorOrigin: "default",
    imageInspectArgs: ["image", "inspect", image],
    buildArgs: [],
    extensionBuildArgs: [],
    builderStopArgs: [],
    builderAbsentPatterns: [],
    egressEnforced: false,
    networkCreateArgs: [],
    networkRemoveArgs: [],
    networkConnectArgs: [],
    proxyRunArgs: [],
    proxyStopArgs: [],
    proxyName: "",
    proxyBundle: "",
    runArgs: [
      "run",
      "--rm",
      "--name",
      "plan-name",
      "--memory",
      "8g",
      "--network",
      "vibe-babysitter-net",
      "--env",
      "HTTPS_PROXY=http://proxy:3128",
      "--volume",
      "/host/secret:/container/secret:ro",
      "--workdir",
      "/workspace",
      "--env",
      "CONFIG_PATH=/workspace/.config.json",
      image,
    ],
    ...overrides,
  } as ContainerLaunchPlan;
}

const OK: BabysitterSpawnResult = {
  success: true,
  code: 0,
  stdout: HTML,
  stderr: "",
  timedOut: false,
};

function deps(
  options: {
    plan?: ContainerLaunchPlan;
    onPath?: boolean;
    imageExists?: boolean;
    result?: BabysitterSpawnResult | Error;
    events?: string[];
  } = {},
): Partial<BabysitterContainerDeps> {
  const events = options.events ?? [];
  return {
    env: (name) => name === "PATH" ? "/usr/bin" : undefined,
    buildPlan: (_base, name) => {
      events.push("plan");
      return Promise.resolve({
        ...plan(),
        ...(options.plan ?? {}),
        containerName: name,
        runArgs: options.plan?.runArgs ??
          plan().runArgs.map((arg) => arg === "plan-name" ? name : arg),
      });
    },
    onPath: (runtime) => {
      events.push(`runtime ${runtime}`);
      return Promise.resolve(options.onPath ?? true);
    },
    imageExists: (_runtime, args) => {
      events.push(`image ${args.join(" ")}`);
      return Promise.resolve(options.imageExists ?? true);
    },
    spawn: (runtime, args, spawnOptions) => {
      events.push(
        `spawn ${runtime} ${args.join(" ")} timeout=${spawnOptions.timeoutMs}`,
      );
      if (options.result instanceof Error) {
        return Promise.reject(options.result);
      }
      return Promise.resolve(options.result ?? OK);
    },
    log: (message) => events.push(`log ${message}`),
  };
}

Deno.test("Chromium check runs the image command with no host mounts or browser", async () => {
  const events: string[] = [];
  await checkBabysitterContainerChromium(
    { baseDir: "/checkout" },
    deps({ events }),
  );
  const spawn = events.find((event) => event.startsWith("spawn ")) ?? "";
  assert(spawn.startsWith("spawn podman run"));
  assertStringIncludes(spawn, "--entrypoint bash");
  assertStringIncludes(spawn, "vibe-coder:test -c");
  assertStringIncludes(spawn, BABYSITTER_CHROMIUM_CHECK_COMMAND);
  assert(!spawn.includes("/host/secret"));
  assert(!events.some((event) => event.startsWith("spawn chromium ")));
  assert(spawn.includes("--network vibe-babysitter-net"));
  assert(spawn.includes("HTTPS_PROXY=http://proxy:3128"));
});

Deno.test("Chromium check passes only on exit zero with HTML stdout", async () => {
  await checkBabysitterContainerChromium(
    { baseDir: "/checkout" },
    deps({ result: { ...OK, stdout: 'prefix <html lang="en">' } }),
  );
  for (
    const result of [
      { ...OK, success: false, code: 7, stderr: "chromium failed to start" },
      { ...OK, stdout: "" },
      { ...OK, stdout: "plain text" },
    ]
  ) {
    await assertRejects(
      () =>
        checkBabysitterContainerChromium(
          { baseDir: "/checkout" },
          deps({ result }),
        ),
      Error,
      result.code === 7
        ? "chromium failed to start"
        : result.stdout === ""
        ? "stdout was empty"
        : "plain text",
    );
  }
});

Deno.test("Chromium check names missing runtime and image causes before egress", async () => {
  const runtimeEvents: string[] = [];
  await assertRejects(
    () =>
      checkBabysitterContainerChromium(
        { baseDir: "/checkout" },
        deps({ onPath: false, events: runtimeEvents }),
      ),
    Error,
    "the container runtime is not on PATH",
  );
  assertEquals(runtimeEvents, ["plan", "runtime podman"]);

  const imageEvents: string[] = [];
  await assertRejects(
    () =>
      checkBabysitterContainerChromium(
        { baseDir: "/checkout" },
        deps({ imageExists: false, events: imageEvents }),
      ),
    Error,
    "the worker image is not built",
  );
  assertEquals(imageEvents, [
    "plan",
    "runtime podman",
    "image image inspect vibe-coder:test",
  ]);
});

Deno.test("enforced egress starts and stops for success, failure and timeout", async () => {
  for (
    const result of [
      OK,
      { ...OK, success: false, code: 9, stderr: "browser crashed" },
      { ...OK, success: false, code: 124, timedOut: true },
    ]
  ) {
    const events: string[] = [];
    const depsWithEgress = deps({
      events,
      result,
      plan: plan({ egressEnforced: true }),
    });
    depsWithEgress.startSidecar = () => {
      events.push("egress start");
      return Promise.resolve();
    };
    depsWithEgress.stopSidecar = () => {
      events.push("egress stop");
      return Promise.resolve([]);
    };
    depsWithEgress.spawn = (_runtime, args) => {
      if (args[0] === "kill") {
        events.push("container kill");
        return Promise.resolve({ ...OK, stdout: "" });
      }
      events.push("container run");
      return Promise.resolve(result);
    };
    const action = checkBabysitterContainerChromium(
      { baseDir: "/checkout", timeoutMs: 3210 },
      depsWithEgress,
    );
    if (result.timedOut) {
      await assertRejects(() => action, Error, "timed out after 3 seconds");
    } else if (!result.success) {
      await assertRejects(() => action, Error, "browser crashed");
    } else {
      await action;
    }
    assert(events.indexOf("egress start") < events.indexOf("container run"));
    assert(events.indexOf("egress stop") > events.indexOf("container run"));
    if (result.timedOut) assert(events.includes("container kill"));
    assert(!events.includes("host chromium"));
  }
});

Deno.test("failed egress start never falls back to an unrestricted container", async () => {
  const events: string[] = [];
  const configured = deps({
    events,
    plan: plan({ egressEnforced: true }),
  });
  configured.startSidecar = () => {
    events.push("egress start failed");
    return Promise.reject(new Error("proxy key missing"));
  };
  configured.stopSidecar = () => {
    events.push("egress stop");
    return Promise.resolve([]);
  };
  await assertRejects(
    () =>
      checkBabysitterContainerChromium(
        { baseDir: "/checkout" },
        configured,
      ),
    Error,
    "proxy key missing",
  );
  assert(events.includes("egress start failed"));
  assert(events.includes("egress stop"));
  assert(!events.some((event) => event.startsWith("spawn ")));
});

Deno.test("timeout reports container cleanup failures and still tears down egress", async () => {
  for (
    const killResult of [
      { ...OK, success: false, code: 17, stderr: "kill denied" },
      new Error("kill denied by runtime"),
    ]
  ) {
    const events: string[] = [];
    const configured = deps({
      events,
      plan: plan({ egressEnforced: true }),
    });
    configured.startSidecar = () => Promise.resolve();
    configured.stopSidecar = () => {
      events.push("egress stop");
      return Promise.resolve([]);
    };
    configured.spawn = (_runtime, args) => {
      if (args[0] === "kill") {
        return killResult instanceof Error
          ? Promise.reject(killResult)
          : Promise.resolve(killResult);
      }
      return Promise.resolve({
        ...OK,
        success: false,
        code: 124,
        timedOut: true,
      });
    };
    await assertRejects(
      () =>
        checkBabysitterContainerChromium(
          { baseDir: "/checkout" },
          configured,
        ),
      Error,
      killResult instanceof Error
        ? "container cleanup failed: Error: kill denied by runtime"
        : "container cleanup exited with code 17",
    );
    assert(events.includes("egress stop"));
  }
});

Deno.test("Apple proxy egress wraps the Chromium launch and always stops", async () => {
  for (
    const result of [OK, { ...OK, success: false, code: 11, stderr: "crash" }]
  ) {
    const events: string[] = [];
    const applePlan = plan({ proxyName: "babysitter-proxy" });
    const configured = deps({ events, plan: applePlan, result });
    configured.startAppleEgress = (_plan, options) => {
      events.push(`apple egress start ${options.timeoutMs}`);
      return Promise.resolve({
        runArgs: [
          ...applePlan.runArgs.slice(0, -1),
          "--env",
          "HTTPS_PROXY=http://apple-proxy:3128",
          applePlan.image,
        ],
        stop: () => {
          events.push("apple egress stop");
          return Promise.resolve([]);
        },
      });
    };
    configured.spawn = (runtime, args, _options) => {
      events.push(`apple container ${runtime} ${args.join(" ")}`);
      return Promise.resolve(result);
    };
    const action = checkBabysitterContainerChromium(
      { baseDir: "/checkout", timeoutMs: 4321 },
      configured,
    );
    if (result.success) await action;
    else await assertRejects(() => action, Error, "crash");
    const launch = events.find((event) =>
      event.startsWith("apple container ")
    ) ?? "";
    assertStringIncludes(launch, "HTTPS_PROXY=http://apple-proxy:3128");
    assert(events.some((event) => event === "apple egress start 4321"));
    assert(
      events.findIndex((event) => event === "apple egress start 4321") <
        events.indexOf(launch),
    );
    assertEquals(events.at(-1), "apple egress stop");
  }
});

Deno.test("setup runs the Chromium check after preflight and propagates failure", async () => {
  const calls: string[] = [];
  await assertRejects(
    () =>
      setupMain({
        args: ["--check", "--app-id=1"],
        env: (name) => name === "HOME" ? "/private/home" : undefined,
        loadConfig: () => Promise.resolve({ repos: ["owner/repo"] } as never),
        command: (name) => {
          calls.push(name);
          return Promise.resolve("version");
        },
        preflight: () => {
          calls.push("preflight");
          return Promise.resolve();
        },
        chromiumCheck: () => {
          calls.push("chromium check");
          return Promise.reject(
            new Error("headless Chromium produced no HTML"),
          );
        },
        runGh: () => {
          calls.push("gh version");
          return Promise.resolve("gh version");
        },
      }),
    Error,
    "headless Chromium produced no HTML",
  );
  assertEquals(calls, ["git", "rtk", "preflight", "chromium check"]);
});

Deno.test("setup preflight is followed by the real injectable Chromium check", async () => {
  const calls: string[] = [];
  await checkBabysitterContainerChromium(
    { baseDir: "/checkout" },
    deps({ events: calls }),
  );
  assert(
    calls.some((event) => event.includes(BABYSITTER_CHROMIUM_CHECK_COMMAND)),
  );
});

Deno.test("probe args replace the entrypoint and omit mounts", () => {
  const args = buildBabysitterChromiumCheckArgs(plan(), "actual-name");
  assertEquals(args[args.indexOf("--name") + 1], "actual-name");
  assertEquals(args[args.indexOf("--entrypoint") + 1], "bash");
  assertEquals(args.at(-1), BABYSITTER_CHROMIUM_CHECK_COMMAND);
  assert(!args.includes("--volume"));
  assert(!args.some((arg) => arg.includes("/host/secret")));
});

Deno.test("run.sh forwards checks before App configuration or authentication", async () => {
  const root = await Deno.makeTempDir();
  try {
    const bin = `${root}/bin`;
    const home = `${root}/home`;
    await Deno.mkdir(bin);
    await Deno.mkdir(home);
    await Deno.writeTextFile(`${root}/config.json`, "{}\n");
    const findExecutable = async (name: string): Promise<string> => {
      for (
        const dir of (Deno.env.get("PATH") ?? "").split(
          Deno.build.os === "windows" ? ";" : ":",
        )
      ) {
        if (!dir) continue;
        const path = `${dir}/${name}`;
        try {
          const info = await Deno.stat(path);
          if (info.isFile && ((info.mode ?? 0) & 0o111) !== 0) return path;
        } catch {
          // Keep searching the inherited PATH for this test's tool link.
        }
      }
      throw new Error(`test prerequisite ${name} is missing from PATH`);
    };
    for (const name of ["dirname", "git"]) {
      await Deno.symlink(await findExecutable(name), `${bin}/${name}`);
    }
    for (const argument of ["--check-container", "--dry-run"]) {
      const child = new Deno.Command("/bin/bash", {
        args: ["fleet-pr-babysitter/run.sh", argument],
        cwd: await Deno.realPath(new URL("../../..", import.meta.url).pathname),
        env: {
          CONFIG_PATH: `${root}/config.json`,
          DENO_EXECUTABLE: Deno.execPath(),
          HOME: home,
          PATH: bin,
        },
        stdout: "piped",
        stderr: "piped",
      });
      const result = await child.output();
      const output = new TextDecoder().decode(result.stderr) +
        new TextDecoder().decode(result.stdout);
      assert(!result.success);
      assertStringIncludes(output, "container runtime");
      assert(!output.includes("App configuration"));
      assert(!output.includes("GitHub App"));
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
