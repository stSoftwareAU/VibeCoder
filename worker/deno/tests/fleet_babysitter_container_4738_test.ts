/**
 * Tests for the babysitter repair container (Issue #4767): the run arguments,
 * the private key guard, the flag and token rules, the preflight, the timeout
 * kill, the egress refusal and the real default deps. Fake deps stand in for
 * the runtime; the default spawn and image check run the real `deno` binary
 * with an empty environment. No test sets a process environment variable:
 * env readers are injected.
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import type { ContainerLaunchPlan } from "../lib/container_launch.ts";
import {
  assertBabysitterKeyOutOfRunArgs,
  type BabysitterContainerDeps,
  type BabysitterContainerInput,
  type BabysitterEnvReader,
  babysitterImageExists,
  babysitterRuntimeOnPath,
  babysitterSpawn,
  type BabysitterSpawnResult,
  buildBabysitterRunArgs,
  runBabysitterRepairContainer,
} from "../lib/fleet_babysitter_container.ts";

const TOKEN = "ghs_FAKE-TOKEN-4738";
const KEY_BODY =
  "-----BEGIN PRIVATE KEY-----\nFAKE-KEY-BODY-4738\n-----END PRIVATE KEY-----";
const SENTINEL = "VIBE_TEST_SENTINEL_4738";
const SECRET = "ghs_Abcdefghij0123456789Abcdefghij012345";
const OK: BabysitterSpawnResult = {
  success: true,
  code: 0,
  stderr: "",
  timedOut: false,
};
const ALLOWED_ENV = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "DOCKER_HOST",
  "XDG_RUNTIME_DIR",
  "CONTAINER_HOST",
  "GH_TOKEN",
];
/** The injected host environment: a sentinel that is not allowlisted sits beside PATH. */
const FAKE_HOST_ENV: Record<string, string> = {
  PATH: "/usr/bin",
  HOME: "/home/fake",
  [SENTINEL]: "leaked",
};
const fakeEnv: BabysitterEnvReader = (name) => FAKE_HOST_ENV[name];

interface Fixture {
  root: string;
  home: string;
  keyDir: string;
  keyPath: string;
  clone: string;
  scratch: string;
}

/** A temp tree: a home holding the key directory, plus clone and scratch. */
async function makeFixture(): Promise<Fixture> {
  const root = await Deno.makeTempDir();
  const home = `${root}/home`;
  const keyDir = `${home}/.vibe-coder/fleet-pr-babysitter`;
  const keyPath = `${keyDir}/babysitter-app.pem`;
  await Deno.mkdir(keyDir, { recursive: true });
  await Deno.writeTextFile(keyPath, KEY_BODY);
  const clone = `${root}/clone`;
  const scratch = `${root}/scratch`;
  await Deno.mkdir(clone);
  await Deno.mkdir(scratch);
  return { root, home, keyDir, keyPath, clone, scratch };
}

function inputFor(f: Fixture): BabysitterContainerInput {
  return {
    baseDir: "/checkout",
    clone: f.clone,
    scratch: f.scratch,
    privateKeyPath: f.keyPath,
    token: TOKEN,
  };
}

/** A launch plan shaped like the worker's, with `extra` before the image. */
function fakePlan(
  root: string,
  name: string,
  extra: string[] = [],
  overrides: Partial<ContainerLaunchPlan> = {},
): ContainerLaunchPlan {
  const image = "vibe-coder:test";
  const plan: ContainerLaunchPlan = {
    runtime: "fake-runtime",
    image,
    keepImages: [image],
    containerName: name,
    watchdogSeconds: 60,
    mounts: [],
    ensureDirectories: [],
    volumes: ["vibe-work"],
    resettableVolumes: ["vibe-work", "vibe-agent-state"],
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
      name,
      "--memory",
      "8g",
      "--volume",
      "vibe-work:/home/vibe/auto-issue-work",
      "--volume",
      "vibe-agent-state:/home/vibe/agent",
      "--volume",
      `${root}/logs:/home/vibe/logs`,
      "--volume",
      `${root}/repo:/workspace:ro`,
      "--workdir",
      "/workspace",
      "--env",
      "VIBE_BASE_DIR=/workspace",
      ...extra,
      image,
    ],
  };
  return { ...plan, ...overrides };
}

