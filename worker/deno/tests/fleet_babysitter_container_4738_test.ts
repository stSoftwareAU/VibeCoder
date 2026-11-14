/**
 * Tests for the babysitter repair container (Issue #4767): the run arguments,
 * the private key guard, the flag and token rules, the preflight, the timeout
 * kill and the real default deps. Fake deps stand in for the runtime; the
 * default spawn and image check run the real `deno` binary with an empty
 * environment. Egress (the Apple helper and the sidecar) lives in
 * fleet_babysitter_container_egress_4738_test.ts. No test sets a process
 * environment variable: env readers are injected.
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import type { ContainerLaunchPlan } from "../lib/container_launch.ts";
import { buildLaunchPlanForCommand } from "../commands/container_launch_plan.ts";
import { REPO_ROOT } from "./fixtures/launcher_harness.ts";
import {
  assertBabysitterKeyOutOfRunArgs,
  BABYSITTER_CLONE_MOUNT,
  BABYSITTER_QUOTA_PARK_EXIT_CODE,
  BABYSITTER_REPAIR_COMMAND,
  BABYSITTER_SCRATCH_MOUNT,
  babysitterCheckoutDir,
  type BabysitterContainerDeps,
  type BabysitterContainerInput,
  type BabysitterEnvReader,
  babysitterImageExists,
  BabysitterQuotaPark,
  babysitterRuntimeOnPath,
  babysitterSpawn,
  type BabysitterSpawnResult,
  buildBabysitterRunArgs,
  preflightBabysitterContainer,
  runBabysitterRepairContainer,
} from "../lib/fleet_babysitter_container.ts";

const TOKEN = "ghs_FAKE-TOKEN-4738";
const KEY_BODY =
  "-----BEGIN PRIVATE KEY-----\nFAKE-KEY-BODY-4738\n-----END PRIVATE KEY-----";
const SENTINEL = "VIBE_TEST_SENTINEL_4738";
const SECRET = "ghs_" + "Abcdefghij0123456789Abcdefghij012345";
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
    volumes: ["vibe-work", "vibe-approval-state"],
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
      "vibe-approval-state:/home/vibe/approval-state",
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
  onPath: string[];
  imageExists: Array<{ runtime: string; args: string[] }>;
}

/** Fake deps that record every call. Each spawn records its runtime, args, env and timeout. */
function fakeDeps(f: Fixture, options: FakeOptions = {}): {
  deps: Partial<BabysitterContainerDeps>;
  calls: Calls;
} {
  const calls: Calls = { built: [], spawns: [], onPath: [], imageExists: [] };
  const queue = [...(options.spawnResults ?? [])];
  const deps: Partial<BabysitterContainerDeps> = {
    env: options.env ?? fakeEnv,
    hostDiskAdmission: () =>
      Promise.resolve({ release: () => Promise.resolve() }),
    onPath: (runtime) => {
      calls.onPath.push(runtime);
      return Promise.resolve(options.onPath ?? true);
    },
    buildPlan: (_baseDir, containerName) => {
      calls.built.push(containerName);
      return Promise.resolve(
        fakePlan(f.root, containerName, options.extra, options.overrides),
      );
    },
    imageExists: (runtime, args) => {
      calls.imageExists.push({ runtime, args: [...args] });
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
      `${f.clone}/.git:/babysitter/clone/.git:ro`,
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

Deno.test("repair drops the named volumes and adds exactly the clone, its read-only .git and scratch mounts", async () => {
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
    assert(
      !args.some((arg) => arg.includes("vibe-approval-state")),
      "vibe-approval-state stays out",
    );
    assertEquals(volumeValues(args), [
      `${f.root}/logs:/home/vibe/logs`,
      `${f.root}/repo:/workspace:ro`,
      `${f.clone}:/babysitter/clone`,
      `${f.clone}/.git:/babysitter/clone/.git:ro`,
      `${f.scratch}:/babysitter/scratch`,
    ]);
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("repair drops the gh credential store mount and keeps the provider credential mounts (Issue #4770)", async () => {
  const f = await makeFixture();
  try {
    const gh = `${f.root}/host/credentials/gh`;
    const claude = `${f.root}/host/credentials/claude`;
    const ghExtra = `${f.root}/host/credentials/gh-extra`;
    const credentialMounts = (options: string): string[] => [
      "--volume",
      `${gh}:/home/vibe/.vibe-coder/credentials/gh${options}`,
      "--volume",
      `${claude}:/home/vibe/.vibe-coder/credentials/claude:ro`,
      "--volume",
      `${ghExtra}:/home/vibe/.vibe-coder/credentials/gh-extra:ro`,
    ];
    for (const options of [":ro", ""]) {
      const plan = fakePlan(f.root, "vibe-test", credentialMounts(options));
      const args = buildBabysitterRunArgs(plan, {
        clone: f.clone,
        scratch: f.scratch,
      });
      const mounts = volumeValues(args);
      assertEquals(
        mounts.filter((value) => value.startsWith(`${gh}:`)),
        [],
        `the gh store must not be mounted (options "${options}")`,
      );
      assert(
        mounts.includes(
          `${claude}:/home/vibe/.vibe-coder/credentials/claude:ro`,
        ),
        "a provider credential mount stays",
      );
      assert(
        mounts.includes(
          `${ghExtra}:/home/vibe/.vibe-coder/credentials/gh-extra:ro`,
        ),
        "a sibling directory named gh-extra is not the gh store",
      );
    }

    // The run the repair spawns carries no gh store mount either.
    const { deps, calls } = fakeDeps(f, {
      extra: credentialMounts(":ro"),
    });
    await runBabysitterRepairContainer(inputFor(f), deps);
    const spawned = volumeValues(spawnAt(calls, 0).args);
    assertEquals(
      spawned.filter((value) => value.startsWith(`${gh}:`)),
      [],
      "the repair run mounts no gh store",
    );
    assert(
      spawned.includes(
        `${claude}:/home/vibe/.vibe-coder/credentials/claude:ro`,
      ),
      "the repair run keeps the provider credential mount",
    );
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("repair drops the custom prompt mount and its env spec, and keeps provider mounts (Issue #4770)", async () => {
  const f = await makeFixture();
  try {
    const label = `${f.home}/.vibe-coder/credentials/gh/label.md`;
    const claude = `${f.root}/host/credentials/claude`;
    const sibling = `${f.root}/host/custom-prompts-other`;
    const promptMap = JSON.stringify({
      [label]: "/home/vibe/.vibe-coder/custom-prompts/1/label.md",
    });
    const planExtra = (envArg: string[]): string[] => [
      "--volume",
      `${label}:/home/vibe/.vibe-coder/custom-prompts/1:ro`,
      "--volume",
      `${claude}:/home/vibe/.vibe-coder/credentials/claude:ro`,
      "--volume",
      `${sibling}:/home/vibe/.vibe-coder/custom-prompts-other:ro`,
      ...envArg,
    ];
    for (
      const envArg of [
        ["--env", `VIBE_CUSTOM_PROMPT_PATHS=${promptMap}`],
        [`--env=VIBE_CUSTOM_PROMPT_PATHS=${promptMap}`],
      ]
    ) {
      const plan = fakePlan(f.root, "vibe-test", planExtra(envArg));
      const args = buildBabysitterRunArgs(plan, {
        clone: f.clone,
        scratch: f.scratch,
      });
      const mounts = volumeValues(args);
      assertEquals(
        mounts.filter((value) => value.startsWith(`${label}:`)),
        [],
        `the custom prompt mount must not be mounted (${envArg[0]})`,
      );
      assert(
        !args.some((arg) => arg.includes("VIBE_CUSTOM_PROMPT_PATHS")),
        `the custom prompt env spec must not reach the run args (${envArg[0]})`,
      );
      assert(
        mounts.includes(
          `${claude}:/home/vibe/.vibe-coder/credentials/claude:ro`,
        ),
        "a provider credential mount stays",
      );
      assert(
        mounts.includes(
          `${sibling}:/home/vibe/.vibe-coder/custom-prompts-other:ro`,
        ),
        "a sibling named custom-prompts-other is not the custom prompt target",
      );
    }
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

Deno.test("key guard refuses caller mounts at or above the key directory", async () => {
  const f = await makeFixture();
  try {
    for (
      const input of [
        { ...inputFor(f), clone: f.home },
        { ...inputFor(f), scratch: f.keyDir },
      ]
    ) {
      const { deps, calls } = fakeDeps(f);
      const error = await assertRejects(
        () => runBabysitterRepairContainer(input, deps),
        Error,
      );
      assertStringIncludes(error.message, "refusing to mount");
      assertStringIncludes(error.message, "App private key");
      assertEquals(calls.spawns.length, 0);
    }
    const { deps, calls } = fakeDeps(f);
    await runBabysitterRepairContainer(inputFor(f), deps);
    assertEquals(calls.spawns.length, 1);
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

Deno.test("buildBabysitterRunArgs drops the custom prompt env spec in the -e and bare-name spellings", async () => {
  const f = await makeFixture();
  try {
    const promptMap = `{"1":"${f.root}/custom-prompts/1"}`;
    for (
      const envArg of [
        ["-e", `VIBE_CUSTOM_PROMPT_PATHS=${promptMap}`],
        ["--env", "VIBE_CUSTOM_PROMPT_PATHS"],
        ["-e", "VIBE_CUSTOM_PROMPT_PATHS"],
      ]
    ) {
      const plan = fakePlan(f.root, "vibe-test", envArg);
      const args = buildBabysitterRunArgs(plan, {
        clone: f.clone,
        scratch: f.scratch,
      });
      assert(
        !args.some((arg) => arg.includes("VIBE_CUSTOM_PROMPT_PATHS")),
        `the custom prompt env spec must not reach the run args (${
          envArg.join(" ")
        })`,
      );
      assertEquals(
        args[args.indexOf("GH_TOKEN") - 1],
        "--env",
        `control: the repair still passes GH_TOKEN (${envArg.join(" ")})`,
      );
    }
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("the real repair plan mounts no gh credential, key or custom prompt path, and passes no GH_, GITHUB_ or SSH_ env (Issue #4770)", async () => {
  const f = await makeFixture();
  try {
    const credentials = `${f.home}/.vibe-coder/credentials`;
    const gh = `${credentials}/gh`;
    const claude = `${credentials}/claude`;
    for (const dir of [`${gh}/prompts`, claude]) {
      await Deno.mkdir(dir, { recursive: true });
    }
    const configFile = `${f.home}/config.json`;
    await Deno.writeTextFile(configFile, "{}");
    const environment: Record<string, string> = {
      HOME: f.home,
      VIBE_CREDENTIAL_DIR: credentials,
      CONFIG_PATH: configFile,
      WORK_DIR: `${f.home}/work`,
      VIBE_CUSTOM_PROMPT_PATHS: JSON.stringify({ "1": `${gh}/prompts` }),
    };
    const plan = await buildLaunchPlanForCommand(
      REPO_ROOT,
      "vibe-babysitter-4738",
      {
        env: (name) => environment[name],
        now: () => 1_900_000_000_000,
        probe: (candidate) =>
          Promise.resolve({
            available: true,
            path: `/usr/bin/${candidate.executable}`,
          }),
      },
    );
    const args = buildBabysitterRunArgs(plan, {
      clone: f.clone,
      scratch: f.scratch,
      workspaceSnapshot: `${f.scratch}/worker-snapshot`,
    });

    const volumes = volumeValues(args);
    const paths = volumes.flatMap((value) => value.split(":").slice(0, 2));
    const forbidden = [
      gh,
      f.keyDir,
      `${f.home}/.vibe-coder/custom-prompts`,
      "/home/vibe/.vibe-coder/credentials/gh",
      "/home/vibe/.vibe-coder/custom-prompts",
    ];
    for (const path of paths) {
      for (const dir of forbidden) {
        assert(
          path !== dir && !path.startsWith(`${dir}/`),
          `no mount may reach ${dir}: ${path}`,
        );
      }
    }
    const mounts = volumeValues(args);
    const base = plan.mounts.find((mount) => mount.target === "/workspace");
    const logs = plan.mounts.find((mount) => mount.target.endsWith("/logs"));
    const stagedConfig = plan.mounts.find((mount) =>
      mount.target.endsWith("/run-config")
    );
    assert(base && logs && stagedConfig);
    assert(mounts.includes(`${f.scratch}/worker-snapshot:/workspace:ro`));
    assert(!mounts.some((mount) => mount.startsWith(`${base.source}:`)));
    assert(!mounts.some((mount) => mount.startsWith(`${logs.source}:`)));
    assert(
      !mounts.some((mount) => mount.startsWith(`${stagedConfig.source}:`)),
    );
    assert(mounts.includes(`${f.scratch}:/home/vibe/logs`));
    assert(args.includes("CONFIG_PATH=/workspace/.config.json"));

    const envSpecs = args.filter((_, i) => args[i - 1] === "--env");
    assert(envSpecs.includes("GH_TOKEN"), "the bare GH_TOKEN is passed");
    assertEquals(
      envSpecs.filter((spec) =>
        /^(GH_|GITHUB_|SSH_)/.test(spec) && spec !== "GH_TOKEN"
      ),
      [],
      "no GH_, GITHUB_ or SSH_ env except the bare GH_TOKEN",
    );

    assertEquals(
      volumes.map((value) => value.split(":")[1]).sort(),
      [
        BABYSITTER_CLONE_MOUNT,
        `${BABYSITTER_CLONE_MOUNT}/.git`,
        BABYSITTER_SCRATCH_MOUNT,
        "/home/vibe/.vibe-coder/credentials/claude",
        "/home/vibe/logs",
        "/workspace",
      ].sort(),
      "only the clone, its read-only .git, scratch, workspace, run-config, logs and enabled provider credential mounts remain",
    );
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("repair mounts a tracked checkout snapshot and a scrubbed config while keeping declared quality credentials", async () => {
  const f = await makeFixture();
  const workerCheckout = `${f.root}/worker-checkout`;
  await Deno.mkdir(workerCheckout);
  await Deno.writeTextFile(
    `${workerCheckout}/tracked.txt`,
    "tracked worker file\n",
  );
  const binaryContent = new Uint8Array([0, 255, 1, 128, 10]);
  await Deno.writeFile(`${workerCheckout}/tracked.bin`, binaryContent);
  await Deno.writeTextFile(
    `${workerCheckout}/untracked-secret.txt`,
    "host-only credential\n",
  );
  for (
    const args of [
      ["init", "-q", workerCheckout],
      ["-C", workerCheckout, "add", "tracked.txt", "tracked.bin"],
      [
        "-C",
        workerCheckout,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-qm",
        "fixture",
      ],
    ]
  ) {
    const result = await new Deno.Command("git", {
      args,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(result.success, new TextDecoder().decode(result.stderr));
  }
  const configStage = `${f.root}/staged`;
  const logs = `${f.root}/logs`;
  const credentialRoot = `${f.root}/credentials`;
  await Deno.mkdir(configStage);
  await Deno.mkdir(logs);
  await Deno.mkdir(`${credentialRoot}/claude`, { recursive: true });
  await Deno.mkdir(`${credentialRoot}/gh`, { recursive: true });
  await Deno.writeTextFile(
    `${configStage}/.config.json`,
    JSON.stringify({
      repos: ["stSoftwareAU/VibeCoder"],
      github_app_private_key_path: f.keyPath,
      imgbb_api_key: "host-imgbb-secret",
      max_issue_body_tokens: 1000,
      recent_activity_max_tokens: 500,
      repo_config: {
        "stSoftwareAU/VibeCoder": {
          quality_credentials: {
            mint: "quality-token-command",
            passthrough: ["QUALITY_TOKEN"],
          },
        },
      },
    }),
  );
  const name = "vibe-babysitter-snapshot";
  const plan = fakePlan(f.root, name, [
    "--volume",
    `${logs}:/home/vibe/logs`,
    "--volume",
    `${workerCheckout}:/workspace:ro`,
    "--volume",
    `${configStage}:/container/run-config:ro`,
    "--volume",
    `${credentialRoot}/gh:/home/vibe/.vibe-coder/credentials/gh:ro`,
    "--volume",
    `${credentialRoot}/claude:/home/vibe/.vibe-coder/credentials/claude:ro`,
    "--env",
    "CONFIG_PATH=/container/run-config/.config.json",
  ]);
  plan.mounts = [
    { source: "vibe-work", target: "/home/vibe/auto-issue-work", volume: true },
    { source: logs, target: "/home/vibe/logs" },
    { source: workerCheckout, target: "/workspace", readOnly: true },
    { source: configStage, target: "/container/run-config", readOnly: true },
    {
      source: `${credentialRoot}/gh`,
      target: "/home/vibe/.vibe-coder/credentials/gh",
      readOnly: true,
    },
    {
      source: `${credentialRoot}/claude`,
      target: "/home/vibe/.vibe-coder/credentials/claude",
      readOnly: true,
    },
  ];
  const { deps, calls } = fakeDeps(f, { overrides: plan });
  // The snapshot is removed when the session ends (Issue #4770), so the
  // container's spawn reads what it mounts while the session runs.
  let seen:
    | {
      tracked: string;
      binary: Uint8Array;
      untracked: boolean;
      config: string;
    }
    | undefined;
  const runSpawn = deps.spawn!;
  deps.spawn = async (runtime, args, options) => {
    const snapshot = `${f.scratch}/workspace`;
    seen = {
      tracked: await Deno.readTextFile(`${snapshot}/tracked.txt`),
      binary: await Deno.readFile(`${snapshot}/tracked.bin`),
      untracked: await Deno.stat(`${snapshot}/untracked-secret.txt`).then(
        () => true,
        () => false,
      ),
      config: await Deno.readTextFile(`${snapshot}/.config.json`),
    };
    return await runSpawn(runtime, args, options);
  };
  try {
    await runBabysitterRepairContainer(
      { ...inputFor(f), baseDir: workerCheckout },
      deps,
    );
    const args = spawnAt(calls, 0).args;
    assert(args.includes(`${f.scratch}/workspace:/workspace:ro`));
    assert(seen, "the container ran with the snapshot");
    assertEquals(seen.tracked, "tracked worker file\n");
    assertEquals(seen.binary, binaryContent);
    assertEquals(seen.untracked, false, "untracked files are not snapshotted");
    // The snapshot is removed when the session ends.
    await assertRejects(
      () => Deno.stat(`${f.scratch}/workspace`),
      Deno.errors.NotFound,
    );
    assert(args.includes(`${f.scratch}:/home/vibe/logs`));
    assert(args.includes("CONFIG_PATH=/workspace/.config.json"));
    assert(!args.some((arg) => arg.includes(`${f.keyDir}`)));
    assert(
      !volumeValues(args).some((mount) => mount.includes(`${configStage}:`)),
    );
    assert(!volumeValues(args).some((mount) => mount.includes(`${logs}:`)));
    assert(
      !volumeValues(args).some((mount) => mount.includes("/credentials/gh")),
    );
    assert(
      volumeValues(args).some((mount) => mount.includes("/credentials/claude")),
    );
    const safeConfig = seen.config;
    assert(!safeConfig.includes(f.keyPath));
    assert(!safeConfig.includes("host-imgbb-secret"));
    assert(safeConfig.includes("quality-token-command"));
    assert(safeConfig.includes("QUALITY_TOKEN"));
    assert(!safeConfig.includes("github_app_private_key_path"));
    assert(!safeConfig.includes("imgbb_api_key"));
    // Numeric limits are not secrets: a key named `*_tokens` keeps its value.
    assertEquals(JSON.parse(safeConfig).max_issue_body_tokens, 1000);
    assertEquals(JSON.parse(safeConfig).recent_activity_max_tokens, 500);
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
    assertEquals(calls.onPath, ["fake-runtime"]);
    assertEquals(calls.imageExists, []);

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
    assertEquals(calls.onPath, ["fake-runtime"]);
    assertEquals(calls.imageExists, [{
      runtime: "fake-runtime",
      args: ["image", "inspect", "vibe-coder:test"],
    }]);

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

Deno.test("repair retains the final failure after lengthy routing logs", async () => {
  const f = await makeFixture();
  try {
    const { deps } = fakeDeps(f, {
      spawnResults: [{
        success: false,
        code: 1,
        stderr: `${
          "routing log\n".repeat(100)
        }provider choice failed: no budget`,
        timedOut: false,
      }],
    });
    const error = await assertRejects(
      () => runBabysitterRepairContainer(inputFor(f), deps),
      Error,
    );
    assertStringIncludes(error.message, "provider choice failed: no budget");
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
    // Exits 0 only when the child's environment holds nothing beyond DENO_DIR
    // and the keys deno itself sets (its Node compatibility shim adds PATH and
    // DENO_NODE_SHIM_ACTIVE to any child). A host variable such as HOME, which
    // the test process has, would make it exit 3.
    const code =
      "const ok = new Set(['DENO_DIR','DENO_NODE_SHIM_ACTIVE','PATH']);" +
      "Deno.exit(Object.keys(Deno.env.toObject()).every((k) => ok.has(k)) ? 0 : 3)";
    const result = await babysitterSpawn(Deno.execPath(), [
      "eval",
      "--allow-env",
      code,
    ], {
      env: { DENO_DIR: dir },
      timeoutMs: 60_000,
    });
    assertEquals(
      result.success,
      true,
      `child saw host variables: exit ${result.code} ${result.stderr}`,
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

Deno.test("repair passes exactly the allowlisted host variables to the image check, repair and kill", async () => {
  const f = await makeFixture();
  try {
    const host: Record<string, string> = {
      PATH: "/usr/bin",
      HOME: "/home/fake",
      USER: "fake-user",
      LOGNAME: "fake-logname",
      TMPDIR: "/tmp/fake",
      DOCKER_HOST: "unix:///fake/docker.sock",
      XDG_RUNTIME_DIR: "/run/user/fake",
      CONTAINER_HOST: "unix:///fake/podman.sock",
      [SENTINEL]: "leaked",
    };
    const { PATH: _path, ...rest } = host;
    const expected: Record<string, string> = { PATH: host.PATH ?? "" };
    for (const [name, value] of Object.entries(rest)) {
      if (name !== SENTINEL) expected[name] = value;
    }
    const timedOut: BabysitterSpawnResult = {
      success: false,
      code: 124,
      stderr: "",
      timedOut: true,
    };
    const { deps, calls } = fakeDeps(f, {
      env: (name) => host[name],
      spawnResults: [timedOut, OK],
    });
    let inspectEnv: Record<string, string> | undefined;
    deps.imageExists = (_runtime, _args, env) => {
      inspectEnv = { ...env };
      return Promise.resolve(true);
    };
    await assertRejects(
      () => runBabysitterRepairContainer(inputFor(f), deps),
      Error,
      "killed",
    );
    assertEquals(inspectEnv, expected, "the image check env");
    assertEquals(
      spawnAt(calls, 0).env,
      { ...expected, GH_TOKEN: TOKEN },
      "the repair env",
    );
    assertEquals(spawnAt(calls, 1).env, expected, "the kill env");
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("repair reads the process environment by default", async () => {
  const f = await makeFixture();
  try {
    const { deps, calls } = fakeDeps(f);
    delete deps.env;
    let inspectEnv: Record<string, string> | undefined;
    deps.imageExists = (_runtime, _args, env) => {
      inspectEnv = { ...env };
      return Promise.resolve(true);
    };
    await runBabysitterRepairContainer(inputFor(f), deps);
    const path = Deno.env.get("PATH");
    assert(path !== undefined && path !== "", "the test process has a PATH");
    assertEquals(inspectEnv?.PATH, path);
    assertEquals(spawnAt(calls, 0).env.PATH, path);
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test({
  name: "babysitterRuntimeOnPath reads the process PATH by default",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    assertEquals(await babysitterRuntimeOnPath("sh"), true);
    assertEquals(await babysitterRuntimeOnPath("absent-runtime-4767"), false);
  },
});

/** Exits 0 only when the child holds PROBE=yes and no variable but the shim's own. */
const PROBE_CODE =
  "const ok = new Set(['PROBE','DENO_DIR','DENO_NODE_SHIM_ACTIVE','PATH']);" +
  "const all = Deno.env.toObject();" +
  "Deno.exit(all.PROBE === 'yes' && Object.keys(all).every((k) => ok.has(k)) ? 0 : 3)";

Deno.test("babysitterSpawn passes the given env to the child", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const result = await babysitterSpawn(Deno.execPath(), [
      "eval",
      "--allow-env",
      PROBE_CODE,
    ], {
      env: { DENO_DIR: dir, PROBE: "yes" },
      timeoutMs: 60_000,
    });
    assertEquals(result.code, 0, `child env wrong: ${result.stderr}`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/**
 * Fake deps for an abort test. The repair spawn runs `onRepairStarted` and
 * then blocks until a kill arrives. The kill returns `killResult`, or throws
 * when it is an Error, and it releases the blocked repair (exit 137).
 */
function blockingDeps(
  f: Fixture,
  killResult: BabysitterSpawnResult | Error,
  onRepairStarted: () => void,
): { deps: Partial<BabysitterContainerDeps>; calls: Calls } {
  const { deps, calls } = fakeDeps(f);
  let release: (result: BabysitterSpawnResult) => void = () => {};
  const repairExited = new Promise<BabysitterSpawnResult>((resolve) => {
    release = resolve;
  });
  deps.spawn = (runtime, args, opts) => {
    calls.spawns.push({
      runtime,
      args: [...args],
      env: { ...opts.env },
      timeoutMs: opts.timeoutMs,
    });
    if (args[0] !== "kill") {
      onRepairStarted();
      return repairExited;
    }
    release({ success: false, code: 137, stderr: "", timedOut: false });
    return killResult instanceof Error
      ? Promise.reject(killResult)
      : Promise.resolve(killResult);
  };
  return { deps, calls };
}

Deno.test("babysitterCheckoutDir is the checkout root, with no trailing slash", async () => {
  const root = babysitterCheckoutDir();
  assert(!root.endsWith("/"), root);
  const stat = await Deno.stat(
    `${root}/worker/deno/lib/fleet_babysitter_container.ts`,
  );
  assert(stat.isFile);
});

Deno.test("preflight refuses when the runtime is not on PATH, and never asks for the image", async () => {
  const f = await makeFixture();
  try {
    const { deps, calls } = fakeDeps(f, { onPath: false });
    await assertRejects(
      () => preflightBabysitterContainer({ baseDir: "/checkout" }, deps),
      Error,
      "cannot run fake-runtime: the container runtime is not on PATH",
    );
    assertEquals(calls.onPath, ["fake-runtime"]);
    assertEquals(calls.imageExists, []);
    assertEquals(calls.spawns.length, 0, "the preflight starts nothing");

    const control = fakeDeps(f, { onPath: true });
    await preflightBabysitterContainer(
      { baseDir: "/checkout" },
      control.deps,
    );
    assertEquals(control.calls.onPath, ["fake-runtime"]);
    assertEquals(control.calls.built.length, 1, "one plan is built");
    assert(
      builtAt(control.calls, 0).startsWith("vibe-babysitter-"),
      "the preflight plan takes a throwaway babysitter container name",
    );
    assertEquals(
      control.calls.spawns.length,
      0,
      "the preflight starts nothing",
    );
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("preflight refuses when the worker image is not built, and starts nothing", async () => {
  const f = await makeFixture();
  try {
    const { deps, calls } = fakeDeps(f, { imageExists: false });
    await assertRejects(
      () => preflightBabysitterContainer({ baseDir: "/checkout" }, deps),
      Error,
      "the worker image is not built; start the Vibe Coder (./run.sh) once to build it",
    );
    assertEquals(calls.imageExists, [{
      runtime: "fake-runtime",
      args: ["image", "inspect", "vibe-coder:test"],
    }]);
    assertEquals(calls.spawns.length, 0, "the preflight starts nothing");

    const control = fakeDeps(f, { imageExists: true });
    await preflightBabysitterContainer({ baseDir: "/checkout" }, control.deps);
    assertEquals(control.calls.spawns.length, 0);
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("abort while the repair runs kills the container by name, and the run settles", async () => {
  const f = await makeFixture();
  try {
    const controller = new AbortController();
    const { deps, calls } = blockingDeps(f, OK, () => controller.abort());
    const logged: string[] = [];
    await assertRejects(
      () =>
        runBabysitterRepairContainer(
          { ...inputFor(f), signal: controller.signal },
          { ...deps, log: (message) => logged.push(message) },
        ),
      Error,
      "exited with code 137",
    );
    assertEquals(calls.spawns.length, 2);
    const name = builtAt(calls, 0);
    assertEquals(spawnAt(calls, 1).runtime, "fake-runtime");
    assertEquals(spawnAt(calls, 1).args, ["kill", name]);
    assertEquals(spawnAt(calls, 1).timeoutMs, 30_000);
    assert(!("GH_TOKEN" in spawnAt(calls, 1).env), "the kill carries no token");
    assertEquals(logged, [], "a kill that worked logs nothing");

    // The listener is removed when the run ends, so a later abort starts no kill.
    const late = new AbortController();
    const after = fakeDeps(f);
    await runBabysitterRepairContainer(
      { ...inputFor(f), signal: late.signal },
      after.deps,
    );
    late.abort();
    assertEquals(
      after.calls.spawns.length,
      1,
      "an abort after the run ends starts no kill",
    );
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("a failed kill after an abort is logged, redacted, and not thrown", async () => {
  const f = await makeFixture();
  try {
    const controller = new AbortController();
    const failed: BabysitterSpawnResult = {
      success: false,
      code: 1,
      stderr: `no such container ${TOKEN}`,
      timedOut: false,
    };
    const { deps, calls } = blockingDeps(
      f,
      failed,
      () => controller.abort(),
    );
    const logged: string[] = [];
    await assertRejects(
      () =>
        runBabysitterRepairContainer(
          { ...inputFor(f), signal: controller.signal },
          { ...deps, log: (message) => logged.push(message) },
        ),
      Error,
      "exited with code 137",
    );
    const name = builtAt(calls, 0);
    assertEquals(logged.length, 1, "the failed kill is logged once");
    assertStringIncludes(
      logged[0]!,
      `could not kill container ${name} after abort`,
    );
    assertStringIncludes(logged[0]!, "exit code 1: no such container ***");
    assert(!logged[0]!.includes(TOKEN), "the token is redacted from the log");

    const thrownController = new AbortController();
    const thrown = blockingDeps(
      f,
      new Error("spawn broke"),
      () => thrownController.abort(),
    );
    const thrownLogged: string[] = [];
    await assertRejects(
      () =>
        runBabysitterRepairContainer(
          { ...inputFor(f), signal: thrownController.signal },
          { ...thrown.deps, log: (message) => thrownLogged.push(message) },
        ),
      Error,
      "exited with code 137",
    );
    assertEquals(thrownLogged.length, 1, "a kill that throws is logged too");
    assertStringIncludes(thrownLogged[0]!, "spawn broke");
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("repair refuses an already-aborted signal before the runtime starts", async () => {
  const f = await makeFixture();
  try {
    const controller = new AbortController();
    controller.abort();
    const { deps, calls } = fakeDeps(f);
    await assertRejects(
      () =>
        runBabysitterRepairContainer(
          { ...inputFor(f), signal: controller.signal },
          deps,
        ),
      Error,
      "aborted before the container started",
    );
    assertEquals(calls.spawns.length, 0, "no runtime process starts");

    const control = fakeDeps(f);
    await runBabysitterRepairContainer(inputFor(f), control.deps);
    assertEquals(
      control.calls.spawns.length,
      1,
      "the same run, unaborted, starts",
    );
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("repair's non-zero exit names the rebuild hint and keeps the stderr cause", async () => {
  const f = await makeFixture();
  try {
    const { deps } = fakeDeps(f, {
      spawnResults: [{
        success: false,
        code: 3,
        stderr: "provider choice failed: no budget",
        timedOut: false,
      }],
    });
    const error = await assertRejects(
      () => runBabysitterRepairContainer(inputFor(f), deps),
      Error,
    );
    assertStringIncludes(
      error.message,
      "exited with code 3: provider choice failed: no budget",
    );
    assertStringIncludes(
      error.message,
      "; if the worker image predates the babysitter-repair mode, relaunch with ./run.sh to rebuild it",
    );
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

// Issue #5072: a spent provider balance is a normal park, not a fault — no
// rebuild hint, and a distinct type the host can stay quiet about.
Deno.test("the quota-park exit is a BabysitterQuotaPark without the rebuild hint (Issue #5072)", async () => {
  const f = await makeFixture();
  try {
    const { deps } = fakeDeps(f, {
      spawnResults: [{
        success: false,
        code: BABYSITTER_QUOTA_PARK_EXIT_CODE,
        stderr: "agent exited 1; quota-exhausted: balance is spent",
        timedOut: false,
      }],
    });
    const error = await assertRejects(
      () => runBabysitterRepairContainer(inputFor(f), deps),
      BabysitterQuotaPark,
    );
    assertStringIncludes(error.message, "quota-exhausted: balance is spent");
    assertEquals(error.message.includes("predates"), false);
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("babysitterImageExists passes the given env, and only that, to the inspect", async () => {
  const dir = await Deno.makeTempDir();
  try {
    assertEquals(
      await babysitterImageExists(
        Deno.execPath(),
        ["eval", "--allow-env", PROBE_CODE],
        { DENO_DIR: dir, PROBE: "yes" },
      ),
      true,
      "the inspect sees the given env and no host variable",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// Issue #4930: the PR's base branch reaches the in-container pre-push gate as a
// trailing `--base-branch <name>` after the fixed repair command.
Deno.test("repair appends --base-branch after the fixed command when a base branch is given (Issue #4930)", async () => {
  const f = await makeFixture();
  try {
    const plan = fakePlan(f.root, "vibe-test");
    const args = buildBabysitterRunArgs(plan, {
      clone: f.clone,
      scratch: f.scratch,
      baseBranch: "main",
    });
    assertEquals(args.slice(-(BABYSITTER_REPAIR_COMMAND.length + 2)), [
      ...BABYSITTER_REPAIR_COMMAND,
      "--base-branch",
      "refs/heads/main",
    ]);
    assertEquals(args[args.length - 1], "refs/heads/main");
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("repair argv is unchanged, with no --base-branch, when no base branch is given (Issue #4930)", async () => {
  const f = await makeFixture();
  try {
    const plan = fakePlan(f.root, "vibe-test");
    const args = buildBabysitterRunArgs(plan, {
      clone: f.clone,
      scratch: f.scratch,
    });
    assertEquals(args.slice(-BABYSITTER_REPAIR_COMMAND.length), [
      ...BABYSITTER_REPAIR_COMMAND,
    ]);
    assert(!args.includes("--base-branch"), "no --base-branch flag");
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("repair refuses a base branch that git would read as an option (Issue #4930)", async () => {
  const f = await makeFixture();
  try {
    const plan = fakePlan(f.root, "vibe-test");
    for (const baseBranch of ["-x", "--upload-pack=echo", ""]) {
      assertThrowsMessage(
        () =>
          buildBabysitterRunArgs(plan, {
            clone: f.clone,
            scratch: f.scratch,
            baseBranch,
          }),
        "babysitter base branch",
      );
    }
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("runBabysitterRepairContainer refuses an unsafe base branch before any process starts (Issue #4930)", async () => {
  const f = await makeFixture();
  try {
    const { deps, calls } = fakeDeps(f);
    await assertRejects(
      () =>
        runBabysitterRepairContainer(
          { ...inputFor(f), baseBranch: "-x" },
          deps,
        ),
      Error,
      "babysitter base branch",
    );
    assertEquals(calls.imageExists.length, 0, "no image check ran");
    assertEquals(calls.spawns.length, 0, "no container spawned");
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("runBabysitterRepairContainer spawns the repair with --base-branch after the fixed command (Issue #4930)", async () => {
  const f = await makeFixture();
  try {
    const { deps, calls } = fakeDeps(f);
    await runBabysitterRepairContainer(
      { ...inputFor(f), baseBranch: "release/2" },
      deps,
    );
    assertEquals(calls.spawns.length, 1, "exactly one repair spawn");
    assertEquals(
      spawnAt(calls, 0).args.slice(-(BABYSITTER_REPAIR_COMMAND.length + 2)),
      [
        ...BABYSITTER_REPAIR_COMMAND,
        "--base-branch",
        "refs/heads/release/2",
      ],
    );
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});
