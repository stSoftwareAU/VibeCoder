/**
 * Tests for the egress side of the babysitter repair container (Issue #4769).
 * The Apple helper and the enforced sidecar start before the repair spawn and
 * stop after it, whatever the outcome. These tests cover the order of those
 * steps, the set-up and teardown failures, the preflight that runs before any
 * egress step, the key guard on the helper's arguments, and the default egress
 * wiring. Fake deps stand in for the runtime and the egress steps, and record
 * every call in one ordered event list. The default Apple helper runs for real
 * against a stub script in a temp checkout, and the default sidecar wiring runs
 * for real with a missing runtime to observe cleanup failures. Every env reader
 * is injected, so no test reads the host environment and none sets a variable.
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import type { ContainerLaunchPlan } from "../lib/container_launch.ts";
import {
  type BabysitterContainerDeps,
  type BabysitterContainerInput,
  type BabysitterEnvReader,
  type BabysitterSpawnResult,
  babysitterStartAppleEgress,
  buildBabysitterRunArgs,
  pause,
  readExitStatus,
  runBabysitterRepairContainer,
} from "../lib/fleet_babysitter_container.ts";

const TOKEN = "ghs_FAKE-TOKEN-4738";
const IMAGE = "vibe-coder:test";
const HELPER_MARK = "VIBE_HELPER_MARK=1";
const PLAN_ONLY_MARK = "VIBE_PLAN_ONLY=1";
/** The helper's run arguments. Like a plan's `runArgs`, they end with the image. */
const HELPER_RUN_ARGS = [
  "run",
  "--rm",
  "--name",
  "vibe-egress-helper",
  "--env",
  HELPER_MARK,
  IMAGE,
];
const OK: BabysitterSpawnResult = {
  success: true,
  code: 0,
  stderr: "",
  timedOut: false,
};
const FAILED: BabysitterSpawnResult = {
  success: false,
  code: 1,
  stderr: "boom",
  timedOut: false,
};
const TIMED_OUT: BabysitterSpawnResult = {
  success: false,
  code: 124,
  stderr: "",
  timedOut: true,
};
const fakeEnv: BabysitterEnvReader = (name) =>
  name === "PATH" ? "/usr/bin" : undefined;

/** Which egress the fake plan needs: an Apple helper, an enforced sidecar, or neither. */
type EgressKind = "apple" | "enforced" | "none";

interface Fixture {
  root: string;
  keyDir: string;
  keyPath: string;
  clone: string;
  scratch: string;
}