interface Spawned {
  runtime: string;
  args: string[];
  env: Record<string, string>;
  timeoutMs: number;
}

interface FakeOptions {
  extra?: string[];
  overrides?: Partial<ContainerLaunchPlan>;
  onPath?: boolean;
  imageExists?: boolean;
  /** Queued spawn outcomes; an Error is thrown instead of returned. */
  spawnResults?: Array<BabysitterSpawnResult | Error>;
  env?: BabysitterEnvReader;
}

interface Calls {
  built: string[];
  spawns: Spawned[];
  onPath: number;
  imageExists: number;
}

/** Fake deps that record every call. Each spawn records its runtime, args, env and timeout. */
function fakeDeps(f: Fixture, options: FakeOptions = {}): {
  deps: Partial<BabysitterContainerDeps>;
  calls: Calls;
} {
  const calls: Calls = { built: [], spawns: [], onPath: 0, imageExists: 0 };
  const queue = [...(options.spawnResults ?? [])];
  const deps: Partial<BabysitterContainerDeps> = {
    env: options.env ?? fakeEnv,
    onPath: () => {
      calls.onPath++;
      return Promise.resolve(options.onPath ?? true);
    },
    buildPlan: (_baseDir, containerName) => {
      calls.built.push(containerName);
      return Promise.resolve(
        fakePlan(f.root, containerName, options.extra, options.overrides),
      );
    },
    imageExists: () => {
      calls.imageExists++;
      return Promise.resolve(options.imageExists ?? true);
    },
    spawn: (runtime, args, opts) => {
      calls.spawns.push({
        runtime,
        args: [...args],
        env: { ...opts.env },
        timeoutMs: opts.timeoutMs,
      });
      const next = queue.shift() ?? OK;
      return next instanceof Error
        ? Promise.reject(next)
        : Promise.resolve(next);
    },
  };
  return { deps, calls };
}

/** The value after each `--volume` in `args`. */
function volumeValues(args: string[]): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--volume") values.push(args[i + 1] ?? "");
  }
  return values;
}

/** The n-th spawn, asserting it exists. */
function spawnAt(calls: Calls, index: number): Spawned {
  const spawn = calls.spawns[index];
  if (spawn === undefined) throw new Error(`no spawn number ${index}`);
  return spawn;
}

/** The n-th container name given to the plan builder, asserting it exists. */
function builtAt(calls: Calls, index: number): string {
  const name = calls.built[index];
  if (name === undefined) throw new Error(`no plan build number ${index}`);
  return name;
}

/** Runs with `extra` in the plan, expects a refusal, and returns the message. Asserts nothing spawned. */
async function refusalFor(f: Fixture, extra: string[]): Promise<string> {
  const { deps, calls } = fakeDeps(f, { extra });
  const error = await assertRejects(
    () => runBabysitterRepairContainer(inputFor(f), deps),
    Error,
  );
  assertEquals(calls.spawns.length, 0, "a refused run must spawn nothing");
  return error.message;
}

/** Runs with `extra` in the plan, expecting acceptance. Returns the spawn count. */
async function acceptedSpawns(f: Fixture, extra: string[]): Promise<number> {
  const { deps, calls } = fakeDeps(f, { extra });
  await runBabysitterRepairContainer(inputFor(f), deps);
  return calls.spawns.length;
}

