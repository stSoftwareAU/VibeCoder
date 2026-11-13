import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import type { ContainerLaunchPlan } from "../lib/container_launch.ts";
import {
  BABYSITTER_CHROMIUM_CHECK_COMMAND,
  type BabysitterContainerDeps,
  type BabysitterSpawnResult,
  buildBabysitterChromiumCheckArgs,
  checkBabysitterContainerChromium,
} from "../lib/fleet_babysitter_container.ts";
import {
  main as setupMain,
  runChromiumCheck,
} from "../commands/fleet_pr_babysitter_setup.ts";
import { withTestKey } from "./fixtures/babysitter_container_fakes_4770.ts";
import { writeBabysitterAppConfig } from "../lib/fleet_babysitter_app.ts";
import { runWithTimeout } from "../lib/subprocess_timeout.ts";

async function denoCacheDir(): Promise<string> {
  const info = await runWithTimeout(Deno.execPath(), ["info", "--json"], {
    timeoutMs: 10_000,
  });
  assert(info.ok);
  assertEquals(info.value.success, true, info.value.stderr);
  return JSON.parse(info.value.stdout).denoDir;
}

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
    // The real admission measures the host and writes a ledger file.
    hostDiskAdmission: () => {
      events.push("admit");
      return Promise.resolve({
        release: () => {
          events.push("release");
          return Promise.resolve();
        },
      });
    },
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
  assertStringIncludes(
    spawn,
    '"$CHROMIUM_PATH" --headless --no-sandbox --dump-dom about:blank',
  );
  assert(!spawn.includes("/host/secret"));
  assert(!spawn.includes("CONFIG_PATH"));
  assertStringIncludes(spawn, "timeout=60000");
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

Deno.test("Chromium check keeps the trailing cause after startup noise", async () => {
  const noiseLine =
    '[ERROR:dbus.cc(123)] Failed to connect to the bus: Could not parse server address: Unknown address type (examples of valid types are "tcp" and on UNIX "unix")';
  const cause =
    "FATAL:zygote_host_impl_linux.cc(89)] Running as root without --no-sandbox is not supported";
  const stderr = `${noiseLine}\n`.repeat(5) + cause;
  assert(stderr.length > 500, "fixture must exceed the diagnostic cap");
  await assertRejects(
    () =>
      checkBabysitterContainerChromium(
        { baseDir: "/checkout" },
        deps({
          result: { ...OK, success: false, code: 133, stderr },
        }),
      ),
    Error,
    cause,
  );
});

Deno.test("Chromium check accepts HTML beyond the diagnostic cap", async () => {
  await checkBabysitterContainerChromium(
    { baseDir: "/checkout" },
    deps({ result: { ...OK, stdout: "startup output ".repeat(50) + HTML } }),
  );
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
        : "container cleanup exited with code 17: kill denied",
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
    // Admitted before the proxy starts, released after the proxy stops.
    assert(events.indexOf("admit") < events.indexOf("apple egress start 4321"));
    assertEquals(events.slice(-2), ["apple egress stop", "release"]);
  }
});