/** A temp tree: a key directory holding a fake App key, plus clone and scratch. */
async function makeFixture(): Promise<Fixture> {
  const root = await Deno.makeTempDir();
  const keyDir = `${root}/home/.vibe-coder/fleet-pr-babysitter`;
  const keyPath = `${keyDir}/babysitter-app.pem`;
  await Deno.mkdir(keyDir, { recursive: true });
  await Deno.writeTextFile(
    keyPath,
    "-----BEGIN PRIVATE KEY-----\nFAKE-KEY-BODY-4769\n-----END PRIVATE KEY-----",
  );
  const clone = `${root}/clone`;
  const scratch = `${root}/scratch`;
  await Deno.mkdir(clone);
  await Deno.mkdir(scratch);
  return { root, keyDir, keyPath, clone, scratch };
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

/**
 * A launch plan shaped like the worker's. Its own run arguments carry a
 * plan-only marker, so a test can tell the plan's arguments from the helper's.
 */
function fakePlan(
  root: string,
  name: string,
  kind: EgressKind,
): ContainerLaunchPlan {
  const egress = kind === "none"
    ? { egressEnforced: false, proxyName: "" }
    : { egressEnforced: kind === "enforced", proxyName: `${name}-proxy` };
  return {
    runtime: "fake-runtime",
    image: IMAGE,
    keepImages: [IMAGE],
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
    imageInspectArgs: ["image", "inspect", IMAGE],
    buildArgs: [],
    extensionBuildArgs: [],
    builderStopArgs: [],
    builderAbsentPatterns: [],
    ...egress,
    networkCreateArgs: [],
    networkRemoveArgs: [],
    networkConnectArgs: [],
    proxyRunArgs: [],
    proxyStopArgs: [],
    proxyBundle: "",
    runArgs: [
      "run",
      "--rm",
      "--name",
      name,
      "--volume",
      "vibe-work:/home/vibe/auto-issue-work",
      "--volume",
      `${root}/logs:/home/vibe/logs`,
      "--env",
      PLAN_ONLY_MARK,
      IMAGE,
    ],
  };
}

interface Spawned {
  runtime: string;
  args: string[];
  env: Record<string, string>;
  timeoutMs: number;
}

interface Harness {
  /** Every egress step and every spawn, in call order. */
  events: string[];
  /** Messages passed to `log`. */
  logged: string[];
  /** Each Apple helper start, with the plan and the base directory it got. */
  apple: Array<{ plan: ContainerLaunchPlan; baseDir: string }>;
  sidecarStarts: ContainerLaunchPlan[];
  sidecarStops: ContainerLaunchPlan[];
  spawns: Spawned[];
  /** The container name given to each plan build. */
  built: string[];
}

interface Options {
  kind?: EgressKind;
  /** The Apple helper's returned run arguments (default HELPER_RUN_ARGS). */
  helperRunArgs?: string[];
  /** The Apple helper's start rejects with this. */
  helperError?: Error;
  /** The enforced sidecar's start rejects with this. */
  sidecarStartError?: Error;
  /** The problems a teardown returns. */
  stopProblems?: string[];
  /** A teardown rejects with this. */
  stopError?: Error;
  /** Queued spawn outcomes; an Error is thrown instead of returned. */
  spawnResults?: Array<BabysitterSpawnResult | Error>;
  onPath?: boolean;
  imageExists?: boolean;
  /** Every egress step throws, for a plan that needs none. */
  forbidEgress?: boolean;
}

/** Fake deps that record every call, in one ordered event list. */
function harness(
  f: Fixture,
  options: Options = {},
): { deps: Partial<BabysitterContainerDeps>; h: Harness } {
  const h: Harness = {
    events: [],
    logged: [],
    apple: [],
    sidecarStarts: [],
    sidecarStops: [],
    spawns: [],
    built: [],
  };
  const queue = [...(options.spawnResults ?? [])];
  const kind = options.kind ?? "none";
  const forbidden = (step: string): void => {
    if (options.forbidEgress) {
      throw new Error(`${step} must not run for this plan`);
    }
  };
  const deps: Partial<BabysitterContainerDeps> = {
    env: fakeEnv,
    hostDiskAdmission: () =>
      Promise.resolve({ release: () => Promise.resolve() }),
    onPath: () => Promise.resolve(options.onPath ?? true),
    buildPlan: (_baseDir, containerName) => {
      h.built.push(containerName);
      return Promise.resolve(fakePlan(f.root, containerName, kind));
    },
    imageExists: () => Promise.resolve(options.imageExists ?? true),
    spawn: (runtime, args, opts) => {
      h.events.push("spawn");
      h.spawns.push({
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
    startAppleEgress: async (plan, egressOptions) => {
      h.events.push("start-apple");
      h.apple.push({ plan, baseDir: egressOptions.baseDir });
      forbidden("start-apple");
      if (options.helperError) throw options.helperError;
      return {
        runArgs: options.helperRunArgs ?? HELPER_RUN_ARGS,
        stop: async () => {
          h.events.push("stop-apple");
          if (options.stopError) throw options.stopError;
          return options.stopProblems ?? [];
        },
      };
    },
    startSidecar: async (plan) => {
      h.events.push("start-sidecar");
      h.sidecarStarts.push(plan);
      forbidden("start-sidecar");
      if (options.sidecarStartError) throw options.sidecarStartError;
    },
    stopSidecar: async (plan) => {
      h.events.push("stop-sidecar");
      h.sidecarStops.push(plan);
      forbidden("stop-sidecar");
      if (options.stopError) throw options.stopError;
      return options.stopProblems ?? [];
    },
    log: (message) => {
      h.logged.push(message);
    },
  };
  return { deps, h };
}

/** The n-th item of a recorded list, asserting it exists. */
function at<T>(items: readonly T[], index: number, label: string): T {
  const item = items[index];
  if (item === undefined) throw new Error(`no ${label} number ${index}`);
  return item;
}

Deno.test("apple egress: an abort during the helper start stops the repair before the spawn, and the helper is stopped", async () => {
  const f = await makeFixture();
  try {
    const { deps, h } = harness(f, { kind: "apple" });
    const controller = new AbortController();
    const startHelper = deps.startAppleEgress!;
    deps.startAppleEgress = async (plan, egressOptions) => {
      const helper = await startHelper(plan, egressOptions);
      controller.abort();
      return helper;
    };
    await assertRejects(
      () =>
        runBabysitterRepairContainer(
          { ...inputFor(f), signal: controller.signal },
          deps,
        ),
      Error,
      "the babysitter repair was aborted before the container started",
    );
    assertEquals(
      h.events,
      ["start-apple", "stop-apple"],
      "the abort is caught by the check inside runRepairProcess, so nothing spawns",
    );
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("apple egress: the repair runs the helper's args, starts the helper once and stops it after the spawn", async () => {
  const f = await makeFixture();
  try {
    const { deps, h } = harness(f, { kind: "apple" });
    const result = await runBabysitterRepairContainer(inputFor(f), deps);

    assertEquals(result, { containerName: at(h.built, 0, "build") });
    assertEquals(h.events, ["start-apple", "spawn", "stop-apple"]);
    assertEquals(h.apple.length, 1, "the helper starts once");
    const started = at(h.apple, 0, "helper start");
    assertEquals(started.baseDir, "/checkout");
    assertEquals(started.plan.containerName, at(h.built, 0, "build"));

    const spawn = at(h.spawns, 0, "spawn");
    assertEquals(
      spawn.args,
      buildBabysitterRunArgs(
        { ...started.plan, runArgs: HELPER_RUN_ARGS },
        { clone: f.clone, scratch: f.scratch },
      ),
      "the spawn runs the helper's arguments, not the plan's",
    );
    assert(
      spawn.args.includes(HELPER_MARK),
      "the helper's marker reaches the spawn",
    );
    assert(
      !spawn.args.includes(PLAN_ONLY_MARK),
      "the plan's own marker does not reach the spawn",
    );
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("apple egress: a failed repair stops the helper after the spawn and throws its own error", async () => {
  const f = await makeFixture();
  try {
    const cases: Array<{
      label: string;
      spawnResults: Array<BabysitterSpawnResult | Error>;
      message: string;
      spawns: number;
    }> = [
      {
        label: "a non-zero exit",
        spawnResults: [{ ...FAILED, code: 2, stderr: "bad" }],
        message: "exited with code 2",
        spawns: 1,
      },
      {
        label: "a spawn that throws",
        spawnResults: [new Error("spawn broke")],
        message: "spawn broke",
        spawns: 1,
      },
      {
        label: "a timeout, whose kill succeeds",
        spawnResults: [TIMED_OUT, OK],
        message: "timed out after 90 minutes",
        spawns: 2,
      },
    ];
    for (const c of cases) {
      const { deps, h } = harness(f, {
        kind: "apple",
        spawnResults: c.spawnResults,
      });
      await assertRejects(
        () => runBabysitterRepairContainer(inputFor(f), deps),
        Error,
        c.message,
      );
      assertEquals(
        h.events,
        ["start-apple", ...Array(c.spawns).fill("spawn"), "stop-apple"],
        `${c.label}: the helper is stopped last`,
      );
      assertEquals(h.spawns.length, c.spawns, c.label);
    }
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("enforced egress: the sidecar starts before the spawn and stops after it, on success, a throw and a non-zero exit", async () => {
  const f = await makeFixture();
  try {
    const cases: Array<{
      label: string;
      spawnResults: Array<BabysitterSpawnResult | Error>;
      message?: string;
    }> = [
      { label: "a successful repair", spawnResults: [OK] },
      {
        label: "a spawn that throws",
        spawnResults: [new Error("spawn broke")],
        message: "spawn broke",
      },
      {
        label: "a non-zero exit",
        spawnResults: [FAILED],
        message: "exited with code 1",
      },
    ];
    for (const c of cases) {
      const { deps, h } = harness(f, {
        kind: "enforced",
        spawnResults: c.spawnResults,
      });
      if (c.message === undefined) {
        await runBabysitterRepairContainer(inputFor(f), deps);
      } else {
        await assertRejects(
          () => runBabysitterRepairContainer(inputFor(f), deps),
          Error,
          c.message,
        );
      }
      assertEquals(
        h.events,
        ["start-sidecar", "spawn", "stop-sidecar"],
        c.label,
      );
      assertEquals(h.sidecarStarts.length, 1, c.label);
      assertEquals(h.sidecarStops.length, 1, c.label);
      const stopped = at(h.sidecarStops, 0, "sidecar stop");
      assertEquals(
        stopped,
        at(h.sidecarStarts, 0, "sidecar start"),
        `${c.label}: stop is given the plan`,
      );
      assertEquals(stopped.containerName, at(h.built, 0, "build"), c.label);
      assertEquals(h.apple.length, 0, `${c.label}: no Apple helper`);
    }
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("egress set-up failure: the repair rejects with the cause and spawns nothing", async () => {
  const f = await makeFixture();
  try {
    const apple = harness(f, {
      kind: "apple",
      helperError: new Error("egress setup failed: boom cause"),
    });
    await assertRejects(
      () => runBabysitterRepairContainer(inputFor(f), apple.deps),
      Error,
      "egress setup failed: boom cause",
    );
    assertEquals(apple.h.spawns.length, 0, "no spawn after a helper failure");

    const enforced = harness(f, {
      kind: "enforced",
      sidecarStartError: new Error("sidecar boom cause"),
    });
    await assertRejects(
      () => runBabysitterRepairContainer(inputFor(f), enforced.deps),
      Error,
      "sidecar boom cause",
    );
    assertEquals(
      enforced.h.spawns.length,
      0,
      "no spawn after a sidecar failure",
    );
    assertEquals(
      enforced.h.events,
      ["start-sidecar", "stop-sidecar"],
      "the half-started sidecar is still stopped",
    );
    assertEquals(enforced.h.sidecarStops.length, 1);
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("a plan that needs neither egress starts and stops nothing, and spawns once", async () => {
  const f = await makeFixture();
  try {
    const { deps, h } = harness(f, { kind: "none", forbidEgress: true });
    await runBabysitterRepairContainer(inputFor(f), deps);
    assertEquals(h.events, ["spawn"], "no egress step runs");
    assertEquals(h.spawns.length, 1);
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("egress teardown problems and throws are logged, and never hide the repair's result or error", async () => {
  const f = await makeFixture();
  try {
    for (const kind of ["apple", "enforced"] as const) {
      // Problems from a teardown on a successful repair are logged.
      {
        const { deps, h } = harness(f, {
          kind,
          stopProblems: ["could not remove the egress proxy (exit 1)"],
        });
        const result = await runBabysitterRepairContainer(inputFor(f), deps);
        assertEquals(result, { containerName: at(h.built, 0, "build") }, kind);
        assert(
          h.logged.some((m) =>
            m.includes("could not remove the egress proxy (exit 1)")
          ),
          `${kind}: the problem is logged, got ${JSON.stringify(h.logged)}`,
        );
      }

      // A teardown that throws on a successful repair is logged, not raised.
      {
        const { deps, h } = harness(f, {
          kind,
          stopError: new Error("kaboom"),
        });
        const result = await runBabysitterRepairContainer(inputFor(f), deps);
        assertEquals(result, { containerName: at(h.built, 0, "build") }, kind);
        assert(
          h.logged.some((m) => m.includes("kaboom")),
          `${kind}: the cause is logged, got ${JSON.stringify(h.logged)}`,
        );
      }

      // A teardown that throws after a failed repair leaves the repair's error.
      {
        const { deps, h } = harness(f, {
          kind,
          spawnResults: [FAILED],
          stopError: new Error("kaboom"),
        });
        const error = await assertRejects(
          () => runBabysitterRepairContainer(inputFor(f), deps),
          Error,
          "exited with code 1",
        );
        assert(
          !error.message.includes("kaboom"),
          `${kind}: the teardown's error must not be thrown`,
        );
        assert(
          h.logged.some((m) => m.includes("kaboom")),
          `${kind}: the teardown cause is logged`,
        );
      }

      // A token in a teardown problem never reaches the log.
      {
        const { deps, h } = harness(f, {
          kind,
          stopProblems: [`could not remove the egress proxy for ${TOKEN}`],
        });
        await runBabysitterRepairContainer(inputFor(f), deps);
        assert(
          h.logged.some((m) => m.includes("could not remove the egress proxy")),
          `${kind}: the problem is logged`,
        );
        assert(
          h.logged.every((m) => !m.includes(TOKEN)),
          `${kind}: the token must not be logged`,
        );
      }
    }
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("egress preflight failures happen before any egress step, for both egress kinds", async () => {
  const f = await makeFixture();
  try {
    for (const kind of ["apple", "enforced"] as const) {
      const offPath = harness(f, { kind, onPath: false });
      await assertRejects(
        () => runBabysitterRepairContainer(inputFor(f), offPath.deps),
        Error,
        "cannot run fake-runtime: the container runtime is not on PATH",
      );
      assertEquals(
        offPath.h.events,
        [],
        `${kind}: no egress before PATH check`,
      );

      const noImage = harness(f, { kind, imageExists: false });
      await assertRejects(
        () => runBabysitterRepairContainer(inputFor(f), noImage.deps),
        Error,
        "the worker image is not built; start the Vibe Coder (./run.sh) once to build it",
      );
      assertEquals(
        noImage.h.events,
        [],
        `${kind}: no egress before image check`,
      );
      assertEquals(noImage.h.spawns.length, 0, kind);

      const control = harness(f, { kind });
      await runBabysitterRepairContainer(inputFor(f), control.deps);
      assert(control.h.events.length > 0, `${kind}: control runs egress`);
    }
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("apple egress: helper args that mount the App key are refused, spawn nothing, and the helper is still stopped", async () => {
  const f = await makeFixture();
  try {
    const { deps, h } = harness(f, {
      kind: "apple",
      helperRunArgs: ["run", "--rm", "--volume", `${f.keyDir}:/k`, IMAGE],
    });
    const error = await assertRejects(
      () => runBabysitterRepairContainer(inputFor(f), deps),
      Error,
      "refusing to mount",
    );
    assertStringIncludes(error.message, "App private key");
    assertEquals(h.spawns.length, 0, "a refused run spawns nothing");
    assertEquals(
      h.events,
      ["start-apple", "stop-apple"],
      "the helper is stopped after the refusal",
    );
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

/**
 * The stub helper, run in place of apple_egress_launch_main.ts. It mirrors the
 * helper's contract: argv `<plan> <ready> <log-dir> <owner-pid>`, a ready file
 * written atomically as NUL-terminated run arguments, and an exit on SIGTERM.
 * The plan's `run=` tokens are its run arguments. Markers among them choose the
 * stub's behaviour: `STUB_FAIL=attempt` or `STUB_FAIL=silent` fail before the
 * ready file, and `STUB_EXIT=<n>` sets the exit code on SIGTERM. On SIGTERM it
 * writes its pid to `stopped` in its working directory, the checkout.
 */
const STUB_HELPER_SOURCE = `
const [planPath, readyPath, logDir] = Deno.args;
const plan = await Deno.readTextFile(planPath);
const runArgs = plan.split("\\u0000")
  .filter((token) => token.startsWith("run="))
  .map((token) => token.slice("run=".length));
const marker = (key: string) =>
  runArgs.find((token) => token.startsWith(key + "="))?.slice(key.length + 1);
const say = (line: string) =>
  Deno.stderr.writeSync(new TextEncoder().encode(line + "\\n"));
if (marker("STUB_FAIL") === "attempt") {
  say("[egress] attempt 1/3 failed: old");
  say("[egress] attempt 3/3 failed: real cause");
  say("at stack trace");
  Deno.exit(1);
}
if (marker("STUB_FAIL") === "silent") Deno.exit(2);
const exitCode = Number(marker("STUB_EXIT") ?? "0");
const image = runArgs[runArgs.length - 1] ?? "";
const ready = [
  ...runArgs.slice(0, -1),
  "--env",
  "STUB_MODE=" + (Deno.env.get("VIBE_APPLE_EGRESS_MODE") ?? "unset"),
  "--env",
  "STUB_DIR=" + logDir,
  "--env",
  "STUB_PID=" + String(Deno.pid),
  image,
];
Deno.addSignalListener("SIGTERM", () => {
  Deno.writeTextFileSync(Deno.cwd() + "/stopped", String(Deno.pid));
  Deno.exit(exitCode);
});
await Deno.writeTextFile(
  readyPath + ".tmp",
  ready.map((arg) => arg + "\\u0000").join(""),
);
await Deno.rename(readyPath + ".tmp", readyPath);
await new Promise(() => {});
`;

/** A temp checkout holding the stub helper and the lock file its run names. */
async function makeStubCheckout(): Promise<string> {
  const base = await Deno.makeTempDir();
  await Deno.mkdir(`${base}/worker/deno`, { recursive: true });
  await Deno.writeTextFile(`${base}/worker/deno/deno.lock`, '{"version":"5"}');
  await Deno.writeTextFile(
    `${base}/worker/deno/apple_egress_launch_main.ts`,
    STUB_HELPER_SOURCE,
  );
  return base;
}

/** The host environment for the default helper: PATH and HOME, and the mode if given. */
function hostEnv(home: string, mode?: string): BabysitterEnvReader {
  const values = new Map<string, string>([
    ["PATH", "/usr/bin"],
    ["HOME", home],
  ]);
  if (mode !== undefined) values.set("VIBE_APPLE_EGRESS_MODE", mode);
  return (name) => values.get(name);
}

/** An Apple-kind plan whose run arguments carry the stub's markers as `--env` pairs. */
function stubPlan(
  root: string,
  name: string,
  markers: string[],
): ContainerLaunchPlan {
  const env = markers.flatMap((marker) => ["--env", marker]);
  return {
    ...fakePlan(root, name, "apple"),
    runArgs: ["run", "--rm", "--name", name, ...env, IMAGE],
  };
}

/** The value of the first argument with the given prefix. */
function tokenWith(args: readonly string[], prefix: string): string {
  const found = args.find((arg) => arg.startsWith(prefix));
  if (found === undefined) throw new Error(`no argument ${prefix}...`);
  return found.slice(prefix.length);
}

interface Wiring {
  /** Deps with the plan, preflight and spawn faked; the egress steps are not. */
  deps: Partial<BabysitterContainerDeps>;
  built: string[];
  spawns: Spawned[];
  logged: string[];
}

/**
 * Deps that leave the egress steps to the real defaults. The plan, the
 * preflight and the spawn are faked. The log is not set, so the default log
 * is used unless a test sets one.
 */
function defaultWiring(
  env: BabysitterEnvReader,
  plan: (containerName: string) => ContainerLaunchPlan,
): Wiring {
  const w: Wiring = { deps: {}, built: [], spawns: [], logged: [] };
  w.deps = {
    env,
    hostDiskAdmission: () =>
      Promise.resolve({ release: () => Promise.resolve() }),
    onPath: () => Promise.resolve(true),
    imageExists: () => Promise.resolve(true),
    buildPlan: (_baseDir, containerName) => {
      w.built.push(containerName);
      return Promise.resolve(plan(containerName));
    },
    spawn: (runtime, args, opts) => {
      w.spawns.push({
        runtime,
        args: [...args],
        env: { ...opts.env },
        timeoutMs: opts.timeoutMs,
      });
      return Promise.resolve(OK);
    },
  };
  return w;
}

Deno.test("default Apple helper: the stub's ready args reach the spawn, and the helper is stopped and its temp dir removed", async () => {
  const base = await makeStubCheckout();
  const f = await makeFixture();
  try {
    const w = defaultWiring(
      hostEnv(`${f.root}/home`, "advisory"),
      (name) => stubPlan(f.root, name, []),
    );
    const result = await runBabysitterRepairContainer(
      { ...inputFor(f), baseDir: base },
      {
        ...w.deps,
        log: (message) => {
          w.logged.push(message);
        },
      },
    );
    assertEquals(result, { containerName: at(w.built, 0, "build") });
    assertEquals(w.spawns.length, 1, "one repair spawn");
    const args = at(w.spawns, 0, "spawn").args;
    assert(
      args.includes("STUB_MODE=advisory"),
      `the helper's mode reaches the spawn, got ${JSON.stringify(args)}`,
    );
    const dir = tokenWith(args, "STUB_DIR=");
    const pid = tokenWith(args, "STUB_PID=");
    assertStringIncludes(dir, "vibe-babysitter-egress-");
    assertEquals(
      await Deno.readTextFile(`${base}/stopped`),
      pid,
      "the helper that was spawned is the one stopped by SIGTERM",
    );
    assertEquals(w.logged, [], "a clean teardown logs nothing");
    await assertRejects(() => Deno.stat(dir), Deno.errors.NotFound);
  } finally {
    await Deno.remove(base, { recursive: true });
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("default Apple helper: a non-zero exit on stop is logged by the default log, and the repair still returns", async () => {
  const base = await makeStubCheckout();
  const f = await makeFixture();
  const lines: string[] = [];
  const original = console.error;
  console.error = (...data: unknown[]) => {
    lines.push(data.map(String).join(" "));
  };
  try {
    const w = defaultWiring(
      hostEnv(`${f.root}/home`, "advisory"),
      (name) => stubPlan(f.root, name, ["STUB_EXIT=3"]),
    );
    const result = await runBabysitterRepairContainer(
      { ...inputFor(f), baseDir: base },
      w.deps,
    );
    assertEquals(result, { containerName: at(w.built, 0, "build") });
  } finally {
    console.error = original;
    await Deno.remove(base, { recursive: true });
    await Deno.remove(f.root, { recursive: true });
  }
  assert(
    lines.some((line) =>
      line.includes(
        "[babysitter] egress teardown: egress helper exited with code 3",
      )
    ),
    `the teardown problem reaches the default log, got ${
      JSON.stringify(lines)
    }`,
  );
});

Deno.test("default Apple helper: a failed start rejects with the last attempt's cause, not an earlier line or a trace", async () => {
  const base = await makeStubCheckout();
  const f = await makeFixture();
  try {
    const tuning = {
      env: hostEnv(`${f.root}/home`, "advisory"),
      readyTimeoutMs: 30_000,
      pollMs: 20,
    };
    const options = { baseDir: base, timeoutMs: 60_000 };

    const attempt = await assertRejects(
      () =>
        babysitterStartAppleEgress(
          stubPlan(f.root, "vibe-babysitter-attempt", ["STUB_FAIL=attempt"]),
          options,
          tuning,
        ),
      Error,
      "egress setup failed: ",
    );
    assertStringIncludes(attempt.message, "real cause");
    assert(
      !attempt.message.includes("old"),
      `an earlier attempt line leaked: ${attempt.message}`,
    );
    assert(
      !attempt.message.includes("at stack trace"),
      `a trace line leaked: ${attempt.message}`,
    );

    const silent = await assertRejects(
      () =>
        babysitterStartAppleEgress(
          stubPlan(f.root, "vibe-babysitter-silent", ["STUB_FAIL=silent"]),
          options,
          tuning,
        ),
      Error,
      "egress setup failed: ",
    );
    assertStringIncludes(
      silent.message,
      "no output; helper exited with code 2",
    );
  } finally {
    await Deno.remove(base, { recursive: true });
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("default sidecar wiring: the real start refuses an enforced plan with empty keys before any spawn, and a control stops without a runtime", async () => {
  const f = await makeFixture();
  try {
    const env = hostEnv(`${f.root}/home`);
    // With no proxy name the default stop has nothing to run, so no runtime
    // process is started on the host.
    const keyless = (name: string): ContainerLaunchPlan => ({
      ...fakePlan(f.root, name, "enforced"),
      proxyName: "",
    });

    const refused = defaultWiring(env, keyless);
    const error = await assertRejects(
      () =>
        runBabysitterRepairContainer(inputFor(f), {
          ...refused.deps,
          log: (message) => {
            refused.logged.push(message);
          },
        }),
      Error,
      "missing a network or proxy key",
    );
    assertStringIncludes(error.message, "refusing to launch");
    assertEquals(refused.spawns.length, 0, "nothing spawns");
    assertEquals(refused.logged, [], "the default stop reports no problem");

    const control = defaultWiring(env, keyless);
    const result = await runBabysitterRepairContainer(inputFor(f), {
      ...control.deps,
      startSidecar: () => Promise.resolve(),
      log: (message) => {
        control.logged.push(message);
      },
    });
    assertEquals(result, { containerName: at(control.built, 0, "build") });
    assertEquals(control.spawns.length, 1, "the control spawns once");
    assertEquals(control.logged, [], "the default stop reports no problem");
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("default sidecar stop reports cleanup failures after the repair", async () => {
  const f = await makeFixture();
  try {
    const wiring = defaultWiring(hostEnv(`${f.root}/home`), (name) => ({
      ...fakePlan(f.root, name, "enforced"),
      proxyStopArgs: ["rm", "-f", `${name}-proxy`],
      networkRemoveArgs: ["network", "rm", `${name}-network`],
    }));
    const result = await runBabysitterRepairContainer(inputFor(f), {
      ...wiring.deps,
      startSidecar: () => Promise.resolve(),
      log: (message) => wiring.logged.push(message),
    });
    assertEquals(result, { containerName: at(wiring.built, 0, "build") });
    assertEquals(wiring.spawns.length, 1);
    assert(
      wiring.logged.some((message) =>
        message.includes("could not remove the egress proxy (exit 1)")
      ),
    );
    assert(
      wiring.logged.some((message) =>
        message.includes("could not remove the egress network (exit 1)")
      ),
    );
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("a helper whose exit status cannot be read counts as a failed exit with code -1 and no signal", async () => {
  assertEquals(
    await readExitStatus(Promise.reject(new Error("status lost"))),
    { success: false, code: -1, signal: null },
  );
  const read: Deno.CommandStatus = { success: true, code: 0, signal: null };
  assertEquals(await readExitStatus(Promise.resolve(read)), read);
});

Deno.test("pause waits for the time given before it resolves", async () => {
  const start = Date.now();
  await pause(60);
  assert(
    Date.now() - start >= 50,
    `pause(60) resolved after ${Date.now() - start} ms`,
  );
});