Deno.test("repair spawns the plan's run args, the mounts, GH_TOKEN and the fixed command", async () => {
  const f = await makeFixture();
  try {
    const { deps, calls } = fakeDeps(f);
    await runBabysitterRepairContainer(inputFor(f), deps);

    assertEquals(calls.spawns.length, 1, "exactly one repair spawn");
    const spawn = spawnAt(calls, 0);
    assertEquals(spawn.runtime, "fake-runtime");
    assert(spawn.runtime !== "codex", "the repair never runs codex");
    const name = builtAt(calls, 0);
    assert(
      /^vibe-babysitter-[a-z0-9-]+$/.test(name),
      `unexpected name ${name}`,
    );
    assertEquals(spawn.args[spawn.args.indexOf("--name") + 1], name);
    assertEquals(spawn.args, [
      "run",
      "--rm",
      "--name",
      name,
      "--memory",
      "8g",
      "--volume",
      `${f.root}/logs:/home/vibe/logs`,
      "--volume",
      `${f.root}/repo:/workspace:ro`,
      "--workdir",
      "/workspace",
      "--env",
      "VIBE_BASE_DIR=/workspace",
      "--volume",
      `${f.clone}:/babysitter/clone`,
      "--volume",
      `${f.scratch}:/babysitter/scratch`,
      "--env",
      "GH_TOKEN",
      "vibe-coder:test",
      "babysitter-repair",
      "--dir",
      "/babysitter/clone",
      "--prompt-file",
      "/babysitter/scratch/prompt.md",
      "--response-file",
      "/babysitter/clone/.babysitter-response",
    ]);

    // Two calls give two container names.
    await runBabysitterRepairContainer(inputFor(f), deps);
    assertEquals(calls.built.length, 2);
    assert(
      builtAt(calls, 0) !== builtAt(calls, 1),
      "each run gets its own name",
    );
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("repair drops the named volumes and adds exactly the clone and scratch mounts", async () => {
  const f = await makeFixture();
  try {
    const { deps, calls } = fakeDeps(f);
    await runBabysitterRepairContainer(inputFor(f), deps);
    const args = spawnAt(calls, 0).args;

    assert(
      !args.some((arg) => arg.includes("vibe-work")),
      "vibe-work stays out",
    );
    assert(
      !args.some((arg) => arg.includes("vibe-agent-state")),
      "vibe-agent-state stays out",
    );
    assertEquals(volumeValues(args), [
      `${f.root}/logs:/home/vibe/logs`,
      `${f.root}/repo:/workspace:ro`,
      `${f.clone}:/babysitter/clone`,
      `${f.scratch}:/babysitter/scratch`,
    ]);
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("repair keeps the key out of every mount, argument and env value", async () => {
  const f = await makeFixture();
  try {
    const { deps, calls } = fakeDeps(f);
    await runBabysitterRepairContainer(inputFor(f), deps);
    const spawn = spawnAt(calls, 0);

    for (
      const source of volumeValues(spawn.args).map((value) =>
        value.split(":")[0] ?? ""
      )
    ) {
      const atOrAbove = source === "/" || source === f.keyDir ||
        f.keyDir.startsWith(`${source}/`);
      assert(!atOrAbove, `mount ${source} is at or above the key directory`);
    }
    assert(
      !spawn.args.some((arg) => arg.includes(f.keyPath)),
      "key path in an argument",
    );
    assert(
      !spawn.args.some((arg) => arg.includes(f.keyDir)),
      "key directory in an argument",
    );
    assert(
      !spawn.args.some((arg) => arg.includes("FAKE-KEY-BODY-4738")),
      "key body in an argument",
    );
    assert(
      !Object.values(spawn.env).some((v) => v.includes("FAKE-KEY-BODY-4738")),
      "key body in env",
    );
    assert(
      !spawn.args.some((arg) => arg.includes(TOKEN)),
      "token in an argument",
    );

    const tokenArgs = spawn.args.filter((arg) => arg.startsWith("GH_TOKEN"));
    assertEquals(tokenArgs, ["GH_TOKEN"], "GH_TOKEN appears exactly once");
    assertEquals(spawn.args[spawn.args.indexOf("GH_TOKEN") - 1], "--env");

    assertEquals(spawn.env.GH_TOKEN, TOKEN);
    assertEquals(
      spawn.env.PATH,
      "/usr/bin",
      "the injected env reader feeds the allowlist",
    );
    assertEquals(
      spawn.env[SENTINEL],
      undefined,
      "a non-allowlisted host variable is not passed",
    );
    for (const key of Object.keys(spawn.env)) {
      assert(ALLOWED_ENV.includes(key), `unexpected env ${key}`);
    }
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("key guard refuses a mount of the key directory itself, and accepts a legal mount", async () => {
  const f = await makeFixture();
  try {
    const message = await refusalFor(f, ["--volume", `${f.keyDir}:/mnt/key`]);
    assertStringIncludes(message, "refusing to mount");
    assertStringIncludes(message, "App private key");
    assertEquals(
      await acceptedSpawns(f, ["--volume", `${f.root}/elsewhere:/mnt/ok`]),
      1,
    );
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("key guard refuses a mount of an ancestor of the key, and accepts a legal mount", async () => {
  const f = await makeFixture();
  try {
    const message = await refusalFor(f, ["--volume", `${f.home}:/mnt/home`]);
    assertStringIncludes(message, "refusing to mount");
    assertStringIncludes(message, "App private key");
    assertEquals(
      await acceptedSpawns(f, ["--volume", `${f.root}/elsewhere:/mnt/ok`]),
      1,
    );
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("key guard refuses a mount of the filesystem root, and accepts a legal mount", async () => {
  const f = await makeFixture();
  try {
    const message = await refusalFor(f, ["--volume", "/:/mnt/root"]);
    assertStringIncludes(message, "refusing to mount /");
    assertStringIncludes(message, "App private key");
    assertEquals(
      await acceptedSpawns(f, ["--volume", `${f.root}/elsewhere:/mnt/ok`]),
      1,
    );
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("key guard refuses a source that reaches the key through '..', and accepts a legal mount", async () => {
  const f = await makeFixture();
  try {
    await Deno.mkdir(`${f.home}/.vibe-coder/other`);
    const message = await refusalFor(f, [
      "--volume",
      `${f.home}/.vibe-coder/other/../fleet-pr-babysitter:/mnt/dotdot`,
    ]);
    assertStringIncludes(message, "refusing to mount");
    assertStringIncludes(message, "App private key");
    assertEquals(
      await acceptedSpawns(f, ["--volume", `${f.root}/elsewhere:/mnt/ok`]),
      1,
    );
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test({
  name:
    "key guard refuses a symlink to the key directory, and accepts a legal mount",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const f = await makeFixture();
    try {
      const link = `${f.root}/key-link`;
      await Deno.symlink(f.keyDir, link);
      const message = await refusalFor(f, ["--volume", `${link}:/mnt/link`]);
      assertStringIncludes(message, "refusing to mount");
      assertStringIncludes(message, "App private key");
      assertEquals(
        await acceptedSpawns(f, ["--volume", `${f.root}/elsewhere:/mnt/ok`]),
        1,
      );
    } finally {
      await Deno.remove(f.root, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "key guard refuses a symlink reached through a missing '..' segment, and accepts a harmless one",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const f = await makeFixture();
    try {
      await Deno.symlink(f.keyDir, `${f.root}/link`);
      await Deno.symlink(f.home, `${f.root}/ancestor-link`);
      await Deno.mkdir(`${f.root}/elsewhere`);
      await Deno.symlink(`${f.root}/elsewhere`, `${f.root}/harmless`);

      const viaKeyDir = await refusalFor(f, [
        "--volume",
        `${f.root}/missing/../link:/mnt/a`,
      ]);
      assertStringIncludes(viaKeyDir, "refusing to mount");
      assertStringIncludes(viaKeyDir, "App private key");

      const viaAncestor = await refusalFor(f, [
        "--volume",
        `${f.root}/missing/../ancestor-link:/mnt/b`,
      ]);
      assertStringIncludes(viaAncestor, "refusing to mount");
      assertStringIncludes(viaAncestor, "App private key");

      assertEquals(
        await acceptedSpawns(f, [
          "--volume",
          `${f.root}/missing/../harmless:/mnt/ok`,
        ]),
        1,
      );
    } finally {
      await Deno.remove(f.root, { recursive: true });
    }
  },
});

Deno.test("key guard refuses the key path embedded in another argument, and accepts a legal argument", async () => {
  const f = await makeFixture();
  try {
    const message = await refusalFor(f, ["--env", `KEYFILE=${f.keyPath}`]);
    assertStringIncludes(message, "App private key path");
    assertEquals(
      await acceptedSpawns(f, ["--env", `KEYFILE=${f.root}/elsewhere`]),
      1,
    );
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("key guard does not refuse a sibling directory that shares the key directory's prefix", async () => {
  const f = await makeFixture();
  try {
    const sibling = `${f.home}/.vibe-coder/fleet-pr-babysitter-other`;
    await Deno.mkdir(sibling);
    assertEquals(
      await acceptedSpawns(f, ["--volume", `${sibling}:/mnt/sibling`]),
      1,
    );
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("key guard refuses a relative source, and accepts the same plan with an absolute source", async () => {
  const f = await makeFixture();
  try {
    const message = await refusalFor(f, ["--volume", "relative:/mnt/x"]);
    assertStringIncludes(message, "not an absolute path");
    assertEquals(
      await acceptedSpawns(f, ["--volume", `${f.root}/elsewhere:/mnt/x`]),
      1,
    );
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("key guard function refuses a relative source directly", async () => {
  const f = await makeFixture();
  try {
    const error = await assertRejects(
      () =>
        assertBabysitterKeyOutOfRunArgs(
          ["--volume", "relative:/mnt/x"],
          f.keyPath,
        ),
      Error,
    );
    assertStringIncludes(error.message, "not an absolute path");
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("repair refuses other mount and env-file spellings, and accepts the normal plan", async () => {
  const f = await makeFixture();
  try {
    const variants: Array<[string[], string]> = [
      [["-v", `${f.root}/x:/mnt/v`], "-v"],
      [[`-v${f.home}:/mnt/home`], `-v${f.home}:/mnt/home`],
      [[`-v=${f.home}:/mnt/home`], `-v=${f.home}:/mnt/home`],
      [["--mount", `type=bind,source=${f.home},target=/mnt/home`], "--mount"],
      [
        [`--mount=type=bind,source=${f.home},target=/mnt/home`],
        `--mount=type=bind,source=${f.home},target=/mnt/home`,
      ],
      [["--env-file", f.keyPath], "--env-file"],
      [[`--env-file=${f.keyPath}`], `--env-file=${f.keyPath}`],
      [[`--volume=${f.home}:/mnt/home`], `--volume=${f.home}:/mnt/home`],
    ];
    for (const [extra, refused] of variants) {
      const message = await refusalFor(f, extra);
      assertStringIncludes(
        message,
        `refusing plan argument ${refused}`,
        `variant ${refused}`,
      );
    }
    assertEquals(
      await acceptedSpawns(f, [
        "--volume",
        `${f.root}/elsewhere:/mnt/ok`,
        "--env",
        "OTHER=x",
      ]),
      1,
      "the spaced --volume and --env spellings are accepted",
    );
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("repair refuses every spelling of a GH_TOKEN env spec, and accepts an other variable", async () => {
  const f = await makeFixture();
  try {
    const variants: string[][] = [
      ["--env", "GH_TOKEN"],
      ["--env", "GH_TOKEN=x"],
      ["-e", "GH_TOKEN"],
      ["-e", "GH_TOKEN=x"],
      ["--env=GH_TOKEN"],
      ["--env=GH_TOKEN=x"],
      ["-eGH_TOKEN"],
      ["-e=GH_TOKEN"],
    ];
    for (const extra of variants) {
      const message = await refusalFor(f, extra);
      assertStringIncludes(
        message,
        "carries GH_TOKEN",
        `variant ${extra.join(" ")}`,
      );
    }
    assertEquals(
      await acceptedSpawns(f, ["--env", "OTHER=x"]),
      1,
      "control: other env accepted",
    );
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("buildBabysitterRunArgs refuses a plan whose run args do not end with its image", async () => {
  const f = await makeFixture();
  try {
    const plan = fakePlan(f.root, "vibe-babysitter-x");
    const mismatched = {
      ...plan,
      runArgs: [...plan.runArgs.slice(0, -1), "other:image"],
    };
    assertThrowsMessage(
      () =>
        buildBabysitterRunArgs(mismatched, {
          clone: f.clone,
          scratch: f.scratch,
        }),
      "does not end with its image vibe-coder:test",
    );
    const args = buildBabysitterRunArgs(plan, {
      clone: f.clone,
      scratch: f.scratch,
    });
    assertEquals(args[0], "run", "control: the plan's own run leads the args");
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

/** Asserts `fn` throws synchronously with a message containing `fragment`. */
function assertThrowsMessage(fn: () => unknown, fragment: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  assert(caught instanceof Error, `expected an Error containing ${fragment}`);
  assertStringIncludes(caught.message, fragment);
}

Deno.test("repair refuses a blank GH_TOKEN before any plan is built or spawn", async () => {
  const f = await makeFixture();
  try {
    const { deps, calls } = fakeDeps(f);
    await assertRejects(
      () =>
        runBabysitterRepairContainer({ ...inputFor(f), token: "   " }, deps),
      Error,
      "the babysitter repair needs the agent's GH_TOKEN; it is empty",
    );
    assertEquals(calls.built.length, 0, "no plan built");
    assertEquals(calls.spawns.length, 0, "nothing spawned");
    const accepted = fakeDeps(f);
    await runBabysitterRepairContainer(inputFor(f), accepted.deps);
    assertEquals(
      accepted.calls.spawns.length,
      1,
      "control: a real token is accepted",
    );
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("repair refuses a relative or NUL clone, scratch or key path, and accepts the absolute ones", async () => {
  const f = await makeFixture();
  try {
    const labelled: Array<[string, "clone" | "scratch" | "privateKeyPath"]> = [
      ["clone", "clone"],
      ["scratch", "scratch"],
      ["private key", "privateKeyPath"],
    ];
    for (const [label, field] of labelled) {
      for (const bad of ["relative/path", "/abs\0bad"]) {
        const { deps, calls } = fakeDeps(f);
        await assertRejects(
          () =>
            runBabysitterRepairContainer(
              { ...inputFor(f), [field]: bad },
              deps,
            ),
          Error,
          `the babysitter ${label} path must be an absolute path with no NUL byte`,
        );
        assertEquals(
          calls.spawns.length,
          0,
          `${label} ${JSON.stringify(bad)} spawns nothing`,
        );
      }
    }
    const accepted = fakeDeps(f);
    await runBabysitterRepairContainer(inputFor(f), accepted.deps);
    assertEquals(
      accepted.calls.spawns.length,
      1,
      "control: absolute paths accepted",
    );
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("repair refuses when the runtime is not on PATH, and never asks for the image", async () => {
  const f = await makeFixture();
  try {
    const { deps, calls } = fakeDeps(f, { onPath: false });
    await assertRejects(
      () => runBabysitterRepairContainer(inputFor(f), deps),
      Error,
      "cannot run fake-runtime: the container runtime is not on PATH",
    );
    assertEquals(calls.spawns.length, 0);
    assertEquals(calls.imageExists, 0);

    const control = fakeDeps(f, { onPath: true });
    await runBabysitterRepairContainer(inputFor(f), control.deps);
    assertEquals(control.calls.spawns.length, 1);
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("repair refuses when the worker image is not built, and spawns nothing", async () => {
  const f = await makeFixture();
  try {
    const { deps, calls } = fakeDeps(f, { imageExists: false });
    await assertRejects(
      () => runBabysitterRepairContainer(inputFor(f), deps),
      Error,
      "the worker image is not built; start the Vibe Coder (./run.sh) once to build it",
    );
    assertEquals(calls.spawns.length, 0);

    const control = fakeDeps(f, { imageExists: true });
    await runBabysitterRepairContainer(inputFor(f), control.deps);
    assertEquals(control.calls.spawns.length, 1);
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("repair kills the container by name on timeout, and reports a failed kill", async () => {
  const f = await makeFixture();
  try {
    const timedOut: BabysitterSpawnResult = {
      success: false,
      code: 124,
      stderr: "",
      timedOut: true,
    };
    const { deps, calls } = fakeDeps(f, { spawnResults: [timedOut, OK] });
    await assertRejects(
      () => runBabysitterRepairContainer(inputFor(f), deps),
      Error,
      "timed out after 90 minutes",
    );
    assertEquals(calls.spawns.length, 2);
    assertEquals(
      spawnAt(calls, 0).timeoutMs,
      90 * 60_000,
      "default repair timeout",
    );
    const name = builtAt(calls, 0);
    assertEquals(spawnAt(calls, 1).runtime, "fake-runtime");
    assertEquals(spawnAt(calls, 1).args, ["kill", name]);
    assertEquals(spawnAt(calls, 1).timeoutMs, 30_000);
    assert(!("GH_TOKEN" in spawnAt(calls, 1).env), "the kill carries no token");

    const failedKill = fakeDeps(f, {
      spawnResults: [timedOut, {
        success: false,
        code: 1,
        stderr: "no such container",
        timedOut: false,
      }],
    });
    const error = await assertRejects(
      () => runBabysitterRepairContainer(inputFor(f), failedKill.deps),
      Error,
    );
    assertStringIncludes(
      error.message,
      "kill failed: exit code 1: no such container",
    );
    assertStringIncludes(error.message, "not killed");
    assert(
      !error.message.endsWith("killed"),
      "a failed kill is not reported as killed",
    );

    const throwingKill = fakeDeps(f, {
      spawnResults: [timedOut, new Error("spawn broke")],
    });
    const thrown = await assertRejects(
      () => runBabysitterRepairContainer(inputFor(f), throwingKill.deps),
      Error,
    );
    assertStringIncludes(thrown.message, "kill failed: spawn broke");
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("repair passes a custom timeout through to the spawn", async () => {
  const f = await makeFixture();
  try {
    const { deps, calls } = fakeDeps(f);
    await runBabysitterRepairContainer(
      { ...inputFor(f), timeoutMs: 5_000 },
      deps,
    );
    assertEquals(spawnAt(calls, 0).timeoutMs, 5_000);
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("repair propagates a spawn that throws, and attempts no kill", async () => {
  const f = await makeFixture();
  try {
    const { deps, calls } = fakeDeps(f, {
      spawnResults: [new Error("spawn broke")],
    });
    await assertRejects(
      () => runBabysitterRepairContainer(inputFor(f), deps),
      Error,
      "spawn broke",
    );
    assertEquals(
      calls.spawns.length,
      1,
      "no kill after a repair spawn that threw",
    );
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("repair reports a non-timeout exit with its code and a redacted stderr cause", async () => {
  const f = await makeFixture();
  try {
    const { deps } = fakeDeps(f, {
      spawnResults: [{
        success: false,
        code: 2,
        stderr: `boom ${TOKEN} and ${SECRET}\n`,
        timedOut: false,
      }],
    });
    const error = await assertRejects(
      () => runBabysitterRepairContainer(inputFor(f), deps),
      Error,
    );
    assertStringIncludes(error.message, "exited with code 2: boom *** and");
    assert(!error.message.includes(TOKEN), "the token is redacted");
    assert(
      !error.message.includes(SECRET),
      "a classic GitHub token is redacted",
    );
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("repair refuses a plan that needs the egress proxy, and accepts neither flag set", async () => {
  const f = await makeFixture();
  try {
    for (const overrides of [{ egressEnforced: true }, { proxyName: "p" }]) {
      const { deps, calls } = fakeDeps(f, { overrides });
      await assertRejects(
        () => runBabysitterRepairContainer(inputFor(f), deps),
        Error,
        "the plan needs the egress proxy",
      );
      assertEquals(calls.spawns.length, 0);
    }
    assertEquals(await acceptedSpawns(f, []), 1);
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("babysitterRuntimeOnPath finds an executable on PATH, and not with an empty PATH", async () => {
  const bin = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${bin}/fake-runtime`, "#!/bin/sh\n");
    await Deno.chmod(`${bin}/fake-runtime`, 0o755);
    await Deno.writeTextFile(`${bin}/not-executable`, "");
    await Deno.chmod(`${bin}/not-executable`, 0o644);
    const withPath = (value: string): BabysitterEnvReader => (name) =>
      name === "PATH" ? value : undefined;

    assertEquals(
      await babysitterRuntimeOnPath("fake-runtime", withPath(bin)),
      true,
    );
    assertEquals(
      await babysitterRuntimeOnPath("not-executable", withPath(bin)),
      false,
    );
    assertEquals(
      await babysitterRuntimeOnPath("absent-runtime", withPath(bin)),
      false,
    );
    assertEquals(
      await babysitterRuntimeOnPath("fake-runtime", withPath("")),
      false,
    );
  } finally {
    await Deno.remove(bin, { recursive: true });
  }
});

Deno.test("babysitterRuntimeOnPath skips a PATH entry that cannot be stat'd and finds the next", async () => {
  const bin = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${bin}/fake-runtime`, "#!/bin/sh\n");
    await Deno.chmod(`${bin}/fake-runtime`, 0o755);
    const plainFile = `${bin}/plain-file`;
    await Deno.writeTextFile(plainFile, "");
    // `plain-file/fake-runtime` is ENOTDIR, not NotFound: it must not abort the search.
    const env: BabysitterEnvReader = (name) =>
      name === "PATH" ? `${plainFile}:${bin}` : undefined;
    assertEquals(await babysitterRuntimeOnPath("fake-runtime", env), true);
  } finally {
    await Deno.remove(bin, { recursive: true });
  }
});

Deno.test("babysitterSpawn runs the runtime from an empty environment", async () => {
  const dir = await Deno.makeTempDir();
  try {
    // Exits 0 only when PATH is absent from the child, i.e. the env was cleared.
    const result = await babysitterSpawn(Deno.execPath(), [
      "eval",
      "--allow-env",
      "Deno.exit(Deno.env.get('PATH') === undefined ? 0 : 3)",
    ], { env: { DENO_DIR: dir }, timeoutMs: 60_000 });
    assertEquals(
      result.success,
      true,
      `child saw PATH: exit ${result.code} ${result.stderr}`,
    );
    assertEquals(result.code, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("babysitterSpawn throws when the runtime cannot be started", async () => {
  await assertRejects(
    () =>
      babysitterSpawn("/nonexistent/runtime-4767", [], {
        env: {},
        timeoutMs: 10_000,
      }),
    Error,
    "cannot start /nonexistent/runtime-4767",
  );
});

Deno.test("babysitterImageExists is true on exit 0, false on a completed non-zero exit", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const env = { DENO_DIR: dir };
    assertEquals(
      await babysitterImageExists(
        Deno.execPath(),
        ["eval", "Deno.exit(0)"],
        env,
      ),
      true,
    );
    assertEquals(
      await babysitterImageExists(
        Deno.execPath(),
        ["eval", "Deno.exit(1)"],
        env,
      ),
      false,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("babysitterImageExists throws when the inspect cannot be started, rather than reporting no image", async () => {
  await assertRejects(
    () =>
      babysitterImageExists("/nonexistent/runtime-4767", [
        "image",
        "inspect",
        "x",
      ], {}),
    Error,
    "cannot inspect the worker image with /nonexistent/runtime-4767",
  );
});