Deno.test("egress teardown problems are logged verbatim with no token to split on", async () => {
  // Enforced egress: the sidecar's stop problem survives unchanged.
  {
    const events: string[] = [];
    const configured = deps({
      events,
      plan: plan({ egressEnforced: true }),
    });
    configured.startSidecar = () => Promise.resolve();
    configured.stopSidecar = () =>
      Promise.resolve(["could not remove the egress proxy (exit 1)"]);
    await checkBabysitterContainerChromium(
      { baseDir: "/checkout" },
      configured,
    );
    assert(
      events.includes(
        "log egress teardown: could not remove the egress proxy (exit 1)",
      ),
      `the sidecar stop problem is logged verbatim, got ${
        JSON.stringify(events)
      }`,
    );
  }

  // Apple egress: the helper's stop problem survives unchanged.
  {
    const events: string[] = [];
    const applePlan = plan({ proxyName: "babysitter-proxy" });
    const configured = deps({ events, plan: applePlan });
    configured.startAppleEgress = () =>
      Promise.resolve({
        runArgs: [
          ...applePlan.runArgs.slice(0, -1),
          "--env",
          "HTTPS_PROXY=http://apple-proxy:3128",
          applePlan.image,
        ],
        stop: () => Promise.resolve(["egress helper exited with code 1"]),
      });
    await checkBabysitterContainerChromium(
      { baseDir: "/checkout" },
      configured,
    );
    assert(
      events.includes("log egress teardown: egress helper exited with code 1"),
      `the Apple stop problem is logged verbatim, got ${
        JSON.stringify(events)
      }`,
    );
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
  await runChromiumCheck("/checkout", deps({ events: calls }));
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

Deno.test("probe args reject empty and mismatched image plans", () => {
  for (const runArgs of [[], ["run", "different-image"]]) {
    assertThrows(
      () => buildBabysitterChromiumCheckArgs(plan({ runArgs })),
      Error,
      "the container plan does not end with its image vibe-coder:test",
    );
  }
});

Deno.test("probe args remove short volumes and mount options", () => {
  for (const option of ["-v", "--mount"]) {
    const args = buildBabysitterChromiumCheckArgs(plan({
      runArgs: [
        "run",
        option,
        "/host/private:/container/private",
        "vibe-coder:test",
      ],
    }));
    assertEquals(args, [
      "run",
      "--entrypoint",
      "bash",
      "vibe-coder:test",
      "-c",
      '"$CHROMIUM_PATH" --headless --no-sandbox --dump-dom about:blank',
    ]);
  }
});

Deno.test("successful and failed container diagnostics suppress service health", async () => {
  const root = await Deno.makeTempDir();
  try {
    const bin = `${root}/bin`;
    const home = `${root}/home`;
    const state = `${home}/.vibe-coder/fleet-pr-babysitter`;
    await Deno.mkdir(bin);
    await Deno.mkdir(state, { recursive: true });
    for (const provider of ["gh", "claude"]) {
      await Deno.mkdir(`${home}/.vibe-coder/credentials/${provider}`, {
        recursive: true,
      });
    }
    await Deno.writeTextFile(`${root}/config.json`, "{}\n");
    await Deno.writeTextFile(
      `${state}/health-hook`,
      `#!/bin/sh\nprintf '%s' "$1" > '${root}/health-result'\n`,
      { mode: 0o700 },
    );
    const cacheDir = await denoCacheDir();
    for (const fails of [false, true]) {
      await Deno.writeTextFile(
        `${bin}/docker`,
        `#!/bin/sh
printf '%s\\n' "$*" >> '${root}/runtime-calls'
case "$*" in
  *CHROMIUM_PATH*) printf '<html></html>'; exit ${fails ? 7 : 0};;
  logs*) printf '[EGRESS_PROXY] listening\\n';;
  run*) /bin/cat > /dev/null;;
esac
`,
        { mode: 0o755 },
      );
      const result = await runWithTimeout(Deno.execPath(), [
        "run",
        "--allow-all",
        "--cached-only",
        "worker/deno/commands/fleet_pr_babysitter_supervisor.ts",
        "--check-container",
      ], {
        cwd: new URL("../../..", import.meta.url).pathname,
        clearEnv: true,
        env: {
          DENO_DIR: cacheDir,
          HOME: home,
          PATH: `${bin}:/usr/bin:/bin`,
          CONFIG_PATH: `${root}/config.json`,
          VIBE_CREDENTIAL_DIR: `${home}/.vibe-coder/credentials`,
        },
        timeoutMs: 30_000,
      });
      assert(result.ok);
      assertEquals(result.value.timedOut, false, result.value.stderr);
      assertEquals(result.value.code, fails ? 1 : 0, result.value.stderr);
      assertStringIncludes(
        await Deno.readTextFile(`${root}/runtime-calls`),
        "--entrypoint bash",
      );
      await assertRejects(
        () => Deno.stat(`${root}/health-result`),
        Deno.errors.NotFound,
      );
      assert(!result.value.stdout.includes("GitHub App"));
      assert(!result.value.stderr.includes("App configuration"));
      await assertRejects(
        () =>
          Deno.stat(
            `${home}/.local/state/vibe-coder/fleet-pr-babysitter/deployment-health.json`,
          ),
        Deno.errors.NotFound,
      );
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("watch announces its App identity once across two successful browser probes", async () => {
  await withTestKey(async (privateKeyPath) => {
    const root = await Deno.makeTempDir();
    try {
      await Deno.mkdir(`${root}/bin`);
      await Deno.writeTextFile(`${root}/bin/docker`, "#!/bin/sh\n", {
        mode: 0o755,
      });
      await Deno.chmod(privateKeyPath, 0o600);
      await writeBabysitterAppConfig(root, {
        appId: "123",
        installationId: "456",
        privateKeyPath,
      });
      for (const provider of ["gh", "claude"]) {
        await Deno.mkdir(`${root}/.vibe-coder/credentials/${provider}`, {
          recursive: true,
        });
      }
      // The preload stops at access discovery after the browser and identity checks.
      await Deno.writeTextFile(
        `${root}/config.json`,
        JSON.stringify({ repos: ["owner/repo"] }),
      );
      const result = await runWithTimeout(Deno.execPath(), [
        "run",
        "--allow-all",
        "--cached-only",
        "--preload",
        new URL(
          "./fixtures/fleet_babysitter_container_preload.ts",
          import.meta.url,
        ).pathname,
        new URL("../commands/fleet_pr_babysitter.ts", import.meta.url).pathname,
        "--watch",
        "--dry-run",
      ], {
        cwd: new URL("../../..", import.meta.url).pathname,
        clearEnv: true,
        env: {
          DENO_DIR: await denoCacheDir(),
          HOME: root,
          PATH: `${root}/bin:/usr/bin:/bin`,
          CONFIG_PATH: `${root}/config.json`,
          BABYSITTER_REPAIR_FIXTURE: root,
          BABYSITTER_REAL_CHECKOUT: new URL("../../..", import.meta.url)
            .pathname.replace(/\/$/, ""),
          BABYSITTER_WATCH_PROBES: "1",
          VIBE_CREDENTIAL_DIR: `${root}/.vibe-coder/credentials`,
        },
        timeoutMs: 30_000,
      });
      assert(result.ok);
      assertEquals(result.value.code, 0, result.value.stderr);
      assertEquals(
        result.value.stdout.match(
          /Using GitHub App babysitter\[bot\] for babysitter requests\./g,
        )?.length,
        1,
        result.value.stderr,
      );
      assertEquals(
        (await Deno.readTextFile(`${root}/browser-probes`)).trim().split("\n")
          .length,
        2,
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
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
    const cacheDir = await denoCacheDir();
    for (const argument of ["--check-container", "--dry-run"]) {
      const child = new Deno.Command("/bin/bash", {
        args: ["fleet-pr-babysitter/run.sh", argument],
        cwd: await Deno.realPath(new URL("../../..", import.meta.url).pathname),
        clearEnv: true,
        env: {
          DENO_DIR: cacheDir,
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

Deno.test("Chromium check preserves explicit timeout and redacts spawn failure causes", async () => {
  const token = "ghp_" + "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8";
  const events: string[] = [];
  const error = await assertRejects(
    () =>
      checkBabysitterContainerChromium(
        { baseDir: "/checkout", timeoutMs: 1234 },
        deps({ events, result: new Error(`daemon refused ${token}`) }),
      ),
    Error,
    "cannot run headless Chromium in the worker container: Error: daemon refused",
  );
  assert(!error.message.includes(token));
  assertStringIncludes(
    events.find((event) => event.startsWith("spawn ")) ?? "",
    "timeout=1234",
  );
});

Deno.test("probe args strip inline mounts and private environments and retain proxy values", () => {
  const args = buildBabysitterChromiumCheckArgs(plan({
    runArgs: [
      "run",
      "--volume=/host/secret:/secret",
      "--mount=type=bind,src=/private,dst=/private",
      "--env=CONFIG_PATH=/private/config.json",
      "--env=HTTPS_PROXY=http://proxy:3128",
      "-e",
      "PRIVATE_VALUE=secret",
      "-e",
      "http_proxy=http://proxy:3128",
      "-w",
      "/workspace",
      "vibe-coder:test",
    ],
  }));
  assertEquals(args, [
    "run",
    "--env=HTTPS_PROXY=http://proxy:3128",
    "-e",
    "http_proxy=http://proxy:3128",
    "--entrypoint",
    "bash",
    "vibe-coder:test",
    "-c",
    '"$CHROMIUM_PATH" --headless --no-sandbox --dump-dom about:blank',
  ]);
});
